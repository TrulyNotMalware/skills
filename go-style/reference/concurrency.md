# Goroutines, channels, context and sync

Applies to Go 1.27.1 with a go.mod `go` line of 1.26 or later, and `golang.org/x/sync` v0.23.0 for
errgroup (it requires `go 1.26.0`; older go lines pin an older x/sync) ([tags and labels](versions-tools.md#reported-by-vocabulary)). Concurrency bugs pass a
quick test because the bad interleaving or the early return does not happen in it. Run tests with
`-race`, and write the test that cancels the context or closes the channel early.

Contents: [The shape to aim for](#the-shape-to-aim-for) · [Goroutine lifetime and leaks](#goroutine-lifetime-and-leaks) ·
[Channels and select](#channels-and-select) · [context](#context) · [Timers](#timers) · [sync](#sync) ·
[errgroup](#errgroup) · [Maps and the race detector](#maps-and-the-race-detector) · [Gotchas](#gotchas)

## The shape to aim for

```go
// FetchAll calls fetch for every id, at most limit (> 0) at a time, and returns
// the first error. Every goroutine it started has finished when it returns.
func FetchAll(ctx context.Context, ids []string, limit int,
	fetch func(context.Context, string) (Result, error),
) ([]Result, error) {
	results := make([]Result, len(ids))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(limit)
	for i, id := range ids {
		g.Go(func() error {
			r, err := fetch(ctx, id)
			if err != nil {
				return fmt.Errorf("fetch %s: %w", id, err)
			}
			results[i] = r // each goroutine writes its own index
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}
```

The function is synchronous to its caller, takes `ctx` first, bounds the parallelism, cancels `ctx`
on the first error (that stops the rest only if `fetch` honours it; queued ids still call `fetch`),
and waits for every goroutine. Capturing `i` and `id` is correct only `(go ≥1.22)`. Without errors
to collect, `sync.WaitGroup.Go` `(go ≥1.25)` does the same with the standard library:

```go
func processAll(items []string, process func(string)) {
	var wg sync.WaitGroup
	for _, it := range items {
		wg.Go(func() { process(it) })
	}
	wg.Wait()
}
```

## Goroutine lifetime and leaks

Every goroutine needs an evident exit (when it ends, or what stops it) and a way to wait for it:
`Wait` before the starting function returns, or a `Close`/`Stop` method that waits; document it
when the code does not make it obvious. Prefer synchronous functions and let the caller add
concurrency. A goroutine blocked forever on a channel is never collected.

```go
// Wrong: when ctx is done first, the goroutine blocks forever on the send.
func firstResultLeaky(ctx context.Context, query func() string) (string, error) {
	ch := make(chan string) // fix: make(chan string, 1); the send then never blocks
	go func() { ch <- query() }()
	select {
	case r := <-ch:
		return r, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}
```

Three calls with a canceled context left three goroutines behind; with the buffer, none. The
buffer frees only the send: a `query` that never returns still leaks one goroutine per call, so it
needs `ctx` too. Reported by: none — test or review (gosec G118 did not fire on this shape). At run
time:

- `pprof.Lookup("goroutineleak")` `(toolchain ≥1.27)` listed leaked senders, but not a goroutine
  blocked on a channel reachable from a package-level variable. On 1.26 it exists only with
  `GOEXPERIMENT=goroutineleakprofile`.
- In tests, `go.uber.org/goleak`'s `VerifyNone(t)` failed the test with the blocked stack, and a
  [synctest](testing.md#synctest) bubble fails when goroutines are still blocked at its end.

## Channels and select

- `for v := range ch` ends when `ch` is closed and drained; a receive from a closed channel returns
  the zero value and `ok == false`. Only the sending side closes a data channel, once, after its
  last send (several senders: one goroutine closes it after a `WaitGroup`); a `done` channel that
  nobody sends on is closed by whoever cancels, often the receiver.
- **Send on a closed channel, close of a nil channel and a second close all panic.** Reported by:
  none — test or review.
- **A nil channel is never ready in `select`**; set a finished input to nil to disable its case.
  A **closed** channel is always ready: a loop that keeps selecting on one spun 84 000 times in
  10 ms. Return, or set the variable to nil, once it is closed.
- **`select` picks uniformly among ready cases** (both ready 10 000 times: 4957 / 5043). There is
  no priority; check the urgent channel in its own non-blocking `select` first if order matters.
- **`break` inside `select` or `switch` leaves only that statement**, not the enclosing `for`:

  ```go
  func consume(ctx context.Context, ch <-chan int, handle func(int)) error {
  loop:
  	for {
  		select {
  		case <-ctx.Done():
  			return ctx.Err()
  		case v, ok := <-ch:
  			if !ok {
  				break loop // a plain break would only leave the select
  			}
  			handle(v)
  		}
  	}
  	return nil
  }
  ```

  With a plain `break`, the loop spun on the closed channel until its iteration cap. Reported by:
  `staticcheck SA4011` when `break` is the last statement of a case; inside an `if` in the case,
  as here: none — test or review. A `return` in a helper function avoids the label.

## context

- **`ctx context.Context` is the first parameter**, passed down explicitly. Do not store it in a
  struct: a worker built with a request's context returned "context canceled" from a later call
  made with a live context. Reported by: `golangci:containedctx (opt-in)`.
- **Pass the context you were given.** A helper that calls `context.Background()` ignores the
  caller's cancellation: given a canceled context, two handlers still waited 200 ms. Derive from
  the caller's ctx whenever one exists (`t.Context()` in tests); a new root context belongs where
  no request scope exists (`main`, initialisation; the stricter rule is a
  [house default](../SKILL.md#house-defaults)). Reported by: `golangci:contextcheck (opt-in)`, for
  some shapes.
- **Always call the cancel function**, on every path (`defer cancel()`). 200 000 discarded
  `WithCancel` children of a cancelable parent kept 22–23 MB until the parent was canceled (of
  `context.Background()`: 0 MB). Reported by: `vet` (lostcancel; `go test`
  passes).
- `context.WithoutCancel(ctx)` `(toolchain ≥1.21)` keeps the values and drops cancellation and the
  deadline (its `Done()` is nil): use it for work that must finish after the request, with its own
  timeout. `context.AfterFunc(ctx, f)` runs `f` in a new goroutine after cancellation; its `stop()`
  returns true only if it prevented `f` from running.
- `context.Cause(ctx)` returns the error passed to a `CancelCauseFunc` (errgroup passes the first
  error).

## Timers

With the semantics of `(main go ≥1.23)` on 1.23–1.26 toolchains and of every build from 1.27:
`time.After` in a loop and an unstopped `time.Tick` are collected; `Stop` and `Reset` leave no
stale value in the channel, so the old `if !t.Stop() { <-t.C }` drain is unnecessary; `len(t.C)`
is always 0, so polling it never sees the fire; and `Stop()` returns **true** for a timer that fired
but was not received (false before), so code that branches on it changes path. The full matrix,
including the start-up failure of `GODEBUG=asynctimerchan=1` on 1.27 (binary and `go` command), is in
[versions-tools](versions-tools.md#matrices). A library that still supports toolchains below 1.27
must be correct under both behaviours. Reported by: `staticcheck SA1015` for `time.Tick` only in
go 1.21 and 1.22 modules and outside package main; nothing for `time.After`.

## sync

- **Values containing a `sync.Mutex`, `WaitGroup` or typed atomic must not be copied.** A value
  receiver `func (c Counter) Inc()` called five times left `n` at 0: each call locked and
  incremented a copy. Use pointer receivers on such types and pass them by pointer. Reported by:
  `vet` (copylocks; `go test` passes).
- **`wg.Add(1)` inside the goroutine races with `Wait`**: `Wait` returned with 0 of 3 goroutines
  done. Call `Add` before `go`, or use `wg.Go` `(go ≥1.25)`. Reported by: `vet` (waitgroup,
  `(toolchain ≥1.25)`), `staticcheck SA2000`. `go fix:waitgroupgo` `(go ≥1.25)` rewrites the
  correct `Add`/`go`/`Done` form and leaves `Add` inside the goroutine alone.
- **Keep the mutex next to what it guards**, unexported, and prefer typed atomics for single
  counters:

  ```go
  type Stats struct {
  	requests atomic.Int64

  	mu     sync.Mutex // guards byPath
  	byPath map[string]int
  }

  func (s *Stats) Hit(path string) {
  	s.requests.Add(1)
  	s.mu.Lock()
  	defer s.mu.Unlock()
  	if s.byPath == nil {
  		s.byPath = make(map[string]int)
  	}
  	s.byPath[path]++
  }
  ```

  A typed atomic is used through its methods: `s.requests++` does not compile, and copying the
  value compiles but `vet` copylocks reports it. With the old functions, `n = atomic.AddInt64(&n, 1)` is reported by `vet+test` (atomic).
  `go fix:atomictypes` turns a variable used only through `sync/atomic` into `atomic.Int64` and
  leaves one that is also accessed directly alone.
- **`sync.Once` never retries.** After `Do(f)` panics, a second `Do` does not call its function;
  `sync.OnceFunc` re-panics with the same value on every call; `sync.OnceValues` returns the first
  error forever. Do not use them for initialisation that may fail transiently. Reported by:
  none — test or review.
- Use a mutex for shared state and channels for handing work or ownership between goroutines;
  pick whichever makes the code simpler.

## errgroup

Measured with `golang.org/x/sync` v0.23.0 (the panic row holds from v0.16.0; v0.15.0 re-panicked
in `Wait`, per its source):

- `Wait` returns the first non-nil error; with `WithContext`, the other goroutines see the derived
  context canceled and `context.Cause(ctx)` is that error.
- **The derived context is canceled when `Wait` returns, even if every goroutine succeeded.** Do
  not use it after `Wait`; keep the parent for follow-up work.
- **A panic inside `g.Go` crashes the process**; `Wait` does not return it (deliberate, per the
  source). Recover inside the function if a panic must become an error.
- A zero `errgroup.Group` does not cancel anything. `SetLimit(n)` bounds the running goroutines
  (`Go` blocks until a slot is free); `SetLimit(0)` makes every `Go` block forever, and a negative
  `n` means no limit.

## Maps and the race detector

- **Concurrent map writes are fatal**: `fatal error: concurrent map writes` ended the process (3
  of 3 runs) and a deferred `recover` in every writer did not catch it. Guard the map with a mutex,
  or use `sync.Map` for keys written once and read many times (docs). The crash is not guaranteed
  either: a test with two concurrent writes passed `go test`. Reported by: `-race` (it failed
  that test with "DATA RACE").
- **`go test` passes racy code.** `total++` from 100 goroutines passed `go test` and failed under
  `go test -race` with "WARNING: DATA RACE". The detector sees only interleavings that occur during
  the run, so the test must run the concurrent path. Reported by: `-race` only.

## Gotchas

- Agent starts a goroutine with no way to stop or wait for it - it outlives the request and leaks.
- Agent sends on an unbuffered channel the receiver may abandon - the sender blocks forever.
- Agent writes `break` in a `select` case to leave a `for` loop - the loop continues.
- Agent keeps selecting on a closed channel - a busy loop.
- Agent stores a `context.Context` in a struct - later calls use a dead or wrong context.
- Agent calls `context.Background()` in a helper - cancellation stops there.
- Agent drops the cancel function - children stay registered until the parent ends.
- Agent branches on `Timer.Stop()`'s result written for pre-1.23 semantics - wrong branch under `(main go ≥1.23)` or any 1.27 build.
- Agent gives a type with a mutex a value receiver - every call locks a copy.
- Agent calls `wg.Add(1)` inside the goroutine - `Wait` may return first.
- Agent retries initialisation through `sync.Once` - it never runs again after a panic.
- Agent uses errgroup's derived context after `Wait` - it is already canceled.
- Agent relies on errgroup to report a panic - the process crashes.
- Agent writes a map from several goroutines - fatal error, not recoverable.

## Official sources

- [Go Concurrency Patterns: Context](https://go.dev/blog/context) and [Contexts and structs](https://go.dev/blog/context-and-structs)
- [The Go Memory Model](https://go.dev/ref/mem) and [Data Race Detector](https://go.dev/doc/articles/race_detector)
- Packages [sync](https://pkg.go.dev/sync), [sync/atomic](https://pkg.go.dev/sync/atomic), [time](https://pkg.go.dev/time#Timer.Stop), [errgroup](https://pkg.go.dev/golang.org/x/sync/errgroup)
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments) (contexts, goroutine lifetimes, synchronous functions, copying)
