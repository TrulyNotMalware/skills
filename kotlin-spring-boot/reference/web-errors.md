# REST controllers, validation, and error responses

Spring MVC on Boot 4.1 / Framework 7. The web starter is `spring-boot-starter-webmvc`. The old
`spring-boot-starter-web` still resolves in 4.1 but is a deprecated alias; use the new name in new
builds and leave existing ones alone unless the task is the migration. Keep the project's existing error contract; this file describes how to
build or extend one without Kotlin-specific surprises.

Contents: [Controllers and DTOs](#controllers-and-dtos) ·
[Error responses with ProblemDetail (RFC 9457)](#error-responses-with-problemdetail-rfc-9457) ·
[JSON configuration (Jackson 3, Boot 4)](#json-configuration-jackson-3-boot-4) ·
[Idempotent POST endpoints](#idempotent-post-endpoints) ·
[Pagination and versioning](#pagination-and-versioning) · [Testing](#testing) · [Gotchas](#gotchas)

## Controllers and DTOs

```kotlin
@RestController
@RequestMapping("/api/orders")
class OrderController(private val orderService: OrderService) {
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@Valid @RequestBody request: CreateOrderRequest): OrderResponse = orderService.create(request.toCommand())

    @GetMapping("/{id}")
    fun get(@PathVariable id: UUID): OrderResponse = orderService.find(id) ?: throw OrderNotFoundException(id)
}

data class CreateOrderRequest(
    @field:NotNull val customerId: UUID?,
    @field:NotEmpty @field:Valid val items: List<OrderItemRequest>?,
) {
    fun toCommand() = CreateOrderCommand(customerId = customerId!!, items = items!!.map { it.toCommand() })
}
```

- Request and response DTOs are separate `data class`es. Never bind requests to entities or return
  entities.
- Return the DTO type directly (or `ResponseEntity<T>` when headers/status vary). Avoid
  `ResponseEntity<*>`/`Any` return types; they hide the contract from clients and OpenAPI tooling.
- Map to domain commands at the boundary (`toCommand()`), after validation.

### Nullability vs validation (the Kotlin trade-off)

With `jackson-module-kotlin`, a **missing or `null` value for a non-null constructor parameter
without a default value fails during JSON binding**. (A parameter with a default takes the default
when the field is absent; an explicit `null` for it still fails unless null handling is configured.) Spring then raises `HttpMessageNotReadableException` (400) **before** Bean Validation
runs. Consequences:

- The client gets one generic "unreadable message" error instead of field-level violations, and only
  for the first missing field.
- Custom messages on `@NotNull`/`@NotBlank` never appear for those fields.

Pick one policy per API and apply it consistently:

| Policy | DTO shape | Result |
|---|---|---|
| Field-level errors for every required field | Nullable types + `@field:NotNull`/`@field:NotBlank`, convert with `!!` after validation (as above) | All violations reported together via `MethodArgumentNotValidException` |
| Strict typing, generic error for missing fields | Non-null types; constraints only for value rules (`@field:Size`, `@field:Email`) | Missing field → `HttpMessageNotReadableException`; map it to a clear 400 in the error handler |

Also:

- Nested objects and collection elements are validated only with `@field:Valid` on the property.
- Bean Validation on constructor properties needs the field target on Kotlin below 2.4
  ([kotlin-spring-basics](kotlin-spring-basics.md#annotation-use-site-targets)).
- Constraints on handler parameters (`@RequestParam @Min(1) size: Int`, `@PathVariable @Pattern`)
  are validated by Spring MVC's built-in method validation. A violation raises
  `HandlerMethodValidationException`, **not** `MethodArgumentNotValidException`. Handle both.
  - Do **not** put `@Validated` on the controller class. That switches to AOP-based method validation,
    which raises `ConstraintViolationException` instead. MVC's error handling does not map it, so a
    bad `size=0` becomes a **500** (verified on Boot 4.1.1, with and without a catch-all advice).
  - When a handler has constraints directly on parameters, MVC method validation also covers the
    `@Valid @RequestBody` argument, and its failures arrive as `HandlerMethodValidationException` too.
    Test the exception type you actually get.
- Path variables and query parameters are converted by Spring's conversion service, not by Jackson.
  Enums use case-sensitive `Enum.valueOf` (`/orders?status=paid` fails for `PAID`); register a
  converter if the API accepts other spellings. Kotlin value-class parameters are supported in
  Framework 7; test invalid input for both.
- Kotlin default values make request parameters optional (`@RequestParam size: Int = 20`); do not
  add `required = false`/`defaultValue` on top.

### Polymorphic request bodies (sealed classes)

```kotlin
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "type")
sealed interface PaymentRequest {
    @JsonTypeName("card") data class Card(val token: String) : PaymentRequest
    @JsonTypeName("transfer") data class Transfer(val iban: String) : PaymentRequest
}
```

- `@JsonTypeInfo`/`@JsonTypeName` come from `com.fasterxml.jackson.annotation` (the annotations kept
  their package in Jackson 3).
- The Kotlin module discovers subtypes of a sealed class, so `@JsonSubTypes` is not needed, but the
  **discriminator** still is: declare `@JsonTypeInfo` and give each subtype a stable name. Class
  names are not a contract.
- Test a missing discriminator and an unknown value; both should produce a 400, not a 500.

## Error responses with ProblemDetail (RFC 9457)

Two ways to produce `application/problem+json`:

1. `spring.mvc.problemdetails.enabled=true` (default `false` in Boot 4.1): Spring's own exceptions
   (unreadable body, method not allowed, validation, ...) render as Problem Details.
2. A `@RestControllerAdvice` extending `ResponseEntityExceptionHandler`, which does the same for
   framework exceptions and lets you add domain mappings. Do not combine it with option 1: when the
   application defines such an advice, Boot backs off its own.

```kotlin
@RestControllerAdvice
class ApiExceptionHandler : ResponseEntityExceptionHandler() {
    private val log = KotlinLogging.logger {} // not `logger`: the parent has a protected `logger`

    @ExceptionHandler
    fun handle(e: OrderNotFoundException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Order ${e.orderId} not found").apply {
            type = URI.create("https://api.example.com/problems/order-not-found")
            setProperty("errorCode", "ORDER_NOT_FOUND")
        }

    @ExceptionHandler
    fun handle(e: ObjectOptimisticLockingFailureException): ProblemDetail =
        ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "The resource was modified concurrently; reload and retry")

    @ExceptionHandler
    fun handle(e: Exception): ProblemDetail {
        // Method security (@PreAuthorize) throws inside MVC; let Spring Security's
        // ExceptionTranslationFilter turn these into 401/403 instead of a 500.
        if (e is AccessDeniedException || e is AuthenticationException) throw e
        log.error(e) { "Unhandled exception" }
        return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "Internal error")
    }

    // Kotlin signatures of the overridable hooks (Framework 7): parameters non-null, result nullable.
    override fun handleMethodArgumentNotValid(
        ex: MethodArgumentNotValidException,
        headers: HttpHeaders,
        status: HttpStatusCode,
        request: WebRequest,
    ): ResponseEntity<Any>? {
        ex.body.setProperty(
            "violations",
            ex.bindingResult.fieldErrors.map { mapOf("field" to it.field, "message" to it.defaultMessage) },
        )
        return super.handleMethodArgumentNotValid(ex, headers, status, request) // keeps MessageSource resolution
    }
}
```

- **Extend `ResponseEntityExceptionHandler` when you add a catch-all `Exception` handler.** Without it,
  the catch-all also catches Spring's own exceptions (`NoResourceFoundException` 404,
  `HttpRequestMethodNotSupportedException` 405, `HttpMessageNotReadableException` 400) and turns them
  into 500s.
- The inherited `protected val logger` (commons-logging) shadows a file-level `logger`. Name your
  logger differently ([kotlin-spring-basics](kotlin-spring-basics.md#logging)).
- **A catch-all must rethrow security exceptions.** `@PreAuthorize`/`@Secured` denials raise an
  `AccessDeniedException` (concretely `AuthorizationDeniedException` in Spring Security 7) inside the
  MVC call. A catch-all that swallows it answers 500 instead of
  403. Rethrow `AccessDeniedException` and `AuthenticationException` (as above) and test a
  method-security denial.
- Override `handleMethodArgumentNotValid` (and `handleHandlerMethodValidationException`) to add
  field-level details as a stable extension property (for example `violations: [{field, message}]`).
  Clients must not parse `detail` text. Add to `ex.body` and delegate to `super` as above: the parent
  resolves `type`/`title`/`detail` through the `MessageSource` (i18n) when it builds the body. A
  hand-built `ProblemDetail` passed as the body skips that step.
- Domain exceptions that carry their own status: extend `ErrorResponseException`
  (`ErrorResponseException(HttpStatus.CONFLICT, problemDetail, null)`). `ResponseEntityExceptionHandler`
  handles `ErrorResponseException` subclasses; a class that merely **implements** `ErrorResponse`
  falls through to your catch-all (500) unless you map it explicitly. Keep such exceptions in the web
  adapter if the domain module must stay free of Spring.
- Stable machine-readable codes go in extension properties (`errorCode`). The `type` URI is optional
  (defaults to `about:blank`); when set, keep it stable and project-owned.
- Never return exception messages from infrastructure (SQL, driver, stack traces) in `detail`. Log
  them; return a generic message.

### Status mapping

| Situation | Status |
|---|---|
| Malformed JSON, type mismatch, missing required field (binding) | 400 |
| Bean Validation / method validation of **inputs** | 400 (or 422 if the project uses it for validation) |
| Method validation of a **return value** (controller produced invalid output) | 500 (`HandlerMethodValidationException` maps it so; do not remap to 4xx) |
| Unsupported request `Content-Type` / no acceptable response representation | 415 / 406 (framework exceptions; keep them, test them) |
| Resource absent | 404 |
| Optimistic-lock conflict, duplicate idempotency key with a different payload, state conflict | 409 |
| Well-formed request that breaks a business rule | 422 |
| Unauthenticated / forbidden | 401 / 403, from the security layer (below) |
| Unexpected failure | 500, generic detail |

Follow the existing mapping when the project has one; consistency matters more than this table.

- **A handler's status comes from its return value or `@ResponseStatus`, not from the exception.**
  A Kotlin `@ExceptionHandler fun handle(e: SomeException) { log.warn(e) { "..." } }` returns `Unit`
  (`void`); in a `@RestControllerAdvice` or a plain `@ControllerAdvice` that answers **200 with an empty
  body**. Return a
  `ProblemDetail`/`ResponseEntity` or add `@ResponseStatus`. This matters most for callers that read
  only the status, such as webhook senders deciding whether to retry
  ([security](security.md#responding-to-webhook-deliveries)).

### Security errors are not controller errors

`@RestControllerAdvice` never sees exceptions thrown in the security filter chain. Authentication
failures go through the `AuthenticationEntryPoint`, authorization failures through the
`AccessDeniedHandler`. Configure both to write the same Problem Details shape, and test 401 and 403
separately from controller errors ([testing](testing.md#web-layer-webmvctest)).

- Those handlers write the servlet response directly: set the status and
  `Content-Type: application/problem+json` yourself, and serialize with the application's `JsonMapper`
  bean (not a new mapper), so the error shape matches the MVC one.
- Keep authentication challenges. For bearer tokens, the `WWW-Authenticate` header on 401 carries the
  error reason (`invalid_token`, ...); a custom entry point must not drop it. Wrap or delegate to the
  default entry point instead of replacing it blindly.
- Test missing credentials, an invalid token, and insufficient authority as three separate cases.

### Errors after the response is committed

A handler cannot change the status once the body is being streamed (large downloads, SSE, a
`StreamingResponseBody`). Validate and load everything that can fail **before** starting to write.

## JSON configuration (Jackson 3, Boot 4)

- Customize the mapper with a `JsonMapperBuilderCustomizer` bean (`org.springframework.boot.jackson.autoconfigure`).
  The Jackson 2 `Jackson2ObjectMapperBuilderCustomizer` is **gone** from Boot 4.1, so old code does not compile.
- Custom serializers registered as components use `@JacksonComponent` (`org.springframework.boot.jackson`);
  `@JsonComponent` is removed as well.
- Prefer `spring.jackson.*` properties for simple settings. Remember that separate mappers (Kafka,
  HTTP clients) do not inherit them ([messaging-outbox](messaging-outbox.md#dependencies-and-boot-4-changes)).

## Idempotent POST endpoints

For create/charge-style endpoints that clients retry:

- Accept an `Idempotency-Key` header. Scope it by the authenticated principal (and tenant) and the
  operation. A raw client key must not let one user read another's result.
- In **one DB transaction**: claim the key (`INSERT ... ON CONFLICT DO NOTHING` or a unique
  constraint), apply the business write, store the response status and body. On failure the claim
  rolls back with the write.
- Same key, same request hash → replay the stored response (status, body, and the headers the client
  needs, such as `Location`). Same key, different payload → 409 (or 422; document it).
- Define the request hash on a normalized form (canonical JSON, relevant headers only), and the key
  retention from the client's real retry window.
- "In progress" is not visible for free: the claim row is uncommitted, so a concurrent request with the
  same key **blocks** on the unique index until the first transaction ends. Bound that wait (lock or
  statement timeout) and map the timeout to 409 with a retry hint, or commit the claim in its own
  short transaction with an explicit `IN_PROGRESS` state.
- Never implement it as "check if exists, then insert". Concurrent retries both pass the check. Do
  not catch a unique-constraint violation and keep using the same transaction; on PostgreSQL it is
  already aborted.
- A cache with TTL alone is not a guard for business effects. For external effects (payments, email),
  use an outbox and the provider's idempotency key ([messaging-outbox](messaging-outbox.md#transactional-outbox)).

## Pagination and versioning

- Bound page size: `spring.data.web.pageable.max-page-size` (default 2000) or an explicit cap. Return a
  DTO page (content + paging metadata), not a serialized `PageImpl`.
- Boot 4 / Framework 7 support API versioning natively (`version = "1.1"` on mappings, configured via
  `WebMvcConfigurer.configureApiVersioning` or `spring.mvc.apiversion.*`). Use it instead of
  duplicated `/v1`, `/v2` controllers when adding versioning to a project that has none; do not
  migrate an existing scheme as a side effect.
- Enabling it changes behavior for existing clients: a version resolver (header, query parameter,
  path segment, or media-type parameter) is required, and by default a request **without** a version
  is rejected with 400. Configure the resolver, whether the version is required, the default
  version, and the supported versions together, and test missing, unsupported, and default-version
  requests.

## Testing

- Validation and error contracts are HTTP behavior: test them with `@WebMvcTest` and raw JSON bodies
  ([testing](testing.md#web-layer-webmvctest)). Cover a missing required field, a `null` value, a wrong
  type, a nested-element violation, a request-parameter violation, 404/409/422 domain errors, an
  unknown route (404, not 500), and an unexpected exception (500 with no internal message).
- Assert status, content type, and the stable fields (`errorCode`, `violations`), not the prose.

## Gotchas

- Agent adds `spring-boot-starter-web` to a new Boot 4 build - it is a deprecated alias; use `spring-boot-starter-webmvc`.
- Agent expects `@field:NotNull` messages for a non-null Kotlin property - binding fails first with `HttpMessageNotReadableException`.
- Agent handles only `MethodArgumentNotValidException` - parameter constraints raise `HandlerMethodValidationException`.
- Agent forgets `@field:Valid` on nested DTOs or lists - nested constraints are skipped.
- Agent writes a catch-all `@ExceptionHandler(Exception::class)` without extending `ResponseEntityExceptionHandler` - framework 404/405/400 become 500.
- Agent names the logger `logger` in a `ResponseEntityExceptionHandler` subclass - the inherited member shadows it.
- Agent expects controller advice to shape 401/403 - configure the entry point and access-denied handler.
- Agent's catch-all swallows `AccessDeniedException` from `@PreAuthorize` - rethrow security exceptions.
- Agent puts `@Validated` on a controller class - MVC's built-in method validation is replaced by AOP validation.
- Agent implements `ErrorResponse` on a domain exception and expects the parent handler to use it - extend `ErrorResponseException` or map it.
- Agent maps a return-value validation failure to 400 - that is a server bug (500).
- Agent writes an `@ExceptionHandler` that only logs (returns `Unit`) - the response is 200 with an empty body.
- Agent enables API versioning on an existing API without a default - unversioned clients get 400.
- Agent returns SQL or driver messages in `detail` - log them; return a generic message.
- Agent implements idempotency as check-then-insert - enforce it with a unique claim in the same transaction.
- Agent uses `Jackson2ObjectMapperBuilderCustomizer` or `@JsonComponent` in Boot 4 - both are removed; use `JsonMapperBuilderCustomizer` / `@JacksonComponent`.

## Official sources

- [Spring MVC error responses (ProblemDetail)](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html)
- [Spring MVC validation](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-controller/ann-validation.html)
- [API versioning](https://docs.spring.io/spring-framework/reference/web/webmvc-versioning.html)
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
