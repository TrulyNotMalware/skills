---
name: kotlin-style
description: >
  How to write Kotlin: null safety and platform types, explicit types on public API, idiomatic
  constructs (val, when, data and sealed classes, scope functions, collections, named arguments),
  and the pitfalls that compile and run without error. Use when writing, reviewing, refactoring,
  or debugging any Kotlin code on the JVM: nullability, `!!`, `lateinit`, Java interop, casts and
  generics, `when` exhaustiveness, enums and sealed types, data class equality, `copy` and
  `toString`, constructors, extension functions, collections and sequences, numbers and
  BigDecimal, strings and locale, lambdas and non-local return, exceptions, `runCatching` and
  cancellation, compiler warnings, ktlint and detekt findings. Also use when Kotlin code "works
  but does the wrong thing" (a "null" string in output, a new enum value falling into `else`, a
  constructor value lost, a copy that resets a field, an overflow assigned to a Long). Use
  kotlin-spring-boot together with this skill for Spring Boot code.
---

# Kotlin style

The Kotlin compiler catches a lot, so the remaining mistakes are the ones it accepts: a Java value
that was null after all, an `else` branch that absorbs a new enum constant, a data class that
compares or copies differently than it looks, an `Int` product that overflowed before it became a
`Long`. This skill puts plain, idiomatic Kotlin first and lists those accepted mistakes with what
reports each one. Read the matching reference before writing or reviewing code in that area.

## Target versions

Verified 2026-10-02 by running code on these versions. Version-bound statements are tagged
`(Kotlin 2.4)`, `(ktlint 1.8)` or `(detekt 1.23)` / `(detekt 2.0)`.

| Component | Baseline | Notes |
|---|---|---|
| Kotlin | 2.4.10 on JVM 21 | K2 compiler. Opt-in checks: `explicitApi()`, `-Xreturn-value-checker`, `-Xname-based-destructuring` |
| ktlint | 1.8.0, `ktlint_official` | Formatting only: no semantic finding in about 55 probes |
| detekt | 1.23.8 stable; 2.0.0-alpha.6 | 1.23.8 cannot load Kotlin 2.4 library metadata (it reads up to 2.1), so type-resolved rules miss calls into the standard library without an error; use detekt 2.0 with `--analysis-mode full` for them |
| kotlinx.coroutines | 1.11.0 | Only for the cancellation pitfalls |

The project's own build wins. Read `build.gradle.kts` (Kotlin version, `compilerOptions`,
`explicitApi`, `allWarningsAsErrors`), `.editorconfig` (ktlint settings), the detekt config if any,
and the root `AGENTS.md`/`CLAUDE.md` first.

## Workflow

1. **Read the surrounding code first** and match its naming, error types, logging and test style.
   The codebase's conventions beat this skill's house defaults; the always-on rules still apply.
2. **Open the relevant reference** from the table below.
3. **Write the types at the edges first**: the Kotlin type of every value that comes from Java, a
   parser or a lookup, and the declared types of public functions and properties.
4. **Build and read every warning.** The compiler prints no warnings for a module that also has
   compile errors (Kotlin 2.4), so fix errors and build again before judging the warnings. Read them
   in Gradle's default output (`w:` lines): with `--warning-mode all`, Gradle 9.7 showed only the
   first 15 Kotlin warnings, as `Problem found: Kotlin compiler warning` blocks. **That mode can
   also come from `org.gradle.warning.mode=all` in `gradle.properties` or a preset that writes it**
   — check before counting: a `w:` count of 0 next to problem blocks means the mode is on, and
   exactly 15 blocks means the list was cut. The complete list is always in
   `build/reports/problems/problems-report.html` (count the distinct `"path":…,"line":` entries);
   on Gradle 9.8.0 with KGP 2.4.10, `--warning-mode=summary` printed the warnings nowhere on the
   console, so the report, not the console, is the source of truth (2026-10-06: a project preset had
   the property, and "0 warnings" was reported for a build that carried 16). An UP-TO-DATE compile task
   prints none, so force the compile (`--rerun-tasks` or after `clean`). Then run the project's
   ktlint and detekt tasks.
5. For behaviour that no tool reports (see Gotchas), write a test with the edge value: `null`, an
   empty list, a duplicate key, a negative number, a value near `Int.MAX_VALUE`, a new enum
   constant.

## Always-on rules

Basic Kotlin usage comes first; the house defaults below only fill in where these are silent.

- **`val` by default.** `var` only for state that really changes. Expose read-only types
  (`List`, `Map`), and hand out a copy (`toList()`) when the backing collection is mutable.
- **Non-null by default.** Resolve nullability once, at the boundary (Java calls, parsing,
  lookups, external input), with `?:`, an early return, `requireNotNull`/`checkNotNull`, or a
  default. Keep `T?` only where "absent" is a valid value. No `!!`; use `checkNotNull(x) { "why" }`.
- **Give every Java value a Kotlin type** where it enters the code (`val name: String? =
  javaObject.name`). An inferred platform type defers the NPE to a distant use site.
- **Public and protected functions and properties declare their types.** Private and local
  declarations may use inference. A public expression body (`fun total() = ...`) changes its type
  whenever the implementation does.
- **`when` over an enum, sealed type or `Boolean` lists every case and has no `else`.** Then a new
  case is a compile error instead of a silent fallthrough.
