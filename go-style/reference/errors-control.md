# Errors and control flow

Applies to Go 1.27.1 with a go.mod `go` line of 1.26 or later unless a rule carries a version tag
([tags and labels](versions-tools.md#reported-by-vocabulary)). These mistakes lose or misclassify an
error only on the failure path, which a quick manual test never takes: test each error path.

Contents: [The shape to aim for](#the-shape-to-aim-for) · [Wrapping and matching](#wrapping-and-matching) ·
[Sentinels, types and messages](#sentinels-types-and-messages) · [Handle each error once](#handle-each-error-once) ·
[Typed nil](#typed-nil) · [panic and recover](#panic-and-recover) · [defer](#defer) ·
[Exiting](#exiting) · [Shadowed err](#shadowed-err) · [Gotchas](#gotchas)

## The shape to aim for

```go
// ErrNotFound is returned, wrapped, when an order does not exist.
var ErrNotFound = errors.New("order not found")

// ValidationError reports an invalid field. Callers match it with errors.AsType.
type ValidationError struct {
	Field string
}

func (e *ValidationError) Error() string { return "invalid field " + e.Field }

func (s *Store) Get(id string) (Order, error) {
	o, ok := s.byID[id]
	if !ok {
		return Order{}, fmt.Errorf("get order %q: %w", id, ErrNotFound)
	}
	return o, nil
}

func Validate(o Order) error {
	if o.Total < 0 {
		return &ValidationError{Field: "Total"}
	}
	return nil // the untyped nil, never a nil *ValidationError
}

func HTTPStatus(err error) int {
	switch {
	case err == nil:
		return http.StatusOK
	case errors.Is(err, ErrNotFound):
		return http.StatusNotFound
	}
	if _, ok := errors.AsType[*ValidationError](err); ok {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}
```

The error is the last result; the message adds what the caller does not know (the ID); the
sentinel is matched with `errors.Is` and the type with `errors.AsType` (`errors.As` below a
`go 1.26` line), both of which see through any number of `%w` wraps; success returns a literal
`nil`.

## Wrapping and matching

- **`%v` (or `%s`) ends the chain**: after `fmt.Errorf("load: %v", err)`, `errors.Is(err,
  fs.ErrNotExist)` and `errors.As` are false. That is a bug where callers are meant to match the
  cause, and deliberate at a public API or system boundary ([house defaults](../SKILL.md#house-defaults);
  the baseline's errorlint then needs `//nolint:errorlint // <why>`).
  **`==`, `switch err`, a type assertion and a type switch** all missed a `%w`-wrapped sentinel or
  `*fs.PathError`. Reported by: `golangci:errorlint (opt-in)` for those four and for `%v`/`%s` of an
  error in `fmt.Errorf` (not `Printf`, `Sprintf` or `log.Printf`); comparing `err.Error()` strings:
  none — test or review (message text is not API).
- **`errors.As` needs a non-nil pointer to a variable of the target type.** A nil `*PathError` or
  `&pathErrValue` panics at run time, but only on the error path (`errors.As(nil, …)` returns false
  first), so a happy-path test passes. Reported by: `vet+test` (errorsas).
- **`errors.AsType[T]` `(toolchain ≥1.26)` checks the target at compile time**:
  `errors.AsType[fs.PathError]` (value type, pointer-receiver `Error`) does not compile. Below a
  `go 1.26` line it still builds on a 1.26+ toolchain; `vet` stdversion reports it (`vet+test` from
  toolchain 1.27). `go fix:errorsastype` rewrites `var pe *T; errors.As(err, &pe)` once the `go`
  line allows, producing `_, ok :=` when the value is unused. errcheck's opt-in `check-blank`
  reports every such `_, ok :=` form, `HTTPStatus` above included: a false positive for this API.
- **Chained `AsType` calls that reuse `err` test the wrong value**: variables declared in an `if`
  are visible in its `else if`.

  ```go
  // Wrong: in the else-if, err is the *NotFoundError declared by the first if.
  func classifyBad(err error) string {
  	if err, ok := errors.AsType[*NotFoundError](err); ok {
  		return "not found: " + err.ID
  	} else if err, ok := errors.AsType[*ValidationError](err); ok {
  		return "invalid: " + err.Field
  	}
  	return "other"
  }
  ```

  A wrapped `*ValidationError` was classified "other". Use distinct names (`nf`, `verr`) and
  separate `if` statements. Reported by: `gopls:errorsastypeshadow`; no golangci linter.
- **Several `%w` or `errors.Join`**: `errors.Is`/`As` search every branch, but `errors.Unwrap`
  returns nil, so a hand-written unwrap loop sees one link. Reported by: none — test or review.
- **`%w` with a pointer to a value-receiver error `(go ≥1.27)`.** `fmt.Errorf("op: %w", &E{})`
  where `E` implements `error`: callers matching `errors.Is(err, E{})` never match. Reported by:
  `vet+test` printf "defeats errors.Is", only in files whose `go` line is 1.27 or later, so raising
  the `go` line makes `go test` fail on existing code.

## Sentinels, types and messages

- Use the simplest form callers need: `errors.New`/`fmt.Errorf` when nobody matches; a sentinel
  `var ErrX = errors.New("…")` for a fixed condition; a `XxxError` type with a pointer receiver
  when callers need data. Reported by: `staticcheck ST1012` for a sentinel not named `ErrX`/`errX`;
  `golangci:errname (opt-in)` also for type names.
- **Error strings are lowercase without trailing punctuation**, because they get wrapped
  (`"load config: open x.yaml: no such file"`). Reported by: `staticcheck ST1005`.
- Add context the caller lacks (an ID, a path the callee does not print), not "failed to": the
  chain already says it failed, and `os` errors already contain the path.

## Handle each error once

- **Log or return, not both.** A function that logs an error and returns it gets the same failure
  logged again by every caller up the stack. The layer that decides (usually the top: `main`, a
  request handler, a job runner) logs it once. Reported by: none — test or review.
- **`if err != nil { return nil }`** returns success on failure; so does returning an earlier,
  already-checked `err` after checking `err2`. Reported by: `golangci:nilerr (opt-in)` for the
  first shape and `golangci:nilnesserr (opt-in)` for the second; each missed the other's shape.
- **Every error is checked.** An ignored `json.Unmarshal` error leaves the target zero or partly
  filled. Reported by: `golangci:errcheck (standard)`; `_ = f()`, `n, _ := strconv.Atoi(s)` and an
  unchecked `x.(T)` only with errcheck's `check-blank`/`check-type-assertions` settings or
  `golangci:forcetypeassert (opt-in)`. If ignoring is right (`(*bytes.Buffer).Write`), say why in
  a comment.

## Typed nil

An interface holding a nil pointer is not nil.

```go
// Wrong: when o is valid this returns a non-nil error holding a nil *ValidationError.
func validateBad(o Order) error {
	var verr *ValidationError
	if o.Total < 0 {
		verr = &ValidationError{Field: "Total"}
	}
	return verr
}
```

`validateBad(validOrder) != nil` is true, and `errors.As` then hands back a nil `*ValidationError`
that panics on use. The same happens with `return helper()` when `helper` returns `*ValidationError`.
Keep `error` as the result type of helpers and write `return nil` on success, as `Validate` above
does.

Reported by: `staticcheck SA4023` at the caller's comparison (never at the `return`), only when the
callee returns a non-nil interface on every path or the pointer is assigned to the interface in
the same function; silent for a callee that also has a `return nil` path (the realistic shape), a
package-level variable, and comparisons in `_test.go` files. `gopls:nilness` and
`golangci:govet nilness (opt-in)` add only the same-function shape.

## panic and recover

- Panic for programmer errors and impossible states, not for input or I/O failures. A `MustX`
  helper that panics belongs in package initialisation or tests. A package may use
  panic/recover internally (a recursive parser), but an internal panic never escapes its API.
- **`panic(nil)` `(main go ≥1.21)`**: see [versions-tools](versions-tools.md#matrices).
- **`recover` works only when the deferred function calls it directly**, as in
  `defer func() { if r := recover(); r != nil { err = fmt.Errorf("panic: %v", r) } }()` with a
  named result `err`. `defer handle()` recovers; `defer func() { handle() }()` with `recover` inside `handle` crashed
  the program. Reported by: `golangci:revive defer (opt-in)`, which flags every `recover` in a
  helper, including the working `defer handle()`.
- **A `recover` catches only its own goroutine's panic.** A panic in a goroutine started by the
  function ends the process, deferred `recover` in `main` or not. Each goroutine that may panic
  needs its own `defer`/`recover`; `errgroup` does not convert panics
  ([concurrency](concurrency.md#errgroup)), and `fatal error: concurrent map writes` is not a panic
  at all. Reported by: none — test or review.

## defer

- **Arguments are evaluated when `defer` runs, not at exit.** `defer log.Printf("took %v",
  time.Since(start))` printed microseconds for a 50 ms function; `defer fmt.Println(x)` prints the
  old `x`. Reported by: `vet` (defers, `time.Since` only); a plain value: none — test or review.
  Defer a closure (`defer func() { log.Printf("took %v", time.Since(start)) }()`).
- **`defer setup()` where `setup` returns the cleanup function** runs `setup` at exit and never
  the cleanup; write `defer setup()()`. Reported by: `staticcheck SA9010` (revive's opt-in `defer`
  rule flags the correct `()()` form instead).
- **`defer` in a loop runs when the function returns.** Opening five files in a loop with
  `defer f.Close()` kept all five open until return. Reported by: `staticcheck SA9001` (range over
  a channel) and SA5003 (endless `for {}`) only when the body has no `return` or `break`, so the
  usual `if err != nil { return err }` silences both; any loop: gocritic `deferInLoop` and revive
  `defer` (both opt-in). Move the loop body into a function.
- **A deferred `Close` on a file you wrote drops the error that reports lost data.** With a writer
  that fails on flush, `defer zw.Close()` returned nil while a checked `Close` returned "no space
  left on device". A read-only file can use `defer f.Close()`, but errcheck (standard, without
  the `std-error-handling` preset) reports it too: mark it (`//nolint:errcheck // read-only`) or
  follow the team's convention. Written files merge the error:

  ```go
  func WriteLines(path string, lines []string) (err error) {
  	f, err := os.Create(path)
  	if err != nil {
  		return err
  	}
  	defer func() {
  		if cerr := f.Close(); cerr != nil && err == nil {
  			err = cerr
  		}
  	}()
  	w := bufio.NewWriter(f)
  	for _, line := range lines {
  		if _, err = w.WriteString(line + "\n"); err != nil {
  			return err
  		}
  	}
  	return w.Flush()
  }
  ```

  Reported by: `golangci:errcheck (standard)`, but not when the config uses the
  `std-error-handling` exclusion preset ([versions-tools](versions-tools.md#golangci-lint-baseline)).
  Name the results only for a deferred closure like this one, or to tell same-typed results apart.

## Exiting

`os.Exit` and `log.Fatal*` skip deferred calls: with `defer w.Flush()` pending, both left a 0-byte
output file. Call them once, in `main`, and keep the work in a function that returns an error:

```go
func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1) // the only exit; run's deferred calls have already finished
	}
}

func run(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: report ID [ID ...]")
	}
	w := bufio.NewWriter(stdout)
	for _, id := range args {
		if _, err := fmt.Fprintf(w, "order %s\n", id); err != nil {
			return err
		}
	}
	return w.Flush()
}
```

Reported by: `golangci:gocritic exitAfterDefer (opt-in)` (in gocritic's default checks; it reports
only the first exit per function and not an exit inside a callee); `golangci:revive deep-exit
(opt-in)` for exits outside `main`/`init`.

## Shadowed err

```go
// Wrong: := declares a new n and err inside the if, so "42" and "abc" both return 0, nil.
func parseCountBad(s string) (int, error) {
	var n int
	var err error
	if s != "" {
		n, err := strconv.Atoi(s)
		if err == nil && n < 0 {
			return 0, errors.New("negative count")
		}
	}
	return n, err
}
```

Named results behave the same way. Reported by: `golangci:govet shadow (opt-in)`; not `go vet`, not gopls (shadow is off). Use `=` when the outer
variables exist, or return from inside the block. Using a result before its error check is a
separate bug that panics from Go 1.25 on ([versions-tools](versions-tools.md#matrices)).

## Gotchas

- Agent wraps with `%v` where callers match the cause, or compares with `==` - `errors.Is`/`As` stop matching.
- Agent chains `errors.AsType` calls in `if … else if`, each declaring `err` - the second call tests the first one's nil result.
- Agent returns a nil `*MyError` through `error` - callers see a non-nil error; SA4023 misses the mixed-return shape.
- Agent logs an error and also returns it - every layer logs the same failure.
- Agent writes `if err != nil { return nil }` - the failure becomes success.
- Agent defers `Close` on a file it wrote - a full disk returns nil; and `std-error-handling` hides errcheck's report.
- Agent defers `Close` inside a loop - descriptors stay open until the function returns.
- Agent defers `log.Printf(..., time.Since(start))` - the duration is computed at the `defer` line.
- Agent writes `defer setup()` where `setup` returns the cleanup - cleanup never runs.
- Agent calls `recover` inside a helper - it returns nil and the panic continues.
- Agent calls `log.Fatal` or `os.Exit` after a `defer` - buffers are not flushed.
- Agent writes `x, err := f()` inside an `if` that should set outer variables - the value and the error are lost.

## Official sources

- [Working with Errors in Go 1.13](https://go.dev/blog/go1.13-errors) and package [errors](https://pkg.go.dev/errors)
- [FAQ: Why is my nil error value not equal to nil?](https://go.dev/doc/faq#nil_error)
- [Defer, Panic, and Recover](https://go.dev/blog/defer-panic-and-recover) and [the spec on handling panics](https://go.dev/ref/spec#Handling_panics)
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) (error strings, handle errors, in-band errors)
