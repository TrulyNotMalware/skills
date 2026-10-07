# Gradle Kotlin DSL builds for Spring Boot

Multi-module Gradle builds with the Kotlin DSL (Gradle 9.x, Kotlin 2.4, Boot 4.1). Plugin and flag
basics are in [kotlin-spring-basics](kotlin-spring-basics.md#build-setup-gradle-kotlin-dsl). For
raising versions (what to bump, how to verify, Dependabot), use the `dependency-bump` skill instead
of this file.

Contents: [Know who owns each version](#know-who-owns-each-version) ·
[Importing the Spring Boot BOM](#importing-the-spring-boot-bom) ·
[Multi-module structure](#multi-module-structure) ·
[Kotlin compiler configuration](#kotlin-compiler-configuration) ·
[Excluding dependencies](#excluding-dependencies) ·
[Build behavior and verification](#build-behavior-and-verification) · [Gotchas](#gotchas)

## Know who owns each version

Before changing any version, find its authority:

| What | Usually owned by |
|---|---|
| Gradle itself | `gradle/wrapper/gradle-wrapper.properties` (change with `./gradlew wrapper --gradle-version X`) |
| Plugins (Boot, Kotlin, ktlint) | `plugins { }` in the root script, `pluginManagement` in `settings.gradle.kts`, or a version catalog |
| Spring-managed libraries (Spring, Jackson, Hibernate, Kafka, Testcontainers, kotlinx-coroutines, Kotlin stdlib) | The Spring Boot BOM |
| Everything else | Version catalog (`gradle/libs.versions.toml`) or `extra` properties in the root script |
| JDK | Toolchain (`jvmToolchain(N)`) plus the foojay resolver in `settings.gradle.kts` |

- Remove an explicit version before adding one. If the BOM manages a library, a hard-coded version
  in a module can change the tested combination; whether it wins depends on the mechanism below.
- Align library **families**, not single artifacts (all of Jackson, all of Netty, Kotlin stdlib +
  reflect + coroutines). Mixed family versions compile and then fail at runtime with
  `NoSuchMethodError`/`NoClassDefFoundError`.

## Importing the Spring Boot BOM

Two mechanisms, with different override rules. Check which one the build uses.

| Mechanism | How | Overriding one managed version |
|---|---|---|
| Gradle platform | `implementation(platform(SpringBootPlugin.BOM_COORDINATES))` | Gradle conflict resolution picks the **highest** requested version: an explicit higher version wins, an explicit **lower** version loses to the BOM. Boot's `xxx.version` properties do **not** apply |
| `io.spring.dependency-management` plugin | Applied alongside the Boot plugin | Set the BOM property, e.g. `extra["kotlin-coroutines.version"] = "1.11.0"`. An explicitly declared version wins in both directions (Maven-style) |

- `enforcedPlatform(...)` forces the BOM's versions over everything, including higher versions other
  dependencies need, and a library published with it imposes that on its consumers. Use a plain
  `platform` for anything reusable.
- Do not switch mechanisms as a side effect. They resolve differently (the dependency-management
  plugin can downgrade a version another BOM asked for; a platform lets the highest requested version
  win).
- Property names are the BOM's own (read them from the `spring-boot-dependencies` POM): for example
  `kotlin.version`, `kotlin-coroutines.version`, `jackson-bom.version`.
- **Boot 4.1.1's BOM defaults to Kotlin 2.3.21.** With the dependency-management plugin, the Boot
  plugin sets `kotlin.version` to the applied Kotlin plugin's version, so the libraries follow the
  compiler. With a plain `platform`, the plugin-added stdlib (the higher version) wins resolution.
  Either way, confirm the effective alignment rather than assuming it:
  `./gradlew :app:dependencyInsight --dependency kotlin-stdlib --configuration runtimeClasspath`
  (stdlib, `kotlin-reflect`, and coroutines should match the compiler you build with).
- **Every module that uses Spring needs the BOM**, including test-only and library modules. A module
  without it resolves whatever versions transitive dependencies ask for. That module's classpath can
  then carry an old Spring (for example `spring-core` 5.3.31 from an old `spring-data-commons`) while
  the application module resolves 7.x, even after Boot was upgraded. (Within one classpath Gradle
  picks one version per artifact, but different Spring artifacts can still end up on different
  versions.) (Maven `optional` dependencies are not
  inherited, so not every old library drags Spring in; check with `dependencyInsight`.) Apply the BOM in the shared convention, not per module.

## Multi-module structure

```
settings.gradle.kts          // include("domain", "application", "infrastructure"), foojay toolchain resolver
build.gradle.kts             // plugin versions (apply false) + shared conventions
domain/                      // pure Kotlin, no Spring
application/                 // Spring app: the only module with the Boot plugin's bootJar
infrastructure/              // adapters (JPA, Kafka, HTTP clients)
```

- Declare plugin versions once in the root `plugins { }` with `apply false`, then apply without
  versions in modules.
- Shared configuration: prefer **convention plugins** (`build-logic/` included build, or `buildSrc`)
  over `subprojects { }`/`allprojects { }`. Cross-project configuration works, but it blocks Gradle's
  isolated projects, is harder to reason about, and root-level blocks such as `kotlin { }` configure
  only the root project. Follow the existing structure; do not migrate as a side effect.
- In a `build-logic` included build, plugins used by convention scripts are ordinary
  `implementation` dependencies of `build-logic` (for example
  `implementation("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.10")`). Root `apply false`
  declarations do not reach it, a version catalog must be imported into it explicitly, and catalog
  aliases cannot be used in a precompiled script's `plugins { }` block.
- **Apply the Spring Boot plugin only to the application module.** In a library module without a main
  class, `assemble`/`build` fail on `bootJar` ("Main class name has not been configured"), and the
  plain jar (classifier `plain`) is not built by `assemble` while `bootJar` is enabled. Libraries need
  `java-library` plus the BOM. If the plugin must stay, disable `bootJar` and enable `jar` there.
- `api` vs `implementation`: `api` leaks the dependency to consumers' compile classpath. Use
  `implementation` unless the type appears in the module's public API. Leaked dependencies make
  conflicts appear only in downstream modules.
- Shared test data across modules: `java-test-fixtures` (`src/testFixtures`), consumed with
  `testImplementation(testFixtures(project(":domain")))`. The fixtures source set has its own
  configurations: a BOM declared on `implementation` does not reach it. Add
  `testFixturesImplementation(platform(...))` (or `testFixturesApi(platform(...))` when consumers need
  the constraints).
- Keep `domain` free of Spring (no BOM-managed Spring dependencies) if the architecture says so, and
  let the build enforce it; a stray `implementation("org.springframework:spring-context")` is
  easier to catch in review than a package import. Dependencies also arrive from shared build logic:
  a root `subprojects { dependencies { ... } }` block or a convention plugin adds them to `domain`
  without any change in its own build file. Guard the boundary with a test that fails when it breaks:
  an architecture test (ArchUnit, Konsist) for imports, plus a check that forbidden classes are absent
  from the module's test runtime classpath (`Class.forName` expecting `ClassNotFoundException`), which
  catches dependencies injected by shared build logic.

## Kotlin compiler configuration

```kotlin
// in each module's build file or a convention plugin, not the root build of a multi-module project
kotlin {
    jvmToolchain(25)
    compilerOptions {
        freeCompilerArgs.addAll("-Xjsr305=strict")
    }
}
```

- `jvmToolchain(25)` also sets the bytecode target to 25: the artifacts will not run on a Java 21
  runtime. Match the toolchain (or `jvmTarget`) to the JDK in the deployed image. The toolchain is not
  the JVM that runs Gradle itself (the daemon JVM is configured separately).
- **A module without a toolchain compiles with the JDK that runs Gradle**, and its bytecode target
  follows that JDK. The same sources then produce Java 21 bytecode on one machine and Java 25 on
  another. Set the toolchain in every module (a root `kotlin { }` block reaches only the root project)
  and check the result with `javap -v` (`major version`) on a module class.
- Do not add `-Xjvm-default=...`: Kotlin 2.2 replaced it with `-jvm-default` and made generating JVM
  default methods for interface functions the default. On 2.4 the old flag is only a deprecation
  warning but still takes effect (`-Xjvm-default=all` drops the `DefaultImpls` classes, a binary
  compatibility change).
- Use `compilerOptions { }`. The old `kotlinOptions { }` block no longer compiles with the Kotlin
  Gradle plugin 2.4 (build-script compilation error); it was deprecated earlier in 2.x.
- The Kotlin Gradle plugin version, the Kotlin stdlib version, and Boot's managed Kotlin version must
  agree. If the build pins the plugin to a newer Kotlin than Boot manages, make sure the stdlib and
  `kotlin-reflect` follow the plugin (they do by default when declared as `kotlin("reflect")`
  without a version).
- Annotation processing: `spring-boot-configuration-processor` (IDE metadata for
  `@ConfigurationProperties`) needs **kapt** in Kotlin; it has no KSP processor. kapt is in
  maintenance mode and slows builds. Add it only if the project wants the metadata.

## Excluding dependencies

- A per-dependency `exclude` applies to **that declaration only**. If another dependency brings the
  same artifact in through a different path (for example a starter that itself depends on
  `spring-boot-starter-web`), the excluded artifact is back.
- Find every path with `./gradlew :app:dependencyInsight --dependency tomcat-embed-core --configuration runtimeClasspath`.
- Verify the packaged result, not the declaration: `unzip -l app/build/libs/app.jar | grep tomcat`.
- Prefer declaring the pieces you need over a starter plus exclusions. `configurations.all { exclude }`
  works but hides the intent; use it deliberately and comment why.

## Build behavior and verification

- Run verification builds with warnings visible:
  `./gradlew build --warning-mode all --console=plain`. Without `--warning-mode all`, Gradle prints
  only a one-line "Deprecated Gradle features were used" summary, and `-q` hides even that, so "no
  warnings" from a quiet build is not evidence. (Kotlin compiler diagnostics for build scripts are a
  separate channel and can be hard errors regardless of warning mode.) The flag has a cost for
  Kotlin sources: Gradle 9.7.1 with Kotlin 2.4.10 then renders compiler warnings as "Problem found"
  blocks and showed only the first 15 of a task's warnings (15 of 20, 15 of 23) without a notice,
  while the default output listed every `w:` line. Read Kotlin warnings from a run without the flag
  that actually compiles: an UP-TO-DATE `compileKotlin` prints none, so add `--rerun-tasks` (or run
  after `clean`).
- Deprecated Kotlin DSL forms to avoid in new code (Gradle 9.x warns): `val x: String by extra` and
  `val t by tasks.getting`. Use `extra["x"] as String` and `tasks.named<T>("x") { }`. If Dependabot
  updates versions in the build script, declare them in a form its parser reads (a version catalog,
  `extra["x"] = "1.2.3"`, or `extra.set("x", "1.2.3")`) and keep the reads separate; test a new form
  before relying on it.
- Configuration cache: if the project enables it (`org.gradle.configuration-cache=true`), task actions
  must not access `Project` at execution time or capture unsupported objects; pass values through
  providers and task inputs. Separately, prefer lazy task APIs (`tasks.register`/`named`) over eager
  ones (`tasks.create`/`getByName`) for configuration time.
- `gradle.properties` is often machine-specific (heap sizes, daemon options) and sometimes
  git-ignored. CI jobs that do not generate it run with default heaps: pass the needed JVM options on
  the command line in CI (`-Dorg.gradle.jvmargs=... -Pkotlin.daemon.jvmargs=...`).
- Budget memory as a whole: the Gradle daemon, the Kotlin compile daemon (which inherits Gradle's
  heap settings unless configured, and can be more than one), and parallel test workers. A tool that
  runs inside the compiler (static analysis) raises the compiler's needs.
- `kotlin.incremental=false` turns off incremental compilation (on by default); it is independent of
  the build cache.
- `FROM-CACHE` means the task's inputs matched an existing cache entry. It is weak evidence either
  way: inputs can match an earlier state, and normalization can reuse results across dependency
  changes. Verify a dependency change by the resolved versions (`dependencyInsight`), not by task
  outcomes.
- If the build uses dependency locking or verification metadata (`gradle.lockfile`,
  `gradle/verification-metadata.xml`), update them intentionally: `--write-locks` per affected
  project/configuration (a root invocation does not cover every subproject), and review new checksums
  instead of regenerating blindly.
- Boot's layered jar puts project-module dependencies in the `application` layer by default; custom
  layers are needed only if module jars should be cached separately in images.

## Gotchas

- Agent adds a hard-coded version for a BOM-managed library - remove it and let the BOM decide.
- Agent sets `extra["xxx.version"]` in a build that imports the BOM as a `platform()` - the property is ignored.
- Agent adds a new module without the BOM - old transitive Spring/Jackson versions appear on its classpath.
- Agent applies the Spring Boot plugin to library modules - `bootJar` expects a main class.
- Agent uses `api` by default - dependencies leak into every consumer.
- Agent excludes a transitive artifact on one declaration and calls it done - check other paths and the packaged jar.
- Agent verifies with `./gradlew -q build` and reports "no warnings" - quiet mode hides them.
- Agent writes `kotlinOptions { }` (compile error on KGP 2.4) or `by extra` (deprecated) - use `compilerOptions { }` and `extra["x"]`.
- Agent declares a lower version than the BOM under `platform()` expecting a downgrade - the higher BOM version wins; use `strictly` or the BOM property with the dependency-management plugin.
- Agent puts compiler options in a root `kotlin { }` block of a multi-module build - only the root project gets them.
- Agent adds kapt for the configuration processor without being asked - it slows every build.

## Official sources

- [Spring Boot Gradle plugin](https://docs.spring.io/spring-boot/gradle-plugin/index.html)
- [Gradle: sharing build logic (convention plugins)](https://docs.gradle.org/current/userguide/sharing_build_logic_between_subprojects.html)
- [Gradle: platforms and BOMs](https://docs.gradle.org/current/userguide/platforms.html)
- [Kotlin Gradle plugin compiler options](https://kotlinlang.org/docs/gradle-compiler-options.html)
