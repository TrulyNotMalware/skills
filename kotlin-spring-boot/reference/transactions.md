# Transactions in Kotlin + Spring

Declarative transactions work through proxies. Most Kotlin-specific failures come from what the
proxy cannot see: final members, self-calls, exception types that do not trigger rollback, and
threads that change under coroutines. API names below were checked against Spring Framework 7.0.

Contents: [Boundaries](#boundaries) · [Proxy rules in Kotlin](#proxy-rules-in-kotlin) ·
[Rollback rules](#rollback-rules) · [Propagation](#propagation) ·
[Optimistic locking and retry](#optimistic-locking-and-retry) ·
[After-commit side effects](#after-commit-side-effects) ·
[Programmatic transactions](#programmatic-transactions) · [Coroutines](#coroutines) ·
[Verification](#verification) · [Gotchas](#gotchas)

## Boundaries

```kotlin
@Service
@Transactional(readOnly = true)
class OrderService(
    private val orderRepository: OrderRepository,
    private val clock: Clock,
) {
    @Transactional
    fun submit(orderId: UUID): OrderResponse {
        val order = orderRepository.findByIdOrNull(orderId) ?: throw OrderNotFoundException(orderId)
        order.submit()
        return OrderResponse.from(order) // map inside the transaction; no lazy loads outside
    }

    fun find(orderId: UUID): OrderResponse? =
        orderRepository.findByIdOrNull(orderId)?.let(OrderResponse::from)
}
```

- Put the transaction on the application service method that owns the unit of work, not on the
  controller and not on every repository call.
- `readOnly = true` does not route to a replica by itself and is not an authorization mechanism. With
  JPA it **does** change behavior: Hibernate skips dirty-checking flushes (and PostgreSQL connections
  are set read-only). On a class annotated `@Transactional(readOnly = true)`, a new mutating method
  without its own `@Transactional` inherits read-only: entity changes relying on dirty checking are
  typically not flushed, while explicit modifying queries may still run or be rejected by the
  database. Every write method on such a class needs an explicit `@Transactional`.
- An inner `@Transactional` (default `REQUIRED`) **joins** an outer transaction and inherits its
  attributes. Annotating the inner method as writable does not lift an outer read-only transaction.
- Dirty checking saves managed entities at commit; calling `save()` on an already-managed entity is
  redundant but harmless. Follow the project's habit.
- A local transaction does not make HTTP calls, Kafka sends, or writes to another database atomic
  with the DB write. See [After-commit side effects](#after-commit-side-effects).
- Do not hold a transaction open across slow remote calls. Each in-flight call pins a pooled
  connection and any row locks. Read, call out, then open a short transaction to write the result.
- Do not catch an exception inside the transaction and return a success-shaped result. Either the
  transaction is already rollback-only (outer commit fails) or the partial writes commit.
- Constraint violations and optimistic-lock conflicts usually surface at flush or commit, not at
  the line that changed the entity. Handle them at the caller of the transactional method, or call
  `flush()` deliberately where the error must be caught.

## Proxy rules in Kotlin

- `kotlin("plugin.spring")` opens classes annotated with `@Transactional` or a Spring stereotype, and
  all their members. Without it, CGLIB cannot subclass the class and startup fails. Only the class
  annotation counts: a class with `@Transactional` on methods only, and no stereotype (registered
  through `@Bean`), stays `final`, and with Boot's default class-based proxying startup fails with
  `AopConfigException`
  ([kotlin-spring-basics](kotlin-spring-basics.md#explicit-and-conditional-registration)).
- A member explicitly marked `final` (or `private`) in an opened class is not advised. The annotation
  is silently ignored.
- **Self-invocation bypasses the proxy.** `this.other()` or an unqualified call to another method of
  the same bean runs without that method's `@Transactional` or `@Retryable`. Move the method to
  another bean when it needs its own boundary.
- `internal` functions compile to public methods with mangled names. They are proxied, but calls from
  Java or reflection-based tooling are awkward. Keep transactional entry points `public`.

## Rollback rules

Spring's default: roll back on `RuntimeException` and `Error`, **commit** on checked exceptions.
Kotlin does not have checked exceptions, but the rule uses the Java type hierarchy:

```kotlin
@Transactional
fun import(file: Path) {
    repository.save(ImportJob(file.name))
    Files.readAllLines(file) // IOException is a checked type: the job row is COMMITTED
}
```

Choose one approach and apply it consistently:

1. Project-wide: `@EnableTransactionManagement(rollbackOn = RollbackOn.ALL_EXCEPTIONS)` on a
   configuration class (Spring Framework 6.2+). Boot's own transaction-management configuration then
   backs off, so also set `proxyTargetClass = true` (Boot's default) to keep class-based proxies for
   beans that implement interfaces.
2. Per method: `@Transactional(rollbackFor = [Exception::class])`.
3. Convention: domain exceptions extend `RuntimeException`, and I/O exceptions are wrapped at the
   boundary.

Check which approach the project already uses before adding a new one.

- Catching an exception thrown by an inner `REQUIRED` call does not undo the rollback-only mark.
  The outer commit then throws `UnexpectedRollbackException`.
- Never use `noRollbackFor` to survive an optimistic-lock failure. The persistence context is no
  longer usable; retry the whole unit in a new transaction.
- When the callback throws and the **rollback itself fails**, `TransactionTemplate.rollbackOnException`
  throws the rollback failure instead of the original (Framework 7.0.9). A `TransactionSystemException`
  still carries the original as `applicationException`, but `JpaTransactionManager.doRollback` first asks
  the JPA dialect, which turns a `PersistenceException` into a `DataAccessException` that only *logs* the
  original ("Application exception overridden by rollback exception"). A wrapper that turns exceptions
  into results must record the original in the callback and rethrow it when `execute` fails, or an
  `Error` from the action ends as a logged `Result.failure`. See
  [programmatic transactions](#programmatic-transactions) for the shape.

## Propagation

| Propagation | Use it for |
|---|---|
| `REQUIRED` (default) | Almost everything |
| `REQUIRES_NEW` | A record that must survive the caller's rollback (for example a failed-attempt log) |
| `MANDATORY` | Methods that must never start their own transaction (guards against misuse) |
| `NOT_SUPPORTED` | Long non-transactional work called from a transactional context |

`REQUIRES_NEW` suspends the outer transaction **while keeping its connection**. Each request then
holds two pooled connections. Under load, requests fill the pool with outer connections and wait
forever for their inner ones, so everything times out (reproduced 10/10 at pool-size concurrency).
Raising the pool size only moves the threshold. It also does not fix "inner committed, outer rolled
back". Prefer moving the independent write **after** the outer commit, or into its own top-level call.

Do not commit a success audit row in `REQUIRES_NEW`. If the outer transaction rolls back, the audit
claims something that never happened.

## Optimistic locking and retry

Use `@Version` (see [jpa-entities](jpa-entities.md)). A conflict surfaces at flush or commit as
`ObjectOptimisticLockingFailureException`. Retry the whole unit of work, with a fresh read, in a
new transaction:

```kotlin
@Configuration
@EnableResilientMethods
class ResilienceConfig

@Component
class OrderStatusFacade(private val orderService: OrderService) {
    @Retryable(includes = [ObjectOptimisticLockingFailureException::class], maxRetries = 3, delay = 50, jitter = 25)
    fun submit(orderId: UUID): OrderResponse = orderService.submit(orderId) // new transaction per attempt
}
```

- Spring Framework 7 ships retry in core (`org.springframework.resilience.annotation.Retryable`,
  `@EnableResilientMethods`). Do not add `spring-retry` for new code. Keep an existing
  `spring-retry` integration unless the task is to migrate it.
- Every attempt needs a fresh transaction. Framework 7 registers retry advice **before** existing
  advisors, so `@Retryable` and `@Transactional` on the same externally called method works: each
  attempt opens a new transaction (verified on 7.0.9). A separate facade bean, as above, makes the
  boundary explicit and is the clearer choice when reviewing.
- Either way, the **caller** of the retrying method must not already hold a transaction. Each
  attempt would then join (`REQUIRED`) the caller's transaction, which is already rollback-only after
  the first failure.
- `maxRetries` counts retries **after** the first call: `maxRetries = 3` means up to 4 invocations.
  When `@Retryable` gives up, the caller receives the last original exception (not wrapped).
- Programmatic `RetryTemplate` (Framework 7) wraps the failure in `RetryException` when retries end,
  including exceptions that were never retryable. Inspect `cause` (or the suppressed exceptions)
  instead of catching the original type around `execute`.
- `RetryPolicy.Builder.includes(...)` and `excludes(...)` are matched against the **whole cause chain**
  (`ExceptionTypeFilter.match(throwable, true)`, Framework 7.0.9). `includes(Exception::class.java)` therefore
  also retries an `Error` whose cause is an `Exception` (`ExceptionInInitializerError`, a `LinkageError`
  built with a cause). Add `excludes(Error::class.java)` when an `Error` must never be retried; it then
  comes back after one attempt as `RetryException` with the `Error` as `cause`, and the earlier attempts
  sit as suppressed exceptions on the `RetryException`, lost unless the facade copies them onto what it
  rethrows. Narrowing the parameter type to `Class<out Exception>` does not cover this case.
- Retry only idempotent units. A unit that also sent an HTTP request or a message will send it again.
- Cap contention on hot paths with `@ConcurrencyLimit` (same package) instead of retry storms.

## After-commit side effects

```kotlin
@Transactional
fun submit(orderId: UUID) {
    val order = orderRepository.findByIdOrNull(orderId) ?: throw OrderNotFoundException(orderId)
    order.submit()
    events.publishEvent(OrderSubmitted(order.id!!))
}

@Component
class OrderNotifications(private val mailer: Mailer) {
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    fun on(event: OrderSubmitted) = mailer.sendConfirmation(event.orderId) // best effort only
}
```

- `AFTER_COMMIT` prevents sending on rollback. It does not make delivery durable: a crash or a
  failing listener loses the event. For required delivery, write an outbox row in the same
  transaction and publish it separately.
- An exception thrown from an `AFTER_COMMIT` `@TransactionalEventListener` does **not** reach the
  caller. These listeners run in the synchronization's `afterCompletion` callback, whose failures
  Spring catches and only logs (Framework 7.0.9). The failure is silent unless you record it: add
  metrics or alerting on the listener, or use an outbox. (Custom `TransactionSynchronization.afterCommit()`
  callbacks are different; do not generalize from one to the other.)
- Database writes inside an `AFTER_COMMIT` listener need a new transaction: annotate the listener
  `@Transactional(propagation = Propagation.REQUIRES_NEW)` (Framework 6.1+). Plain `@Transactional`
  on an `AFTER_COMMIT` listener is rejected at startup (a `BEFORE_COMMIT` listener accepts it).
- **A synchronous `AFTER_COMMIT` listener still holds the committed transaction's connection.**
  Spring runs these listeners in `afterCompletion`, before `cleanupAfterCompletion` releases the
  connection (Framework 7.0.9; custom `afterCommit()` callbacks run before the release too, from
  source). Observed on Boot 4.1.1 with `open-in-view` off and the service called directly: Hikari
  active stayed at 1 for the whole listener, with JPA defaults and with a plain JDBC transaction
  manager, so a slow call in the listener keeps a pooled connection and the request thread busy. A
  `REQUIRES_NEW` write in the listener takes a second connection (active 2). With a one-connection pool
  it timed out after `connection-timeout`, the error was only logged, and the write was lost. Move
  slow work off the thread or into an outbox: `@Async` on the listener (needs `@EnableAsync`; see
  [scheduling-executors](scheduling-executors.md#async-and-executor-beans)) let the caller return at
  once and released the connection. With `open-in-view` on, the request's `EntityManager` stays open,
  so the connection is held until the request ends either way (from source, not run).
  Spring configures Hibernate with `DELAYED_ACQUISITION_AND_HOLD`. Setting
  `spring.jpa.properties.hibernate.connection.handling_mode=DELAYED_ACQUISITION_AND_RELEASE_AFTER_TRANSACTION`
  released the connection before the listener (active 0), but Spring then stops preparing
  connections: a non-default `isolation` fails with `InvalidIsolationLevelException` (run), and
  `readOnly` no longer reaches the JDBC connection (from source). Do not use it as the fix.
- Without an active transaction the listener is skipped by default (`fallbackExecution = false`).
- **`@TransactionalEventListener` is transactional only where a `TransactionalEventListenerFactory`
  is registered.** Boot's transaction auto-configuration (`@EnableTransactionManagement`) does that; a
  hand-built `AnnotationConfigApplicationContext` with `registerBean` does not, and the annotated
  method then runs as a plain `@EventListener`: at publish time, inside the publishing transaction,
  and also when that transaction rolls back (Framework 7.0.9, observed in a spec that first passed
  for the wrong reason). Register the factory, or import `@EnableTransactionManagement`, before
  asserting after-commit behaviour there; see [testing](testing.md#transactions-time-and-concurrency-in-tests).
- An application-wide asynchronous `ApplicationEventMulticaster` (one given a task executor) makes
  every plain `@EventListener` run on the executor, outside the publisher's transaction.
  `@TransactionalEventListener`s are still invoked on the publishing thread (Framework 6.1+); `@Async`
  on one is what moves its work to another thread.
- `order.id!!` is safe only after the ID is generated. With `GenerationType.UUID` that happens on
  persist. Publish after `save()` for new entities.

## Programmatic transactions

Use `TransactionTemplate` when the boundary is dynamic or inside tests:

```kotlin
val saved = transactionTemplate.execute { orderRepository.save(order) }
transactionTemplate.executeWithoutResult { orderRepository.deleteById(id) }
```

- The result's nullability follows the lambda (Framework 7, JSpecify:
  `<T extends @Nullable Object> T execute(TransactionCallback<T>)` in spring-tx 7.0.9): a lambda that
  returns a non-null type gives a non-null `T`, and a `!!` or `?: default` after it is dead code that the
  compiler flags (Kotlin 2.4.10, seen as a warning in a `--rerun-tasks` build). A lambda that returns
  `T?` gives `T?`. On Framework 6 `execute` was `@Nullable` for every callback and `!!` was the norm, so
  copy the call shape from a project file compiled against the current version, not from older examples.
- A `Result`-returning wrapper around `execute` has to survive three paths: an `Exception` from the
  action (roll back, return a failure), an interrupt (restore the flag first), and an `Error`, which must
  propagate even when the rollback that follows it throws (see [rollback rules](#rollback-rules)):

  ```kotlin
  inline fun <T> TransactionTemplate.runInTx(crossinline action: () -> T): Result<T> {
      var escaped: Error? = null
      return try {
          execute<Result<T>> { status ->
              try {
                  Result.success(action())
              } catch (interrupted: InterruptedException) {
                  Thread.currentThread().interrupt()
                  status.setRollbackOnly()
                  Result.failure(interrupted)
              } catch (exception: Exception) {
                  status.setRollbackOnly()
                  Result.failure(exception)
              } catch (error: Error) {
                  escaped = error
                  throw error
              }
          }
      } catch (rollbackFailure: Exception) {
          val original = escaped ?: return Result.failure(rollbackFailure)
          original.addSuppressed(rollbackFailure)
          throw original
      }
  }
  ```

  Pin it with a mocked `PlatformTransactionManager` whose `rollback` throws, once with
  `TransactionSystemException` and once with a plain runtime exception: the action's `Error` must be the
  one that propagates, with the rollback failure as its suppressed exception.

## Coroutines

- With a JPA/JDBC (`PlatformTransactionManager`) setup, a thread-bound transaction does not reliably
  cover a `suspend fun` body. What happens depends on the classpath. Without
  `kotlinx-coroutines-reactor`, the compiled method returns at its first suspension and the
  transaction ends there. With it on the classpath, Spring adapts the call to a deferred publisher,
  and the imperative advice can finish before the body even runs. In both cases part of the work runs
  without the transaction, and no error is raised.
- Keep `@Transactional` JPA services blocking. Call them from coroutine code with
  `withContext(Dispatchers.IO) { orderService.submit(id) }` (or a virtual-thread executor), so the
  whole unit runs on one thread.
- The documented coroutine path is reactive: `TransactionalOperator.executeAndAwait { }` with a
  `ReactiveTransactionManager` (R2DBC).
- Other proxy advice on `suspend` functions behaves per feature, not uniformly. For example,
  Framework 7 caching has explicit handling for suspending functions, while `@Async` rejects them
  (their JVM return type is `Object`). Check the specific feature's documented coroutine support
  and test it before relying on it.

## Verification

Transaction behavior is invisible to unit tests that construct the service directly.

- Test through the Spring context, against the production database engine (Testcontainers).
- Assert committed state from a **new** transaction or connection, not from the same persistence
  context. A test-managed transaction that rolls back at the end hides after-commit behavior entirely.
- Cover: a checked-type exception, an inner rollback-only failure, an optimistic conflict at commit,
  and listener behavior on both commit and rollback.
- For concurrency tests, assert that the latch `await` returned `true`. On a slow CI, a timed-out
  await otherwise turns the test into a sequential one that still passes.

## Gotchas

- Agent throws `IOException` (or another checked-type exception) from a `@Transactional` method and
  expects rollback - it commits unless rollback rules say otherwise.
- Agent calls a `@Transactional`/`@Retryable` method on `this` - the proxy is bypassed.
- Agent calls a `@Retryable` method from inside an existing transaction - every attempt joins the
  caller's rollback-only transaction.
- Agent reads `maxRetries` as total attempts - it is retries after the first call.
- Agent adds a write method to a `@Transactional(readOnly = true)` class without its own
  `@Transactional` - dirty-checked changes are typically not flushed.
- Agent uses `REQUIRES_NEW` inside request handling - two connections per request; pool deadlock
  under load.
- Agent treats `AFTER_COMMIT` as reliable messaging - use an outbox.
- Agent makes a slow call (HTTP, mail) in a synchronous `AFTER_COMMIT` listener - the request's DB
  connection stays checked out until the listener returns.
- Agent marks a JPA service `suspend` with `@Transactional` - part of the body runs outside the
  transaction.
- Agent assumes an `AFTER_COMMIT` listener failure surfaces to the caller - it is only logged.
- Agent verifies transactional behavior in the same persistence context - first-level cache makes
  the assertion pass regardless.
- Agent writes `execute { … }!!` or `execute { … } ?: default` on Framework 7 - the result is already
  non-null for a non-null lambda; the compiler warns and readers look for a null path that does not exist.
- Agent asserts after-commit behaviour of a `@TransactionalEventListener` in a hand-built context
  without `TransactionalEventListenerFactory` - it ran as a plain listener inside the transaction.
- Agent turns every exception from `TransactionTemplate.execute` into a result - when the rollback itself
  fails, the wrapper sees the rollback failure and the action's exception (even an `Error`) is only logged.
- Agent retries with `includes(Exception::class.java)` and expects an `Error` to stop the retry - the policy
  matches the cause chain, so an `Error` with an `Exception` cause is retried.

## Official sources

- [Declarative transaction management](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative.html)
- [Transaction propagation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html)
- [Resilience features (Retryable, ConcurrencyLimit)](https://docs.spring.io/spring-framework/reference/core/resilience.html)
- [Transaction-bound events](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)
