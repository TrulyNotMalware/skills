---
name: kotlin-spring-boot
description: >
  Conventions and pitfalls for Kotlin + Spring Boot 4 backends (Gradle Kotlin DSL, JPA/Hibernate 7,
  Kotest + MockK). Use when writing, reviewing, refactoring, or debugging Kotlin code in a Spring
  Boot project: beans, DI and conditional beans, @ConfigurationProperties, Jackson, JPA entities,
  repositories and fetch joins, @Transactional, optimistic locking, retries, REST controllers,
  validation and ProblemDetail, @Scheduled jobs, @Async executors and virtual threads, coroutines,
  Spring Security and webhook signature filters, RestClient and streaming HTTP clients, Spring
  Modulith, Kafka, outbox and Debezium CDC, Actuator, metrics, tracing, graceful shutdown, tests
  (Kotest, MockK, @WebMvcTest, @DataJpaTest, Testcontainers), Gradle builds and Kotlin compiler
  plugins. Also use when a Spring feature silently does nothing in Kotlin (transaction not rolling
  back, validation ignored, default argument ignored, proxy not applied, scheduled jobs not running
  in parallel). Not for Android or Kotlin Multiplatform.
---

# Kotlin + Spring Boot

Spring Boot is documented Java-first. Most agent mistakes in Kotlin projects come from applying Java
advice literally (Lombok, records, checked-exception assumptions) or from Kotlin defaults that
interact badly with Spring (final classes, annotation targets, default arguments, data classes).
This skill lists those interactions. Read the matching reference file before editing that area.
Language-level Kotlin (null safety and platform types, data classes, `when`, collections, numbers,
exceptions and `runCatching`) is in the kotlin-style skill; use both together.

## Target versions

Verified 2026-09-28. Version-bound statements in this skill and its references are tagged
`(Boot 4.1)` or similar; when the project upgrades, re-check those first.

| Component | Baseline | Notes |
|---|---|---|
| Spring Boot | 4.1.x | Spring Framework 7, Hibernate 7, Jackson 3, JUnit 6 |
| Kotlin | 2.2+ (Boot minimum), 2.4.x in use | BOM default 2.3.21; libraries must end up aligned with the Kotlin plugin (see gradle-build) |
| Build | Gradle Kotlin DSL, multi-module | |
| Tests | Kotest 6 + MockK, SpringMockK 5 | JUnit 6 platform underneath |

The project's own build files win over this table. Read `build.gradle.kts`, `settings.gradle.kts`,
`gradle/libs.versions.toml` (if present), and the root `AGENTS.md`/`CLAUDE.md` before changing
anything version- or convention-related.

## Workflow

1. **Read the project's existing patterns first.** Find one existing controller, service, entity and
   test in the same module and follow their style (naming, logger name, DTO mapping, test spec style).
   Consistency with the codebase beats this skill's defaults. That includes structure: if beans are
   registered with `@Bean` methods instead of stereotypes, or the domain model is separate from the
   JPA entities, follow it and read the matching conditional sections in the references.
2. **Open the relevant reference** from the table below before writing code in that area.
3. **Verify through Spring, not around it.** Proxy, transaction, binding, and injection behavior is
   invisible to plain unit tests. When you change wiring, prove it with a Spring-context test or by
   running the app (see Gotchas).
