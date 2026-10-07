# Outbound HTTP clients

Calling other services from Spring Boot 4.1 with `RestClient`, HTTP interface clients, or
`WebClient`, in Kotlin. Module names, property names, and defaults below were read from the Boot
4.1.1 jars on 2026-09-29.

Contents: [Choose the client](#choose-the-client) ·
[Always start from the Boot-configured builder](#always-start-from-the-boot-configured-builder) ·
[Calling and handling responses](#calling-and-handling-responses) ·
[HTTP interface clients](#http-interface-clients) ·
[Retries, rate limits, and non-idempotent calls](#retries-rate-limits-and-non-idempotent-calls) ·
[Consuming streams (SSE, NDJSON, long bodies)](#consuming-streams-sse-ndjson-long-bodies) ·
[Logging and secrets](#logging-and-secrets) · [Testing](#testing) · [Gotchas](#gotchas)

## Choose the client

| Client | Use when | Starter |
|---|---|---|
| `RestClient` | Blocking stack (MVC, virtual threads, JPA). Default choice | `spring-boot-starter-restclient` |
| HTTP interface (`@HttpExchange` + `@ImportHttpServices`) | Several endpoints of one API; you want a typed Kotlin interface instead of call-site URIs | same (uses `RestClient` underneath by default) |
| `WebClient` | Reactive or coroutine code that must not block (`awaitBody`) | `spring-boot-starter-webclient` |

`WebClient` buffers a response body in memory up to 256 KB by default (codec `maxInMemorySize`); a
larger JSON document fails (through `retrieve()` as a `WebClientResponseException` whose cause is
`DataBufferLimitException`). Raise it deliberately with `spring.http.codecs.max-in-memory-size`
(applies to the injected `WebClient.Builder`) or on the builder's codecs, or stream the response,
rather than removing the limit.
| Vendor SDK (Slack, AWS, ...) | The vendor maintains auth, pagination, rate-limit handling | vendor artifact; check its own retry/timeout defaults |

Boot 4 split client support into these starters; `spring-boot-starter-webmvc` alone does not
auto-configure `RestClient.Builder`.

## Always start from the Boot-configured builder

```kotlin
@Configuration
class PricingClientConfig {
    @Bean
    fun pricingRestClient(builder: RestClient.Builder, props: PricingProperties): RestClient =
        builder
            .baseUrl(props.baseUrl.toString())
            .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
            .build()
}
```

- **Inject `RestClient.Builder`; do not call `RestClient.create()` or `RestClient.builder()`.** The
  static factories ignore everything Boot configures: `spring.http.clients.*` timeouts, the
  application's Jackson 3 mapper (with the Kotlin module and your customizations), observation
  (`http.client.requests` metrics and `traceparent` propagation), and `RestClientCustomizer` beans.
- **There is no default timeout.** Neither `spring.http.clients.connect-timeout` nor `read-timeout` has
  a default, and a statically built client uses a request factory without a read timeout: a stalled
  server blocks the calling thread forever. Set both, globally or per client:

```yaml
spring:
  http:
    clients:
      connect-timeout: 2s
      read-timeout: 5s
```

  On the `jdk` transport (Boot's choice when no Apache, Jetty or Reactor client is on the classpath)
  the read timeout is a deadline for the whole exchange, body download included, so a 5 s value also
  cuts off any response that takes longer to stream ([consuming streams](#consuming-streams-sse-ndjson-long-bodies)).

  `spring.http.client.*` (singular) is the deprecated Boot 3 prefix and is **silently ignored** in
  4.1.1 (no binding, no warning; verified: a singular `read-timeout` did not time out). Use
  `spring.http.clients.*`.
- A client that needs different settings still starts from the injected builder. A new request factory
  does **not** inherit the configured timeouts or SSL; build it from the injected
  `ClientHttpRequestFactoryBuilder` with adjusted `HttpClientSettings`, and for a TLS bundle alone use
  `RestClientSsl` (`builder.apply(ssl.fromBundle("partner"))`).
- **The transport depends on the classpath.** Boot picks the request factory in this order: Apache
  HttpClient → Jetty → Reactor Netty → JDK `HttpClient` → simple JDK. Adding `spring-boot-starter-webclient`
  (Reactor Netty) or an Apache dependency for something else silently changes the transport of every
  `RestClient`, with different pooling, redirect, and timeout behavior (verified: webclient on the
  classpath → `ReactorClientHttpRequestFactory`; `httpclient5` → `HttpComponentsClientHttpRequestFactory`).
  Pin it with `spring.http.clients.imperative.factory` (`http-components`, `jetty`, `reactor`, `jdk`,
  `simple`) and re-check after dependency changes.
- Redirects: decide per API (`spring.http.clients.redirects` = `follow-when-possible` (default),
  `follow`, or `dont-follow`; per group under `spring.http.serviceclient.<group>.redirects`). With
  `dont-follow` the 3xx response is returned to the caller (not an error). For authenticated calls, `dont-follow` avoids sending
  credentials to wherever a redirect points.
- Keep one `RestClient` bean per remote service (base URL, auth, timeouts), not one per call.

## Calling and handling responses

```kotlin
val price: Price = restClient.get()
    .uri("/prices/{sku}", sku)
    .retrieve()
    .body<Price>()                  // reified Kotlin extension; returns Price?
    ?: throw IllegalStateException("Empty body for $sku")

val items: List<Item> = restClient.get().uri("/items").retrieve().body<List<Item>>().orEmpty()
```

- Use the reified `body<T>()` extension (`org.springframework.web.client.body`) for generic types
  instead of `ParameterizedTypeReference`. It returns a **nullable** `T?` (an empty body is `null`);
  decide explicitly what an empty body means.
- `retrieve()` throws for error statuses: `HttpClientErrorException` (4xx) and
  `HttpServerErrorException` (5xx), both `RestClientResponseException` with status, headers, and body.
  I/O problems, including timeouts, surface as `ResourceAccessException`. Handle these three
  categories differently (4xx: usually not retryable; 5xx and I/O: maybe, see below).
- Map remote failures into your own errors at the client boundary with
  `.onStatus({ it.is4xxClientError }) { _, response -> throw PartnerRejected(response.statusCode, response.body.readAllBytes().decodeToString()) }`
  or a `try`/`catch` around the call. The first matching `onStatus` handler wins and the default error
  handling is **skipped**. A handler that reads the body, logs, and returns does not produce a clean
  error: the following `.body<T>()` then fails with a `RestClientException` ("Error while extracting
  response") because the body is already consumed. Throw a meaningful exception from the handler. Do not let a downstream 404 become your API's 404 by accident, or a
  downstream 500 your 500 without a decision.
- `.exchange { request, response -> ... }` gives full control, but then status handling is yours.
- **A 2xx status is not always success.** Some APIs report failures in a 200 body (Slack Web API
  returns `{"ok": false, "error": "..."}`; GraphQL servers commonly return `errors` with 200). Check the
  provider's error field at the client boundary and classify by its error code, not only by HTTP status;
  a rate limit reported in the body is retryable after the advertised delay, an invalid argument is not.
- **Do not turn an upstream failure into an empty result.** Returning `emptyList()` on 403/429/5xx makes
  "nothing found" and "could not ask" look the same to the caller, and a job then records a successful
  run with no data. Throw (or return a result type that says which happened).
- These Kotlin extensions are convenience helpers, **not** suspend adapters. `RestClient` blocks.
  For concurrent calls from coroutines use `WebClient` with `awaitBody()`, or offload explicitly
  ([coroutines](coroutines.md#structured-concurrency)).

## HTTP interface clients

```kotlin
@HttpExchange("/orders")
interface OrderApi {
    @GetExchange("/{id}")
    fun get(@PathVariable id: UUID): OrderDto?

    @PostExchange
    fun create(@RequestBody request: CreateOrderRequest): OrderDto
}

@Configuration
@ImportHttpServices(group = "orders", types = [OrderApi::class])
class HttpClientsConfig
```

```yaml
spring:
  http:
    serviceclient:
      orders:
        base-url: https://orders.internal.example.com
        read-timeout: 3s
```

- `@ImportHttpServices` (Framework 7, `org.springframework.web.service.registry`) registers the proxies
  as beans; no manual `HttpServiceProxyFactory` per client. Group settings live under
  `spring.http.serviceclient.<group>.*` and must use the same group name.
- Keep the host out of `@HttpExchange` and in configuration.
- Declare return types honestly in Kotlin: `OrderDto?` if the remote can answer with an empty body.
  **A non-null return type does not protect you:** the interface proxy is a Java dynamic proxy, and
  with an empty body it returns `null` through the non-null `OrderDto` signature without any
  exception (verified on Framework 7.0.9). The `null` then surfaces later as an NPE far from the call.
  Use nullable return types, or `ResponseEntity<OrderDto>` and check the body.
- `suspend`/`Flow` methods need the group to use `WebClient`
  (`@ImportHttpServices(group = "orders", types = [...], clientType = HttpServiceGroup.ClientType.WEB_CLIENT)`).
  The default group client is `RestClient`.
- Per-group auth, interceptors, and error handling belong in a `RestClientHttpServiceGroupConfigurer`
  (or `WebClientHttpServiceGroupConfigurer`) filtered to that group, not in a global
  `RestClientCustomizer` that would add one partner's credentials to every client.

## Retries, rate limits, and non-idempotent calls

- Retry only calls that are safe to repeat: reads, or writes the remote side deduplicates (an
  `Idempotency-Key` header the provider honors). A timed-out POST may have succeeded; retrying it
  blindly duplicates the effect. Record the attempt and reconcile unknown outcomes.
- Framework 7 core retry on the client wrapper bean:

```kotlin
@Component
class PricingGateway(private val pricingRestClient: RestClient) {
    @Retryable(includes = [ResourceAccessException::class, HttpServerErrorException::class], maxRetries = 2, delay = 200, multiplier = 2.0, jitter = 100)
    fun price(sku: String): Price? = pricingRestClient.get().uri("/prices/{sku}", sku).retrieve().body<Price>()
}
```

  Needs `@EnableResilientMethods`; `maxRetries` counts retries after the first call
  ([transactions](transactions.md#optimistic-locking-and-retry)).
- **Know who else retries.** An SDK, a gateway, a service mesh, or a message redelivery may already
  retry the same call. Stacked retries multiply load (3 × 3 × 3). Check the SDK's behavior before
  adding your own. Some SDKs retry 429 for you, others only report it.
- `429 Too Many Requests` and `503` often carry `Retry-After`, either as seconds or as an HTTP date.
  Parse both, fall back to your own back-off for invalid values, and honor it instead of a fixed delay
  (the `@Retryable` example above does not). Still bound the total: a maximum number of attempts or an
  overall deadline, so a permanently throttled call does not retry forever.
- Timeouts are three different things: connect, read, and **waiting for a pooled connection** (Apache
  `connectionRequestTimeout`, Reactor Netty `pendingAcquireTimeout`). A small pool with no acquisition
  timeout queues requests silently.
- Bound concurrency toward a fragile dependency (`@ConcurrencyLimit`, a semaphore, or a bulkhead) so
  a slow dependency cannot occupy every request thread. Virtual threads make threads cheap but do not
  add connections or remote capacity; they make the bound more important, not less. A circuit breaker (for example Resilience4j)
  helps when failures are fast and repeated; for slow-but-alive dependencies, tight timeouts and
  bulkheads matter more.

## Consuming streams (SSE, NDJSON, long bodies)

- **What a read timeout bounds depends on the client** (observed on Framework 7.0.9):

  | Client | The timeout bounds | Consequence |
  |---|---|---|
  | Raw JDK `HttpClient` (`HttpRequest.timeout()`) | The wait for the response headers only | A body that stalls afterwards blocks forever, with `ofInputStream()` and with `ofString()` |
  | `RestClient` on `simple` or `http-components` | Each socket read | A stall fails after the timeout; a stream that trickles a byte now and then never times out |
  | `RestClient` on `jdk` | The whole exchange, from sending until the body is closed | Also cuts off a healthy long stream (SSE) at the read timeout |

  Give a streaming client its own settings (a separate client or request factory), with an idle limit
  and an overall deadline chosen for the stream.
- **A watchdog that closes the stream does not work on every transport.** Closing the body
  `InputStream` from another thread unblocks a blocked read on raw `HttpClient` (`ofInputStream()`) and
  on `RestClient` with the `jdk` transport: the read throws `IOException: closed`. On `simple` and
  `http-components`, closing the body or the response of a **stalled** stream from another thread
  neither returned nor unblocked the reader (observed on Framework 7.0.9; `jetty` and `reactor` not
  run). `ClientHttpResponse.close()` reads the rest of the body before closing on the `simple`, `jdk`,
  `http-components` and (from source) `reactor` transports, so a watchdog must close the body stream,
  never the response.
- Bound what you buffer: maximum line or event size, maximum total size, and build text with a
  `StringBuilder` (not `+=` on a `String` in a loop).
- Close the body on every path (`use { }` on the stream). An abandoned stream holds its connection.
- Where the protocol defines a completion marker (an API's `[DONE]` or `done` event), treat
  end-of-stream without it as a failure, not as a short but complete answer. Plain NDJSON and SSE define
  no such marker; there, completeness has to come from the payload or the API's own contract.

## Logging and secrets

- Never log `Authorization` headers, tokens, or full request/response bodies by default. A logging
  interceptor must redact them.
- A request interceptor that reads the response body consumes it unless it buffers
  (`BufferingClientHttpRequestFactory`), which costs memory for large responses.
- Keep credentials in configuration properties with a redacted `toString()`
  ([kotlin-spring-basics](kotlin-spring-basics.md#configuration-properties)).

## Testing

- `@RestClientTest` (Boot 4: `org.springframework.boot.restclient.test.autoconfigure`, starter
  `spring-boot-starter-restclient-test`) with `MockRestServiceServer` tests a client bean against
  scripted responses. It binds to the Boot-configured `RestClient.Builder`, so clients built from
  static factories are **not** intercepted.
- For timeout and connection behavior, use a real local server (JDK `com.sun.net.httpserver.HttpServer`
  or WireMock) that delays or drops the response. `MockRestServiceServer` does not exercise the
  request factory or timeouts.
- Test the error mapping: 404, 409, 500, an empty body, a malformed body, and a timeout.

## Gotchas

- Agent writes `RestClient.create()`/`RestClient.builder()` - no Boot timeouts, mapper, or observation; inject `RestClient.Builder`.
- Agent assumes a default timeout - there is none; a stalled server blocks the thread forever.
- Agent configures `spring.http.client.*` in Boot 4 - silently ignored; use `spring.http.clients.*`.
- Agent treats `body<T>()` as non-null - it returns `T?`.
- Agent declares a non-null return type on an HTTP interface method - an empty body returns `null` anyway, with no error.
- Agent retries a non-idempotent POST after a timeout - the first attempt may have succeeded.
- Agent adds retries on top of an SDK or gateway that already retries - load multiplies.
- Agent ignores `Retry-After` on 429/503 - use the server's hint (seconds or HTTP date), with an overall bound.
- Agent adds a dependency that brings Apache HttpClient or Reactor Netty - every `RestClient` switches transport; pin `spring.http.clients.imperative.factory`.
- Agent writes an `onStatus` handler that reads the body, logs, and returns - body extraction then fails confusingly; throw a meaningful exception.
- Agent logs request headers including `Authorization` - redact.
- Agent calls a `RestClient` inside `async { }` expecting parallelism - it blocks; use `WebClient` or offload.
- Agent tests timeouts with `MockRestServiceServer` - it never exercises the transport.
- Agent treats every 200 as success for an API that reports errors in the body - check the provider's error field.
- Agent returns an empty list when the upstream call fails - "no data" and "could not ask" become indistinguishable.
- Agent relies on a read timeout for a streaming body - depending on the client it bounds only the headers, only each read (trickles never time out), or the whole stream (long SSE streams are cut off).
- Agent closes the `ClientHttpResponse` from a watchdog thread - on most transports `close()` drains the body first and blocks; closing the body stream unblocked the reader only on the JDK transport.

## Official sources

- [REST clients (RestClient, WebClient, HTTP interface)](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)
- [Spring Boot: calling REST services](https://docs.spring.io/spring-boot/reference/io/rest-client.html)
- [Framework 7 resilience features](https://docs.spring.io/spring-framework/reference/core/resilience.html)
