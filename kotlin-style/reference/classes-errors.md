# Classes, errors and tooling

Applies to Kotlin 2.4.10 on JVM 21. Each pitfall names what reports it: a compiler diagnostic, a
detekt rule, or **nothing**; ktlint 1.8 reports none of them. detekt notes follow
[types](types.md): "type resolution" means detekt 2.0 with `--analysis-mode full`, and "opt-in"
means inactive in the default configuration.

Contents: [Data classes](#data-classes) · [Constructors and properties](#constructors-and-properties) ·
[Extension functions](#extension-functions) · [Exceptions](#exceptions) · [Tooling](#tooling) ·
[Gotchas](#gotchas)

## Data classes

A data class derives `equals`, `hashCode`, `toString`, `componentN` and `copy` from the properties
of its **primary constructor**, and only from those.

```kotlin
import java.time.LocalDate

@ConsistentCopyVisibility
data class DateRange private constructor(val from: LocalDate, val to: LocalDate) {
    init {
        require(!from.isAfter(to)) { "from $from is after to $to" }
    }

    companion object {
        fun of(from: LocalDate, to: LocalDate): DateRange = DateRange(from = from, to = to)
    }
}

data class Credentials(val user: String, val password: String) {
    override fun toString(): String = "Credentials(user=$user, password=***)"
}
```

- **A property in the body is not part of the data.** `var note: String = ""` declared in the
  class body is ignored by `equals`, `hashCode` and `toString`, and `copy()` resets it to its
  initializer. Put every value that belongs to the record in the primary constructor. detekt
  `DataClassShouldBeImmutable` (opt-in) reports any `var` in a data class.
- **`toString` prints every constructor property**, passwords and tokens included, into logs,
  exception messages and user-facing text. Override `toString` (as `Credentials` above) or wrap
  the secret in a type whose `toString` redacts it. **Nothing** reports it.
- **Arrays have no value equality.** For an `Array` property the generated `equals` compares array
  references, while `hashCode` and `toString` use the contents: two instances with equal arrays
  print the same and hash the same but are not equal, and the hash code changes when the array is
  mutated. Kotlin 2.4 (K2) gives no warning. Use `List`.
- `copy()` is shallow: a `MutableList` property is shared between the original and the copy, and
  a change through one shows in both. **Nothing** reports it. Keep data class properties immutable.
- A data class with `var` properties used as a `HashMap` key or `HashSet` element becomes
  unreachable after a mutation (`contains` and `remove` return `false`). detekt
  `DataClassShouldBeImmutable` (opt-in).
- **`copy()` ignores a private constructor in Kotlin 2.4.** With `private constructor`, outside
  code can still call `copy(...)` and skip the factory. Kotlin 2.4 only warns
  (`DATA_CLASS_COPY_VISIBILITY_WILL_BE_CHANGED_WARNING` on the class,
  `DATA_CLASS_INVISIBLE_COPY_USAGE_WARNING` at the call) and the warning says it becomes an error
  in language version 2.5. Annotate the class `@ConsistentCopyVisibility` now; then `copy` has the
  constructor's visibility. `copy()` does run the primary constructor, so `init { require(...) }`
  also rejects an invalid copy.
- Data classes are for values. Do not use them for JPA entities or other objects with identity
  (see the kotlin-spring-boot skill).

## Constructors and properties

- **A constructor parameter without `val`/`var` declares no property.** It is visible only in
  property initializers and `init` blocks (and stays alive if a lambda created there captures it).
  In `class AppException(message: String, code: ErrorCode, detail: String) : RuntimeException(message)`,
  nothing uses `code` and `detail`, so they are dropped. Kotlin 2.4 gives no warning. detekt
  `UnusedPrivateProperty` (default) reports it, except that any call passing that name as a named
  argument hides it (detekt 1.23: any call anywhere; detekt 2.0: a call to that class). Declare
  `val` for what must be kept:

  ```kotlin
  enum class ErrorCode { NOT_FOUND, CONFLICT }

  class AppException(message: String, val code: ErrorCode, val detail: String? = null) : RuntimeException(message)
  ```

- **Do not read or call overridable members during construction.** A base-class initializer runs
  before the subclass's: with `open val size: Int = 1` read by `val captured = size` in the base
  class and `override val size: Int = 9` in the subclass, `captured` is `0`, not `1` or `9`; for an
  overridden `open val name: String` it is `null`, despite the non-null type. Kotlin 2.4 gives no
  warning. Keep initializers and `init` blocks to final members and constructor
  parameters.
- Initialize state in the primary constructor or in property initializers; use `init` blocks for
  validation. Prefer constructor parameters with defaults to secondary constructors.
- **An `object` is one instance per JVM (per class loader).** Mutable state in an `object` or a
  companion object survives between tests in the same Gradle test JVM, across test classes, and
  test order is not guaranteed. Keep `object`s stateless, or reset them explicitly in tests.

## Extension functions

- **A member always wins over an extension with the same signature.** `fun Account.close()`
  declared as an extension is never called if `Account` has a member `close()`; the compiler warns
  (`EXTENSION_SHADOWED_BY_MEMBER`) at the extension.
- **Extensions are resolved statically**, by the declared type of the receiver expression: with
  `fun Base.name()` and `fun Derived.name()`, a `val b: Base = Derived()` calls `Base.name()`.
  Use a member (or an interface method) when behaviour must depend on the runtime type.
  **Nothing** reports it.
- Put an extension next to the type or the feature it serves; a file of unrelated extensions on
  `String` or `Any` hides where behaviour lives.

## Exceptions

- `require(cond)` throws `IllegalArgumentException` ("Failed requirement." without a message
  lambda), `check(cond)` and `error(msg)` throw `IllegalStateException`, `requireNotNull` throws
  `IllegalArgumentException` and `checkNotNull` `IllegalStateException`. Pass a message lambda:
  `require(amount > 0) { "amount must be positive: $amount" }`.
- **`TODO()` throws `NotImplementedError`, which is an `Error`.** `catch (e: Exception)` does not
  catch it, so an unfinished branch reached in production escapes the usual error handling. Do
  not leave `TODO()` on reachable paths; throw `UnsupportedOperationException` where an operation
  is intentionally unsupported. detekt `NotImplementedDeclaration` (opt-in).
- **`runCatching` catches `Throwable`.** That includes `OutOfMemoryError`, `StackOverflowError`
  and, in coroutines, `CancellationException`: inside a cancelled coroutine,
  `runCatching { delay(1_000) }` returns a failure and the code after it keeps running until the
  next suspension point. Use `try`/`catch` with the exception types you can handle.
- **`catch (e: Exception)` around suspending calls swallows cancellation at every suspension
  point**: in a cancelled coroutine the body ran on to its end, catching the cancellation each
  time. Rethrow it first:

  ```kotlin
  import kotlin.coroutines.cancellation.CancellationException

  suspend fun refreshAll(ids: List<String>, refresh: suspend (String) -> Unit, onFailure: (String, Exception) -> Unit) {
      for (id in ids) {
          try {
              refresh(id)
          } catch (e: CancellationException) {
              throw e
          } catch (e: Exception) {
              onFailure(id, e)
          }
      }
  }
  ```

  `CancellationException` extends `IllegalStateException`, so `catch (e: IllegalStateException)`
  swallows it too. The broad `catch (e: Exception)` above is deliberate (one failed id must not stop
  the others) and still triggers detekt `TooGenericExceptionCaught`; suppress it there with a
  reason. detekt `TooGenericExceptionCaught` (default) reports the `catch (Exception)`;
  detekt 2.0 `SuspendFunSwallowedCancellation` (opt-in, type resolution) reports the swallowed
  cancellation, but also a `catch (CancellationException)` that logs before rethrowing (a false
  positive). detekt 1.23.8 has the rule but missed both cases on Kotlin 2.4 code. Structured
  concurrency and dispatchers are covered by the coroutines reference of the kotlin-spring-boot
  skill.
- Never catch `Throwable` or `Error`. Close resources with `use { }`.

## Tooling

What each tool contributed in the probes behind this skill (about 55 snippets):

| Tool | Reported | Did not report |
|---|---|---|
| Compiler (default) | `NO_ELSE_IN_WHEN`, `UNCHECKED_CAST`, `CAST_NEVER_SUCCEEDS`, `EXTENSION_SHADOWED_BY_MEMBER`, identity on boxed numbers, `DUPLICATE_BRANCH_CONDITION_IN_WHEN`, data class `copy` visibility, JSpecify nullability errors | platform types, nullable templates, overflow, unused constructor parameters, ignored results, `else` in `when`, `runCatching` |
| Compiler, opt-in | `explicitApi()`: missing visibility and return types; `-Xreturn-value-checker=check`: ignored results; `-Xname-based-destructuring=name-mismatch` (experimental): positional destructuring | |
| ktlint 1.8 | formatting only | every semantic pitfall |
| detekt (default rules) | `UnsafeCallOnNullableType`, `HasPlatformType`, `UnsafeCast` (never-succeeding casts), `TooGenericExceptionCaught`, `UnusedPrivateProperty`, `InvalidRange`, `ImplicitDefaultLocale` | most rules below need type resolution |
| detekt (opt-in) | `NullableToStringCall`, `ElseCaseInsteadOfExhaustiveWhen`, `DataClassShouldBeImmutable`, `DontDowncastCollectionTypes`, `LateinitUsage`, `NotImplementedDeclaration`, `NamedArguments`, `SuspendFunSwallowedCancellation` (2.0), `UnnamedParameterUse` (2.0) | |

```kotlin
kotlin {
    jvmToolchain(21)
    compilerOptions {
        allWarningsAsErrors = true
        freeCompilerArgs.addAll("-Xreturn-value-checker=check", "-Xrender-internal-diagnostic-names")
    }
}
```

- **Read warnings from a build without errors, in Gradle's default output.** The compiler prints
  no warnings for a module that also has errors (Kotlin 2.4; `-Xreport-all-warnings` keeps them),
  so they appear only once the errors are fixed. By default Gradle 9.7 prints them as plain
  `w: file:line` lines; with `--warning-mode all` it renders them as "Problem found" blocks and
  showed only the first 15 (15 of 20 and 15 of 23 in two runs) without saying so.
  `-Xrender-internal-diagnostic-names` adds the diagnostic name (`[RETURN_VALUE_NOT_USED]`) in both
  modes. Warnings are printed only when the task compiles: an UP-TO-DATE `compileKotlin` prints
  none, so rerun it (`--rerun-tasks`, or after `clean`) before concluding there are no warnings.
- `allWarningsAsErrors` turns every warning, deprecations included, into an error. Enable it on a
  codebase that builds without warnings; on an existing one, fix or explicitly suppress the
  current warnings first.
- **detekt on Kotlin 2.4**: detekt 1.23.8 (the latest stable release, built on the Kotlin 2.0
  compiler) analyses 2.4 sources without type resolution, but with `--classpath` it cannot read
  Kotlin 2.4 metadata, logs that only under `--debug`, and silently misses findings that depend
  on standard library types. Its CLI flag `--all-rules` had no effect; activate opt-in rules in
  the configuration file instead. detekt 2.0.0-alpha.6 (built on Kotlin 2.4) resolves types with
  `--analysis-mode full` and honours `--all-rules`. The bracket destructuring syntax
  `val [a, b] = pair` needs `-Xname-based-destructuring` in Kotlin 2.4; detekt 1.23.8 crashes on it,
  ktlint 1.8 rejects the file ("Not a valid Kotlin file"), and detekt 2.0 parses it.
- ktlint enforces formatting from `.editorconfig`. Do not hand-format against it; run its format
  task. Suppress a rule in `.editorconfig`, not with scattered `@Suppress`.

## Gotchas

- Agent adds a `var` in a data class body - it is ignored by `equals`/`toString`, and `copy()` resets it.
- Agent puts a password or token in a data class - `toString` writes it to logs and messages.
- Agent uses an `Array` property in a data class - equal contents are not `equal`; no warning in Kotlin 2.4.
- Agent relies on a private constructor of a data class to enforce a factory - `copy()` bypasses it unless the class has `@ConsistentCopyVisibility`.
- Agent writes a constructor parameter without `val` and never uses it - the value is dropped silently.
- Agent reads an `open` property in a base-class initializer - it sees the subclass value as uninitialized (`0`/`null`).
- Agent keeps mutable state in an `object` - it leaks between tests and requests.
- Agent defines an extension with the same signature as a member - the extension is never called.
- Agent expects an extension to dispatch on the runtime type - it dispatches on the declared type.
- Agent leaves `TODO()` reachable - `NotImplementedError` escapes `catch (e: Exception)`.
- Agent wraps a call in `runCatching` - it also catches `Error`s and coroutine cancellation.
- Agent catches `Exception` (or `IllegalStateException`) around suspending calls - cancellation is swallowed at every suspension point.
- Agent judges warnings from a build that also has compile errors - the warnings are not printed.
- Agent trusts detekt 1.23.8 with type resolution on Kotlin 2.4 code - it silently misses findings.

## Official sources

- [Data classes](https://kotlinlang.org/docs/data-classes.html)
- [Extensions](https://kotlinlang.org/docs/extensions.html)
- [Exceptions](https://kotlinlang.org/docs/exceptions.html)
- [Compiler options in the Kotlin Gradle plugin](https://kotlinlang.org/docs/gradle-compiler-options.html)
- [ktlint](https://pinterest.github.io/ktlint/) and [detekt](https://detekt.dev/)
