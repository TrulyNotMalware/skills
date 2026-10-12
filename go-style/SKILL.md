---
name: go-style
description: >
  How to write Go: idiomatic errors, naming and API shape, and the pitfalls that compile, pass
  go vet and a quick test, and are still wrong. Use when writing, reviewing, refactoring, or
  debugging any Go code (libraries, CLIs, services, tests): errors and wrapping, nil and typed nil,
  interfaces and embedding, slices, maps, strings and runes, numbers and conversions, time,
  encoding/json, bufio, defer, panic and recover, goroutines, channels and select, context,
  timers, sync, atomics and errgroup, table tests, benchmarks, test caching and the race detector,
  go.mod go lines and GODEBUG, and findings from go vet, staticcheck, golangci-lint, gopls or go
  fix. Also use when Go code "works but does the wrong thing" (a nil error that is not nil, two
  appends that overwrite each other, a JSON field that vanishes, a deferred Close whose error is
  lost, a seeded random that is random, a route that returns 404, a test that passes from the
  cache or tests only its last case).
---

# Go style

Go's tools catch less than they appear to: `go test` runs only part of vet, the go.mod `go` line
silently changes how loops and routes behave (and timers on 1.23–1.26 toolchains), and many
mistakes yield a plausible value instead of an error. This skill puts plain, idiomatic Go first and lists those mistakes with what
reports each one. Read the matching reference before writing or reviewing code in that area.

## Target versions

Verified 2026-10-08 by running code on these versions.

| Component | Baseline | Notes |
|---|---|---|
| Go toolchain | 1.27.1 (supported line: 1.26.8) | Older toolchains were used only for the version matrices |
| go.mod `go` line | 1.26 | Rules for other lines are tagged; `go mod init` writes the toolchain's own version (`go 1.27.1`) |
| staticcheck | 2026.2.1 (v0.8.1) | The CLI runs no QF checks; SA5011 no longer exists |
| golangci-lint | v2.14.0 | Config `version: "2"`; default output hides issues |
| gopls | v0.23.0 | `gopls check` hides hints unless `-severity=hint` |
| govulncheck | v1.8.0 | Not probed |