4. Build with `./gradlew build --console=plain` and read the Kotlin `w:` lines. Add
   `--warning-mode all` for Gradle deprecations, but read Kotlin warnings without it: with it,
   Gradle 9.7 rendered them as `Problem found: Kotlin compiler warning` blocks and showed only the
   first 15. The mode may already be on through `org.gradle.warning.mode=all` in `gradle.properties`
   (or a preset that generates it) — check first, and treat "0 `w:` lines next to problem blocks" or
   "exactly 15 blocks" as the mode, not as the count. The complete list is in
   `build/reports/problems/problems-report.html` (distinct `"path":…,"line":` entries); on Gradle
   9.8.0 + KGP 2.4.10 `--warning-mode=summary` printed them nowhere on the console, so read the report
   (2026-10-06, one project's presets: 16 warnings reported as 0). An UP-TO-DATE compile
   task prints no warnings; force it with `--rerun-tasks` (or after `clean`). The same applies to
   test evidence: with `org.gradle.caching=true`, `clean build` restores unchanged `test` tasks
   FROM-CACHE (Gradle 9.7.1, measured 2026-10-06), so only `--rerun-tasks` proves the tests ran now;
   check the `build/test-results` timestamps.

When **diagnosing** ("annotation does nothing", startup failure, wrong bean, binding error), gather
evidence before editing: the full `Caused by:` chain, the call site (does it cross a bean
boundary?), the build plugins of the module, and the effective configuration. Report the broken
mechanism, the concrete reason, the minimal fix, and how you verified it. Do not add `open`,
`@Lazy`, broader component scans, or nullable types just to make a symptom disappear.

## Always-on rules

- Constructor injection through the primary constructor. No `@Autowired` fields, no `lateinit var`
  for beans in production code.
- The `kotlin("plugin.spring")` plugin must be applied in every module that has Spring beans, and
  `kotlin("plugin.jpa")` in every module that has entities. Below Kotlin 2.3.20, the entity module also
  needs an explicit `allOpen` block for the JPA annotations.
- JPA entities are regular `class`es, never `data class`. DTOs, commands, events, and
  `@ConfigurationProperties` are `data class`es.
- No Lombok, no Java records in Kotlin sources.
- Use Kotlin nullability as the contract: `findByIdOrNull` instead of `Optional`, nullable return
  types instead of `Optional<T>`.
- Below Kotlin 2.4, put Bean Validation annotations on fields explicitly (`@field:NotBlank`)
  unless the build sets `-Xannotation-default-target=param-property`. On 2.4+ that is the default.
- Never return entities from controllers; map to response DTOs inside the transaction.

## Reference routing

| Task touches... | Read |
|---|---|
| Gradle plugins, compiler flags, bean injection, `@Bean` and conditional registration, `@ConfigurationProperties`, `@Value`, Jackson, logging, Spring Kotlin extensions | [reference/kotlin-spring-basics.md](reference/kotlin-spring-basics.md) |
| `@Entity`, `@Embeddable`, repositories, queries, N+1 and fetch joins, pagination, batch writes, `@Version`, a domain model separate from entities, schema changes | [reference/jpa-entities.md](reference/jpa-entities.md) |
| `@Transactional`, rollback, propagation, optimistic-lock retry, after-commit events, `@Retryable` | [reference/transactions.md](reference/transactions.md) |
| REST controllers, request validation, error responses (ProblemDetail), idempotent POST, pagination, API versioning | [reference/web-errors.md](reference/web-errors.md) |
| Choosing coroutines vs virtual threads, `suspend` controllers/schedulers, structured concurrency, cancellation, dispatchers, context propagation, `Flow` | [reference/coroutines.md](reference/coroutines.md) |
| Gradle multi-module structure, BOM import and version overrides, `api`/`implementation`, exclusions, compiler options, build verification (version bumps: use the `dependency-bump` skill) | [reference/gradle-build.md](reference/gradle-build.md) |
| Profiles and config sources, Actuator health/probes, Micrometer metrics, observations/tracing, logging, graceful shutdown | [reference/config-observability.md](reference/config-observability.md) |
| Calling other services: `RestClient`, HTTP interface clients (`@ImportHttpServices`), `WebClient`, timeouts, retries, errors in 2xx bodies, consuming streams (SSE/NDJSON), client tests | [reference/http-clients.md](reference/http-clients.md) |
| Spring Security filter chains (Kotlin DSL), JWT resource server, authorities mapping, method security, webhook signature filters and responses, security tests | [reference/security.md](reference/security.md) |
| Spring Modulith: module packages in Kotlin (`@PackageInfo`), `verify()`, `@ApplicationModuleListener`, event publication registry | [reference/modulith.md](reference/modulith.md) |
| Kafka producers/consumers, `@KafkaListener`, error handlers and DLT, transactional outbox, Debezium CDC relays | [reference/messaging-outbox.md](reference/messaging-outbox.md) |
| `@Scheduled` jobs, `@Async` and executor beans, scheduler/executor changes under virtual threads, jobs on several instances | [reference/scheduling-executors.md](reference/scheduling-executors.md) |
| Writing or fixing tests: Kotest specs, MockK/`@MockkBean`, `@WebMvcTest`, `@DataJpaTest`, Testcontainers, time/concurrency in tests | [reference/testing.md](reference/testing.md) |

## Gotchas

These are the Kotlin-specific failures that compile fine and pass unit tests.

- Agent forgets `kotlin("plugin.spring")` in a new module - Spring-annotated classes stay final, so
  class-based proxies for `@Transactional`/`@Cacheable`/`@Async`/`@Configuration` fail at startup,
  and any `final` member of an opened class is silently not advised.
- Agent registers a class without a stereotype through a `@Bean` method and annotates only its methods
  with `@Transactional`/`@Async`/`@Cacheable` - `plugin.spring` opens classes by class-level
  annotations only, so the class stays final and, with Boot's default class-based proxying, startup
  fails (`AopConfigException`) even when it implements an interface.
- Agent throws a Java-checked exception type (`IOException`, any `Exception` that is not a
  `RuntimeException`) from a `@Transactional` method - Kotlin has no checked exceptions, but Spring
  still commits on them. See [transactions](reference/transactions.md#rollback-rules).
- On Kotlin 2.2–2.3 (or older), agent writes `@NotBlank val name: String` in a request DTO - without
  `@field:` or the `param-property` flag the constraint lands on the constructor parameter only and
  `@Valid` ignores it. Kotlin 2.4+ applies it to the field as well.
- Agent gives a bean constructor parameter a default value (`clock: Clock = Clock.systemDefaultZone()`)
  - the default is used only when no bean of that type exists. If any `Clock` bean exists, it is
  injected instead, regardless of the default.
- Agent relies on the parameter name to pick among several beans of the same type - a `@Primary`
  bean wins over name matching. Use `@Qualifier`.
- Agent uses `data class` for an entity - generated `equals`/`hashCode`/`toString` touch lazy
  associations and change as fields mutate; `copy()` creates a detached twin with the same ID.
- Agent writes `private set` on an entity property - `plugin.jpa` (2.3.20+) or the `allOpen` block
  makes properties open,
  and open properties cannot have private setters. Use `protected set`.
- Agent writes `"\${app.url}"` wrongly as `"${app.url}"` in `@Value` - Kotlin string templates
  consume `$`. Escape it, or prefer `@ConfigurationProperties`.
- Agent adds `@Transactional` to a `suspend fun` in a JPA/JDBC project - the thread-bound
  transaction does not reliably cover the coroutine body (exactly how it fails depends on the
  classpath). Keep JPA service methods blocking.
- Agent sets compiler flags in a root-level `kotlin { }` block of a multi-module build - it
  configures only the root project; modules compile without the flags.
- Agent writes unit tests only for a wiring change - default-argument, qualifier, and proxy defects
  never appear in unit tests that construct the class directly.

## Maintaining this skill

When bumping the target versions: update the table above, then grep this directory for version tags
(`Boot 4`, `Hibernate 7`, `Jackson 3`, `Kotlin 2.`) and re-verify each tagged statement against the
official docs. The change history is kept outside this directory, in the author's wiki.
