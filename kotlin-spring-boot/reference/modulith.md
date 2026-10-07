# Spring Modulith in Kotlin

Module boundaries, verification, and module events with Spring Modulith 2.1 on Boot 4.1 (resolved
2026-09-29). Use this only when the project already uses Modulith or the task is to introduce it;
do not add it as a side effect of another change.

Contents: [Setup](#setup) ·
[Modules are packages, not Gradle modules](#modules-are-packages-not-gradle-modules) ·
[Verify the structure in CI](#verify-the-structure-in-ci) ·
[Events between modules](#events-between-modules) · [Gotchas](#gotchas)

## Setup

```kotlin
dependencies {
    implementation(platform("org.springframework.modulith:spring-modulith-bom:2.1.1"))
    implementation("org.springframework.modulith:spring-modulith-starter-core")
    implementation("org.springframework.modulith:spring-modulith-starter-jpa")   // persistent event publication registry (or -jdbc)
    testImplementation("org.springframework.modulith:spring-modulith-starter-test")
}
```

- Boot does not manage Modulith versions. Use the Modulith 2.x line for Boot 4; do not mix a Boot 3
  era Modulith 1.x BOM into a Boot 4 build. The official compatibility table can lag behind releases
  (as of 2026-09 it had no 2.1 row); 2.1.1 was verified here by running it on Boot 4.1.1 (it pulls the
  same Spring Framework 7.0.9). Check the resolved Spring Framework version when in doubt.

## Modules are packages, not Gradle modules

- With the default detection strategy, each **direct subpackage** of the application's main package is
  an application module (check `spring.modulith.detection-strategy`; `explicitly-annotated` or a
  custom strategy changes this)
  (`com.example.orders`, `com.example.billing`). Types in the module's base package are its API;
  subpackages (`com.example.orders.internal`) are hidden from other modules.
- Kotlin's `internal` modifier is scoped to the **Gradle** module, not to a package. It does not stop
  `billing` from using `orders.internal` when both live in the same Gradle module. Modulith's
  verification is what enforces the package boundary.
- Kotlin has no `package-info`. For package-level metadata (`@ApplicationModule`, `@NamedInterface`)
  put a type annotated with `@PackageInfo` in that package:

```kotlin
package com.example.orders.spi

@PackageInfo
@NamedInterface("spi")
class ModuleMetadata
```

```kotlin
package com.example.orders

@PackageInfo
@ApplicationModule(allowedDependencies = ["inventory", "shared::events"])
class ModuleMetadata
```

- Expose deliberately: a named interface (`@NamedInterface`) is a supported extra API of a module.
  Avoid a catch-all `shared`/`common` module that every module depends on; it becomes the coupling
  point Modulith was meant to remove.

## Verify the structure in CI

```kotlin
class ModularityTest : StringSpec({
    "modules respect their boundaries" {
        ApplicationModules.of(Application::class.java).verify()
    }
})
```

- `verify()` fails on dependency cycles between modules and on access to another module's internals
  (and on dependencies outside `allowedDependencies`). Run it in the normal test task. If jMolecules
  ArchUnit rules are on the classpath, `verify()` runs them too, so adding a dependency can change the
  result; manage extra checks explicitly with `VerificationOptions`.
- `allowedDependencies` covers **every** type reference, including the parameter types of event
  listeners. An event class that lives in the publishing module's base package is a dependency on that
  module; if you restrict dependencies to a named interface (`orders::events`), put the event types in
  that interface's package.
- `ApplicationModules.of(X::class.java)` needs `X` to be the `@SpringBootApplication` (or `@Modulith`)
  class; any other class throws immediately.
- A passing `verify()` proves structure only. It says nothing about transactions or event delivery.
- `@ApplicationModuleTest` boots only part of the application, depending on the bootstrap mode:
  `STANDALONE` (default, the module alone), `DIRECT_DEPENDENCIES`, or `ALL_DEPENDENCIES` (actual
  dependencies, not the `allowedDependencies` list). `extraIncludes` and shared modules widen it.
  Missing beans from other modules show up as startup failures, which is the point; mock them or use
  events.

## Events between modules

```kotlin
data class OrderCompleted(val orderId: UUID, val customerId: UUID, val total: BigDecimal)

@Service
class OrderService(private val orders: OrderRepository, private val events: ApplicationEventPublisher) {
    @Transactional
    fun complete(orderId: UUID) {
        val order = orders.findByIdOrNull(orderId) ?: throw OrderNotFoundException(orderId)
        order.complete()
        events.publishEvent(OrderCompleted(order.id!!, order.customerId, order.total.amount))
    }
}

@Component
class LoyaltyPoints(private val accounts: LoyaltyAccounts) {
    @ApplicationModuleListener
    fun on(event: OrderCompleted) = accounts.award(event.customerId, event.total)
}
```

- Publish immutable event DTOs with IDs and the facts consumers need. Never publish entities (lazy
  associations, mutable state, no versioning).
- **`@ApplicationModuleListener` changes the consistency model.** It combines `@Async`,
  `@Transactional(propagation = REQUIRES_NEW)`, and `@TransactionalEventListener` (AFTER_COMMIT). The
  listener runs **after** the publisher committed, on another thread, in its own transaction. If it
  fails, the publisher's change stays committed and the modules are out of sync until the event is
  retried: eventual consistency.
- If two modules must change **atomically** in one commit, that is a different design: a plain
  `@TransactionalEventListener(phase = BEFORE_COMMIT)` (or `@EventListener`, as long as the event
  multicaster is synchronous, the default) runs synchronously in the publisher's transaction, so a
  listener failure rolls everything back. It keeps modules decoupled in
  code but not in failure. Choose per event; do not switch an existing BEFORE_COMMIT design to
  `@ApplicationModuleListener` as a "cleanup".
- The async listener runs on the executor that `@Async` resolves to. Modulith enables async support
  for it. Defining your own `Executor` makes Boot's executor back off, and the listener then runs on an
  `AsyncConfigurer`'s executor, a unique or `@Primary` `TaskExecutor`, or a bean named `taskExecutor`,
  or else on an unbounded `SimpleAsyncTaskExecutor`
  ([scheduling-executors](scheduling-executors.md#async-and-executor-beans)). Size its threads and queue together
  with the connection pool, since each listener opens its own transaction.
- The listener runs asynchronously, so tests must wait for it (`Scenario` from
  `spring-modulith-test`, or Kotest `eventually`) instead of asserting right after the call. In
  Kotlin, `scenario.publish(event).andWaitForStateChange({ supplier() }, { predicate(it) })` needs both
  lambdas inside the parentheses; only one trailing lambda is possible.
- `Scenario` runs the stimulus in its **own transaction**, so its database changes (and event
  publications) are not rolled back with the test. Clean up with `andCleanup(Runnable { ... })` (a bare
  Kotlin lambda `andCleanup { }` is ambiguous between the `Runnable` and `Consumer` overloads and does
  not compile) or explicitly after the asynchronous work finished.

### Event publication registry (durability)

- With a registry starter (`-jpa`/`-jdbc`), a publication is recorded in the publisher's transaction for
  each **AFTER_COMMIT** transactional listener (which includes `@ApplicationModuleListener`) and marked
  completed when the listener succeeds. **BEFORE_COMMIT listeners are not tracked**: they run inside
  the publisher's transaction and either succeed with it or roll it back, so there is nothing to
  resubmit. Without a persistent
  registry, a crash between commit and listener execution loses the event.
- Incomplete publications are **not** retried automatically by default
  (`spring.modulith.events.republish-outstanding-events-on-restart=false`). Decide how they are
  resubmitted: enable republish on restart, or run a scheduled resubmission through
  `IncompleteEventPublications`. In a multi-instance deployment, both republish-on-restart and a
  scheduled resubmission on every instance can resubmit the same events, including ones another
  instance is still processing. Resubmit only publications older than the normal processing time.
- Distinguish in-progress from failed publications (the registry tracks status and completion
  attempts). The staleness monitor is **off** by default (staleness durations default to zero); set
  thresholds above the normal processing time and alert on failed counts and the oldest incomplete
  publication.
- Completed entries are updated in place by default (`spring.modulith.events.completion-mode=update`);
  plan retention, or the table grows forever. `delete` removes completed entries (then
  `CompletedEventPublications` finds nothing); `archive` moves them to a separate table that needs its
  own migration and retention, since archiving does not reduce total storage.
- The registry table is schema you own: create it through the project's migration tool, not by
  relying on auto-DDL in production.
- The registry stores events **serialized as JSON** and deserializes them on resubmission. If the
  serializer's mapper lacks the Kotlin module (for example when the application exposes no Boot
  `JsonMapper` bean and the registry falls back to its own), Kotlin data-class events fail with
  "no Creators" exactly when an incomplete publication is resubmitted, long after it was stored. Test a
  resubmission, not only first delivery.
- Delivery is at-least-once: a listener can run twice (crash after its effect, before completion is
  recorded). Make listeners idempotent ([messaging-outbox](messaging-outbox.md#consuming)).
- Externalizing events to Kafka (`@Externalized`, `spring-modulith-events-kafka`) goes through the same
  registry. It is an outbox-like mechanism, not exactly-once delivery. By default only annotated events
  inside the application's packages are selected, the target is derived from the type name, and no
  record key is set. Declare the topic and key explicitly: `@Externalized("orders::#{orderId}")` for a
  Kotlin data class (property syntax; the Java-record form `#{orderId()}` fails with "Method orderId()
  cannot be found"). Configure the Kafka serializer separately from the registry's JSON serialization.

## Gotchas

- Agent relies on Kotlin `internal` to hide a module's internals - it is Gradle-module scoped; Modulith verification enforces packages.
- Agent tries to write `package-info` in Kotlin - use a `@PackageInfo`-annotated type in the package.
- Agent imports another module's `internal` repository - call its API or react to its events.
- Agent introduces a `shared` module everyone depends on - expose named interfaces instead.
- Agent replaces a BEFORE_COMMIT listener with `@ApplicationModuleListener` - atomic becomes eventual; decide explicitly.
- Agent asserts a module listener's effect right after the call - it is async; wait for it.
- Agent assumes the registry retries by itself - republish is off by default; configure resubmission.
- Agent expects the registry to cover BEFORE_COMMIT listeners - only AFTER_COMMIT listeners are tracked.
- Agent leaves `Scenario` test data behind - the stimulus commits in its own transaction; clean up with `andCleanup(Runnable { })`.
- Agent copies `#{orderId()}` from Java examples into `@Externalized` on a Kotlin class - use `#{orderId}`.
- Agent never cleans completed publications - the table grows without bound.
- Agent keeps event types in the base package but allows only `orders::events` - the listener parameter type breaks `verify()`.
- Agent tests only first delivery of registry-backed events - a resubmit can fail to deserialize Kotlin events.
- Agent publishes JPA entities as events - publish immutable DTOs.

## Official sources

- [Spring Modulith reference](https://docs.spring.io/spring-modulith/reference/)
- [Fundamentals (modules, named interfaces)](https://docs.spring.io/spring-modulith/reference/fundamentals.html)
- [Events and the publication registry](https://docs.spring.io/spring-modulith/reference/events.html)
- [Compatibility matrix](https://docs.spring.io/spring-modulith/reference/appendix.html)
