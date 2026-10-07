# Idioms and silent pitfalls

Applies to Kotlin 2.4.10 on JVM 21. Each pitfall names what reports it: a compiler diagnostic, a
detekt rule, or **nothing**; ktlint 1.8 reports none of them. detekt notes follow
[types](types.md): "type resolution" means detekt 2.0 with `--analysis-mode full`, and "opt-in"
means inactive in the default configuration. The ones marked **nothing** need review and tests.

Contents: [Prefer the direct construct](#prefer-the-direct-construct) · [Collections](#collections) ·
[`when` and enums](#when-and-enums) · [Scope functions and lambdas](#scope-functions-and-lambdas) ·
[Ignored results](#ignored-results) · [Named arguments and destructuring](#named-arguments-and-destructuring) ·
[Numbers](#numbers) · [Strings and locale](#strings-and-locale) · [Gotchas](#gotchas)

## Prefer the direct construct

```kotlin
enum class Status { PENDING, PAID, CANCELLED }

data class Line(val sku: String, val quantity: Int, val unitCents: Long)

data class Order(val id: Long, val status: Status, val lines: List<Line>)

fun label(status: Status): String =
    when (status) {
        Status.PENDING -> "waiting for payment"
        Status.PAID -> "paid"
        Status.CANCELLED -> "cancelled"
    }

fun totalCents(order: Order): Long = order.lines.sumOf { line -> line.quantity * line.unitCents }

fun quantityBySku(orders: List<Order>): Map<String, Int> =
    orders.flatMap { it.lines }.groupingBy { it.sku }.fold(0) { sum, line -> sum + line.quantity }

fun firstPaid(orders: List<Order>): Order? = orders.firstOrNull { it.status == Status.PAID }

fun summary(order: Order): String =
    buildString {
        append("order ").append(order.id).append(": ").append(label(order.status))
        order.lines.forEach { line -> append("\n  ").append(line.sku).append(" x").append(line.quantity) }
    }
```

`when` without `else`, `sumOf` with a `Long` selector, grouping without a mutable map,
`firstOrNull` instead of `first` plus a try, and a builder instead of string concatenation in a
loop.

## Collections

- **Read-only is not immutable.** `List` has no `add`, but the object behind it may be a
  `MutableList`. A class that returns its backing list as `List` lets a caller write
  `(owner.items as MutableList).add(x)` and change the owner; even without a cast, the caller's
  view shows later changes. Return `items.toList()` (a copy) or keep the mutable list private and
  expose a copy. detekt `DontDowncastCollectionTypes` (opt-in, type resolution) reports the cast.
- What `listOf` returns is an implementation detail: `listOf(1, 2)` is a fixed-size array-backed
  list (`set` works after a cast, `add` throws `UnsupportedOperationException`), `listOf(1)` is a
  singleton list (`set` throws too), while the result of `map { }` is an `ArrayList`. Do not cast
  read-only collections to mutable ones.
- **`+=` depends on the declared type.** On `var xs: List<Int>` it builds a new list and reassigns
  `xs`, so another reference to the old list does not see the element; on `val xs: MutableList<Int>`
  it adds to the shared list. When sharing matters, write `xs.add(x)` or `xs = xs + x` explicitly.
  **Nothing** reports it.
- **Duplicate keys are dropped silently.** `associateBy`, `associate`, `associateWith`, `toMap`
  and `mapOf` keep the last value for a repeated key. Use `groupBy` when keys can repeat, or check
  `map.size == list.size`. **Nothing** reports it.
- **Empty and ambiguous collections throw.** `first()`, `last()`, `max()`, `maxOf { }` throw
  `NoSuchElementException` on an empty collection, `single()` throws `IllegalArgumentException`
  on two elements, `reduce` throws `UnsupportedOperationException` on an empty one. Use
  `firstOrNull`, `maxOrNull`, `singleOrNull` or `fold` where empty is possible.
- **A `Sequence` re-runs its pipeline for every terminal operation.** Iterating a mapped sequence
  twice calls the lambda twice per element; a `List` from `map` computes once. A sequence from an
  iterator (`iterator.asSequence()`) can be iterated only once; the second pass throws
  `IllegalStateException`. Use sequences for long or lazy pipelines that are consumed once.
- **Ranges are inclusive.** `for (i in 0..list.size)` reads one past the end. Use `list.indices`,
  `0 until n` or `0..<n`. detekt `InvalidRange` (default) reports empty ranges like `3..0`, and
  `UntilInsteadOfRangeTo` (`RangeUntilInsteadOfRangeTo` in detekt 2.0, opt-in) reports
  `0..size - 1`; `0..size` is reported by **nothing**.
- **`getOrPut` is atomic only through a `ConcurrentMap` type, and the lambda may still run more
  than once.** With `val cache: MutableMap<K, V> = ConcurrentHashMap()` the call compiles to a
  separate `get` and `put`: under contention several threads computed and saw different values
  (32 threads, 1 ms lambda: up to 32 different values per round). Typed as `ConcurrentMap`, it uses `putIfAbsent`:
  every caller saw one value, but the lambda still ran up to 32 times. `ConcurrentHashMap.computeIfAbsent`
  ran it once; that is part of its contract, not of every `ConcurrentMap` (the default
  implementation, used for example by `ConcurrentSkipListMap`, computes and then calls
  `putIfAbsent`). Use `ConcurrentHashMap.computeIfAbsent` when the lambda is expensive, and do not
  treat it as exactly-once: after a removal, a `null` result or an exception it computes again.

## `when` and enums

- **`else` absorbs new cases.** With `else ->` in a `when` over an enum or sealed type, a constant
  or subtype added later compiles and silently takes the `else` branch. Without `else`, both a
  `when` expression and a `when` statement over the type fail to compile (`NO_ELSE_IN_WHEN`) until
  the new case is handled. detekt `ElseCaseInsteadOfExhaustiveWhen` (opt-in, type resolution).
- The compiler warns only about an exact duplicate condition (`DUPLICATE_BRANCH_CONDITION_IN_WHEN`).
  A range that overlaps an earlier one, or an `is` subtype after its supertype, is unreachable with
  **no** warning: the first matching branch wins.
- `Status.valueOf("UNKNOWN")` throws `IllegalArgumentException` ("No enum constant ..."). Parse
  external input with `Status.entries.firstOrNull { it.name == raw }`. Prefer `entries` to
  `values()`: `values()` allocates a new array on every call (no warning in Kotlin 2.4).

## Scope functions and lambdas

| Function | Receiver as | Returns | Use for |
|---|---|---|---|
| `let` | `it` | lambda result | transform a value, act on a non-null value |
| `run` | `this` | lambda result | compute something from a receiver |
| `with(x)` | `this` | lambda result | several calls on one object |
| `apply` | `this` | receiver | configure a newly created object |
| `also` | `it` | receiver | side effects (logging, validation) in a chain |

- **Locals shadow receiver members inside `apply`/`run`/`with`.** With a local `var name` in
  scope, `Person().apply { name = "y" }` assigns the local variable and leaves `Person.name`
  unchanged. With a `val` local or a parameter of that name the code does not compile
  (`VAL_REASSIGNMENT`); with a `var` it does, and **nothing** reports it. Write `this.name = ...`
  when a local has the same name, or rename the local.
- **`return` inside `forEach { }` returns from the enclosing function.** The lambda is inlined, so
  `listOf(1, 2, 3).forEach { if (it == 2) return "early" }` leaves the function at the second
  element and skips everything after the loop. Use `return@forEach` to skip one element, or a
  `for` loop when you mean to leave early. **Nothing** reports it (detekt `LabeledExpression`,
  opt-in, even flags the `return@forEach` fix).
- Do not chain or nest scope functions to avoid a local variable; `it` and `this` lose their
  meaning after one level. A named local is clearer.

## Ignored results

Most collection and string functions return a new value and leave the receiver unchanged:
`list.plus(x)`, `list.sorted()`, `list.map { }`, `list.filter { }`, `s.trim()`, `s.replace(...)`.
Calling one as a statement throws the result away and leaves the receiver unchanged; the lambda of
an eager `map` or `filter` still runs, side effects included. Use `forEach` when only the side
effect is wanted.

- By default neither the compiler nor ktlint reports it, and detekt only for the return types below.
- The compiler reports it with `-Xreturn-value-checker=check` (Kotlin 2.4): `RETURN_VALUE_NOT_USED`
  for `map`, `filter`, `sorted`, `plus`, `trim`, `replace` and `Sequence.map`. It does not flag
  `MutableList.add` or `copy()`; `=full` also flags `copy()`.

  ```kotlin
  kotlin {
      compilerOptions { freeCompilerArgs.add("-Xreturn-value-checker=check") }
  }
  ```

- detekt `IgnoredReturnValue` (default, type resolution) checks functions annotated
  `@CheckReturnValue` and functions returning `Sequence`, `*Flow` or `*Stream` (detekt 2.0 also
  function types): an ignored `asSequence().map { }` is reported, an ignored `list.map { }` is not.
  With `restrictToConfig: false` it reports every ignored result, including `copy`,
  `MutableList.add`, `getOrPut`, `first` and `await`, which is noisy.

## Named arguments and destructuring

- **Positional arguments of the same type swap silently.** `transfer(to, from, amount)` compiles
  against `fun transfer(from: String, to: String, amount: Long)`. Named arguments make the call
  site checkable and survive parameter reordering: `transfer(from = a, to = b, amount = 100)`.
  detekt `NamedArguments` (opt-in, type resolution) reports calls with more than 3 arguments unless all are named (`threshold` in 1.23, `allowedArguments` in 2.0), so the three-argument swap above is not reported; detekt 2.0
  `UnnamedParameterUse` (opt-in, type resolution) reports arguments whose variable name matches a
  different parameter. No rule reports a bare `true`/`false` argument.
- **Destructuring is positional.** `val (y, x) = point` assigns `point.x` to `y`; if a data class
  reorders its properties, every destructuring call site swaps values without an error. Kotlin 2.4
  has an experimental `-Xname-based-destructuring`: `=name-mismatch` warns
  (`DESTRUCTURING_SHORT_FORM_NAME_MISMATCH`, also on ordinary `for ((id, fn) in pairs)` loops) and
  `=complete` binds by name, which breaks `val (a, b) = pair`; with the flag, `val [a, b] = pair`
  is the positional form. Prefer property access (`point.x`) for classes with several properties
  of one type; without the flag, keep destructuring for `Pair`, `Map.Entry` and short lambdas,
  where position is the meaning.

## Numbers

- **`Int` arithmetic overflows silently, also on the way to a `Long`.** `val ms: Long = 30 * 24 *
  60 * 60 * 1000` is `-1702967296`: the product is computed as `Int` and then widened.
  `Int.MAX_VALUE + 1` wraps to `Int.MIN_VALUE` with no warning, even as a constant. Make the first
  operand a `Long` (`30L * ...`), use `Duration`/`TimeUnit` for times, or `Math.addExact` and
  `multiplyExact` where overflow must fail. **Nothing** reports it.
- Division and remainder truncate toward zero: `-7 / 2 == -3`, `-7 % 2 == -1`, `(-7).mod(2) == 1`,
  `Math.floorDiv(-7, 2) == -4`. Note `-7.mod(2) == -1`: unary minus applies after the call.
- Conversions truncate and saturate: `2.9.toInt() == 2`, `(-2.9).toInt() == -2`,
  `Double.NaN.toInt() == 0`, `1e20.toInt() == Int.MAX_VALUE`, `3_000_000_000L.toInt()` wraps to a
  negative number. `kotlin.math.round(2.5) == 2.0` (half to even) but `2.5.roundToInt() == 3`.
- **`BigDecimal` `==` is `equals`, which compares scale.** `BigDecimal("1.0") == BigDecimal("1.00")`
  is `false`, while `<`, `<=` and `compareTo` ignore scale; a `HashSet` keeps both values, a
  `sortedSetOf` keeps one. Compare amounts with `compareTo(...) == 0`, or normalize the scale
  first. For money prefer `Long` minor units or `BigDecimal` with a fixed scale. **Nothing**
  reports `==`.
- **`BigDecimal` `/` keeps the dividend's scale and rounds half to even.** `BigDecimal("1") /
  BigDecimal("2")` is `0`, `BigDecimal("10") / BigDecimal("4")` is `2`, `BigDecimal("1.0") /
  BigDecimal("3")` is `0.3`. Call `divide(other, scale, RoundingMode)` or pass a `MathContext`.
  **Nothing** reports it.
- Floating point: `0.1 + 0.2 == 0.3` is `false`. `==` follows IEEE 754 only when both sides are
  statically `Double` or `Double?` (`NaN == NaN` is `false`, `-0.0 == 0.0` is `true`); through
  `Any` or inside collections it uses `equals` (`listOf(Double.NaN).contains(Double.NaN)` is
  `true`, `listOf(-0.0).contains(0.0)` is `false`).
- `'1'.toInt()` is `49`, the character code, with only a deprecation warning. Use
  `'1'.digitToInt()` for the digit and `.code` for the code.

## Strings and locale

- **`split` keeps trailing empty strings**, unlike Java's `String.split`: `"a,b,,".split(",")` is
  `[a, b, , ]`, and `"".split(",")` is `[""]`. A string argument is literal, not a regex
  (`"a.b".split(".")` is `[a, b]`); `split(Regex("."))` splits on every character.
- `lowercase()` and `uppercase()` are locale-invariant. `lowercase(Locale.getDefault())` and Java's
  `toLowerCase()` follow the default locale (Turkish: `"TITLE"` becomes `"tıtle"`); Kotlin's
  `toLowerCase()` is a compile error (`DEPRECATION_ERROR`) in Kotlin 2.4.
- **`format` uses the default locale.** `"%.2f".format(1.5)` is `"1,50"` under `Locale.GERMANY`,
  and parsing it back with `toDouble()` throws. Pass `Locale.ROOT` for machine-readable output
  (`"%.2f".format(Locale.ROOT, value)`). detekt `ImplicitDefaultLocale` (default) reports
  `String.format(...)` in detekt 1.23.8 but not the `"...".format(...)` extension; detekt 2.0
  reports both, with type resolution only. String templates (`"$value"`) are
  locale-independent.

## Gotchas

- Agent exposes a mutable backing list as `List` - callers can cast it and mutate the owner.
- Agent builds a map with `associateBy`/`toMap` on keys that can repeat - earlier entries vanish without an error.
- Agent calls `first()`/`max()`/`single()` on data that can be empty or repeated - an exception instead of a value.
- Agent iterates a `Sequence` twice - the whole pipeline runs twice, or fails for an iterator-backed sequence.
- Agent loops `for (i in 0..list.size)` - one index past the end.
- Agent uses `getOrPut` on a `ConcurrentHashMap` typed as `MutableMap` - not atomic; callers can get different values.
- Agent adds `else ->` to a `when` over an enum or sealed type - new cases fall into it silently.
- Agent parses external input with `valueOf` - an unknown value throws `IllegalArgumentException`.
- Agent assigns a property inside `apply` while a local `var` has the same name - the local changes, not the property.
- Agent writes `return` inside `forEach` to skip an element - the whole function returns.
- Agent calls `list.plus(x)`, `list.sorted()` or `s.trim()` as a statement - nothing changes.
- Agent passes arguments of the same type positionally - a swap compiles.
- Agent destructures a data class with several same-typed properties - a reordered class swaps values silently.
- Agent multiplies `Int` literals for a `Long` duration - overflow before widening.
- Agent compares `BigDecimal` with `==` - scale-sensitive; `1.0 != 1.00`.
- Agent converts a `Char` digit with `toInt()` - gets the character code.
- Agent formats a number with `"%.2f".format(x)` for a file or API - a comma decimal separator under some locales.

## Official sources

- [Idioms](https://kotlinlang.org/docs/idioms.html) and [Coding conventions](https://kotlinlang.org/docs/coding-conventions.html)
- [Scope functions](https://kotlinlang.org/docs/scope-functions.html)
- [Collections overview](https://kotlinlang.org/docs/collections-overview.html) and [Sequences](https://kotlinlang.org/docs/sequences.html)
- [Returns and jumps](https://kotlinlang.org/docs/returns.html)
- [Numbers](https://kotlinlang.org/docs/numbers.html) and [Equality](https://kotlinlang.org/docs/equality.html)
