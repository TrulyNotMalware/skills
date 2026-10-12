# Tests and benchmarks

Applies to Go 1.27.1 with a go.mod `go` line of 1.26 or later unless a rule carries a version tag
([tags and labels](versions-tools.md#reported-by-vocabulary)). The examples use only the standard
library and `github.com/google/go-cmp`; in a codebase that uses testify, keep testify and apply the
same rules about messages and helpers. A green `go test` can mean the test was cached, ran only
the last table case, or never ran the vet checks you assumed.

Contents: [The shape to aim for](#the-shape-to-aim-for) · [Failure messages and helpers](#failure-messages-and-helpers) ·
[Parallel subtests](#parallel-subtests) · [Contexts and cleanup](#contexts-and-cleanup) ·
[Benchmarks](#benchmarks) · [synctest](#synctest) · [Goroutines in tests](#goroutines-in-tests) ·
[Running the tests](#running-the-tests) · [Gotchas](#gotchas)

## The shape to aim for

```go
func TestParseCount(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    int
		wantErr bool
	}{
		{name: "empty", in: "", want: 0},
		{name: "number", in: "42", want: 42},
		{name: "not a number", in: "abc", wantErr: true},
		{name: "negative", in: "-1", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseCount(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseCount(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("ParseCount(%q) = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}
```

A table when every case runs the same checks; separate test functions when cases need different
logic. Name subtests so `-run 'TestParseCount/negative'` selects one. Cases include the edge values
(empty, zero, negative, too large) and every error path.

## Failure messages and helpers

- The message names the function and the input and puts got before want:
  `ParseCount("abc") = 0, want 42`. Use `t.Errorf` to keep checking, `t.Fatalf` only when the
  rest of the test cannot run (setup failed, a nil result about to be dereferenced).
- Helpers call `t.Helper()` so a failure points at the caller's line, take `t` first (after a
  `ctx`, if any), and fail the test themselves instead of returning an error:

  ```go
  func writeTemp(t *testing.T, content string) string {
  	t.Helper() // failures are reported at the caller's line
  	path := filepath.Join(t.TempDir(), "input.txt")
  	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
  		t.Fatalf("write %s: %v", path, err)
  	}
  	return path
  }

  func TestReadLines(t *testing.T) {
  	path := writeTemp(t, "a=1\nb=2\n")
  	got, err := readLines(path)
  	if err != nil {
  		t.Fatalf("readLines(%q): %v", path, err)
  	}
  	want := []Line{{Key: "a", Count: 1}, {Key: "b", Count: 2}}
  	if diff := cmp.Diff(want, got); diff != "" {
  		t.Errorf("readLines(%q) mismatch (-want +got):\n%s", path, diff)
  	}
  }
  ```

- Compare structures with `cmp.Diff` and print the diff with its direction; compare errors with
  `errors.Is`/`errors.AsType`, not message strings. Do not build a private assertion library.
- `t.TempDir()`, `t.Setenv()`, `t.Chdir()` and `t.Context()` clean up after themselves; prefer them
  to `os.MkdirTemp`, `os.Setenv`, `os.Chdir` and `context.Background()`. Reported by:
  `golangci:usetesting (opt-in)` for the first three; `context.Background()` not by default.

## Parallel subtests

- **Loop variables in parallel subtests `(go ≥1.22)`.** In a go 1.21 module, every parallel
  subtest of a table like the one above sees the last case, and the test passes. From 1.22 each
  iteration has its own `tt`, and `tt := tt` is dead code (`go fix:forvar` removes it at go ≥1.22).
  Reported by, in go 1.21 modules: `vet` loopclosure (not in `go test`), `golangci:govet
  (standard)`, `gopls:loopclosure`, `golangci:paralleltest (opt-in)`.
- **`t.Setenv` or `t.Chdir` panics when the test or any ancestor called `t.Parallel`** ("test
  using t.Setenv, t.Chdir, or cryptotest.SetGlobalRandom can not use t.Parallel"), in either order:
  a table under a parallel top-level test cannot `t.Setenv` in its subtests. The reverse (Setenv in
  the parent, `t.Parallel` in subtests) works. Reported by: none — test or review.

## Contexts and cleanup

`t.Context()` `(toolchain ≥1.24)` is canceled when the test ends, **before** `t.Cleanup` functions
run. Teardown that needs a context makes its own:

```go
func TestWithServer(t *testing.T) {
	ctx := t.Context() // canceled when the test ends, before Cleanup functions run
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		stop(stopCtx)
	})
	if err := ctx.Err(); err != nil {
		t.Fatal(err)
	}
}
```

Reported by: none — test or review. `go fix:testingcontext` replaces
`context.WithCancel(context.Background())` plus `defer cancel()` in a test with `t.Context()`
`(go ≥1.24)`; a `t.Cleanup(cancel)` shape is left alone.

## Benchmarks

```go
func BenchmarkParseCount(b *testing.B) {
	input := strings.Repeat("9", 9) // setup runs once and is not timed
	for b.Loop() {
		if _, err := ParseCount(input); err != nil {
			b.Fatal(err)
		}
	}
}
```

`for b.Loop()` `(toolchain ≥1.24)` runs the setup once, times only the loop, and keeps the compiler
from deleting the call. The old `for i := 0; i < b.N; i++ { f() }` with an unused result measured
0.31 ns/op for an inlined function (0.64 with a sink); 100 ms of setup without `b.ResetTimer()`
ran on each of the framework's ~10 calls (once with `b.Loop`) and inflated ns/op by 12–58 %
across runs. `b.Loop` adds about 1.5 ns/op over a sink-based `b.N` loop, so
compare numbers only between benchmarks of the same style. Reported by: `gopls:bloop` (warning
level); `go fix` does not rewrite it.

## synctest

`testing/synctest` `(toolchain ≥1.25)` runs a function in a bubble with a fake clock that jumps
when every goroutine in the bubble is blocked:

```go
func TestTimeoutFiresAfterFiveSeconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		start := time.Now()
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		<-ctx.Done() // the fake clock jumps when every goroutine in the bubble is blocked
		if got := time.Since(start); got != 5*time.Second {
			t.Errorf("timeout after %v, want 5s", got)
		}
	})
}
```

It finished in 0 s of real time. A goroutine still blocked when the function returns fails the
test ("deadlock: main bubble goroutine has exited but blocked goroutines remain"), which makes the
bubble a leak check. The entry point is `synctest.Test`; `synctest.Run` was experimental in 1.25
and is gone from 1.26 (source). Network I/O, system calls and waiting for a `sync.Mutex` do not
count as blocked in the bubble, so use in-memory pipes such as `net.Pipe` (docs).

## Goroutines in tests

- **`t.Fatal` from a goroutine the test started ends only that goroutine**: the test is marked
  failed but its body keeps running. Send the error back on a channel and fail from the test
  goroutine. Reported by: `vet` testinggoroutine and `staticcheck SA2002` (`go test` does not run
  the vet check).
- **A goroutine that calls `t.Error` after its test returned panics the whole test binary**
  ("Fail in goroutine after TestX has completed"), so unrelated tests in the package fail too; a
  late `t.Log` is dropped (or printed under a parent test that is still running). Wait for every
  goroutine before the test returns. Reported by:
  none — test or review.

## Running the tests

`go test -race -count=1 -shuffle=on ./...` before calling a change done; `go vet ./...` beside it.

- **The result cache.** In package-list mode (`go test ./...`, `go test ./pkg`) results are reused
  when the package, its inputs and the flags are unchanged. A changed `os.Getenv` variable or a
  changed file that the test opened inside the module reruns it; a data file it did not open, one
  **outside** the module root, an environment variable read through `os.Environ()`, the clock, a
  database or a network response do not: the old output is replayed with `(cached)`. `-count=1`
  disables the cache. `go test` with no package arguments never caches.
- **`-shuffle=on`** randomises test order and prints `-test.shuffle <seed>` (in package-list mode
  only with `-v` or on failure); `-shuffle=<seed>` reproduces it. An order-dependent pair failed in 2 of 6 runs
  and passed in default order.
- **`-race`** finds data races only on paths the tests execute; plain `go test` passed a racy
  counter ([concurrency](concurrency.md#maps-and-the-race-detector)).
- **`go test` runs 12 vet analyzers, not 35** (`-vet=all` runs them all)
  ([versions-tools](versions-tools.md#what-each-tool-runs)). It runs them even for packages with no
  test files (a printf mistake fails the package as `[build failed]`; `-vet=off` skips them), and
  from 1.27 the subset includes `stdversion`, so an API newer than the `go` line fails `go test`.

## Gotchas

- Agent captures the loop variable in a parallel subtest of a go 1.21 module - only the last case is tested, and it passes.
- Agent uses `t.Context()` inside `t.Cleanup` - it is already canceled.
- Agent writes a `b.N` loop whose result is unused - the call is optimised away; setup is timed.
- Agent calls `t.Fatal` in a spawned goroutine - the test continues after the "fatal".
- Agent lets a goroutine call `t.Error` or `t.Fatal` after the test returned - the whole test binary panics (a late `t.Log` is lost or lands under the parent test).
- Agent calls `t.Setenv` or `t.Chdir` in a test or subtest under `t.Parallel` - panic.
- Agent reads a fixture outside the module or a DB in a test and trusts `go test ./...` - a cached pass is replayed.
- Agent runs `go test` without `-race` on concurrent code - races pass.
- Agent treats a passing `go test` as vet-clean - copylocks, lostcancel, loopclosure and structtag never ran.
- Agent compares errors by message in a test - the test breaks on rewording and misses wrapping bugs.

## Official sources

- Package [testing](https://pkg.go.dev/testing) and [cmd/go: testing flags](https://pkg.go.dev/cmd/go#hdr-Testing_flags)
- [Go Test Comments](https://go.dev/wiki/TestComments) and [Using Subtests and Sub-benchmarks](https://go.dev/blog/subtests)
- [testing.B.Loop](https://go.dev/blog/testing-b-loop) and [Testing concurrent code with testing/synctest](https://go.dev/blog/synctest)