A change reaches a program through one of three gates; the version tags say which
([details and matrices](reference/versions-tools.md#the-three-gates)):

- `(go ≥1.22)` — language semantics: the `go` line of the module that contains the code.
- `(main go ≥1.24)` — GODEBUG behaviour: only the main module's `go` line and `godebug` settings.
- `(toolchain ≥1.25)` — anyone building with that toolchain or newer.

The project's own go.mod wins. Read its `go`, `toolchain` and `godebug` lines (and `go.work`), the
lint config, the CI scripts and the root `AGENTS.md`/`CLAUDE.md` first.

## Workflow

1. **Read the surrounding code first** and match its error handling, naming, logging and test
   style; it beats the house defaults, not the always-on rules. Open the matching reference.
2. **Write the signature before the body**: `ctx` first if it can block, `error` last, concrete
   return types, and who waits for any goroutine it starts.
3. **Run the checks the project runs, then these**:
   - `gofmt -l .` (or goimports) and `go vet ./...` (or `go test -vet=all`): plain `go test` runs
     12 of vet's analyzers, so copylocks, lostcancel, loopclosure and structtag findings need this.
   - The project's linter; for complete golangci-lint output add `--uniq-by-line=false
     --max-issues-per-linter=0 --max-same-issues=0`. No config: use the
     [baseline](reference/versions-tools.md#golangci-lint-baseline).
   - `go test -race -count=1 -shuffle=on ./...`: `-count=1` because cached results replay, `-race`
     because racy code passes plain `go test`.
   - `govulncheck ./...` when dependencies change; `go fix -diff ./...` only as a reviewed cleanup
     (it deletes `omitempty` from `time.Time` and struct fields instead of adding `omitzero`).
4. For behaviour no tool reports ("none — test or review"), write a test with the edge value: an
   error path, an empty or nil input, a canceled context, a second call, another `TZ`.

## Always-on rules

Effective Go, Go Code Review Comments and the Google and Uber guides agree on these (two or more
each).

- **gofmt decides formatting**; no fixed line length unless the linter sets one.
- **Every error is handled once**: returned with context the caller lacks, or logged and
  dropped at the top, never both. No `_ =` on an error without a comment saying why it is safe.
  Return `(T, error)` or `(T, bool)` instead of in-band values like `-1`.
- **Error strings** are lowercase, end without punctuation, and skip "failed to". Match errors with
  `errors.Is`/`errors.As`/`errors.AsType`, never `==` on a possibly wrapped error or the message
  text. `%w` makes the wrapped error part of your API.
- **Return early**; the happy path stays at the left margin, no `else` after `return`.
- **No panic for ordinary failures.** `MustX` only at initialisation or in tests; a panic used
  inside a package never escapes its API (programmer-error panics such as `MustCompile` are fine).
- **`ctx context.Context` is the first parameter**, never stored in a struct, and passed down: no
  `context.Background()` where a caller's ctx exists (`t.Context()` in tests); every `cancel` is
  called.
- **Every goroutine has an evident exit and a way to wait for it**: `Wait` before the starting
  function returns, or a `Close` that waits. Prefer synchronous APIs; callers add concurrency.
- **Never copy a value that holds a mutex, `WaitGroup` or atomic**, or whose methods have pointer
  receivers; a type's methods are all pointer or all value receivers.
- **Interfaces belong to the consumer** and stay small; return concrete types; none just to mock.
- **A nil slice is the empty slice**; check `len`, not `nil`. JSON (`null` vs `[]`),
  `reflect.DeepEqual` and `cmp.Diff` still tell them apart.
- **Names**: MixedCaps, one case per initialism (`ID`, `URL`), short consistent receivers (not
  `this`/`self`), no `Get` prefix, short lower-case package names (not `util`) not repeated.
- **Every exported name has a doc comment** that is a sentence starting with that name.
- **Named results** only to tell same-typed results apart or for a deferred closure that sets
  them; bare `return` only in very short functions.
- **Generics** only when the same code would otherwise be written for several types;
  **`crypto/rand`** for anything secret.
- **Tests**: failure messages name the function and input and print got before want; `t.Error` to
  keep going, `t.Fatal` when the rest cannot run; `t.Helper()` in helpers; `t.Fatal` only from the
  test's own goroutine; a table when every case runs the same checks.

## House defaults

The skill author's choices where the authorities disagree. Follow the codebase when it has a
convention; otherwise use these.

- **`%w` or `%v`**: `%w` between your own packages and wherever callers are meant to match the
  cause; at a module's public API or a system boundary (database driver, RPC), translate to your
  own sentinel or type, or use `%v` so callers cannot depend on an implementation detail.
- **Assertions**: the standard `testing` package plus `github.com/google/go-cmp` (`cmp.Diff`) for
  structures. In a codebase that uses testify, keep testify; never write a new assertion library.
- **Imports**: goimports' two groups (standard library, then the rest); a third only if present.
- **Enums**: the zero value is a named unset constant or a deliberate default; switches list all.
- **Constructors**: a config struct whose zero fields mean "default"; functional options only for
  a public constructor that most callers call without options and that will keep growing.
- **`var _ I = (*T)(nil)`** only where nothing else checks the interface; **capacity hints** only
  when the final size is known.
- **`init()`** only for registration or values that cannot fail; **`os.Exit`/`log.Fatal`** only
  in `main`, once, around a `run() error` function; **`context.Background()`** only in `main`,
  initialisation and `TestMain` (tests use `t.Context()`).
- **Tests** in the same package by default; an `_test` package for examples and API-level tests.

## Reference routing

| Task touches... | Read |
|---|---|
| go.mod `go`/`toolchain`/`godebug` lines, GODEBUG, version-gated behaviour (loop variables, ServeMux patterns, timers, `rand.Seed`, `panic(nil)`, `slices.Delete`), stdversion, `go fix`, what vet, `go test`, staticcheck, golangci-lint and gopls each run, a golangci-lint config, the "Reported by" labels | [reference/versions-tools.md](reference/versions-tools.md) |
| Errors (wrapping, `errors.Is`/`As`/`AsType`, `Join`, sentinels and types, messages, handling once), typed nil, panic and recover, defer, `os.Exit`/`log.Fatal`, shadowed `err` | [reference/errors-control.md](reference/errors-control.md) |
| Interfaces and embedding, method values, slices (`append` aliasing, range copies, nil vs empty), maps, strings and runes, integer overflow and conversions, durations and `time.Time`, `encoding/json`, `bufio.Scanner` | [reference/types-data.md](reference/types-data.md) |
| Goroutine lifetime and leaks, channels and `select`, `context`, timers, `sync` (mutexes, `WaitGroup`, `Once`, atomics), errgroup, concurrent maps, the race detector | [reference/concurrency.md](reference/concurrency.md) |
| Table tests, helpers and failure messages, `t.Parallel`, `t.Context` and cleanup, `b.Loop`, `testing/synctest`, the test cache, `-shuffle`, `-race`, goroutines in tests | [reference/testing.md](reference/testing.md) |
| Names, receivers, packages, interfaces and return types, zero values, constructors and options, doc comments, layout, `init` and globals, enums and exhaustive switches, generics, which naming checks are on by default | [reference/naming-api.md](reference/naming-api.md) |

## Gotchas

These compile, pass `go vet` and a quick test, and are wrong. Each reference has a longer list and
says which tool, if any, reports each one.

- Agent applies a "since Go 1.22" rule by toolchain - the `go` line decides: a go 1.21 module still shares loop variables, and a go 1.21 main module 404s on `"GET /items/{id}"`. See [versions-tools](reference/versions-tools.md#matrices).
- Agent runs `go test` and reports the code as vet-clean - copylocks, lostcancel and loopclosure are not in its subset.
- Agent reads golangci-lint's default output as complete - one issue per line and capped counts. See [versions-tools](reference/versions-tools.md#what-each-tool-runs).
- Agent returns a nil `*MyError` as `error` - callers see a non-nil error. See [errors-control](reference/errors-control.md#typed-nil).
- Agent wraps with `%v` where callers match the cause, or compares wrapped errors with `==` - matching silently stops working.
- Agent defers `Close` on a file it wrote - a failed write-back returns nil. See [errors-control](reference/errors-control.md#defer).
- Agent calls `log.Fatal` or `os.Exit` with a `defer` pending - buffered output is lost.
- Agent appends to a slice it did not allocate - two results share one array. See [types-data](reference/types-data.md#slices).
- Agent embeds `time.Time` in a JSON struct - the other fields vanish.
- Agent tags a `time.Time` or struct field `omitempty` - it is never omitted; use `omitzero`. See [types-data](reference/types-data.md#encodingjson).
- Agent scans lines without checking `sc.Err()` - everything after a 64 KiB line is dropped.
- Agent compares `time.Time` with `==` or parses without a location - wrong answers, host-dependent.
- Agent starts a goroutine that sends on an unbuffered channel and returns on `ctx.Done()` - the goroutine leaks. See [concurrency](reference/concurrency.md#goroutine-lifetime-and-leaks).
- Agent writes `break` in a `select` inside a `for` - only the `select` is left.
- Agent uses `t.Context()` in `t.Cleanup` or relies on a cached `go test` pass - canceled context, stale result. See [testing](reference/testing.md#contexts-and-cleanup) and [running the tests](reference/testing.md#running-the-tests).

## Maintaining this skill

When bumping versions: update the table above, re-run the tool matrices in
`reference/versions-tools.md` first (vet's analyzers, the `go test` subset, `go tool fix help`,
golangci-lint defaults), then grep for `go ≥`, `main go ≥`, `toolchain ≥`, `1.27`, `1.28`,
`GODEBUG`, `GOEXPERIMENT`, `SA`, `golangci`, `gopls`, `go fix` and `x/sync` and re-run each tagged
statement. The change history is kept outside this directory, in the author's wiki.
