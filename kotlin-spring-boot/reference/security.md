# Security: resource server, filter chains, request signatures

Spring Security 7 on Boot 4.1 for Kotlin services: JWT resource servers, authorization rules,
custom signature-verification filters, and security tests. Error-response shape for 401/403 is in
[web-errors](web-errors.md#security-errors-are-not-controller-errors); Actuator exposure is in
[config-observability](config-observability.md#actuator-and-health).

Contents: [Filter chain in Kotlin](#filter-chain-in-kotlin) ·
[JWT resource server](#jwt-resource-server) ·
[Authorization beyond URLs](#authorization-beyond-urls) ·
[Custom request-signature filters (webhooks)](#custom-request-signature-filters-webhooks) ·
[Passwords and secrets](#passwords-and-secrets) · [Testing security](#testing-security) ·
[Gotchas](#gotchas)

## Filter chain in Kotlin

```kotlin
import org.springframework.security.config.annotation.web.invoke // required for the Kotlin DSL

@Configuration
@EnableMethodSecurity
class SecurityConfig {
    @Bean
    fun apiChain(http: HttpSecurity): SecurityFilterChain {
        http {
            securityMatcher("/api/**")
            csrf { disable() }                                  // stateless bearer-token API only
            sessionManagement { sessionCreationPolicy = SessionCreationPolicy.STATELESS }
            authorizeHttpRequests {
                authorize("/api/public/**", permitAll)
                authorize("/api/admin/**", hasAuthority("SCOPE_admin"))
                authorize(anyRequest, authenticated)
            }
            oauth2ResourceServer { jwt { } }
        }
        return http.build()
    }
}
```

- Use the Kotlin DSL (`http { }`). It needs the `org.springframework.security.config.annotation.web.invoke`
  import; without it `http { }` does not resolve and agents fall back to Java-style chains.
- Security 7 has only the lambda/DSL style: `and()`, `authorizeRequests()`, `antMatchers()`,
  `mvcMatchers()`, and `WebSecurityConfigurerAdapter` are gone.
- **Deny by default, across chains.** `anyRequest` inside a chain only covers the requests that chain's
  `securityMatcher` selected. The example chain above secures `/api/**` only; every other path (and
  Actuator) gets no authentication and no security headers from it. Add a last catch-all chain:

```kotlin
@Bean
@Order(Ordered.LOWEST_PRECEDENCE)
fun defaultChain(http: HttpSecurity): SecurityFilterChain {
    http {
        authorizeHttpRequests {
            authorize(DispatcherTypeRequestMatcher(DispatcherType.ERROR), permitAll) // keep error statuses
            authorize("/actuator/health/**", permitAll)
            authorize(anyRequest, denyAll)
        }
    }
    return http.build()
}
```

  (`securityMatcher` selects the chain; `authorize(...)` matchers decide access inside it.) Give the
  `/api/**` chain a lower `@Order` value so it is tried first. Verified: with only the `/api/**` chain,
  `GET /other` reached the controller unauthenticated (200); with the catch-all it is 403.
- **Permit the error dispatch in a deny-all chain.** A status set with `sendError` (a filter's 401 or
  413, a `ResponseStatusException` that no exception handler renders, a firewall rejection) is rendered
  by a second dispatch to `/error`.
  That dispatch is matched against the chains again, falls into the catch-all, and is denied: the client
  receives 403 with an empty body instead of the real status (verified on Security 7.1.1). The first
  rule above (`jakarta.servlet.DispatcherType`,
  `org.springframework.security.web.util.matcher.DispatcherTypeRequestMatcher`; the Kotlin DSL has no
  `DispatcherType` overload) restores 401, 413, 503 and the firewall's 400.
- **Several chains:** each chain needs a `securityMatcher`, and chains are tried in `@Order`. A chain
  without a matcher matches every request; if any chain is ordered after it, Security 7 refuses to
  start (`UnreachableFilterChainException`). Put the catch-all chain last, with the highest order.
- **CORS** for APIs called from browsers: preflight `OPTIONS` requests carry no token, so CORS must run
  before authentication. Add `cors { }` to the chain and a `CorsConfigurationSource` bean with the
  exact origins, methods, and headers. `permitAll` on `OPTIONS` alone does not produce CORS response
  headers.
- Disable CSRF only for stateless APIs that authenticate with a header token. Browser flows with
  cookies or sessions need CSRF protection. For a SPA with cookie auth, a cookie token repository alone
  is not enough: follow Security's SPA recipe (a request handler that deals with deferred and
  BREACH-masked tokens) and refresh the token after login and logout.
- Any custom `SecurityFilterChain` replaces Boot's defaults, including Actuator protection
  ([config-observability](config-observability.md#actuator-and-health)).

## JWT resource server

```yaml
spring:
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://idp.example.com/realms/main
          audiences: orders-api
```

- Starter: `spring-boot-starter-security-oauth2-resource-server`.
- `issuer-uri` validates the `iss` claim and discovers the JWK set. **Set `audiences`** too; without
  it, any token the issuer minted for another API is accepted by yours.
- **These properties configure only Boot's own `JwtDecoder`.** Once you define a `JwtDecoder` bean
  (custom key source, local public key, extra validation), `audiences` and the other
  `spring.security.oauth2.resourceserver.jwt.*` validation settings are **ignored** (verified: wrong
  `aud` accepted). Add the validators yourself:

```kotlin
// Boot 4 package: org.springframework.boot.security.oauth2.server.resource.autoconfigure.OAuth2ResourceServerProperties
@Bean
fun jwtDecoder(props: OAuth2ResourceServerProperties): JwtDecoder {
    val issuerUri = requireNotNull(props.jwt.issuerUri) { "spring.security.oauth2.resourceserver.jwt.issuer-uri must be set" }
    return NimbusJwtDecoder.withIssuerLocation(issuerUri).build().apply {
        setJwtValidator(
            DelegatingOAuth2TokenValidator(
                JwtValidators.createDefaultWithIssuer(issuerUri),
                JwtClaimValidator<List<String>>(JwtClaimNames.AUD) { aud -> aud != null && "orders-api" in aud },
            ),
        )
    }
}
```

`issuerUri` is nullable (JSpecify `@Nullable`), so Kotlin needs the explicit check. Verified with a local
key: wrong `aud`, wrong `iss`, and a missing `aud` are all rejected (401).
- Signature keys are fetched from the JWK set URI and cached. A token with an unknown key ID triggers a
  refetch; if the IdP is unreachable at that moment, validation fails for those requests. Rotation
  works when the IdP publishes the new key before signing with it and keeps the old one until old
  tokens expire. Set a timeout on the JWK fetch and test rotation and IdP-outage behavior. Tokens are
  validated with a default clock skew of 60 seconds.
- **Several issuers (multi-tenant):** never build a decoder from whatever `iss` the token claims. Keep
  an allowlist of issuers (`JwtIssuerAuthenticationManagerResolver` with explicit issuers), validate
  audience per issuer, and identify users by `(iss, sub)`, not `sub` alone.
- **Authorities mapping:** by default the `scope`/`scp` claim becomes `SCOPE_<value>` authorities.
  Roles in other claims (Keycloak `realm_access.roles`, Auth0 custom namespaces, Entra `roles`) are
  **ignored** until you map them with a `JwtAuthenticationConverter`. `hasRole("ADMIN")` checks for
  `ROLE_ADMIN`; `hasAuthority("SCOPE_admin")` checks the scope. Mixing them up denies everything
  (or, with a too-broad converter, grants too much).

```kotlin
@Bean
fun jwtAuthenticationConverter() = JwtAuthenticationConverter().apply {
    setJwtGrantedAuthoritiesConverter { jwt ->
        val scopes = JwtGrantedAuthoritiesConverter().convert(jwt).orEmpty()
        val roles = (jwt.getClaimAsMap("realm_access")?.get("roles") as? List<*>)
            .orEmpty().filterIsInstance<String>().map { SimpleGrantedAuthority("ROLE_$it") }
        scopes + roles
    }
}
```

- Read the principal in controllers with `@AuthenticationPrincipal jwt: Jwt` and derive user IDs from
  stable claims (`sub`), not from email or display names.
- Validating the token is not the whole check: a disabled or deleted user can still hold a valid
  token until it expires. Check account state where it matters.
- Issuing your own JWTs is a different job (authorization server). If a project must, use the
  Nimbus-based `JwtEncoder`/`JwtDecoder` that ship with the resource server starter, keep keys out of
  code, and keep token lifetimes short; do not copy jjwt 0.11-era examples.

## Authorization beyond URLs

- URL rules answer "may this caller use this endpoint". Ownership and tenant checks ("may this caller
  see **this** order") belong in the service or in method security with the resource at hand.
- Method security (`@PreAuthorize`) requires `@EnableMethodSecurity` and works through proxies: the
  same self-invocation and `final` rules as transactions apply
  ([transactions](transactions.md#proxy-rules-in-kotlin)). A denial throws
  `AuthorizationDeniedException` inside MVC; make sure a catch-all handler rethrows it
  ([web-errors](web-errors.md#error-responses-with-problemdetail-rfc-9457)).
- SpEL in `@PreAuthorize` refers to Kotlin parameter names (resolved through Kotlin reflection; verified
  without `-java-parameters`). The expression is a string, so renaming a parameter breaks it silently.
  Keep expressions short, move the logic into a testable bean
  (`@PreAuthorize("@orderAccess.canRead(#id, authentication)")`), and cover it with a denial test.
- `kotlin("plugin.spring")` does not open classes for `@PreAuthorize` itself; it opens Spring
  stereotypes. A class without a stereotype, created through a `@Bean` method, stays final, and the
  context **fails to start** (`AopConfigException: Could not generate CGLIB subclass ... final class`).
  Annotate it with a stereotype or declare it `open`, and keep a test that expects the denial.
- Custom `AuthorizationManager` implementations: Security 7 has only
  `authorize(authentication: Supplier<out Authentication?>, context): AuthorizationResult`. Older
  examples that override `check(...)` do not compile.
- The security context is thread-bound. `@Async`, custom executors, and coroutines do not carry it
  unless propagated; resolve the principal on the request thread and pass it along
  ([coroutines](coroutines.md#spring-integration)).

## Custom request-signature filters (webhooks)

Webhook providers sign the raw body, but each has its own header, signed input, and encoding. For
example Slack signs `v0:<timestamp>:<body>` and sends `v0=<hex>` in `X-Slack-Signature`; GitHub sends
`X-Hub-Signature-256: sha256=<hex>` with no signed timestamp. Implement the provider's documented
contract (or use its SDK); the filter below shows the shape only.

```kotlin
class SignatureVerificationFilter(
    private val secret: ByteArray,
    private val clock: Clock,
    private val maxBodyBytes: Int, // the provider's documented maximum payload size
) : OncePerRequestFilter() {
    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        // 1. Cheap header checks before touching the body
        val timestamp = request.getHeader("X-Timestamp")?.toLongOrNull()
        val signature = request.getHeader("X-Signature")?.let(::decodeProviderSignature) // null if malformed
        if (timestamp == null || signature == null || abs(clock.instant().epochSecond - timestamp) > 300) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED)
            return
        }
        // 2. Bounded read: an unauthenticated caller must not make you buffer an arbitrary body
        val body = if (request.contentLengthLong > maxBodyBytes) null else request.inputStream.readNBytes(maxBodyBytes + 1)
        if (body == null || body.size > maxBodyBytes) {
            response.sendError(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE)
            return
        }
        // 3. MAC over the exact bytes received
        if (!MessageDigest.isEqual(expectedMac(secret, timestamp, body), signature)) {
            response.sendError(HttpServletResponse.SC_UNAUTHORIZED)
            return
        }
        chain.doFilter(CachedBodyRequest(request, body), response)
    }
}

class CachedBodyRequest(request: HttpServletRequest, private val body: ByteArray) : HttpServletRequestWrapper(request) {
    override fun getInputStream(): ServletInputStream {
        val input = body.inputStream()
        return object : ServletInputStream() {
            override fun read(): Int = input.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int = input.read(b, off, len)
            override fun isFinished(): Boolean = input.available() == 0
            override fun isReady(): Boolean = true
            override fun setReadListener(listener: ReadListener): Unit = throw UnsupportedOperationException()
        }
    }
    override fun getReader(): BufferedReader = BufferedReader(InputStreamReader(inputStream, characterEncoding ?: "UTF-8"))
    override fun getContentLengthLong(): Long = body.size.toLong()
    override fun getContentLength(): Int = body.size
}
```

- **Check headers, then the size, then the MAC.** Reading the whole body first lets anyone without a
  valid signature make every replica buffer an arbitrarily large request. `Content-Length` can be
  absent (chunked) or wrong, so also cap the read itself (`readNBytes(limit + 1)`).
- **Verify the raw bytes before JSON parsing.** Re-serializing a parsed body changes whitespace and
  field order, so the signature no longer matches.
- The servlet body can be read once. Wrap the request in a class that replays the bytes you read, as
  above. `ContentCachingRequestWrapper` caches only **after** someone reads it, so it does not help a
  filter that must read first (in Framework 7 it also requires an explicit cache limit argument).
- **Form-encoded webhooks** (`application/x-www-form-urlencoded`, for example Slack slash commands and
  interactions): `getParameter*` merges query-string and body parameters, and the query-string values
  come first. When the provider signs only the body (as Slack does), a replayed, correctly signed
  request with an added `?payload=...` can then hand the controller an unsigned value. Once the filter has consumed the stream, the container may not see the
  body parameters at all. Override the `getParameter*` methods in the wrapper to parse the signed body
  only.
- Compare signatures with `MessageDigest.isEqual` (constant time), not `==`, and compare the same
  representation: decode the provider's hex/base64 signature (and strip prefixes such as `v0=` or
  `sha256=`) before comparing with the raw MAC bytes.
- Check the timestamp window (replay protection) with an injected `Clock`, where the provider signs a
  timestamp.
- **Deduplicate retries with the provider's stable identifier**, which differs per provider: GitHub's
  `X-GitHub-Delivery` stays the same on redelivery. For Slack, do not key on the timestamp or the
  signature: whether a retry carries new ones is not in the Events API documentation, and retry
  headers were never captured. Use the event ID (`event_id`, Events API) or a body hash.
  Forget a failed attempt only if its side effects were rolled back or are idempotent, so the
  provider's retry can succeed without duplicating work.
- **Register the filter once.** A `Filter` that is also a `@Component`/`@Bean` is registered by Boot
  as a servlet filter **and** again when you add it to the security chain. A plain `Filter` then runs
  twice per request. A `OncePerRequestFilter` runs only once (its "already filtered" attribute skips
  the second call), but which of the two positions executes it depends on filter order, so it may run
  outside the place in the chain you intended. Either add it to the chain only and disable the servlet
  registration (`FilterRegistrationBean(filter).apply { isEnabled = false }`), or register it only as
  a servlet filter.
- **Limit the filter to the webhook path the way the server maps it.** `shouldNotFilter` that compares
  `request.requestURI` (raw: still percent-encoded and carrying `;` path parameters) with `startsWith`
  can be bypassed. Spring MVC matches each path segment after percent-decoding it and removing `;`
  parameters, so `/webhook%73/slack` or `/webhooks;a=b/slack` skips the check and still reaches the
  controller (verified on Tomcat 11 and Jetty 12, Boot 4.1). Select the path with a servlet mapping
  (`FilterRegistrationBean(filter).apply { urlPatterns = listOf("/webhooks/*") }`; the container maps
  the decoded, normalized path, and every variant that reached the controller ran the filter), or with a
  dedicated `SecurityFilterChain` whose `securityMatcher` covers the webhook paths (its firewall rejects
  the rest). If you must decide in code, compare the decoded path without `;` parameters and default to
  verifying.

### Responding to webhook deliveries

- **The response status is the provider's retry instruction.** A provider that retries treats a
  timeout or a non-success status as "deliver again" (which statuses count differs: Slack's Events API
  retries any non-2xx, including your filter's 401 and 413, unless the response sets
  `x-slack-no-retry: 1`), and a 2xx as "done". Policies differ: Slack retries a failed or slow (over
  3 s) delivery a few times, Stripe retries for days, and GitHub does not redeliver automatically. Read
  the provider's documented policy before choosing statuses.
- **Answer 2xx only for an event that is durably recorded or already processed.** Store the event
  (keyed by the provider's stable ID) and acknowledge within the provider's time limit, then process it
  from the store. A 2xx for an event held only in memory or in an executor queue loses it when that
  work fails.
- A retry can arrive while the first delivery is still being processed. If the first attempt can still
  fail, do not answer the retry with a plain 2xx from an in-memory "seen" set: that acknowledges an
  event nobody has finished. Either record before acknowledging (above), or answer a retryable status
  until the first attempt completes, if the provider retries.
- With several replicas, deduplication needs shared state (a unique key in the database) written in
  the same transaction as the handler's changes; an in-memory set is per instance.
- For event deliveries, the sender decides on retries from the status alone; a ProblemDetail body is
  for API clients. Some provider interactions do read the body, with their own contract (Slack's URL
  verification `challenge`, a modal submission's `response_action`), so keep those responses as the
  provider documents them. Check the status that actually reaches the sender on webhook paths: a
  Kotlin `@ExceptionHandler` that returns `Unit` answers 200 ([web-errors](web-errors.md#status-mapping)), and a deny-all catch-all chain without the
  error-dispatch rule turns every `sendError` status into 403 ([above](#filter-chain-in-kotlin)).

## Passwords and secrets

- Use `PasswordEncoderFactories.createDelegatingPasswordEncoder()` (bcrypt by default, upgradable) for
  stored passwords. Never compare secrets with `==`.
- API keys and signing secrets come from configuration (`${ENV}`), never from code or committed YAML.
  Treat a secret that ever reached git history as leaked.

## Testing security

```kotlin
mockMvc.get("/api/orders/1") {
    with(jwt().jwt { it.claim("sub", "user-1") }.authorities(SimpleGrantedAuthority("SCOPE_orders.read")))
}.andExpect { status { isOk() } }
```

- `spring-security-test` provides `jwt()`, `user()`, `csrf()` request post-processors and
  `@WithMockUser`. `jwt()` bypasses signature validation; it tests authorization, not token parsing.
  Test the decoder (issuer, audience, expiry) separately, for example against a locally generated key.
- In `@WebMvcTest`, add `spring-boot-starter-security-test` and `@Import` the security configuration,
  or the slice tests Boot's defaults instead of your rules ([testing](testing.md#web-layer-webmvctest)).
- Cover per protected endpoint: no token (401), wrong authority (403), right authority (2xx), and for
  ownership rules another user's resource (403 or 404, as designed).
- Signature filters: valid signature, tampered body, stale timestamp, replayed request, a provider
  retry of a request already processed (deduplicated whatever timestamp it carries), an oversized
  body (rejected without reading it all), percent-encoded and
  `;`-parameter variants of the webhook path, and for form-encoded webhooks an added query parameter.
  Run path variants against the real embedded server (a `RANDOM_PORT` test with a client that sends the
  path verbatim). MockMvc applies neither the container's normalization to filter mappings nor its
  rejections, and its String URL templates encode `%` again: `mockMvc.get("/webhook%73/slack")` requests
  `/webhook%2573/slack`, gets 404, and hides the bypass. If you use MockMvc, pass a `URI`.

## Gotchas

- Agent writes `http { }` without importing `org.springframework.security.config.annotation.web.invoke` - the Kotlin DSL does not resolve.
- Agent uses `authorizeRequests()`, `antMatchers()`, `.and()`, or `WebSecurityConfigurerAdapter` - removed in Security 7.
- Agent adds a catch-all chain (no `securityMatcher`) before other chains - Security 7 fails to start; order it last.
- Agent configures `issuer-uri` without `audiences` - tokens for other APIs are accepted.
- Agent defines a `JwtDecoder` bean and relies on `audiences`/`issuer-uri` properties for validation - they no longer apply; add validators.
- Agent uses `hasRole` with roles from a custom claim and no converter - authorities are only `SCOPE_*` by default.
- Agent disables CSRF for a cookie/session-based browser app - CSRF protection is needed there.
- Agent verifies a webhook signature over re-serialized JSON - verify the raw body.
- Agent reads the whole webhook body before checking headers and size - anyone can make every replica buffer huge requests; check headers, cap the read.
- Agent scopes a signature filter with `requestURI.startsWith` - percent-encoded or `;`-parameter path variants skip it; match the path the container maps.
- Agent adds a deny-all catch-all chain without permitting the ERROR dispatch - every `sendError` status (401, 413, 503) reaches the client as 403.
- Agent reads form-webhook values with `getParameter` - query-string values come first and are unsigned; parse the signed body.
- Agent answers a webhook 2xx before the event is durable - the provider will not retry, and a later failure loses the event.
- Agent compares signatures with `==` - use `MessageDigest.isEqual`.
- Agent dedups webhook retries by the timestamp or signature (whether a Slack retry changes them is undocumented and was not observed) - use the provider's stable ID (`event_id`) or a body hash.
- Agent compares a raw MAC with the provider's hex/base64 header string - decode and strip prefixes first.
- Agent secures only `/api/**` with one chain - add a last catch-all chain that denies by default.
- Agent adds `permitAll` for `OPTIONS` instead of configuring CORS - preflight gets no CORS headers.
- Agent copies an `AuthorizationManager.check(...)` override - Security 7 only has `authorize(...)`.
- Agent builds a JWT decoder from the token's own `iss` - allowlist issuers.
- Agent annotates a security filter with `@Component` and also adds it to the chain - registered twice (plain `Filter` runs twice; `OncePerRequestFilter` may run at the wrong position).
- Agent tests only the happy path with `jwt()` - add 401/403 cases and test the decoder separately.

## Official sources

- [Spring Security Kotlin configuration](https://docs.spring.io/spring-security/reference/servlet/configuration/kotlin.html)
- [OAuth2 resource server JWT](https://docs.spring.io/spring-security/reference/servlet/oauth2/resource-server/jwt.html)
- [Method security](https://docs.spring.io/spring-security/reference/servlet/authorization/method-security.html)
- [Testing with MockMvc](https://docs.spring.io/spring-security/reference/servlet/test/mockmvc/index.html)
