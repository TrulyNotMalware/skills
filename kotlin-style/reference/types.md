# Types, nullability and Java interop

Applies to Kotlin 2.4.10 on JVM 21. Each pitfall names what reports it: a compiler diagnostic, a
detekt rule, or **nothing**. ktlint 1.8 reports none of them; it checks formatting. detekt rules
marked "type resolution" fire only when detekt resolves types, which for Kotlin 2.4 code means
detekt 2.0 with `--analysis-mode full`. detekt 1.23.8 runs without an error but cannot read Kotlin
2.4 metadata, so calls into the standard library stay unresolved and those findings go missing.
"Opt-in" marks a detekt rule that is inactive in the default configuration.

Contents: [Non-null by default](#non-null-by-default) ·
[Java values and platform types](#java-values-and-platform-types) ·
[Declared and inferred types](#declared-and-inferred-types) · [Casts and generics](#casts-and-generics) ·
[Gotchas](#gotchas)

## Non-null by default

Resolve nullability where a value enters the code, and pass non-null values inward:

```kotlin
data class Customer(val id: Long, val email: String, val nickname: String?)

fun parseCustomer(row: Map<String, String?>): Customer {
    val id = requireNotNull(row["id"]?.toLongOrNull()) { "id missing or not a number: ${row["id"]}" }
    val email = row["email"]?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("email missing")
    return Customer(id = id, email = email, nickname = row["nickname"]?.ifBlank { null })
}
```

- Keep a property or parameter nullable only when "absent" is a valid value (`nickname` above),
  not to postpone a decision.
- **`!!` throws `NullPointerException` with no message** at that line. Use
  `checkNotNull(value) { "why it cannot be null here" }` (throws `IllegalStateException`) or
  `requireNotNull` for arguments (`IllegalArgumentException`). detekt `UnsafeCallOnNullableType`
  (default, type resolution).
- **A nullable in a string template prints `null`.** `"user=$name"` with `name == null` is
  `"user=null"`, and `name.toString()` on a nullable receiver returns `"null"`; neither throws.
  The value ends up in messages, keys and logs. detekt `NullableToStringCall` (opt-in, type
  resolution); nothing by default.
- **`lateinit var` read before assignment** throws `UninitializedPropertyAccessException`, a
  `RuntimeException`. Prefer constructor parameters, `by lazy`, or a nullable type; check
  `::prop.isInitialized` only where late initialization is the design (test fixtures). detekt
  `LateinitUsage` (opt-in).
- **`x?.let { ... } ?: fallback()` runs both** when the block's last expression is `null` (for
  example a function that returns `null`). Use `if (x != null) ... else ...` when the block can
  produce `null`. **Nothing** reports it.

## Java values and platform types

A value from a Java method without nullability annotations has a platform type (`String!`): Kotlin
lets you treat it as nullable or non-null, and checks nothing until you choose.

- **Inferred, the NPE moves to the use site.** `val home = System.getenv("APP_HOME")` compiles;
  `home.length` later throws a plain NPE (`Cannot invoke "String.length()" because "home" is null`)
  wherever it is used. Declared as
  `val home: String = System.getenv("APP_HOME")`, it fails at the assignment with
  `getenv(...) must not be null`. Declared as `String?`, the compiler makes you handle `null`.
  For a local `val`, **nothing** reports the inferred form; for a top-level or class property,
  detekt `HasPlatformType` (default, type resolution) does.
- **A public expression body exports the platform type.** `fun env() = System.getenv("X")` gives
  callers a `String!`; a caller's `env().length` throws a JVM NPE in the caller, with no Kotlin
  null check anywhere. Declare the return type. detekt `HasPlatformType` (default, type
  resolution).
- **JSpecify annotations remove the guesswork.** For a Java class annotated `@NullMarked`, Kotlin
  2.4 reads `@Nullable String` as `String?` and reports misuse as a compile **error** by default,
  and reads an unannotated `String` as non-null. Libraries that ship JSpecify annotations (Spring
  Framework 7 does) therefore give typed nullability; unannotated libraries still give platform
  types.
- **Kotlin has no checked exceptions, Java does.** A Kotlin function that throws `IOException`
  without `@Throws(IOException::class)` cannot be caught by that type in Java: `javac` rejects
  `catch (IOException e)` with "exception IOException is never thrown". Annotate functions that
  Java code calls.
- **Default arguments do not exist for Java callers.** Java must pass every argument unless the
  function has `@JvmOverloads`, which generates the shorter overloads.
- **`internal` is public on the JVM.** Member functions and properties get mangled names
  (`process$moduleName`) but stay `public`; top-level `internal` functions are not mangled at all.
  Java code in another module can call them. Do not rely on `internal` as an access barrier
  against Java.

## Declared and inferred types

Declare the type of every public and protected function and property; let private and local code
infer.

```kotlin
class OrderSummary(private val lines: List<Line>) {
    val itemCount: Int get() = lines.sumOf { it.quantity }

    fun totalCents(): Long = lines.sumOf { it.quantity * it.unitCents }

    private fun skus() = lines.map { it.sku }.toSet()
}

data class Line(val sku: String, val quantity: Int, val unitCents: Long)
```

- **An inferred public type follows the implementation.** With `fun total() = items.sumOf { it.qty
  }`, changing `qty` from `Int` to `Long` changes `total()` from `Int` to `Long`; callers in the
  same module keep compiling with the new type. **Nothing** reports it by default.
- **An expression body returns whatever the expression returns.** `fun save(order: Order) =
  repository.save(order)` returns the saved entity, and `fun start() = scope.launch { }` returns
  a `Job`, not `Unit`. Use a block body for side effects, or declare `: Unit`.
- Library modules: `kotlin { explicitApi() }` makes missing visibility modifiers and missing
  return types on public declarations compile errors (`NO_EXPLICIT_VISIBILITY_IN_API_MODE`,
  `NO_EXPLICIT_RETURN_TYPE_IN_API_MODE`). detekt `LibraryCodeMustSpecifyReturnType` is not in the
  CLI jars; it ships in the separate `detekt-rules-libraries` plugin.
- A property with a getter is recomputed on every access: `val now get() = Instant.now()` returns
  a new value each time, `val now = Instant.now()` keeps the first. Pick deliberately.

## Casts and generics

- `value as String` throws `ClassCastException` when the value is something else; `value as?
  String` returns `null`. The compiler warns (`CAST_NEVER_SUCCEEDS`) and detekt `UnsafeCast`
  (default, type resolution) reports only casts that can never succeed. A plausible but wrong cast
  is reported by **nothing**.
- **Generic casts are unchecked.** `any as List<String>` on a `List<Int>` succeeds (warning
  `UNCHECKED_CAST`); `size` and `joinToString()` work, `contains("1")` is silently `false`, and the
  `ClassCastException` comes only when an element is used as a `String`, possibly far away. Check
  the elements: `(any as? List<*>)?.filterIsInstance<String>()` keeps the matching ones and drops
  the rest, so to reject bad input test `all { it is String }` first. A `reified` type parameter
  does not help when the type argument is itself generic: an inline `castTo<List<String>>(listOf(1))`
  succeeds the same way.
- `===` on boxed numbers compares identity: two `Int?` values of `1000` are not identical, two of
  `100` are (the JVM caches small values). The compiler warns (`FORBIDDEN_IDENTITY_EQUALS_WARNING`
  for `Int?`, `DEPRECATED_IDENTITY_EQUALS` for `Int`); through `Any` it says nothing. Use `==`.

## Gotchas

- Agent assigns a Java result to an inferred `val` - the NPE appears at a later use, far from the cause.
- Agent writes `fun env() = javaApi.read()` as public API - callers receive a platform type.
- Agent adds `!!` to satisfy the compiler - an NPE without a message at runtime; use `checkNotNull` with a reason.
- Agent interpolates a nullable into a message or key - the string `"null"` appears; nothing reports it by default.
- Agent ends `?.let { }` with `?: fallback()` where the block can yield `null` - both branches run.
- Agent reads a `lateinit` property on a path that runs before initialization - `UninitializedPropertyAccessException`.
- Agent lets a public return type be inferred - it changes when the implementation changes, and callers recompile silently.
- Agent writes `fun save(x) = repository.save(x)` for a side effect - the function returns the entity, not `Unit`.
- Agent casts to `List<String>` - the cast cannot check elements; the failure comes later or never.
- Agent throws a checked Java exception from Kotlin that Java code calls - Java cannot catch it by type without `@Throws`.
- Agent treats `internal` as hidden from Java - it is public in bytecode.

## Official sources

- [Null safety](https://kotlinlang.org/docs/null-safety.html)
- [Calling Java from Kotlin (platform types, JSpecify)](https://kotlinlang.org/docs/java-interop.html)
- [Calling Kotlin from Java (`@Throws`, `@JvmOverloads`, `internal`)](https://kotlinlang.org/docs/java-to-kotlin-interop.html)
- [Explicit API mode](https://kotlinlang.org/docs/whatsnew14.html#explicit-api-mode-for-library-authors)
- [Coding conventions](https://kotlinlang.org/docs/coding-conventions.html)