- **Model with types**: a fixed set of values is an `enum class` or sealed interface; a value
  record is a `data class` whose properties are all `val`s in the primary constructor, with no
  arrays and no secrets (its `toString` prints every property).
- **Exceptions**: `require` for arguments, `check` for state, specific exception types for the
  rest. Never catch `Throwable` or `Error`, and do not wrap suspending calls in `runCatching` or
  `catch (e: Exception)` without rethrowing `CancellationException`.
- **Scope functions for their purpose**: `let` to transform a value or handle a nullable, `apply`
  to configure a new object, `also` for a side effect, `run`/`with` to compute within a receiver.
  Do not nest them, and do not end a `?.let { }` with `?:` when the block can return `null`.
- No Java habits: no getters/setters around plain properties, no static utility classes (use
  top-level functions), no `Optional` (use `T?`), no Lombok.

## House defaults

The skill author's preferences. Apply them when the codebase has no convention of its own, and
drop them when they would fight an always-on rule.

- **Named arguments in Kotlin-to-Kotlin calls**, including constructors of data classes. Skip
  them for a single argument whose meaning is clear from the function name (`require(ok)`,
  `println(x)`), for varargs (`listOf(a, b)`), for trailing lambdas, and where Kotlin prohibits
  them: calls of Java methods and of function-type values (`onFailure(id, e)`). Positional
  arguments of the same type swap silently.
- **No redundant `this.`** Write it only to reach a receiver member that a local or parameter
  shadows. Neither ktlint 1.8 nor detekt 1.23/2.0 reports a redundant `this.`.
- **Prefer the standard library and existing DSLs** over manual loops and builders when the
  result reads as one expression (`groupBy`, `associate`, `buildList`, `sumOf`, the project's own
  builders), as long as the always-on rules about clarity and scope functions hold.
- **Comments only for what the code cannot say**: an external constraint, an ordering dependency,
  a reason. No narration of what the next line does.

## Reference routing

| Task touches... | Read |
|---|---|
| Nullable types, `!!`, `lateinit`, Java interop and platform types, JSpecify, `@Throws`, `@JvmOverloads`, `internal` from Java, declared vs inferred types, `explicitApi`, casts and generics | [reference/types.md](reference/types.md) |
| Collections (read-only vs immutable, duplicates, empty-collection exceptions, sequences, ranges, `getOrPut`), `when` and enums, scope functions, lambdas and `return`, ignored results, named arguments and destructuring, numbers, BigDecimal, floating point, strings, locale | [reference/idioms.md](reference/idioms.md) |
| Data classes (`equals`, `copy`, `toString`, arrays, private constructors), constructor parameters and properties, `object` state, extension functions, exceptions, `TODO()`, `runCatching` and cancellation, compiler options, ktlint and detekt setup | [reference/classes-errors.md](reference/classes-errors.md) |

## Gotchas

These compile, pass a quick manual check, and are wrong. Each reference file has a longer list and
says which tool, if any, reports the problem.

- Agent assigns a Java call to an inferred `val` - the NPE happens at a later use, far from the
  cause. See [types](reference/types.md#java-values-and-platform-types).
- Agent writes a public expression body (`fun env() = System.getenv("X")`) - callers get a
  platform type, or a new type when the implementation changes.
- Agent interpolates a nullable (`"user=$name"`) - the output contains the string `null`.
- Agent adds `else ->` to a `when` over an enum or sealed type - a new constant falls into it.
- Agent wraps a suspending call in `runCatching` or `catch (e: Exception)` - cancellation is
  swallowed and the code keeps running; `runCatching` also catches `OutOfMemoryError`.
  See [classes-errors](reference/classes-errors.md#exceptions).
- Agent leaves `TODO()` in a code path - `NotImplementedError` is an `Error` and escapes
  `catch (e: Exception)`.
- Agent writes a constructor parameter without `val` and expects a property - there is none; an
  unused parameter is dropped, and Kotlin 2.4 does not warn.
- Agent adds a `var` in a data class body - it is left out of `equals`, `toString` and `copy`, and
  `copy()` resets it.
- Agent puts an `Array` in a data class - `equals` compares the array references, so equal
  contents are not equal.
- Agent exposes a `MutableList` as `List` - callers can cast it back and mutate the owner.
- Agent builds a map with `associateBy` on keys that can repeat - earlier entries vanish.
- Agent calls `list.plus(x)` or `s.trim()` and ignores the result - nothing changes; only the
  opt-in `-Xreturn-value-checker` or a widened detekt rule reports it. See
  [idioms](reference/idioms.md#ignored-results).
- Agent writes `return` inside `forEach { }` - it returns from the enclosing function.
- Agent writes `val ms: Long = 30 * 24 * 60 * 60 * 1000` - the `Int` product overflows first.
- Agent compares `BigDecimal`s with `==` - `1.0` and `1.00` are not equal.
- Agent passes two arguments of the same type positionally - swapped values compile.

## Maintaining this skill

When bumping the target versions: update the table above, then grep this directory for
`Kotlin 2.`, `2.4`, `2.5`, `ktlint 1.`, `detekt 1.`, `detekt 2.`, `-X` and `alpha`, and re-run each
tagged statement. Compiler diagnostics and detekt rules change between releases (new K2 checks,
detekt 2.0 leaving alpha); re-run the pitfall-to-tool mapping in the references. The change
history is kept outside this directory, in the author's wiki.
