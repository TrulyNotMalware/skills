# Versions, gates and tools

Applies to the Go 1.27.1 toolchain with go.mod `go` lines from 1.21 to 1.27, staticcheck 2026.2.1,
golangci-lint v2.14.0 and gopls v0.23.0. Every matrix below was run with those versions unless a
row says "(docs)". Read this before trusting a "since Go 1.x" rule, a tool's silence, or a
`go fix` rewrite.

Contents: [The three gates](#the-three-gates) · [Matrices](#matrices) ·
[Version boundaries](#version-boundaries) · [stdversion](#stdversion) · [go fix](#go-fix) ·
[What each tool runs](#what-each-tool-runs) · [golangci-lint baseline](#golangci-lint-baseline) ·
[Reported-by vocabulary](#reported-by-vocabulary) · [Gotchas](#gotchas)

## The three gates

A Go change reaches a program by one of three routes, and the go.mod `go` line plays a different
part in each:

| Tag | Gate | Who decides |
|---|---|---|
| `(go ≥1.22)` | Language semantics (loop variables, generic methods, vet checks keyed to the file version) | The `go` line of the module that contains the code. A `//go:build go1.21` line lowers it for one file |
| `(main go ≥1.24)` | GODEBUG-controlled library and runtime behaviour | Only the main module's `go` line (or `go.work`). Dependencies' `go` lines are ignored. A `godebug` block in go.mod, `//go:debug` lines in package main, or the `GODEBUG` environment variable override it |
| `(toolchain ≥1.25)` | Everything else | The toolchain that builds the binary, whatever the `go` line says |

Read go.mod before applying any version rule: `go` (minimum version and language version),
`toolchain` (the toolchain `go` switches to when `GOTOOLCHAIN` allows it), and `godebug`.
`go mod init` writes the running toolchain's full version (`go 1.27.1` on 1.27.1, `go 1.26.8` on
1.26.8), so a new module gets the newest semantics and checks; lower the line on purpose if the
code must build with an older toolchain. A library cannot rely on a `(main go ≥…)` behaviour: the
binary that imports it decides.

## Matrices

**Loop variables `(go ≥1.22)`.** Same source, toolchain 1.27.1:

```go
func counters() []func() int {
	var fs []func() int
	for i := 0; i < 3; i++ {
		fs = append(fs, func() int { return i })
	}
	return fs // calling each: 0 1 2 when this module says go >= 1.22; 3 3 3 below
}
```

go 1.21: `3 3 3`, goroutines and `&i` likewise, and a `t.Parallel()` subtest table tests only the
last case and passes. go 1.22 and 1.27: `0 1 2`. vet `loopclosure` reports only a `go` or `defer`
func literal (or errgroup `g.Go`) that is the last statement of the loop body, and the `t.Run` +
`t.Parallel` shape, not this closure; it is silent in go ≥1.22 files; golangci's govet disables it for a go ≥1.22
module even when one file lowers itself with `//go:build go1.21` (that file still runs the old
semantics; `go vet` and gopls still report it). In go ≥1.22 modules `x := x` copies are dead code:
`go fix:forvar` removes them, `golangci:copyloopvar (opt-in)` reports them.

**ServeMux patterns `(main go ≥1.22)`.** `mux.HandleFunc("GET /items/{id}", h)` with a request for
`/items/7`: main module at go 1.21 → 404 (the pattern is not parsed as method + wildcard); go 1.22
→ 200. A library at go 1.21 that registers the pattern still gets 200 in a go 1.22 main module.
`GODEBUG=httpmuxgo121=0` at run time gives 200 in the go 1.21 module, `=1` gives 404 in the go
1.22 one. Reported by: `golangci:govet httpmux (opt-in)` ("possible enhanced ServeMux pattern used
with Go version before 1.22"); `vet+test stdversion` when the handler calls `r.PathValue`; vet,
staticcheck, golangci standard and gopls were silent on the pattern alone.

**`panic(nil)` `(main go ≥1.21)`.** go 1.20 line: `recover()` returns nil, so a deferred
`if r := recover(); r != nil` treats the panic as "no panic". go ≥1.21: `recover()` returns a
`*runtime.PanicNilError`. Reported by: `gopls:nilness` "panic with nil value",
`golangci:govet nilness (opt-in)`.

**`math/rand.Seed` `(main go ≥1.24)`.** Program `rand.Seed(1)` + three `rand.Intn(1000)`:

| main go line | toolchain | output deterministic |
|---|---|---|
| 1.23 | go1.23.12, go1.24.13, go1.27.1 | yes |
| 1.24 | go1.24.13, go1.27.1 | **no** (`Seed` is a no-op) |
| 1.24 + `GODEBUG=randseednop=0` | go1.27.1 | yes |

Reported by: `staticcheck SA1019` (deprecated) only; nothing says the call does nothing. For a
reproducible sequence use a local generator:

```go
func shuffled(items []string, seed uint64) []string {
	r := rand.New(rand.NewPCG(seed, 0)) // math/rand/v2: same seed, same order
	out := slices.Clone(items)
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}
```

gosec G404 reports every `math/rand` generator; that is expected outside security code.

**Timer channels.** 200 000 `time.After(time.Hour)` in a loop, and `Timer.Stop` on a timer that
fired but was not received:

| toolchain | main go line | `cap(t.C)` | stale value after `Reset`/`Stop` | `Stop()` result | heap growth |
|---|---|---|---|---|---|
| 1.22.12 | 1.22 | 1 | yes | false | +42 MB |
| 1.23.12, 1.26.8 | 1.22 | 1 | yes | false | +53 MB |
| 1.23.12, 1.26.8 | 1.23 | 0 | no | **true** | 0 |
| 1.27.1 | any | 0 | no | true | 0 |

On 1.23–1.26 a go.mod `godebug asynctimerchan=1` brings the old semantics back (run on 1.26.8).
Go 1.27 removed the setting: go.mod with `asynctimerchan=1` fails to load, and
`GODEBUG=asynctimerchan=1` in the environment kills the binary at start-up ("removed GODEBUG"), and
the 1.27 `go` command itself, so a CI job exporting it fails before building. Code that branches on
`Stop()`'s result changes path, not only the drain. `staticcheck SA1015` (`time.Tick` leak) fires only for go
lines 1.21 and 1.22 and never in package main; nothing reports `time.After` in a loop.

**`slices.Delete`, `Compact`, `Replace` `(toolchain ≥1.22)`.** They now zero the tail between the
new and the old length. A go 1.21 module built with go1.22.12 or 1.27.1: the old header after
`Delete([1 2 3 4 5], 1, 3)` reads `[1 4 5 0 0]` (go1.21.13: `[1 4 5 4 5]`). The returned slices
are identical; only code that keeps using the old header changes. Discarding the result as a bare
statement is reported by `vet` unusedresult; `_ =` and reading the old header: none — test or review.

**Use before the error check `(toolchain ≥1.25)`.**

```go
f, err := os.Open(path)
name := f.Name() // f is nil when Open failed
if err != nil {
	return "", err
}
```

Toolchains 1.21–1.24 returned the error without a panic (the compiler moved the nil check);
1.25 and later panic, whatever the `go` line. Other shapes (`fi.Size()` on a nil `FileInfo`, a field
read through a nil pointer) panic on every toolchain. Reported by: none — test or review
(staticcheck SA5011 no longer exists; govet nilness was on).

## Version boundaries

| Version | Change | Gate | Evidence |
|---|---|---|---|
| 1.21 | `panic(nil)` becomes `*runtime.PanicNilError` | main | run |
| 1.21 | `min`, `max`, `clear` builtins | go line | docs |
| 1.21 | `slices`, `maps`, `cmp`, `log/slog`; `context.WithoutCancel`, `AfterFunc`; `sync.OnceFunc`/`OnceValue(s)` | toolchain | run for the context and sync APIs |
| 1.22 | Per-iteration loop variables; `range` over an int | go line | run / docs |
| 1.22 | ServeMux method and wildcard patterns | main (`httpmuxgo121`) | run |
| 1.22 | `slices.Delete`/`Compact`/`Replace` zero the tail; `math/rand/v2` | toolchain | run / docs |
| 1.23 | Timer channels unbuffered, unstopped timers collectable | main (`asynctimerchan`) until 1.26 | run |
| 1.23 | `range` over functions (`iter.Seq`) | go line | docs |
| 1.23 | `maps.Keys`/`Values` added, returning `iter.Seq` (`x/exp/maps` returned a slice) | toolchain (+ stdversion) | run |
| 1.24 | `math/rand.Seed` is a no-op | main (`randseednop`) | run |
| 1.24 | `omitzero`; `t.Context`, `b.Loop`, `strings.Lines` | toolchain | run on 1.27.1 |
| 1.24 | vet printf reports a non-constant format string with no arguments | go line | run (go 1.21: silent; go 1.26: `vet+test`) |
| 1.25 | Delayed nil checks fixed (use-before-check panics) | toolchain | run |
| 1.25 | `sync.WaitGroup.Go`; `testing/synctest`; vet `waitgroup` | toolchain | run |
| 1.25 | Container-aware `GOMAXPROCS` | main | docs |
| 1.26 | `new(expr)` | go line | run |
| 1.26 | `errors.AsType`; `go fix` rebuilt on modernizers | toolchain (+ stdversion) | run |
| 1.27 | `asynctimerchan` removed; timers always use the 1.23 semantics | toolchain | run |
| 1.27 | `encoding/json` runs on the v2 implementation (opt out: `GOEXPERIMENT=nojsonv2`) | toolchain | run: v1 behaviour kept, only the U+FFFD escape form differs |
| 1.27 | `go test` runs `stdversion` | toolchain | run |
| 1.27 | vet printf: `%w` given a `*E` where `E` implements `error` ("defeats errors.Is") | go line | run (go 1.26: silent; go 1.27: `vet+test`) |
| 1.27 | `goroutineleak` pprof profile (1.26: `GOEXPERIMENT=goroutineleakprofile`) | toolchain | run |
| 1.27 | Generic methods (cannot implement interface methods); struct literal keys through embedded fields | go line | run |
| 1.27 | HTTP/1 `Response.Body.Close` drains the unread part when the body's `Content-Length` is at most 256 KiB (an unknown length is tried up to that size) and draining ends within 50 ms (source), so the connection is reused; `Close` is still required, and a larger or slower body must be read to EOF for reuse | toolchain | run: 200 KiB reused; 300 KiB (even with only 50 KiB unread) and a stalled body not; 1.26.8 only after reading to EOF |

Two consequences of the "go line" rows: raising the `go` line can make `go test` fail on code that
passed (printf), and lowering it silently changes behaviour (loops, routing).

## stdversion

A module whose `go` line is older than an API it calls still compiles with a newer toolchain. A
`go 1.24` module using `errors.AsType` (1.26) and `WaitGroup.Go` (1.25), toolchain 1.27.1: builds
and runs; `vet+test stdversion` reports "errors.AsType requires go1.26 or later (module is go1.24)"
(with go1.26.8 `go test` passed, because stdversion joined the `go test` subset in 1.27); golangci
govet and gopls report it; staticcheck does not; `go test -vet=off` passes; building with
`GOTOOLCHAIN=go1.24.13` fails with `undefined: errors.AsType`. Raise the `go` line or use the older
API. stdversion is silent in modules below go 1.21 (source), so it never reports a 1.21 API.

## go fix

`go fix -diff ./...` prints the rewrites and exits 1 when there are any; `go fix ./...` applies
them. The analyzer list changes with the toolchain: check `go tool fix help` instead of trusting
a count. Each analyzer has its own minimum `go` line, which can be later than the API it uses
(`maps.Copy` exists since 1.21 but is rewritten to from go 1.23 on). One corpus, go
lines 1.21 to 1.27, first line at which each rewrite appeared:

| go line | Rewritten from this line on |
|---|---|
| 1.21 | `interface{}` → `any`; atomic-only `int64` field → `atomic.Int64`; `sort.Slice` on strings → `slices.Sort`; `min`/`max`; `strings.Cut`, `CutPrefix`; `slices.Contains`; `strings.Builder` |
| 1.22 | removal of `x := x`; `for i := range n`; `reflect.TypeFor` |
| 1.23 | `maps.Copy`; `slices.Backward` |
| 1.24 | `strings.SplitSeq`; `t.Context()`; the omitzero fix below |
| 1.25 | `wg.Go(...)` |
| 1.26 | `errors.AsType` |
| 1.27 | struct literal keys through embedded fields |

- **The omitzero fix deletes `omitempty` from `time.Time` and struct fields** (`json:"at,omitempty"`
  becomes `json:"at"`) and prints `ignoring alternative fix "Replace omitempty with omitzero
  (behavior change)"`. Output stays identical, because `omitempty` never omitted those fields; if
  the intent was to omit zero values, write `omitzero` by hand.
- Not in `go fix`: `b.Loop` (gopls still suggests it at warning level), `slices.Delete`,
  `append` clipping, `fmt.Appendf`. `atomictypes` leaves a field that is also read or written
  without `sync/atomic`.
- The rewritten corpus still built, vetted and passed its tests at go 1.21, 1.24 and 1.27. Run it
  on a clean working tree and review the diff like any other change.

## What each tool runs

| Tool | Default behaviour (run) | Blind spots that matter |
|---|---|---|
| `go vet ./...` | 35 analyzers (`go tool vet help`) | No `shadow`, `nilness`, `unusedwrite`, `scannererr` |
| `go test` | Only 12 vet analyzers: atomic, bools, buildtag, directive, errorsas, ifaceassert, nilfunc, printf, slog, stdversion, stringintconv, tests. Runs them on packages without test files too; `-vet=off` skips them, `-vet=all` runs all 35 | copylocks, lostcancel, loopclosure, waitgroup, testinggoroutine, unusedresult, structtag, unmarshal, timeformat, defers, composites pass `go test`. `go help test` lists 11 (no `slog`) |
| `staticcheck ./...` | SA, S, ST, U checks except the non-default SA9003, ST1000, ST1003, ST1016, ST1020–ST1023 | Never runs QF checks, not even with `-checks all`. SA5011 is gone. SA4023 was silent in `_test.go` files |
| golangci-lint `default: standard` | errcheck, govet, ineffassign, staticcheck, unused. Its staticcheck adds QF checks, SA9003 and ST1023 | Output is filtered silently: `uniq-by-line: true` keeps one issue per line across linters; 50 issues per linter, 3 identical ones (a notice only with `-v`). A second concurrent run prints "parallel golangci-lint is running" and no findings unless `--allow-parallel-runners` |
| `gopls check` | Default severity is warning | Modernizers (except bloop), unusedwrite, deprecated, QF1009 and omitzero are hints: add `-severity=hint`. `shadow` is off. Does not show SA4023, SA5000, SA1015, SA9001 |
| `govulncheck ./...` | Reachable known vulnerabilities | Not probed here; run it when dependencies change |

When a tool's silence matters, re-run golangci-lint with `--uniq-by-line=false
--max-issues-per-linter=0 --max-same-issues=0`: in the probes the default output hid SA1014 behind
govet unmarshal, SA5008 behind structtag, ST1012 behind ST1005, and SA9001/SA5003 behind errcheck
on the same `defer f.Close()` line. The `std-error-handling` exclusion preset hides errcheck's
reports on `Close`, `Flush`, `os.Remove`, `os.Setenv` and `fmt.Fprintln`, including `defer f.Close()`
on a written file.

## golangci-lint baseline

For a project with no lint config. Verified with `golangci-lint config verify` and run on seeded
code: errcheck, noctx, nilerr, errorlint, gosec, goimports, nilness and unusedwrite all fired;
`httpmux` fired only in a go 1.21 module and was silent at go 1.22 and in the go 1.26 snippets.

```yaml
version: "2"
linters:
  default: standard
  enable: [bodyclose, errorlint, exhaustive, gosec, nilerr, noctx, rowserrcheck, sqlclosecheck]
  settings:
    govet:
      enable: [httpmux, nilness, unusedwrite]
    errcheck:
      check-type-assertions: true
    gosec:
      excludes: [G104] # errcheck already reports unchecked errors
  exclusions:
    presets: [common-false-positives]
formatters:
  enable: [goimports]
issues:
  max-issues-per-linter: 0
  max-same-issues: 0
  uniq-by-line: false
```

- `std-error-handling` is left out on purpose (see above). If a team keeps it, review `Close` and
  `Flush` on written files by hand.
- errorlint reports every non-wrapping `%v` of an error in `fmt.Errorf`; mark a deliberate one at
  an API boundary with `//nolint:errorlint // <why>`, as errcheck's read-only `Close` is marked.
- `goimports` alone: it includes gofmt, and enabling both reports every unformatted file twice.
  `copyloopvar` is left out: it only finds dead `x := x` copies, which `go fix` removes.
- Not in the baseline but useful in review: govet `shadow` (noisy), gocritic (its default set
  includes `exitAfterDefer`; `deferInLoop` and `exposedSyncMutex` need `enabled-checks`),
  `nilnesserr`, `containedctx`, `contextcheck`, `musttag`.

## Reported-by vocabulary

The references end each pitfall with **Reported by:**, using only these labels:

| Label | Meaning |
|---|---|
| `compiler` | The build fails |
| `gofmt` | `gofmt -l` lists the file; golangci-lint's gofmt/goimports formatters report it |
| `vet` | `go vet ./...` reports it; `go test` does not |
| `vet+test` | In the 12-analyzer subset: `go test` fails with `[build failed]` |
| `staticcheck <check>` | staticcheck CLI default (SA, S, ST); `(non-default)` needs `-checks` |
| `golangci:<linter> (standard)` / `(opt-in)` | In `default: standard`, or must be enabled (for govet analyzers: `settings.govet.enable`) |
| `gopls:<analyzer>` | Shown by `gopls check` at default severity; `(hint)` only with `-severity=hint` or in the editor |
| `go fix:<name>` | Rewritten by `go fix` |
| `-race` | The race detector at run time |
| `none — test or review` | Nothing reported it: vet, `go test`, staticcheck (default and `-checks all`), golangci-lint standard and a wide opt-in set (gocritic all checks, revive, gosec, errorlint, nilerr, govet enable-all, …) with `--uniq-by-line=false`, and `gopls check -severity=hint` |
| `(docs)` | Taken from documentation or source; not run |

## Gotchas

- Agent writes "since Go 1.22" for loop or routing behaviour - the `go` line decides (the containing module's for loops, the main module's for routes), not the toolchain.
- Agent registers `"GET /items/{id}"` in a binary whose main module's `go` line is below 1.22 - every request gets 404; only the opt-in govet `httpmux` reports it.
- Agent seeds `math/rand` for a reproducible test - with a main `go` line ≥1.24 the seed is ignored.
- Agent drains a timer with `if !t.Stop() { <-t.C }` on Go ≥1.23 semantics - `Stop` returns true after the timer fired, so the branch changes; the drain is unnecessary.
- Agent sets `GODEBUG=asynctimerchan=1` with Go 1.27 - the binary and the `go` command exit at start-up.
- Agent uses an API newer than the `go` line - it builds; `go test` fails on 1.27 (stdversion) and an older toolchain cannot build it.
- Agent runs `go test` and calls the code vet-clean - copylocks, lostcancel and loopclosure are not in its subset (unless `-vet=all`).
- Agent reads golangci-lint's default output as complete - one issue per line, 50 per linter, 3 identical.
- Agent runs `go fix` to "add omitzero" - it removes `omitempty` instead.
- Agent trusts `gopls check` without `-severity=hint` - modernizer and unusedwrite findings are hidden.

## Official sources

- [Go, backwards compatibility, and GODEBUG](https://go.dev/doc/godebug) and [Go toolchains](https://go.dev/doc/toolchain)
- Release notes: [1.21](https://go.dev/doc/go1.21), [1.22](https://go.dev/doc/go1.22), [1.23](https://go.dev/doc/go1.23), [1.24](https://go.dev/doc/go1.24), [1.25](https://go.dev/doc/go1.25), [1.26](https://go.dev/doc/go1.26), [1.27](https://go.dev/doc/go1.27)
- [cmd/vet](https://pkg.go.dev/cmd/vet), [Using go fix to modernize Go code](https://go.dev/blog/gofix)
- [staticcheck checks](https://staticcheck.dev/docs/checks/), [golangci-lint configuration](https://golangci-lint.run/docs/configuration/), [gopls analyzers](https://go.dev/gopls/analyzers)
