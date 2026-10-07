# Kotlin + Spring basics

Build setup, dependency injection, configuration binding, JSON, and logging. Statements tagged with a
version were verified against the Spring Boot 4.1 reference docs on 2026-09-28.

Contents: [Build setup (Gradle Kotlin DSL)](#build-setup-gradle-kotlin-dsl) ·
[Dependency injection](#dependency-injection) ·
[Configuration properties](#configuration-properties) ·
[Annotation use-site targets](#annotation-use-site-targets) · [JSON (Jackson 3)](#json-jackson-3) ·
[Spring's Kotlin extensions](#springs-kotlin-extensions) · [Logging](#logging) ·
[Checklist](#checklist)

## Build setup (Gradle Kotlin DSL)

```kotlin
plugins {
    id("org.springframework.boot") version "4.1.1" apply false
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.spring") version "2.4.10" apply false
    kotlin("plugin.jpa") version "2.4.10" apply false
}

subprojects {
    apply(plugin = "org.jetbrains.kotlin.jvm")
    apply(plugin = "org.jetbrains.kotlin.plugin.spring")

    // Must be inside subprojects (or a convention plugin): a root-level `kotlin { }` block
    // configures only the root project, and modules silently compile without these flags.
    extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
        jvmToolchain(25)
        compilerOptions {
            freeCompilerArgs.addAll(
                "-Xjsr305=strict",                            // JSR-305 annotations in non-JSpecify libraries
                // Kotlin 2.2–2.3 only: annotations reach the field too. Default (and redundant) on 2.4+.
                "-Xannotation-default-target=param-property",
            )
        }
    }

    dependencies {
        "implementation"(platform(org.springframework.boot.gradle.plugin.SpringBootPlugin.BOM_COORDINATES))
        "implementation"(kotlin("reflect"))
    }
}
```

Modules that declare entities also apply `org.jetbrains.kotlin.plugin.jpa`.

- **Kotlin 2.3.20+:** `plugin.jpa` applies both no-arg and all-open with the JPA preset. Entity
  classes and their members become open without further configuration (verified on 2.4.10: an
  `@Entity` compiled with only `plugin.jpa` is non-final with open accessors).
- **Older Kotlin:** add an explicit `allOpen` block. Existing builds often still have one; it is
  harmless on newer versions.

```kotlin
allOpen { // needed only below Kotlin 2.3.20
    annotation("jakarta.persistence.Entity")
    annotation("jakarta.persistence.MappedSuperclass")
    annotation("jakarta.persistence.Embeddable")
}
```

When the plugin is applied from the root with `apply(plugin = ...)`, the `allOpen { }` accessor is not
generated; use `configure<org.jetbrains.kotlin.allopen.gradle.AllOpenExtension> { annotation(...) }`.

**Check that flags actually reach each module** rather than trusting the root script: compile a
module class affected by the flag and inspect it with `javap -v -p`, or look for flag-specific
compiler output (for example the "redundant" warning on 2.4) in
`./gradlew :module:compileKotlin --rerun --console=plain`.

What each piece does:

- `plugin.spring` is `allopen` preconfigured for `@Component` (and stereotypes), `@Configuration`,
  `@Transactional`, `@Async`, `@Cacheable`, `@SpringBootTest`, including meta-annotations. It opens a
  class (and its members) only when the **class** carries one of them. A method-level
  `@Transactional`, `@Async` or `@Cacheable` opens nothing: a class without a stereotype, registered
  through a `@Bean` method, stays `final` (verified with `javap` on Kotlin 2.4.10), and startup fails
  with `AopConfigException: Could not generate CGLIB subclass ... Cannot subclass final class`. With
  Boot's default class-based proxying, implementing an interface does not avoid it. Annotate the class,
  add a stereotype, or declare it and the advised methods `open`. It does **not** open `@Entity` classes.
- `plugin.jpa` is `noarg` preconfigured for `@Entity`, `@Embeddable`, `@MappedSuperclass`. It
  generates a synthetic no-arg constructor that Hibernate can call. Kotlin code cannot call it.
  Since Kotlin 2.3.20 it also opens those classes (see above).
- `kotlin-reflect` is required by Spring (Boot 4.1 docs list it with `kotlin-stdlib`).
- Spring Boot 4 requires Kotlin 2.2+ and manages the Kotlin version. If the project pins Kotlin
  explicitly in the plugins block, keep the compiler and `kotlin-reflect`/stdlib versions aligned.
- Kotlin 2.1+ treats JSpecify annotations (used by Spring Framework 7) as strict nullability
  automatically. `-Xjsr305=strict` still matters for libraries that ship JSR-305 annotations.

Whether to apply `io.spring.dependency-management` is a project decision. Some projects leave it out
and import the Boot BOM with `platform(...)` because the plugin can override versions from other BOMs
(for example the kotlinx-coroutines BOM). Follow what the project already does; do not add or remove it
as a side effect.

## Dependency injection

```kotlin
@Service
class OrderService(
    private val orderRepository: OrderRepository,
    private val clock: Clock,
    @Qualifier("relayExecutor") private val executor: Executor,
)
```

- Single primary constructor, no `@Autowired`. Use `lateinit var` injection only in tests.
- **Default arguments are a fallback, not a choice.** For `clock: Clock = Clock.systemUTC()`, Spring
  uses the default only when *no* `Clock` bean exists. When one exists (maybe with a different zone),
  it is injected and the default is silently ignored. If the class needs a specific instance, give it
  a qualifier or a dedicated type. Do not rely on the default.
- **Parameter names do not reliably select beans.** Name matching is only a fallback, and a `@Primary`
  candidate wins first. When several beans share a type, use `@Qualifier` on the parameter.
- Nullable constructor parameters (`foo: Foo?`) make the dependency optional. Do not make a required
  dependency nullable to "fix" a startup failure; find out why the bean is missing.
- Use `ObjectProvider<T>` for genuinely lazy or scoped lookups. It also defers a missing-bean
  failure to first use, so do not use it to make startup pass.
- Constructors, `init` blocks, and `@PostConstruct` run on the raw target, not through the proxy.
  Transactions, caching, retry, and security advice do not apply there. Move such work to an
  `ApplicationReadyEvent` listener or an explicit call on the bean.
- In `@Configuration(proxyBeanMethods = false)` classes, and in classes with `@Bean` methods that are
  not `@Configuration` (a `@Component`, or a plain class brought in with `@Import`), calling another
  `@Bean` method directly creates a new instance each time. Take the dependency as a method parameter
  instead.
- **Beans are shared by every request and (virtual) thread.** Do not change a shared collaborator's
  settings per call (a retry policy, a header, a timeout on a shared template or client): concurrent
  calls see each other's settings. Build one configured instance per variant, or pass the options with
  each call.
- `@Async` runs on another thread. The caller's JPA/JDBC transaction **never** transfers to that
  thread; the async method must open its own transaction. (When the executor runs the task on the
  caller's thread instead, as `CallerRunsPolicy` does when the pool is full, it joins the caller's
  transaction.) The security context and MDC do not follow either, unless
  the executor propagates them (for example via a `TaskDecorator` or Micrometer context propagation).
- Top-level functions and `object`s are fine for pure helpers. Anything that needs configuration,
  a clock, or I/O should be a bean so it can be substituted in tests.

### Explicit and conditional registration

Some projects register beans with `@Bean` methods instead of stereotypes and scanning, or switch
implementations with conditions. When the project does:

- **`@ConditionalOnMissingBean` in your own configuration depends on order.** The condition sees only
  the bean definitions registered so far, and Boot's Javadoc recommends it for auto-configuration
  classes only. Between application configuration classes, a "fallback" bean is created next to the
  real one (two candidates of that type) or skipped, depending on processing order. Prefer conditions that do not depend on
  other beans (`@ConditionalOnProperty`, `@Profile`), or `@Primary`.
- **A bean of an auto-configured type turns Boot's bean off.** Most auto-configured beans are
  `@ConditionalOnMissingBean`: defining your own `KafkaTemplate`, `JsonMapper`, `Executor` or
  `TaskScheduler` removes Boot's, together with the `spring.*` properties that configured it
  ([scheduling-executors](scheduling-executors.md#async-and-executor-beans)). When you need an extra
  instance for one purpose (a dead-letter template, a separate pool), check that it does not match the
  auto-configuration's condition, or customize Boot's bean through its `*Customizer` hook instead.
- A custom `Condition` runs before `@ConfigurationProperties` beans exist. Read settings from the
  environment with the `Binder`:
  `Binder.get(context.environment).bind("app.feature.enabled", Boolean::class.java).orElseGet { false }`
  (`orElse` returns a nullable `Boolean?` in Boot 4, so `orElse(false)` does not compile as a `Boolean`).
- A class registered through `@Bean` is opened by `plugin.spring` only through class-level annotations
  ([build setup](#build-setup-gradle-kotlin-dsl)); method-level `@Transactional` leaves it `final`.

## Configuration properties

```kotlin
@ConfigurationProperties("app.slack")
@Validated
data class SlackProperties(
    @field:NotBlank val botToken: String,
    val baseUrl: URI = URI("https://slack.com/api/"),
    val timeout: Duration = Duration.ofSeconds(5),
    @field:Valid val retry: Retry = Retry(),
) {
    data class Retry(@field:Min(1) val maxAttempts: Int = 3, val backoff: Duration = Duration.ofMillis(200))

    override fun toString() = "SlackProperties(baseUrl=$baseUrl, timeout=$timeout, retry=$retry)"
}
```

- Use an immutable `data class` with `val`s. Constructor binding is automatic for a single primary
  constructor; no `@ConstructorBinding` needed.
- Register with `@ConfigurationPropertiesScan` on the application class, or
  `@EnableConfigurationProperties(SlackProperties::class)`. An unregistered class is not a bean.
- `@Validated` needs `spring-boot-starter-validation` on the classpath.
- Validation does not cascade by itself. Constraints inside a nested class (`Retry.maxAttempts`)
  are checked only when the nested property is marked `@Valid`, including when it is created
  from its default value.
- Default values in the constructor act as property defaults. Value classes are the exception: Boot
  4.1 docs say relying on a value class's default value does not work with property binding.
- **An unresolved placeholder is not a startup failure.** If YAML says `bot-token: ${SLACK_TOKEN}`
  and the variable is missing, the binder keeps the literal string `${SLACK_TOKEN}` (observed with
  Boot 4.1.1). `@Value` fails fast instead. For required secrets, add a constraint that rejects the
  literal (for example `@field:Pattern(regexp = "^[^$].*")`) or validate in an `init` block.
- A `data class` generates `toString()` with every field. Override it (as above) when the class holds
  secrets, or keep secrets out of the properties class.
- Blank is not missing. `bot-token: ""` binds successfully to a non-null `String`. Use
  `@field:NotBlank` for anything that must have content.
- Durations and sizes: use `Duration`/`DataSize` types so `5s`, `200ms`, `10MB` bind with units.
- Profile documents override key by key, not as whole files. A list set in a profile replaces the
  base list entirely, while maps merge per key. Check the effective value
  (`/actuator/configprops` in a non-public environment, or a binding test) before editing classes.
- Environment variables map by relaxed binding: `APP_SLACK_BOTTOKEN` → `app.slack.bot-token`
  (dashes are dropped, dots become underscores). List indexes use `_0_`.

### `@Value` in Kotlin

Kotlin string templates consume `$`. Escape it:

```kotlin
@Value("\${app.base-url}") private val baseUrl: String
```

Prefer `@ConfigurationProperties` for anything beyond a single value.

## Annotation use-site targets

Kotlin decides where an annotation on a constructor property (without an explicit `@field:`,
`@param:` target) lands. The default depends on the **language version**:

| Kotlin language version | Default for `@NotBlank val name: String` |
|---|---|
| 2.4+ | Constructor parameter **and** field (verified on 2.4.10; the compiler warns that `-Xannotation-default-target=param-property` is redundant) |
| 2.2–2.3 | Constructor parameter only, unless the build sets `-Xannotation-default-target=param-property` |
| < 2.2 | Constructor parameter only |

A parameter-only annotation matters mainly for **Bean Validation** on request DTOs (`@NotBlank`,
`@Size`, `@Valid` on nested objects): `@Valid @RequestBody` validates fields/getters, so a
parameter-only constraint is ignored. Jackson is different. It reads constructor-parameter
annotations (`@JsonProperty` on a creator parameter works), so a missing field target is rarely the
cause of a Jackson problem.

Rules:

- Check the effective language version (the Kotlin plugin version, or `languageVersion` if pinned
  lower). Below 2.4 without the flag, write `@field:NotBlank`, `@field:Valid` explicitly.
- On 2.4+, remove the now-redundant flag when touching the build, to silence the warning.
- Writing `@field:` explicitly is harmless on every version. Follow the project's existing habit.
- JPA mapping annotations (`@Id`, `@Column`) cannot target parameters, so they reach the field
  anyway, but many projects still write `@field:` for consistency.

## JSON (Jackson 3)

- Boot 4 uses Jackson 3. Kotlin support is `tools.jackson.module:jackson-module-kotlin` (group changed
  from `com.fasterxml.jackson.module` in Jackson 2). Boot registers it automatically when present.
- Jackson 3 **kept** the annotations package: `com.fasterxml.jackson.annotation.JsonProperty` is
  correct in a Jackson 3 project. Do not "migrate" annotation imports to `tools.jackson`.
- Databind classes moved: `tools.jackson.databind.ObjectMapper` and
  `tools.jackson.databind.json.JsonMapper`. Check which one the project injects before adding a new
  mapper bean.
- With the Kotlin module, a missing JSON field for a non-null constructor parameter without a
  default fails deserialization (400 in MVC). A parameter with a default gets the default. Decide
  per field whether "absent" means error or default; do not make everything nullable.
- `null` sent explicitly for a non-null parameter with a default also fails unless the module is
  configured otherwise. Test the contract with a real request.
- PATCH-style endpoints need three states (absent, explicit `null`, value). Ordinary nullable DTO
  fields collapse absent and `null`. Use an explicit patch model instead of guessing intent from
  `null`. If you reach for `JsonNullable` (`jackson-databind-nullable`), note two things: Jackson 3
  needs its `JsonNullableJackson3Module` (the Jackson 2 module does not register with
  `tools.jackson`), and the library documents limitations with creator (constructor) binding, which
  is how Kotlin DTOs deserialize. Write a test for absent, `null`, and value before relying on it.
- Pick time types deliberately: `Instant`/`OffsetDateTime` carry an instant, `LocalDateTime` does
  not. Serializing `LocalDateTime` across services or into Kafka silently depends on each side's zone.
- Kafka, Redis, and HTTP-client code often builds its own mapper. A global customization does not
  reach a private `JsonMapper.builder()` instance. Check which mapper the failing boundary uses.

## Spring's Kotlin extensions

Use these instead of Java-style calls:

| Instead of | Use |
|---|---|
| `repository.findById(id).orElse(null)` | `repository.findByIdOrNull(id)` (`org.springframework.data.repository.findByIdOrNull`) |
| `restClient.get()...body(Foo::class.java)` | `.body<Foo>()` (reified extension) |
| `ParameterizedTypeReference<List<Foo>>` | `.body<List<Foo>>()` |
| `context.getBean(Foo::class.java)` | `context.getBean<Foo>()` |

Derived repository queries may return nullable types directly: `fun findByEmail(email: String): User?`.
For no-result programmatic transactions, `transactionTemplate.executeWithoutResult { }` (a plain Java
method) reads better than `execute { }`.

Spring MVC honours Kotlin default values for optional handler parameters
(`@RequestParam size: Int = 20`). Do not duplicate them with `defaultValue = "20"`.

## Logging

- Common choice: `io.github.oshai:kotlin-logging-jvm` with a file-level
  `private val log = KotlinLogging.logger {}`. Use lambda messages: `log.info { "created $id" }`.
- **Name clash:** classes extending Spring bases such as `ResponseEntityExceptionHandler` inherit a
  `protected val logger` (commons-logging). A file-level `logger` is shadowed by the inherited member,
  producing confusing type errors. Use a different name (`log`) and keep it consistent in the project.
- Structured logging is built into Boot (`logging.structured.format.console=ecs|logstash|gelf`);
  do not add a Logstash encoder dependency just to get JSON logs.

## Checklist

- [ ] `plugin.spring` applied in the module; `plugin.jpa` where entities live (+ `allOpen` below Kotlin 2.3.20)
- [ ] `kotlin-reflect` and `jackson-module-kotlin` (Jackson 3 group) on the classpath
- [ ] No constructor default argument used to select a bean
- [ ] Classes registered with `@Bean` that need proxies carry a class-level annotation or are `open`
- [ ] No `@ConditionalOnMissingBean` fallbacks between application configuration classes
- [ ] Validation/Jackson annotations reach the field (Kotlin 2.4+, the flag on 2.2–2.3, or `@field:`)
- [ ] Properties classes registered, validated, with secret-safe `toString()`
- [ ] Required secret placeholders cannot bind as literal `${...}` strings
