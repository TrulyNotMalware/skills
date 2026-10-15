# WebFlux and Spring Cloud Gateway

Reactive request pipelines in Kotlin: `WebFilter`s, Spring Cloud Gateway (Server WebFlux) global
and route filters, coroutine filters written with `mono { }`, Spring Security on WebFlux, and tests
that run the real filter chain. Measured on Boot 4.1.0, Spring Cloud 2025.1.2 (Gateway Server
WebFlux 5.0.2), Spring Security 7.1.0, Reactor 3.8.6, kotlinx-coroutines 1.10.2, Kotest 6.2.0,
2026-10-14. Servlet-side security (filter chains, webhook filters) is in [security](security.md);
coroutine rules that apply everywhere (cancellation, dispatchers) are in [coroutines](coroutines.md).

Contents: [Where each filter runs](#where-each-filter-runs) ·
[Call the rest of the chain once](#call-the-rest-of-the-chain-once) ·
[Coroutine filters: keep the downstream call outside timeouts and catches](#coroutine-filters-keep-the-downstream-call-outside-timeouts-and-catches) ·
[Gateway defaults that fail quietly](#gateway-defaults-that-fail-quietly) ·
[Raw and decoded paths](#raw-and-decoded-paths) · [CORS with a security chain](#cors-with-a-security-chain) ·
[Reactive security defaults and JWT](#reactive-security-defaults-and-jwt) ·
[Testing the real chain](#testing-the-real-chain) · [Gotchas](#gotchas)

## Where each filter runs

A request passes through three stages:

| Stage | What runs | Ordered by |
|---|---|---|
| 1. `WebFilter` chain | Your `WebFilter` beans and Spring Security's `WebFilterChainProxy` (order `-100`, `WebFluxSecurityConfiguration.WEB_FILTER_CHAIN_FILTER_ORDER`) | `Ordered` / `@Order` among `WebFilter`s |
| 2. `DispatcherHandler` | `RoutePredicateHandlerMapping` picks a route and applies the gateway's CORS configuration | handler-mapping order |
| 3. Gateway chain | `GlobalFilter`s and the route's `GatewayFilter`s, sorted together, ending in the routing filter that calls the backend | `Ordered` among gateway filters |

- **Order numbers do not interleave across stages.** A `GlobalFilter` with order `-200` still runs
  after every `WebFilter`, including Spring Security at `-100`. Consequences:
  - Authentication runs before any `GlobalFilter`. A request rejected with 401 never reaches a
    rate limiter or blocklist written as a `GlobalFilter`.
  - A header added by a `WebFilter` is visible to, and can be removed by, a `GlobalFilter` that
    strips client-supplied headers. Stamp trusted headers in a `GlobalFilter` ordered after the
    strip filter.
- **A `GlobalFilter` gets its order from `Ordered` or from `@Order` on its class.** `@Order` on the
  `@Bean` method that returns a lambda filter is ignored by the gateway's sort (it only reorders the
  injected list): the filter runs at `LOWEST_PRECEDENCE`, after `RouteToRequestUrlFilter` and just
  before the routing filter. A "strip, then stamp" pair written that way silently swaps.
- The authenticated principal reaches `GlobalFilter`s through the Reactor context
  (`ReactiveSecurityContextHolder.getContext()`), not a `ThreadLocal`.
- Responses written in stage 1 (a 401 from Security, a rejection by your own `WebFilter`) skip
  stage 2 entirely, including the gateway's CORS handling ([below](#cors-with-a-security-chain)).

## Call the rest of the chain once

`chain.filter(exchange)` returns `Mono<Void>`. It never emits a value: it **completes empty** (or with an error).
The gateway's `DefaultGatewayFilterChain.filter` is a `Mono.defer`, so building the `Mono` runs
nothing and **each subscription runs every remaining filter again**.

```kotlin
// Wrong: flatMap { chain.filter(...) } completes empty, so switchIfEmpty fires after every
// authenticated request and runs the remaining filters a second time.
ReactiveSecurityContextHolder.getContext()
    .mapNotNull { it.authentication as? JwtAuthenticationToken }
    .flatMap { auth -> chain.filter(withUserHeader(exchange, auth.name)) }
    .switchIfEmpty(chain.filter(exchange))

// Right: choose the exchange first, subscribe to the chain once.
ReactiveSecurityContextHolder.getContext()
    .mapNotNull { it.authentication as? JwtAuthenticationToken }
    .map { auth -> withUserHeader(exchange, auth.name) }
    .defaultIfEmpty(exchange)
    .flatMap { chain.filter(it) }
```

- The second run is easy to miss. The routing filter skips a request already marked as routed, so
  the backend still sees one call, while every remaining filter up to the routing filter (rate limits,
  logging, metrics) runs twice.
- If a filter fails during the duplicate pass, after the response is committed, the server closes
  the connection once the response is written. The request itself still gets its status; the *next*
  request on that keep-alive connection can fail with "Connection prematurely closed BEFORE response"
  or "Connection reset by peer" (5 and 7 of 30 back-to-back requests, depending on where the failing
  filter sits).
- The same applies to `.then(chain.filter(...))` after another `chain.filter`, and to any
  `Mono<Void>` followed by `switchIfEmpty`/`defaultIfEmpty` that expects a value.
- **Add response headers in `exchange.response.beforeCommit { }`**, registered before
  `chain.filter`. Code in `chain.filter(exchange).then { ... }` runs after the body was written when
  the filter is ordered before `NettyWriteResponseFilter` (`-1`): the headers are read-only by then,
  `add` throws `UnsupportedOperationException`, the client still gets the response without the header,
  and the server closes the keep-alive connection. At order `0` and later the same code still works,
  which is why it breaks only after a reorder. Stub chains never commit, so unit specs pass either way.

## Coroutine filters: keep the downstream call outside timeouts and catches

Filters written as `mono { ... }.then()` usually suspend on `chain.filter(exchange).awaitSingleOrNull()`.
That await lasts until the backend's response has been written to the client, so anything wrapped
around it bounds the whole proxied request:

| Wrapped around `chain.filter` | Effect (measured through a real gateway, backend answering after 1.5 s) |
|---|---|
| `withTimeout(1000)` meant for a pre-check | The backend call is cancelled at 1 s; nothing has been written yet, so the client gets the error handler's **500** |
| Plus a `catch (e: Exception)` that calls `chain.filter` again as a fallback | The remaining chain runs a second time; the routing filter skips the already-routed request, so the client gets **200 with an empty body** |
| Plus a fallback that writes an error response (e.g. 429) | A slow but healthy backend is answered with that error |

Compute the decision under the deadline, then act outside it:

```kotlin
override fun filter(exchange: ServerWebExchange, chain: GatewayFilterChain): Mono<Void> =
    mono {
        val allowed =
            try {
                withTimeout(checkTimeoutMs) { checks.isAllowed(exchange) }
            } catch (e: TimeoutCancellationException) {
                failOpen // the operator's stance for a check that could not finish
            } catch (e: CancellationException) {
                currentCoroutineContext().ensureActive() // exchange cancelled (client gone): propagate
                failOpen // a library's CancellationException while the request is live: a failed check
            } catch (e: Exception) {
                failOpen
            }
        if (allowed) {
            chain.filter(exchange).awaitSingleOrNull()
        } else {
            reject(exchange) // a suspend fun that sets the status and awaits the write
        }
    }.then()
```

- `TimeoutCancellationException` is a `CancellationException`; catch it first. Another
  `CancellationException` usually means the request itself is gone (the client disconnected):
  handling it as a failed check runs the failure handling (logging, counters) for a request that is
  gone and, without `ensureActive()`, subscribes to the downstream chain from the cancelled coroutine.
  A blanket `throw e` overshoots the other way: a `CancellationException` raised as an error while the
  request is live (an awaited future that was cancelled) then turns into a 500 instead of following
  the failure stance.
- Await everything inside `mono { }`. If `reject` returned a `Mono` instead of suspending, the `if`
  would widen to `Any?`, `mono { }` would emit that `Mono` as its value and `.then()` would drop it:
  the status is set, the body is never written, and nothing warns.
- A bare `mono { }` starts on `Dispatchers.Default`, so each request hops off the Netty event loop and
  the rest of the chain is subscribed from that pool. `mono(Dispatchers.Unconfined) { }` stays on the
  calling thread (Spring runs suspend handler methods the same way); use it only when the body never
  blocks ([coroutines](coroutines.md#dispatchers-and-blocking-code)).
- `runCatching { suspendCall() }` inside the checks has the same problem: it turns the deadline's
  cancellation into a `Result.failure` and runs the failure branch (logging, fallback counters) after
  the deadline already decided. On a `CancellationException` failure, call
  `currentCoroutineContext().ensureActive()` before handling it ([coroutines](coroutines.md#cancellation)).
- Backend timeouts belong to the gateway's HTTP client (`spring.cloud.gateway.server.webflux.httpclient.*`,
  per-route `response-timeout` metadata) and to circuit-breaker time limiters, not to a filter.

## Gateway defaults that fail quietly

Gateway Server WebFlux 5.0, measured over real sockets:

| Setting | Default behaviour |
|---|---|
| Property prefix | Only `spring.cloud.gateway.server.webflux.*` is bound. Routes, `globalcors` or `httpclient` under the old `spring.cloud.gateway.*` are ignored without a warning: no routes, every request 404 |
| `CircuitBreaker` route filter (Resilience4j) | Adds a **1 s** time limiter: a slower backend gets **504** at about 1 s and the backend call is cancelled. Raise it per breaker: `resilience4j.timelimiter.instances.<name>.timeout-duration` |
| `httpclient.response-timeout` | Unset: no gateway-level timeout at all (a 10 s backend still answered 200). Set it, globally or per route (`response-timeout` metadata) |
| `trusted-proxies` | Unset: the backend receives **no** `X-Forwarded-*`/`Forwarded` headers, and client-sent ones are stripped. Set to a regex matching the immediate peer: the gateway adds them **and keeps whatever the client sent**, appending to it (`X-Forwarded-For: <client value>,<peer>`). Use a narrow regex, and do not let backends trust the leftmost entry |

The starter is `spring-cloud-starter-gateway-server-webflux`; the client IP for per-IP limits comes
from a `RemoteAddressResolver` such as `XForwardedRemoteAddressResolver.maxTrustedIndex(n)`, which
counts trusted hops from the right.

## Raw and decoded paths

| Accessor | Value for `POST /v1/auth/%6Cogin` |
|---|---|
| `exchange.request.path.pathWithinApplication().value()`, `request.uri.rawPath` | `/v1/auth/%6Cogin` (raw) |
| `PathPattern` matching: Security `pathMatchers`, the gateway `Path=` predicate | segments decoded: matches `/v1/auth/login` |
| Path sent to the backend by the routing filter | raw, as received |

With Spring Security in the chain, its default `StrictServerWebExchangeFirewall` rejects any `;`
with 400 before the matchers, so `;` path parameters reach later filters only when semicolons are
allowed (a `ServerWebExchangeFirewall` bean with `setAllowSemicolon(true)`) or there is no security
chain; `PathPattern` matching then drops them too.

A filter that compares the raw string with a configured path (`path in loginPaths`) disagrees with
the matchers. In the measured case `POST /v1/auth/%6Cogin` passed Security's `permitAll` for the
login route and was forwarded unchanged. A check that compares the raw string, such as a login rate
limit keyed on the path, does not match it, and each encoding variant gets its own key. A backend
that percent-decodes before routing would serve it as the login endpoint (not run here).

Match with the framework's own matcher:
`PathPatternParser.defaultInstance.parse(pattern).matches(request.path.pathWithinApplication())`.
For a key or a counter, build the value from the same decoded segments:

```kotlin
fun normalizedPath(request: ServerHttpRequest): String =
    request.path.pathWithinApplication().elements().joinToString("") { element ->
        if (element is PathContainer.PathSegment) element.valueToMatch() else element.value()
    }
```

It joins decoded segments, so an encoded slash (`%2F`) becomes `/` here while `PathPattern` keeps it
inside one segment; Security's default firewall rejects `%2F`, so this differs only where encoded
slashes are allowed. Keep the raw path for audit logs.

## CORS with a security chain

The gateway applies `spring.cloud.gateway.server.webflux.globalcors` in `RoutePredicateHandlerMapping`
(stage 2). A response written by Spring Security in stage 1 carries no CORS headers, so a browser
client cannot read a 401 and reports a CORS error instead (an expired token looks like a network
failure). Preflights are not affected as long as Security lets `OPTIONS` through: they reach stage 2
and get the gateway's CORS answer.

Apply the same configuration in the security chain, which runs its CORS filter before
authentication:

```kotlin
@Bean
fun securityWebFilterChain(http: ServerHttpSecurity, globalCors: GlobalCorsProperties): SecurityWebFilterChain =
    http {
        cors {
            configurationSource =
                UrlBasedCorsConfigurationSource().apply { setCorsConfigurations(globalCors.corsConfigurations) }
        }
        authorizeExchange { authorize(anyExchange, authenticated) }
        oauth2ResourceServer { jwt { } }
    }
```

- `http { }` needs `import org.springframework.security.config.web.server.invoke` (the reactive DSL;
  the servlet one is in `...annotation.web`). The source type is
  `org.springframework.web.cors.reactive.CorsConfigurationSource`, not the servlet `web.cors` one.
- Routed responses still carry one `Access-Control-Allow-Origin`: `DefaultCorsProcessor` skips a
  response that already has one.
- A disallowed origin is now rejected with 403 by the security chain before authentication.
- Only the global configurations are copied, at startup. Per-route `cors` metadata, or a refresh that
  changes `globalcors`, is not reflected in the security chain.

## Reactive security defaults and JWT

Measured on Spring Security 7.1.0 with `oauth2ResourceServer { jwt { } }`:

- **CSRF is on unless you disable it.** Requests that carry a bearer token skip it, so authenticated
  calls work, but a token-less `POST` to a `permitAll` route (login, token refresh, a webhook) gets
  **403** `text/plain` "Access Denied" before it reaches the route. A stateless bearer-token gateway
  sets `csrf { disable() }`.
- **`permitAll` does not shield a route from a bad bearer token.** The bearer filter runs before
  authorization: an expired or unreadable `Authorization: Bearer ...` on a `permitAll` route gets
  **401** `invalid_token`. Only a request without a bearer token passes. Clients must not attach a
  stale token to login or refresh calls (or give those paths a chain without `oauth2ResourceServer`).
- **A decoder you build yourself checks neither `iss` nor `aud`.** Besides the signature, its default
  validator (`JwtValidators.createDefault()`, Security 7.1.0, from source) checks only `exp`/`nbf`
  (60 s clock skew), a `typ` header of `JWT` or none, and the client-certificate thumbprint of a token
  bound with `cnf.x5t#S256`.
  `NimbusReactiveJwtDecoder.withJwkSetUri(...).build()` accepted a wrong and a missing `aud` (200),
  and `spring.security.oauth2.resourceserver.jwt.audiences`/`issuer-uri` configure only Boot's own
  decoder bean, never yours. Set the validators on each decoder:
  `decoder.setJwtValidator(DelegatingOAuth2TokenValidator(JwtValidators.createDefaultWithIssuer(issuer), JwtClaimValidator<List<String>>(JwtClaimNames.AUD) { aud -> expectedAudience in aud }))`
  (wrong or missing `aud` then 401 "The aud claim is not valid"). The audience advice in
  [security](security.md#jwt-resource-server) applies the same way.

- **Several issuers:** `JwtIssuerReactiveAuthenticationManagerResolver.fromTrustedIssuers(...)` builds
  each decoder with `ReactiveJwtDecoders.fromIssuerLocation`, which requires OIDC discovery at
  `{issuer}/.well-known/openid-configuration`. A JWK-set-only issuer then fails with 500 (an
  `IllegalArgumentException`, not 401), and every token retries discovery because the failure is not
  cached. For backends that publish only a JWK set, use the
  constructor with your own lookup (an allowlist map from `iss` to a
  `JwtReactiveAuthenticationManager` built with `NimbusReactiveJwtDecoder.withJwkSetUri(...)`).
  An unknown issuer then yields an empty `Mono` and a 401. Each manager's decoder needs its own
  validators (above).
- **JWK fetch timeouts:** without `.webClient(...)` the decoder uses `WebClient.create()`, which has no
  response timeout (a JWK endpoint that never answered was still pending after 15 s). Pass a
  `WebClient` built from the injected `WebClient.Builder` with a `ReactorClientHttpConnector` whose
  `HttpClient` sets a connect timeout and a `responseTimeout` ([http-clients](http-clients.md)).
- **Unknown `kid` refetches every time** (Spring Security 7.1.0: 5 tokens with random `kid`s made 5
  JWK-set requests; `ReactiveRemoteJWKSource.get` re-downloads the set whenever the cached one has no
  matching key, with no cooldown). Tokens carrying a valid `iss` and random `kid`s make one JWK-set request each,
  and a rate limiter written as a `GlobalFilter` never sees them (they fail in stage 1). Limit before
  authentication (a `WebFilter` ordered before `-100`) or supply a JWK source with a refresh cooldown
  (`NimbusReactiveJwtDecoder.withJwkSource`) where that matters.

## Testing the real chain

Unit specs that construct one filter and stub `GatewayFilterChain` cannot see the defects above.

- **Count subscriptions, not calls.** A stub that counts calls to `filter(...)` misses a Mono that is
  built once and subscribed twice (a reused `val`, a `retry`, a fallback that resubscribes). Model
  the real chain:

```kotlin
class CountingChain(private val downstream: () -> Mono<Void> = { Mono.empty() }) : GatewayFilterChain {
    val runs = AtomicInteger()

    override fun filter(exchange: ServerWebExchange): Mono<Void> =
        Mono.defer {
            runs.incrementAndGet()
            downstream()
        }
}
```

- **Test the authenticated branch without a context** by writing the authentication into the
  Reactor context:
  `filter.filter(exchange, chain).contextWrite(ReactiveSecurityContextHolder.withAuthentication(JwtAuthenticationToken(jwt, emptyList())))`.
  The two-argument `JwtAuthenticationToken` constructor marks the token authenticated.
- **One spec through the real chain**, with a backend stub on a real socket. Slow and failing
  backends, duplicate runs and CORS on 401 only show up here. The application's security chain must
  let `/api/**` through: with the security starters and no chain of your own, Boot's default
  security answers 401.

```kotlin
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class GatewayChainSpec : BehaviorSpec() {
    @LocalServerPort
    private var port: Int = 0

    init {
        extensions(SpringExtension())
        afterSpec { backend.disposeNow() }

        given("a backend slower than the filter's check deadline") {
            then("the client still gets the full response") {
                val result =
                    WebTestClient.bindToServer().baseUrl("http://localhost:$port")
                        .responseTimeout(Duration.ofSeconds(10)).build()
                        .get().uri("/api/slow").exchange().returnResult(String::class.java)
                result.status shouldBe HttpStatus.OK
                result.responseBody.collectList().awaitSingle().joinToString("") shouldBe "done"
            }
        }
    }

    companion object {
        private val backend: DisposableServer =
            HttpServer.create().host("127.0.0.1").port(0).route { routes ->
                routes.get("/api/slow") { _, response ->
                    response.sendString(Mono.delay(Duration.ofMillis(1500)).map { "done" })
                }
            }.bindNow()

        @JvmStatic
        @DynamicPropertySource
        fun route(registry: DynamicPropertyRegistry) {
            registry.add("spring.cloud.gateway.server.webflux.routes[0].id") { "stub" }
            registry.add("spring.cloud.gateway.server.webflux.routes[0].uri") { "http://127.0.0.1:${backend.port()}" }
            registry.add("spring.cloud.gateway.server.webflux.routes[0].predicates[0]") { "Path=/api/**" }
        }
    }
}
```

- **Keep each list element in one property source.** Boot binds an indexed list from the
  highest-precedence source that has any element of it. With `issuers[0].issuer` in
  `@SpringBootTest(properties = ...)` and `issuers[0].jwks-uri` in a `@DynamicPropertySource`, the
  bound element had only `jwks-uri`, and an `issuers[1]` set only in the annotation was dropped: the
  whole list came from the dynamic source. Put the whole list in one source.
- Class-annotation arguments do not see companion members by simple name:
  `@SpringBootTest(properties = ["x=$C"])` with `C` in the spec's companion is an unresolved
  reference, private or not. Qualify it (`GatewayChainSpec.C`) or declare the const at top level.
- Kotest 6: `override fun extensions()` does not compile (it is final); call `extensions(...)` in
  `init`, or use `@ApplyExtension` ([testing](testing.md#kotest-specs-with-spring)).
- Give each case its own client identity (for example its own `X-Forwarded-For` when the
  `RemoteAddressResolver` trusts it) so per-IP limits in one spec do not leak between cases.

## Gotchas

- Agent orders a `GlobalFilter` at `-200` "before Spring Security" - order numbers do not cross from the gateway chain to `WebFilter`s; Security always runs first.
- Agent puts `switchIfEmpty(chain.filter(exchange))` after a branch that already called `chain.filter` - `Mono<Void>` never emits a value, so the remaining filters run twice.
- Agent wraps `chain.filter(...).awaitSingleOrNull()` in `withTimeout` meant for a pre-check - every slower backend response is cut off: a 500, or an empty 200 when a catch-all fallback re-runs the chain.
- Agent's fallback calls `chain.filter` again from `catch (e: Exception)` - backend errors and timeouts re-run the chain, and cancellation is caught too.
- Agent compares `pathWithinApplication().value()` with a configured path - percent-encoded variants pass the matchers and reach the backend but skip the check.
- Agent configures `globalcors` and expects CORS on Security's 401 - stage 1 responses never reach the gateway's CORS handling; add `cors { }` to the security chain.
- Agent imports `org.springframework.security.config.annotation.web.invoke` in a WebFlux app - that is the servlet DSL; use `org.springframework.security.config.web.server.invoke`.
- Agent uses `fromTrustedIssuers` with JWK-set-only issuers - it requires OIDC discovery; build the managers with the constructor.
- Agent puts `@Order` on the `@Bean` method of a lambda `GlobalFilter` - the gateway ignores it and runs the filter last, just before routing.
- Agent adds response headers in `chain.filter(exchange).then { }` - before `NettyWriteResponseFilter` the response is already committed; use `beforeCommit`.
- Agent copies routes or CORS under `spring.cloud.gateway.*` from older docs - Gateway 5.0 binds only `spring.cloud.gateway.server.webflux.*`; the old keys are ignored silently.
- Agent adds the `CircuitBreaker` route filter without a time limiter setting - every backend slower than 1 s gets 504.
- Agent sets `trusted-proxies: ".*"` - client-sent `X-Forwarded-*` values are kept and appended, so the leftmost entry is attacker-controlled.
- Agent leaves CSRF on in a bearer-token gateway - token-less POSTs to `permitAll` routes (login) get 403.
- Agent builds per-issuer decoders with `withJwkSetUri(...).build()` and relies on `audiences` - hand-built decoders check neither `iss` nor `aud`; set the validators.
- Agent relies on a `GlobalFilter` rate limiter to protect JWT verification - requests with unknown `kid`s fail before it and each one refetches the JWK set.
- Agent returns a `Mono` from inside `mono { }` instead of awaiting it - `.then()` drops the value, so that `Mono` is never subscribed and its body is never written.
- Agent stubs `GatewayFilterChain` with a counter on calls - a Mono built once and subscribed twice counts once; count inside `Mono.defer`.
- Agent splits one list element between `@SpringBootTest(properties)` and `@DynamicPropertySource` - the list binds from one source and the element loses fields.

## Official sources

- [Spring Cloud Gateway reference](https://docs.spring.io/spring-cloud-gateway/reference/)
- [Spring Security reactive resource server](https://docs.spring.io/spring-security/reference/reactive/oauth2/resource-server/jwt.html)
- [Spring Security reactive CORS](https://docs.spring.io/spring-security/reference/reactive/integrations/cors.html)
- [Spring Framework: WebFlux request mapping (URI patterns)](https://docs.spring.io/spring-framework/reference/web/webflux/controller/ann-requestmapping.html)
