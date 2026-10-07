# Coroutines in Spring services

Spring Framework 7 supports Kotlin coroutines in WebFlux, in Spring MVC controllers, in
`@Scheduled`, and in Spring Data repositories for **reactive** stores (`CoroutineCrudRepository` on
R2DBC, reactive MongoDB, ...). Adding `suspend` to a JPA repository method does not make persistence
non-blocking; JPA stays blocking. Supporting them does not make them the right
default. Decide the concurrency model first, then follow the rules for that model.

Contents: [Choose the concurrency model](#choose-the-concurrency-model) ·
[Structured concurrency](#structured-concurrency) · [Cancellation](#cancellation) ·
[Dispatchers and blocking code](#dispatchers-and-blocking-code) ·
[Spring integration](#spring-integration) · [Flow and channels](#flow-and-channels) ·
[Testing](#testing) · [Gotchas](#gotchas)

## Choose the concurrency model

| Model | Use when | Cost |
|---|---|---|
| **Spring MVC + virtual threads** (`spring.threads.virtual.enabled=true`, JDK 21+) | Blocking stack (JPA/JDBC, blocking HTTP clients) that needs high request concurrency | Blocking code stays blocking and readable; limits move to pools (DB connections) |
| Spring MVC + platform threads | Moderate concurrency, blocking stack | Thread pool size limits concurrency |
| Coroutines on WebFlux (+ R2DBC / reactive clients) | End-to-end non-blocking stack, streaming, many concurrent slow I/O calls | Every dependency must be non-blocking; blocking calls must be isolated |
| Coroutines inside an MVC app | Fan-out of several independent remote calls in one request, structured timeouts/cancellation | Two models in one codebase; JPA stays blocking |

- Follow the project's existing model. Do not introduce coroutines into a blocking MVC + JPA service
  "for performance". With virtual threads, blocking code already scales on I/O.
- Virtual threads: prefer JDK 24+. On JDK 21–23, blocking inside `synchronized` pins the carrier
  thread, including monitors held inside libraries (drivers, loggers). JEP 491 removed monitor
  pinning in JDK 24; blocking in native frames still pins. With many cheap threads, the bottleneck
  moves to whatever is actually finite: often the connection pool, but also lock contention, CPU, or a
  downstream service. Bound concurrency deliberately (semaphore, bulkhead) instead of relying on
  thread counts.
- `spring.threads.virtual.enabled=true` also switches Boot's scheduler and `@Async` executor:
  `spring.task.scheduling.pool.size` stops applying and all `fixedDelay` jobs share one thread
  ([scheduling-executors](scheduling-executors.md#which-scheduler-runs-scheduled)).
- Mixing coroutines and virtual threads is possible (`Executors.newVirtualThreadPerTaskExecutor()
  .asCoroutineDispatcher()` for blocking calls) but adds a second model. Use it only with a reason.

## Structured concurrency

```kotlin
@Service
class QuoteService(private val webClient: WebClient) {
    suspend fun quote(sku: String): Quote = coroutineScope {
        val price = async { webClient.get().uri("/prices/{sku}", sku).retrieve().awaitBody<Price>() }
        val available = async { webClient.get().uri("/stock/{sku}", sku).retrieve().awaitBody<Stock>() }
        Quote(sku, price.await(), available.await())
    }
}
```

The calls run concurrently only because `awaitBody` really suspends. `async { blockingClient.call() }`
inherits the caller's dispatcher; with a blocking client (`RestClient`, JDBC) the two calls can run
one after the other, or block the caller's thread. `RestClient`'s Kotlin extensions are
convenience helpers, not suspend adapters. Offload blocking calls explicitly
(`async(Dispatchers.IO) { ... }`) or use a non-blocking client.

- Start child coroutines inside `coroutineScope { }`. The function returns only when all children
  finish; a failing child cancels its siblings and the scope rethrows the failure.
- In `supervisorScope { }` a failing **child** does not cancel its siblings. But an exception that
  escapes the scope's own body (for example rethrown by `await()` of a failed `async`) still cancels
  everything. Handle each `await()` where partial results are acceptable.
- `CoroutineExceptionHandler` only sees uncaught failures of `launch`ed coroutines (root or directly
  under a supervisor). It does not handle `async` failures (those surface at `await()`) and cannot
  resume or retry anything; it is a last-resort logger.
- **Never `GlobalScope`.** Work launched there outlives the request and the application context,
  has no owner for failures, and is not cancelled on shutdown.
- Fire-and-forget background work belongs to a scope owned by a bean with a lifecycle:

```kotlin
@Component
class BackgroundJobs : DisposableBean {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineName("background-jobs"))
    fun submit(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)
    override fun destroy() = scope.cancel()
}
```

  Catch inside the launched block, and add a `CoroutineExceptionHandler` to the scope for anything
  that still escapes. Uncaught exceptions in `launch` go to the handler, not to any caller. For work that must survive a crash, use a durable
  mechanism (outbox, job table) instead.
- Do not break the parent-child chain by passing `Job()` or `SupervisorJob()` into `launch`/`async`
  (`scope.launch(Job()) { }`). That child no longer cancels with its parent.
- `async` is for values you `await`. For side effects, use `launch`.

## Cancellation

- Cancellation is cooperative and signalled by `CancellationException`. **Do not swallow it.**
  - `catch (e: Exception)` around suspend calls catches it. Rethrow `CancellationException` first,
    or catch narrower exception types.
  - `runCatching { suspendCall() }` also catches it and turns cancellation into a `Result.failure`.
    Avoid `runCatching` around suspend calls, or rethrow when the failure is a `CancellationException`.
- Timeouts: `withTimeout` throws `TimeoutCancellationException` (a `CancellationException`), which
  cancels the block. `withTimeoutOrNull` returns `null`. Set explicit timeouts on remote calls too; a
  coroutine timeout does not close a blocking socket.
- CPU loops should call `ensureActive()` or `yield()` so cancellation can take effect.
- Cleanup that must run after cancellation goes in `finally`. Wrap suspending cleanup in
  `withContext(NonCancellable) { }`, and only cleanup. Keep it bounded: code there cannot be cancelled,
  so put a `withTimeout` **inside** the `NonCancellable` block. Never `launch(NonCancellable) { }`; that
  detaches the coroutine from its parent.

## Dispatchers and blocking code

- Blocking calls (JPA, JDBC, blocking HTTP clients, file I/O) inside coroutines run on a blocking-capable
  context: `withContext(Dispatchers.IO) { ... }`, a view of it, or a virtual-thread dispatcher. Keep
  each imperative transaction inside **one** such blocking call.
- `Dispatchers.IO` defaults to max(64, CPU count) threads. `Dispatchers.IO.limitedParallelism(n)` is a
  **view** on the same threads that caps how many of its tasks run at once; it is not a separate pool,
  and several views can together exceed IO's limit. Create one view per resource and reuse it (not
  one per call). It limits running threads, not operations that are suspended in between; to bound
  work that suspends across calls (for example requests holding a DB connection), use a `Semaphore`.
- `Dispatchers.Default` is for CPU work, sized to the CPU count. Blocking it starves every other
  coroutine that uses it.
- On WebFlux, a blocking call on the event loop stalls every request served by that loop. Treat any
  blocking call in a WebFlux coroutine path as a bug unless it is offloaded to a blocking-capable
  dispatcher.
- `runBlocking` inside request handling, a listener, or another coroutine blocks a thread and can
  deadlock limited pools. Use it only in `main`, scripts, and tests (tests prefer `runTest`).
- Transactions: JPA transactions are thread-bound and do not cover suspending code
  ([transactions](transactions.md#coroutines)). Keep `@Transactional` JPA methods blocking and call
  them inside a blocking-capable context (`withContext(Dispatchers.IO) { }` or equivalent). With R2DBC, use `TransactionalOperator.executeAndAwait`.

## Spring integration

- **MVC controllers** may be `suspend fun`. Spring bridges them through Reactor, so
  `kotlinx-coroutines-reactor` (and Reactor) must be on the classpath. Without it the application
  starts and every call fails (`NoClassDefFoundError: org/reactivestreams/Publisher`). The request is
  handled asynchronously: without context propagation, `ThreadLocal`-based state set by filters (MDC,
  security context, request attributes) is gone after the first suspension (the coroutine resumes on
  another thread; verified with Boot defaults). In
  MockMvc tests, the first `perform` only starts the async request; assert on
  `mockMvc.perform(asyncDispatch(result))`.
- **Context propagation:** Spring Framework 7 provides `PropagationContextElement`
  (`org.springframework.core`). Adding it to the coroutine context restores the `ThreadLocal`
  values that have a `ThreadLocalAccessor` registered with Micrometer's `ContextRegistry` when the
  coroutine resumes: `withContext(PropagationContextElement()) { ... }`. **Registration is not
  automatic for MDC**: without `ContextRegistry.getInstance().registerThreadLocalAccessor(Slf4jThreadLocalAccessor())`
  (from `io.micrometer:context-propagation`), MDC silently stays empty. Tracing libraries register
  their own accessors.
- **Automatic propagation** for suspend controllers: set `spring.reactor.context-propagation=auto`
  (default `limited`). The property lives in the separate `spring-boot-reactor` module, which
  `spring-boot-starter-webmvc` does **not** bring in; without that module the property is silently
  ignored. With it, Boot enables Reactor's automatic propagation (a JVM-global hook) and Spring adds
  `PropagationContextElement` to controller coroutines; registered accessors still decide what is
  restored (verified on 4.1.1: MDC survives `delay` only with module + property + accessor). Because
  the hook is JVM-global, one test context that enables it changes the behavior of later tests in
  the same JVM.
- For MDC alone, `kotlinx-coroutines-slf4j`'s `MDCContext()` works without any registration. It is a
  **snapshot** taken when the element is created: `MDC.put` inside the coroutine is lost after the
  next suspension unless you wrap the rest in a new `withContext(MDCContext()) { }` **immediately,
  before any suspension**. After a resume, the outer element has already restored its old snapshot. Copying MDC does
  not propagate the active tracing span/observation; that needs the tracing accessors.
- **Security context:** do not read `SecurityContextHolder` after a suspension point in MVC unless
  the context is propagated. Resolve the principal at the start of the handler and pass it along.
- **`@Scheduled`** supports `suspend fun` only with the Reactor bridge on the classpath. Without it the
  **application fails to start** ("Only no-arg methods may be annotated with @Scheduled", because
  the compiled method takes a `Continuation`). Each run is a new coroutine.
- **`@KafkaListener`** `suspend fun` needs `reactor-core` and `kotlinx-coroutines-reactor`; without
  them the container stops ([messaging-outbox](messaging-outbox.md#consuming)).
- **`@Async`** does not accept `suspend` functions: the context starts, and each call fails with
  "Invalid return type for async method (only Future and void supported)". Use a bean-owned scope
  instead (above).
- **`Flow` return types** are supported by WebFlux, and by MVC only with the Reactor bridge. In MVC,
  a `Flow` is **streamed** only for streaming media types (Server-Sent Events, NDJSON, or a text
  stream); for a normal JSON response it is collected into a JSON array first, so an infinite `Flow`
  never completes the response (verified: no bytes written while the flow runs). A `Flow<String>`
  is written by the string converter instead of Jackson, so test with the real element type. **Without the bridge, an MVC handler returning `Flow` does not fail**:
  Jackson serializes the `Flow` object itself and the client gets `200` with `{}`.
- Proxy-based advice on `suspend` functions is feature-specific. Check the feature's documented
  coroutine support before relying on `@Transactional`, `@Cacheable`, or `@Retryable` there.

## Flow and channels

- `flow { }` builds a **cold** flow: nothing runs until it is collected, and each collector runs it
  again. Use `flowOn(Dispatchers.IO)` to move **upstream** work to another dispatcher.
- Context preservation: do not `emit` from a different context than the collector's.
  `flow { withContext(Dispatchers.IO) { emit(x) } }` throws "Flow invariant is violated".
  `flow { val x = withContext(Dispatchers.IO) { load() }; emit(x) }` is fine, because the `emit`
  happens outside `withContext`.
- Hot flows have different contracts:
  - `StateFlow` always has a value, conflates by equality (subscribers may miss intermediate values),
    and never suspends the emitter.
  - `SharedFlow` (default `replay = 0`, no buffer) suspends the emitter while subscribers are slow, and
    **drops** emissions when there are no subscribers.
- `catch { }` in a flow handles only upstream exceptions, and it does not swallow cancellation
  (unlike a blanket `catch (e: Exception)`). Exceptions in the collector are not caught there.

## Testing

- Use `runTest` (kotlinx-coroutines-test) for suspend code: virtual time makes `delay` instant, and
  uncaught child failures fail the test.
- Inject dispatchers (or a `CoroutineDispatcher` bean) so tests can substitute
  `StandardTestDispatcher`. Hard-coded `Dispatchers.IO` escapes virtual time.
- MockK: `coEvery`/`coVerify` for suspend functions ([testing](testing.md#mockk)).
- Test cancellation and timeouts explicitly: cancel the calling job and assert cleanup ran, and assert
  that a timeout does not leave a child running.

## Gotchas

- Agent adds coroutines to a blocking MVC + JPA service for "performance" - virtual threads already cover blocking I/O.
- Agent launches in `GlobalScope` - use `coroutineScope` or a bean-owned scope cancelled on destroy.
- Agent wraps suspend calls in `runCatching` or `catch (e: Exception)` - cancellation is swallowed.
- Agent passes `Job()`/`SupervisorJob()` into `launch` - the child detaches from its parent.
- Agent calls JPA/JDBC from a coroutine without offloading to a blocking-capable dispatcher - it blocks `Default` or the event loop.
- Agent uses `async { restClient... }` for "parallel" calls - blocking clients run sequentially or block the caller; use a suspending client or offload.
- Agent returns an infinite `Flow` from an MVC JSON endpoint - it is collected into a list and never completes; use SSE/NDJSON.
- Agent creates `Dispatchers.IO.limitedParallelism(n)` per call - create one view per resource; it is not a separate pool.
- Agent uses `runBlocking` inside a request or listener - thread blocking and possible deadlock.
- Agent reads MDC or `SecurityContextHolder` after a suspension point - propagate the context or pass values explicitly.
- Agent writes a `suspend` controller, `@Scheduled`, or `@KafkaListener` without `kotlinx-coroutines-reactor` - controllers fail per request, `@Scheduled` stops the app from starting, listeners stop their container.
- Agent returns `Flow` from an MVC handler without the Reactor bridge - `200 {}`, no error.
- Agent adds `PropagationContextElement` and expects MDC to follow - register the MDC accessor, or use `MDCContext()`.
- Agent emits from inside `withContext` in `flow { }` - move `emit` outside or use `flowOn`.
- Agent hard-codes dispatchers - tests cannot control them.

## Official sources

- [Spring Framework: Coroutines](https://docs.spring.io/spring-framework/reference/languages/kotlin/coroutines.html)
- [Kotlin coroutines guide](https://kotlinlang.org/docs/coroutines-guide.html)
- [Spring Boot virtual threads](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html)
- [JEP 491: Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
