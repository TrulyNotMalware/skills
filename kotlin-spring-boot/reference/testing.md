# Testing Kotlin + Spring Boot

Kotest 6 + MockK on the JUnit Platform, Spring Boot 4 test slices, Testcontainers 2. Class locations
and versions below were resolved against Boot 4.1.1, Kotest 6.2.5, SpringMockK 5.0.1, and
Testcontainers 2.0.5 on 2026-09-28.

Contents: [Choose the smallest test that would have failed](#choose-the-smallest-test-that-would-have-failed) ·
[Dependencies (Gradle Kotlin DSL)](#dependencies-gradle-kotlin-dsl) ·
[Kotest specs with Spring](#kotest-specs-with-spring) · [Wiring smoke test](#wiring-smoke-test) ·
[MockK](#mockk) · [Web layer (`@WebMvcTest`)](#web-layer-webmvctest) ·
[Persistence tests and databases](#persistence-tests-and-databases) ·
[Transactions, time, and concurrency in tests](#transactions-time-and-concurrency-in-tests) ·
[Messaging](#messaging) · [Tests that lock in bugs](#tests-that-lock-in-bugs) · [Gotchas](#gotchas)

## Choose the smallest test that would have failed

| What must be proven | Test type |
|---|---|
| Domain rules, calculations, branching, state transitions | Plain Kotest spec, no Spring. Collaborators are MockK mocks or hand-written fakes |
| HTTP contract: status codes, validation, JSON shape, security rules | `@WebMvcTest` slice |
| Repository queries, mappings, locking, constraints | `@DataJpaTest` slice on the production DB engine |
| Wiring: which bean is injected, proxies, transactions, config binding | `@SpringBootTest` (or `ApplicationContextRunner` for configuration) |
| Broker/DB boundary behavior (Kafka, CDC, outbox) | `@SpringBootTest` + embedded broker or Testcontainers |

- Unit tests are the default. Move up only when the behavior lives in the framework: proxies, binding,
  transactions, serialization, security, or SQL.
- A bug caused by wiring needs at least one test above unit level. Constructor defaults, qualifiers,
  and proxy advice are invisible when the test constructs the class itself
  ([wiring smoke test](#wiring-smoke-test)).
- A bug in domain branching does not need a Spring context.
- Follow the project's existing split. If most specs are plain Kotest with hand-wired collaborators,
  a new Spring-booting spec needs a reason.

## Dependencies (Gradle Kotlin DSL)

```kotlin
dependencies {
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.boot:spring-boot-starter-webmvc-test")   // @WebMvcTest, MockMvc
    testImplementation("org.springframework.boot:spring-boot-starter-data-jpa-test") // @DataJpaTest
    testImplementation("org.springframework.boot:spring-boot-testcontainers")        // @ServiceConnection
    testImplementation("org.testcontainers:testcontainers-postgresql")               // Testcontainers 2 naming

    testImplementation(platform("io.kotest:kotest-bom:6.2.5"))
    testImplementation("io.kotest:kotest-runner-junit5")
    testImplementation("io.kotest:kotest-assertions-core")
    testImplementation("io.kotest:kotest-extensions-spring")  // io.kotest group since Kotest 6
    testImplementation("io.mockk:mockk:1.14.11")
    testImplementation("com.ninja-squad:springmockk:5.0.1")  // only if @MockkBean is needed
}

tasks.withType<Test> {
    useJUnitPlatform()
    // Optional: pre-empts JDK 21+ dynamic-agent warnings from MockK's inline mocking. No warning was
    // observed without it on Temurin 21.0.11 + MockK 1.14.11; keep it if the project already has it.
    jvmArgs("-XX:+EnableDynamicAgentLoading")
}
```

Boot 4 uses Jackson 3. If a test module declares the Kotlin module explicitly, it must be
`tools.jackson.module:jackson-module-kotlin`. The Jackson 2 coordinate
(`com.fasterxml.jackson.module`) is not registered with Boot 4's mapper, and Kotlin DTOs then fail with
"no Creators" errors in MockMvc tests.

Boot 4 split test support into modules. The slice annotations moved with them:

| Annotation | Boot 4 location | Artifact |
|---|---|---|
| `@WebMvcTest`, `@AutoConfigureMockMvc` | `org.springframework.boot.webmvc.test.autoconfigure` | `spring-boot-starter-webmvc-test` |
| `@DataJpaTest` | `org.springframework.boot.data.jpa.test.autoconfigure` | `spring-boot-starter-data-jpa-test` |
| `TestEntityManager` | `org.springframework.boot.jpa.test.autoconfigure` | `spring-boot-starter-data-jpa-test` |
| `@ApplyExtension` / Kotest `SpringExtension` | `io.kotest.core.extensions` / `io.kotest.extensions.spring` | `kotest-framework-engine` / `kotest-extensions-spring` |
| `@AutoConfigureRestTestClient` | `org.springframework.boot.resttestclient.autoconfigure` | `spring-boot-resttestclient` |
| `@ServiceConnection` | `org.springframework.boot.testcontainers.service.connection` | `spring-boot-testcontainers` |
| `@MockitoBean` / `@MockitoSpyBean` | `org.springframework.test.context.bean.override.mockito` | `spring-test` |
| `@MockkBean` / `@SpykBean` | `com.ninjasquad.springmockk` | `springmockk` |

`@MockBean`/`@SpyBean` from `org.springframework.boot.test.mock.mockito` are **removed** in Boot 4.
Old Boot 3 import paths for the slices do not compile. Copy imports from an existing spec in the project
rather than from memory or Boot 3 examples.

## Kotest specs with Spring

```kotlin
@DataJpaTest
@ApplyExtension(extensions = [SpringExtension::class])
class OrderRepositoryTest
    @Autowired
    constructor(
        private val orderRepository: OrderRepository,
        transactionManager: PlatformTransactionManager,
    ) : BehaviorSpec({
        val tx = TransactionTemplate(transactionManager)
        fun <T : Any> inTx(block: () -> T): T = tx.execute { block() }!!

        given("a saved order") {
            `when`("it is loaded with items") {
                then("the item collection is initialized") {
                    // Leaf = test transaction (Test mode): the fixture is rolled back afterwards.
                    val id = orderRepository.saveAndFlush(Order(customerId = UUID.randomUUID(), createdAt = Instant.EPOCH)).id!!
                    orderRepository.findWithItemsById(id)!!.items.shouldBeEmpty()
                }
            }
        }

        given("committed data is required") {
            // Writes in container blocks commit for real; the test transaction cannot undo them.
            val id = inTx { orderRepository.save(Order(customerId = UUID.randomUUID(), createdAt = Instant.EPOCH)).id!! }
            afterSpec { inTx { orderRepository.deleteById(id) } } // guaranteed cleanup for committed fixtures

            then("a new transaction sees it") {
                inTx { orderRepository.existsById(id) } shouldBe true // inTx needs a non-null result
            }
        }
    })
```

Put fixtures in the leaf when the test transaction's rollback should clean them up. Anything written in
a container block (or through `TransactionTemplate`) is committed and needs explicit cleanup.

- Register Spring with `@ApplyExtension(extensions = [SpringExtension::class])` on the spec
  (`io.kotest.extensions.spring.SpringExtension`), or once in the project config. The no-arg form
  uses `SpringTestLifecycleMode.Test`.
- Inject through an `@Autowired constructor(...)`. Field injection with `lateinit var` also works,
  but the constructor form matches production code.
- **Transaction scope follows the lifecycle mode.** In `Test` mode, Spring's test transaction wraps
  each leaf test (`then`), not the `given`/`when` containers. Code in a container block runs outside
  any test transaction: `TestEntityManager.flush()` fails with "No transactional EntityManager found".
  Inherited CRUD methods (`save`, `findById`, ...) run in their own repository transaction and commit;
  declared query methods have no transaction of their own by default. `SpringTestLifecycleMode.Root` makes the root
  test the unit instead, so container blocks run inside the test transaction. Read the project's
  setting before reasoning about what is committed.
- `Root` mode registered by the spec itself (`extensions(SpringExtension(SpringTestLifecycleMode.Root))`)
  cannot be combined with constructor injection: the spec must be instantiated before its own
  extension exists ("should have a zero-arg constructor"). Use `@Autowired lateinit var` fields
  there, or register the Root-mode extension in the project config.
- When a container step needs a transaction (lazy loading, locks, first-level cache effects), wrap it
  in `TransactionTemplate` explicitly, as `inTx` above.
- **Isolation mode:** Kotest's default is `SingleInstance`. One spec instance runs all its tests, so
  `val`s declared in the spec body or in `given` blocks are shared across sibling tests. Mutable state
  there leaks between tests. Create fresh state inside the block that uses it, or set
  `isolationMode` deliberately. Prefer `InstancePerRoot` over per-leaf modes when isolation is needed.
- `@DirtiesContext` between tests does not re-inject constructor arguments. Under `SingleInstance`
  the spec keeps references to beans from the closed context. Prefer class-level (after-spec)
  invalidation, or field injection that is re-populated. Invalidating a context never cleans an
  external database.
- `@Sql` goes on the spec class; DSL leaves are not annotated methods. Its scripts run around the
  Spring test-method callbacks, which in `Test` mode means around each leaf, **after** the outer
  `given` block already ran. For committed fixtures or cleanup outside the test transaction, use
  `@SqlConfig(transactionMode = SqlConfig.TransactionMode.ISOLATED)`. Check ordering with one run
  before relying on it.
- Kotest project config (`AbstractProjectConfig`) is not found by classpath scanning in Kotest 6.
  Place it as `io.kotest.provided.ProjectConfig`, or point the `kotest.framework.config.fqn` system
  property at it. A config in another package is silently ignored.
- JUnit tests in Kotlin must return `Unit`. `@Test fun works() = runBlocking { result shouldBe 1 }` (an
  expression body) infers a non-`Unit` return type from the last expression, and JUnit **silently
  does not run it**: no failure, no test. Use a block body (`@Test fun works() { runBlocking { ... } }`)
  or `runTest` with an explicit `: Unit`. Kotest specs are not affected.
- Assertions: Kotest matchers (`shouldBe`, `shouldThrow<T> { }`, `shouldContainExactly`). Don't mix
  in AssertJ unless the project already does.

## Wiring smoke test

Unit tests construct classes themselves, so a default argument shadowed by a bean, a missing
qualifier, a proxy that was not applied, or a scheduler that changed type never shows up there. One
spec that starts the whole application context catches them. Replace external systems (embedded
broker, Testcontainers, or `@MockkBean` on the outermost client) and assert the bean choices the
business rules depend on, not only that the context starts:

```kotlin
@SpringBootTest
@EmbeddedKafka(partitions = 1, bootstrapServersProperty = "spring.kafka.bootstrap-servers")
@ApplyExtension(extensions = [SpringExtension::class])
class WiringSmokeTest
    @Autowired
    constructor(private val context: ApplicationContext) : FunSpec({
        test("the context starts with the intended wiring") {
            context.getBean<Clock>().zone shouldBe ZoneId.of("Europe/Paris") // the zone the rules assume
            context.getBean<TaskScheduler>().shouldBeInstanceOf<ThreadPoolTaskScheduler>()
        }
    })
```

Keep these specs few: each distinct configuration starts another context.

## MockK

```kotlin
val repository = mockk<OrderRepository>()          // strict: unstubbed calls throw
val events = mockk<ApplicationEventPublisher>(relaxed = true)  // relaxed only for sinks
val saved = slot<Order>()

every { repository.save(capture(saved)) } answers { saved.captured }
coEvery { client.fetch(any()) } returns Result.success(dto)   // suspend functions need co*

service.submit(orderId)

verify(exactly = 1) { repository.save(any()) }
saved.captured.status shouldBe OrderStatus.SUBMITTED        // assert the observable result
```

- Strict mocks by default. `relaxed = true` hides missing stubs by returning defaults; keep it for
  fire-and-forget sinks (event publishers, metrics).
- `suspend` functions need `coEvery`/`coVerify`. Plain `every` on a suspend call does not compile
  or does not match.
- Assert outcomes (returned values, captured arguments, state) rather than only interactions. A
  test that only checks `verify { }` proves the code calls something, not that the result is right.
- Kotlin `object`s and top-level functions need `mockkObject`/`mockkStatic`, which are JVM-global.
  Undo exactly what you mocked (`unmockkObject(X)`, `unmockkStatic(...)`) in teardown. `unmockkAll()`
  also removes global mocks of other tests running in parallel. Do not run tests that mock the same
  global target concurrently. Better: inject the dependency instead.
- Plain `mockk()` instances shared across tests (spec-level `val`s) keep stubs and recorded calls.
  Recreate them per test, or `clearMocks(...)` in `beforeTest`.
- Prefer hand-written fakes for collaborators with real behavior (a clock, an in-memory repository).
  They survive refactors that break mock setups.

### `@MockkBean` vs `@MockitoBean`

- In Spring-context tests, replace beans with `@MockkBean` (SpringMockK) when the project uses MockK.
  `@MockitoBean` creates Mockito mocks, which cannot be stubbed with MockK's `every { }`.
- `@MockkBean` works on fields, on `@Autowired` constructor parameters, and at class level with
  `types = [...]` (SpringMockK 5.0.1). Defaults: `relaxed = false`, and mocks are cleared after each
  Spring test method (`clear = MockkClear.AFTER`). In Kotest that means after each leaf in `Test`
  mode but only after the whole root in `Root` mode, where sibling leaves share stubs and recorded
  calls. Stub inside the test that needs it; `clearMocks(...)` explicitly when leaves must be isolated.
- The context cache key includes the bean overrides (type, field name, qualifier, and SpringMockK's
  clear/relaxed settings), active profiles, properties, and dynamic property sources. Two specs that
  mock "the same beans" declared differently still get two contexts. Standardize override
  declarations (for example a shared base config or identical class-level `@MockkBean(types = ...)`)
  so specs actually share a context.
- A shared context also shares the **mock instances**. If one spec leaves stubs or recorded calls
  behind (for example under `Root` mode, where clearing happens only after the root), a later spec
  with the same override declarations can see them. Clear explicitly, or give the spec a distinct
  context on purpose.

## Web layer (`@WebMvcTest`)

```kotlin
@WebMvcTest(OrderController::class)
@ApplyExtension(extensions = [SpringExtension::class])
class OrderControllerTest
    @Autowired
    constructor(
        private val mockMvc: MockMvc,
        @MockkBean private val orderService: OrderService, // class-level @MockkBean(types = [...]) also works
    ) : BehaviorSpec({
        given("an invalid request") {
            then("it returns 400 with a problem detail") {
                mockMvc.post("/api/orders") {
                    contentType = MediaType.APPLICATION_JSON
                    content = """{"customerId": null}"""
                    with(user("alice").roles("USER")) // only when Spring Security is active
                    with(csrf())                      // CSRF-protected POSTs are rejected before validation otherwise
                }.andExpect {
                    status { isBadRequest() }
                    content { contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON) }
                }
                verify(exactly = 0) { orderService.submit(any()) }
            }
        }
    })
```

- Use Spring's MockMvc Kotlin DSL (`mockMvc.post(...) { } .andExpect { }`) rather than the Java builder chain.
- Send JSON as raw strings for validation tests. A DTO serialized by the test cannot express a missing
  or `null` field that the Kotlin type forbids, and those are exactly the cases to test.
- `application/problem+json` responses require either `spring.mvc.problemdetails.enabled=true`
  (default `false` in Boot 4.1) or the application's own `ProblemDetail` exception handling. Assert
  the content type only if the application enables one of them.
- Security in the MVC slice: Boot 4 moved the slice's security auto-configuration into
  `spring-boot-security-test` (add `spring-boot-starter-security-test`), and `@WebMvcTest` does not
  pick up the application's `SecurityFilterChain` bean by itself. `@Import` the security
  configuration when the test is about its rules.
- With security active, send a principal (`user(...)`, `@WithMockUser`) and `csrf()` for unsafe
  methods. Otherwise the request is rejected (401/403) before validation, and a "400 test" tests the
  wrong thing. Test the unauthenticated and forbidden cases separately. The exact status for "no
  credentials" depends on the configured entry point; assert what the security chain defines.
- For full-stack HTTP tests in Boot 4, use `RestTestClient` with `@AutoConfigureRestTestClient` instead
  of `TestRestTemplate`. With `webEnvironment = RANDOM_PORT` the server runs on another thread, so a
  test-level `@Transactional` does **not** roll back what the request wrote. Clean up explicitly.

## Persistence tests and databases

- Use the **production database engine** for anything involving locking, isolation, time, JSON
  columns, native SQL, or DB defaults. H2 differs in ways that make broken code pass:
  - H2 in the default embedded setup evaluates `CURRENT_TIMESTAMP` with the JVM clock and default
    zone (H2 supports a session `SET TIME ZONE`, but tests rarely configure it). A mismatch between a
    DB timestamp and a JVM cutoff (for example KST application vs UTC production database) then
    does not show up.
  - Dialect features, lock semantics, and constraint timing differ.
- H2 is acceptable for mapping/query smoke tests when the project already uses it. Do not switch a
  project's test database as a side effect.
- Testcontainers 2 (Boot 4 manages 2.x):

```kotlin
@TestConfiguration(proxyBeanMethods = false)
class PostgresTestConfig {
    @Bean
    @ServiceConnection
    fun postgres() = PostgreSQLContainer("postgres:17-alpine") // org.testcontainers.postgresql.PostgreSQLContainer
}

@DataJpaTest
@Import(PostgresTestConfig::class) // top-level @TestConfiguration classes are excluded from scanning
class OrderRepositoryPostgresTest : BehaviorSpec({ /* ... */ })
```

  - Artifacts are renamed with a `testcontainers-` prefix (`testcontainers-postgresql`, not `postgresql`).
  - Use `org.testcontainers.postgresql.PostgreSQLContainer` (non-generic). The old
    `org.testcontainers.containers.PostgreSQLContainer<SELF>` still exists but is deprecated.
  - `@ServiceConnection` wires the datasource. No `@DynamicPropertySource` needed for supported services.
  - `@DataJpaTest` keeps it: `@AutoConfigureTestDatabase(replace = ...)` defaults to `NON_TEST` in Boot 4
    (replace only non-test datasources), so a `@ServiceConnection` container is used as-is. Adding
    `replace = NONE` is unnecessary. Without any test datasource, the slice still swaps in an embedded
    database.
  - Pin the image to the major version production runs.
- Testcontainers needs a running Docker daemon. If it is not running, ask the user before starting
  it; do not silently fall back to H2.

## Transactions, time, and concurrency in tests

- **A test-managed transaction that rolls back hides commit-time behavior**: deferred constraints,
  `AFTER_COMMIT` listeners (they never run), and anything that happens only at commit (for example a
  forced version increment scheduled for commit). To test those, commit for real
  (`TransactionTemplate` per step, no test-level `@Transactional`) and clean up explicitly.
- Flush-time behavior is testable inside the test transaction, **if you flush**: ordinary `@Version`
  increments, immediate constraint violations, and generated SQL all happen at flush. Without a
  flush, the rollback discards them before they reach the database. Use `saveAndFlush` or
  `entityManager.flush()`.
- **A mocked `PlatformTransactionManager` proves nothing about atomicity.** It verifies call order
  only. Two writes split into two transactions still pass. Use the real `JpaTransactionManager` on a
  real (or embedded) database.
- Verify committed state from a **new** transaction or `EntityManager`. Reading back in the same
  persistence context returns the cached entity, whatever the database holds.
- **Time:** inject `Clock` everywhere and use a controllable clock in tests (`Clock.fixed`, or a small
  mutable clock with `advance(Duration)`). When SQL compares against the database's own clock
  (`CURRENT_TIMESTAMP`, `now()`), bind the timestamp from the application instead, or test on the
  real engine with the production zone settings.
- **Concurrency:** give each thread its own transaction (`TransactionTemplate` inside the task).
  Assert that `latch.await(timeout, unit)` returned `true`. A timed-out wait silently turns a race
  test into a sequential one that still passes.
- **Async:** wait for conditions, not durations. Use Kotest `eventually(5.seconds) { ... }`
  (`io.kotest.assertions.nondeterministic.eventually`, in `kotest-assertions-core`) or Awaitility.
  Never `Thread.sleep`.
- **Coroutines:** use `runTest` (kotlinx-coroutines-test) for virtual time, or Kotest's coroutine test
  scope. Inject dispatchers so tests can substitute a test dispatcher.
- **A context test also runs the app's background triggers.** With `@EnableScheduling` active, every
  `@Scheduled` job is registered at startup, and `fixedDelay`/`fixedRate` jobs without a long
  `initialDelay` run during the test, against the test's database and `@MockkBean` stubs (Boot 4.1.1: a
  `fixedDelay` job without `initialDelay` ran about 200 ms after startup, inside the test). Event
  listeners run as well when the test commits: an `AFTER_COMMIT` listener calling an unmocked HTTP
  client failed with `ConnectException`, Spring only logged it, and the test stayed green. Gate
  scheduling with a property, and move `@EnableScheduling` off the `@SpringBootApplication` class and
  any other configuration into the gated class, or the gate does nothing. Boot 4.1 has no
  `spring.task.scheduling.enabled` property (setting it changes nothing). Replacing one job bean with
  `@MockkBean` silences only that job. Mock outbound clients in context tests, so that a listener added
  later cannot reach a real service from existing tests.

  ```kotlin
  @Configuration
  @EnableScheduling
  @ConditionalOnProperty(name = ["app.scheduling.enabled"], havingValue = "true", matchIfMissing = true)
  class SchedulingConfig
  ```

  Set `app.scheduling.enabled=false` once for the suite (`src/test/resources/application.yml` or a
  shared test profile); a per-class `properties` override starts another cached context. Turning it off
  also removes Boot's `taskScheduler` bean, so the [wiring smoke test](#wiring-smoke-test) and job
  tests need it on (a `getBean<TaskScheduler>()` assertion fails otherwise), and an app with its own
  `Executor` bean may resolve unqualified `@Async` differently than in production.

## Messaging

- `@EmbeddedKafka` (spring-kafka-test) starts a KRaft broker in the test JVM. Point the app at it with
  `bootstrapServersProperty = "spring.kafka.bootstrap-servers"`.
- Each distinct `@EmbeddedKafka` configuration starts its own broker. Keep broker-backed specs few and
  shared.
- A cached context keeps its broker, topics, and committed offsets across specs. Use unique topic
  names or consumer group IDs per spec, or records from an earlier spec show up in later assertions.
- Spring Kafka's testing docs recommend `@DirtiesContext` for broker-backed tests so the broker shuts
  down with its context. That trades context reuse for isolation; decide per project and follow the
  existing convention.
- Consume with a real consumer and assert payload and headers. Do not assert only that
  `KafkaTemplate.send` was called.

## Tests that lock in bugs

- A test that asserts current behavior can freeze a defect as "correct" (for example
  `verify(exactly = 1) { sender.send(any()) }` for a path that should not resend). Later reviewers
  then trust the green test. Derive expected behavior from the requirement, not from the code.
- When the same agent writes the implementation and its tests, a misreading of the requirement is
  copied into both. Write the test cases from the requirement first, or review the tests separately.
- A regression test must fail on the old code. Check this once by reverting the fix locally or by
  reasoning explicitly about which assertion would have failed.
- **An empty spec passes.** With Kotest 6.2.5 on Gradle 9.7.1, a spec whose body registers no tests is
  reported as one passing entry named after the spec, and a `given` block left without leaves is
  reported as a passing test. Neither guard catches it: Gradle 9's `failOnNoDiscoveredTests` fails only
  when the task discovers nothing at all, and Kotest's `failOnEmptyTestSuite` checks only for a run
  with zero tests (under the JUnit Platform runner it did not fail the build even then). Read the test
  names in the report (a spec name with no test under it, a `Given:` with no `Then:`), and look at the
  test count when a suite suddenly gets faster.
- Assert sizes, not only membership. A query that truncates a collection or drops rows still
  "contains" the expected element. On a database shared across tests, assert deltas
  (`count() shouldBe before + 2`) instead of absolute counts.
- Hand-set timestamps in fixtures can be overwritten: `@CreationTimestamp` sets its value on insert,
  so an ordering test built on fixture `createdAt` values orders by insert time and may pass by
  accident. Set such columns from an injected `Clock` in production code instead of
  `@CreationTimestamp`, or check the stored values.

## Gotchas

- Agent imports `@WebMvcTest`/`@DataJpaTest` from Boot 3 packages - they moved in Boot 4; copy imports from an existing spec.
- Agent uses `@MockBean` - removed in Boot 4; use `@MockkBean` (MockK projects) or `@MockitoBean`.
- Agent stubs a `@MockitoBean` with `every { }` - MockK cannot stub Mockito mocks; use `@MockkBean`.
- Agent uses `every` on a suspend function - use `coEvery`/`coVerify`.
- Agent calls `flush()` or relies on lazy loading in a Kotest `given`/`when` block - no test transaction there in `Test` mode.
- Agent keeps mutable state in the spec body - shared across tests under `SingleInstance`.
- Agent puts `ProjectConfig` in an arbitrary package - Kotest 6 ignores it.
- Agent uses `org.testcontainers:postgresql` or the generic `PostgreSQLContainer<*>` - Testcontainers 2 renamed both.
- Agent tests atomicity with a mocked transaction manager - proves call order only.
- Agent tests after-commit behavior inside a rolled-back test transaction - listeners never fire.
- Agent swaps the project's test database for H2 to "make tests run" - time, locking, and dialect bugs disappear from view.
- Agent expects a 400 from a secured `@WebMvcTest` POST without a principal and `csrf()` - security rejects it first.
- Agent asserts `application/problem+json` without problem details enabled - Boot's default is off.
- Agent defines a top-level `@TestConfiguration` and never `@Import`s it - it is not picked up.
- Agent writes fixtures in a Kotest container block and expects rollback - they are committed.
- Agent uses `unmockkAll()` in a parallel suite - it removes other tests' global mocks.
- Agent writes a JUnit `@Test fun x() = runBlocking { ... }` - non-`Unit` return, the test is silently skipped.
- Agent uses `Thread.sleep` for async assertions - use `eventually` or Awaitility.
- Agent writes only interaction checks (`verify { }`) - assert the observable result too.
- Agent relies on unit tests for a wiring change - add or extend a context-starting smoke test that asserts the chosen beans.
- Agent trusts a green run after moving tests - an empty spec passes as one entry; read the test names, not only the count.
- Agent asserts that a collection contains an element - truncation passes; assert the size.
- Agent adds a `@SpringBootTest` to an app with `@Scheduled` jobs without gating scheduling - the
  jobs run during the test against the same database and mocks.

## Official sources

- [Spring Boot testing](https://docs.spring.io/spring-boot/reference/testing/index.html)
- [Spring Boot Testcontainers support](https://docs.spring.io/spring-boot/reference/testing/testcontainers.html)
- [Spring Framework MockMvc Kotlin DSL](https://docs.spring.io/spring-framework/reference/languages/kotlin/spring-projects-in.html)
- [Kotest Spring extension](https://kotest.io/docs/extensions/spring.html)
- [SpringMockK](https://github.com/Ninja-Squad/springmockk)
- [Testcontainers for Java](https://java.testcontainers.org/)
