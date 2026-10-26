# Lifecycle and deployment

Applies to the Go 1.27.1 toolchain with a go.mod `go` line of 1.26.0 or later and `golang.org/x/sync`
v0.24.0 unless a rule carries a version tag. Server results were measured over HTTP/1.1 (plain TCP,
loopback, darwin/arm64) with a real listener and a raw TCP or `net/http` client; HTTP/2 was not run,
so do not carry the tables over to it. Lifecycle code runs only at start-up, during deploys and under
slow or vanishing clients, so a server that drops responses on every rollout passes functional tests.

Contents: [Run shape](#the-run-shape) · [Timeouts](#server-timeouts) · [Shutdown](#shutdown) ·
[Signals](#signals) · [Panics](#handler-panics) · [Disconnect](#client-disconnect) · [Error log](#server-error-log) ·
[Workers](#workers-and-exit-codes) · [Readiness](#readiness-and-drain) · [Build](#build-and-deploy) · [Gotchas](#gotchas)

## The run shape

`main` calls `run(context.Background(), os.Args[1:], os.Stdout)`, prints a returned error and exits 1
(why `main` holds the only `os.Exit`: the go-style skill, errors-control):

```go
func run(ctx context.Context, args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("server", flag.ContinueOnError)
	addr := fs.String("addr", ":8080", "listen address")
	drainDelay := fs.Duration("drain-delay", 5*time.Second, "time between readiness going false and the listener closing")
	shutdownTimeout := fs.Duration("shutdown-timeout", 20*time.Second, "time in-flight requests get to finish")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil // -h: the FlagSet has printed the usage
		}
		return errors.New("invalid arguments") // the FlagSet has printed the error and the usage
	}
	logger := slog.New(slog.NewJSONHandler(stdout, nil))

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	var ready atomic.Bool
	mux := http.NewServeMux()
	// ... GET /readyz answers 503 "shutting down" unless ready.Load()
	mux.Handle("/", newHandler(logger))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		ready.Store(true)
		logger.Info("starting http server", "addr", *addr)
		// ListenAndServe returns ErrServerClosed as soon as Shutdown starts;
		// the Shutdown goroutine below is what waits for in-flight requests.
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	// ... g.Go(func() error { return runWorker(gctx, logger) })
	g.Go(func() error {
		<-gctx.Done()
		signaled := ctx.Err() != nil // false when another goroutine failed
		stop()                       // from here on a second signal kills the process
		ready.Store(false)
		logger.Info("shutting down", "cause", context.Cause(gctx))
		if signaled { // give load balancers time to stop routing here
			time.Sleep(*drainDelay)
		}
		// ctx is already canceled: Shutdown needs a context that is not.
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), *shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			_ = srv.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
		logger.Info("http server stopped")
		return nil
	})
	return g.Wait()
}
```

Run with SIGTERM 0.5 s into a 3 s request and a 1 s drain delay: `/readyz` 503 during the delay, then
refused; the request 200 at +2.50 s; log `"cause":"terminated signal received"`; exit 0 at +2.6 s. A
second SIGTERM during the drain: exit 143, request cut. Port in use: exit 1 in 0.12 s, no drain. A
signal before `ListenAndServe` runs is harmless: it then returns `ErrServerClosed` unbound.

- **Return from `main` only after Shutdown has returned.** `ListenAndServe` returns `ErrServerClosed`
  the moment Shutdown starts; a `main` that returned then cut the in-flight request (EOF at +0.00 s,
  exit 0), and `log.Fatal(srv.ListenAndServe())` did the same with exit 1 and `http: Server closed`
  on every deploy. Reported by: none — test or review.
- **Shutdown's context must not derive from the (already canceled) signal context**: with
  `context.WithTimeout(ctx, d)` it returned `context canceled` at once, cut the request, exit 1. Use
  `context.WithoutCancel(ctx)` or `context.Background()`. Reported by: none — test or review;
  `golangci:contextcheck (opt-in)` flags the *correct* `Background()` form, `WithoutCancel` passes.

## Server timeouts

One server per row, raw TCP client, seconds after connect, "open" = open at the 14 s cap (HTTP/1.1,
darwin); RHT, RT, WT, IT = ReadHeader, Read, Write, Idle timeout in seconds. Header timeouts gave 400,
or a close without a byte when nothing was pending; never 408, nothing logged.

| Server | Header sent 1 B/s | Body sent 1 B/s | 12 B upload over 6 s | Handler takes 5 s | 6 s stream, flushed | Idle keep-alive |
|---|---|---|---|---|---|---|
| none set | open | open (handler blocked in read) | 200 | 200 | 12/12 chunks | open |
| RHT 2 | 400 at 2.0 | open | 200 | 200 | 12/12 | **open** (with IT 6: 6.0) |
| RT 4 | 400 at 4.0 | 400 at 4.0 (handler's read error) | 400 at 4.0 | 200 | 12/12 | closed at 4.0 |
| RHT 2, RT 4 | 400 at 2.0 | 400 at 4.0 | 400 at 4.0 | 200 | 12/12 | 4.0 |
| RHT 2, RT 4, WT 3 | 400 at 2.0 | **EOF at 4.0, the 400 is lost** | **EOF at 4.0** | **EOF at 5.0, no response** | **6 chunks, EOF at 3.0** | 4.0 (with IT 6: 6.0) |
| WT 3 only | open | open | **body read at 5.5, then EOF** | EOF at 5.0 | 6, EOF at 3.0 | open |

- **`ReadHeaderTimeout` alone bounds only the headers**: the read deadline then becomes RT's (counted
  from the start of the request; none when zero) and an idle connection waits for IT, else RT. That
  literal is exactly what satisfies gosec G112; set RT and IT too. Reported by: none — test or review.
- **A response written after `WriteTimeout` is lost without an error.** WT runs from the end of the
  request headers; the client sees EOF when the handler returns, a small `w.Write` returned nil
  (buffered), only `Flush` returned `i/o timeout`, and `r.Context()` stayed live until a `Flush`
  failed. Also lost: a 400 after a body-read timeout, the 200 after a long upload. Reported by: none — test or review.
- **Move the deadlines per request** with `http.NewResponseController(w)`: a stream needs
  `SetWriteDeadline(time.Time{})` or a later time (12/12 under WT 3); an upload needs `SetReadDeadline`
  *and* `SetWriteDeadline` (RT = WT = 1 s, 60 B over 1.8 s: read only → client EOF; both → 200). Check
  the error: through a wrapper without `Unwrap` they fail ([http-server](http-server.md)).
- **Only gosec sees a missing timeout, and only some shapes.** `http.ListenAndServe`,
  `ListenAndServeTLS` and `http.Serve` cannot set any: G114. A `&http.Server{…}` literal without RHT:
  G112, silent for a literal with only RT, `var srv http.Server` plus assignments and `new(http.Server)`.
  Reported by: `golangci:gosec (opt-in)`; vet, staticcheck, golangci standard, gopls: silent.
  `http.TimeoutHandler`: [http-server](http-server.md).

## Shutdown

Subprocess server, SIGTERM → `Shutdown`; a 3 s `/work` request that selects on `r.Context().Done()`
started 0.5 s before the signal; seconds after SIGTERM (HTTP/1.1, darwin):

| Situation | Shutdown returns | Client sees |
|---|---|---|
| `/work` in flight, Shutdown(10 s) | nil at +2.66 | 200 at +2.50; the handler saw `r.Context().Err() == nil` |
| Shutdown(1 s), process keeps running | `context deadline exceeded` at +1.00 | **200 at +2.50**: nothing was closed |
| Shutdown(1 s), then `srv.Close()` | same | EOF at +1.00; `r.Context()` canceled at +1.00 |
| idle keep-alive connection | (as `/work`) | closed at +0.00; a new dial or a pooled client's next request: `connection refused` |
| accepted, nothing sent, RHT 0 / RHT 2 s | nil at **+5.23** / +2.12 | EOF at +5.23 / +1.70 |
| request sent at +0.30 on a connection accepted before SIGTERM | nil at +0.55 | **no response, EOF** |
| SSE loop watching only `r.Context()`, Shutdown(3 s) | `deadline exceeded` at +3.00 | stream until the process exits |
| SSE + `/work`, `BaseContext` canceled before Shutdown | nil at +0.00 | SSE ends; **`/work` aborted (503 `canceled`)** |
| SSE + `/work`, `RegisterOnShutdown` closes a channel | nil at +2.63 | SSE gets `event: bye`; `/work` 200 at +2.50 |

- **Shutdown does not cancel `r.Context()`**: a loop that ends only on `r.Context().Done()` (SSE, long
  poll) holds Shutdown to its deadline; canceling `BaseContext` aborts every request with the streams.
  Use `srv.RegisterOnShutdown(sync.OnceFunc(func() { close(e.shuttingDown) }))` and a
  `case <-e.shuttingDown:` that writes a goodbye event and returns (13 events, then `event: bye`;
  Shutdown nil in 1.4 ms). Reported by: none — test or review.
- **Hooks run in new goroutines on every `Shutdown` call**: with a bare `close(ch)` hook a second
  Shutdown crashed the process (`panic: close of closed channel`, exit 2). Reported by: none — test or review.
- **A timed-out Shutdown closes nothing**: call `Close` (which cancels the handlers' `r.Context()`)
  or the connections die with the process. Reported by: none — test or review.
- **Shutdown returns up to ~550 ms after the last request ends** (polls back off to 500 ms plus 10 %
  jitter, source; 3–510 ms in 40 runs); a connection that never sent a byte holds it 5 s unless RHT
  closes it (`StateNew` counts as idle only after 5 s, source). Reported by: none — test or review.
- **Shutdown neither waits for nor closes hijacked connections** (WebSockets): it returned nil at
  once while one streamed. Notify them from a hook and wait for them yourself (docs).

## Signals

- **`signal.NotifyContext` keeps catching the signal until `stop()` runs** (darwin): with only
  `defer stop()` a second Ctrl-C or SIGTERM during a hung shutdown did nothing; `stop()` at shutdown
  start let it kill the process. Under `&` from a non-interactive shell SIGINT is inherited ignored:
  the first still starts the shutdown, but after `stop()` only SIGTERM kills. Reported by: none — test or review.
- **`context.Cause(ctx)` names the signal `(toolchain ≥1.26)`** (`terminated signal received`), even
  in a go 1.25 module; go1.25.14 gave `context canceled`. `ctx.Err()` stays `context.Canceled`,
  `errors.Is(cause, context.Canceled)` holds, and errgroup's context passes the cause on.
- **`signal.Notify` needs a buffered channel.** Reported by: `vet` sigchanyzer, `staticcheck SA1017`,
  `golangci:govet (standard)`, `golangci:staticcheck (standard)`, `gopls:sigchanyzer`; not `vet+test`.

## Handler panics

| Handler (HTTP/1.1, darwin) | No middleware: client sees | Naive recover (`http.Error(w, …, 500)`) | `Recover` below |
|---|---|---|---|
| panics before writing | EOF, no bytes | 500 | 500 |
| `Write`, then panic (not flushed) | EOF; the buffered body is discarded | **200, `partial body internal error\n`**, Content-Length set | EOF |
| `Write` + `Flush`, then panic | 200, partial body, `unexpected EOF` | **200, `partial body internal error\n`**, chunked, complete | 200, partial body, `unexpected EOF` |
| `panic(http.ErrAbortHandler)` | EOF; nothing logged | EOF (re-panicked) | EOF; nothing logged |
| a goroutine it started panics | **process exits (status 2); every in-flight request gets EOF** | same | same |

- **net/http recovers a handler panic, logs it with its stack to `ErrorLog` and closes the
  connection**; after a flush the client holds a 200 with a truncated body. Reported by: none — test or review.
- **A recover middleware cannot change the status once anything was written**: `WriteHeader(500)` is
  ignored (`http: superfluous response.WriteHeader call from <middleware> (file:line)`) and
  `http.Error`'s text is appended to the body. Abort the connection instead:

```go
func Recover(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &startWriter{ResponseWriter: w}
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if rec == http.ErrAbortHandler { //nolint:errorlint // net/http compares with ==
				panic(rec) // a deliberate abort: let net/http close the connection quietly
			}
			logger.Error("handler panic", "path", r.URL.Path, "panic", rec, "stack", string(debug.Stack()))
			if sw.started {
				panic(http.ErrAbortHandler) // closes the connection (not a hijacked one), logs nothing more
			}
			http.Error(w, "internal error", http.StatusInternalServerError)
		}()
		next.ServeHTTP(sw, r)
	})
}
```

  `startWriter` embeds `http.ResponseWriter`; `Write`, `FlushError` and a `WriteHeader` with
  `code >= 200 || code == http.StatusSwitchingProtocols` set `started`; `Flush` calls `FlushError`;
  `Hijack` sets `started` and calls `ResponseController.Hijack`; `Unwrap` serves `ResponseController`
  ([http-server](http-server.md)). Tested on a real server: the column above, also via
  `w.(http.Flusher)`; 103 then panic → the 103, then a clean 500 (marking every `WriteHeader` aborted
  it); 101 then panic → EOF (`code >= 200` alone: the 101 and a connection left open). A panic after a
  gorilla/websocket v1.5.3 upgrade left `ErrorLog` empty (without `Hijack` the upgrade got 500; without
  `started` set in it, `http.Error` logged `response.WriteHeader on hijacked connection`). Each panic
  was logged once at ERROR. After a `Hijack` the connection is the handler's: nothing closes it on a
  panic, so defer its `Close` (without it the client sat to its 2 s read deadline, with or without
  `Recover`). Reported by: none — test or review.
- **net/http compares the panic value with `==`**: `panic(fmt.Errorf("…: %w", http.ErrAbortHandler))`
  was logged with a stack. Panic with the sentinel itself. Reported by: none — test or review.
- **A goroutine started by a handler is outside every recover in the request path** (last row);
  recover inside it (see the go-style skill, errors-control). Reported by: none — test or review.

## Client disconnect

The handler optionally reads the body, then waits on `r.Context().Done()` or a 4 s timer; the client
sends the request, waits 0.5 s and goes away (HTTP/1.1, darwin):

| Request and handler | `r.Context()` canceled |
|---|---|
| no body (GET, or Content-Length 0) | at once |
| body read to EOF (`io.ReadAll`, `io.Copy(io.Discard, r.Body)`, a second `Decode` returning `io.EOF`) | at once |
| one `json.NewDecoder(r.Body).Decode` | at once only if EOF came with the last bytes (whole body, or the chunk terminator, in one segment); a trailing `\n` or the terminator 100 ms later, or 4 KiB of trailing spaces: **never** |
| body unread, half read, chunked unread, or 1 MiB still arriving and unread | **never**: the handler ran 4 s; its late `Write` returned nil |
| GET, client half-closes (`CloseWrite`) and keeps reading | at once; the client then read an **empty `200 OK`** |

- **A disconnect is visible only once the body is read to EOF, or a body read fails because the
  client left** (`io.ReadAll` or one `Decode` of a 1 MiB body got `unexpected EOF`, context canceled at
  once): work before the first read runs to completion for a client that left. One `Decode` stops at
  the end of the value. A half-close (`nc -N`, some proxies) counts. Reported by: none — test or review.
- **`r.Context()` is canceled when the handler returns** (seen 100 ms later from a goroutine). Work
  that outlives the response takes `context.WithoutCancel(r.Context())` (values kept, no deadline) and
  its own timeout; Shutdown does not wait for it. Reported by: none — test or review.

## Server error log

- **`ErrorLog: nil` writes to the `log` package's standard logger, which `slog.SetDefault` redirects
  at INFO**: a handler panic, a superfluous `WriteHeader`, HTTP on a TLS port and a failed handshake
  all came out at `"level":"INFO"`. `slog.NewLogLogger(h, slog.LevelError)` gives ERROR. Reported by: none — test or review.

## Workers and exit codes

- **A worker returns nil when its context ends** (`runWorker`: `case <-ctx.Done(): return nil`).
  Returning `ctx.Err()` made `run` return `context canceled`: exit 1 on every normal SIGTERM, while the
  request still completed 200. Reported by: none — test or review.
- **`errgroup.WithContext` cancels the group on the first error**: a failed listener stops the worker
  and skips the drain. errgroup basics (a panic in `g.Go` crashes the process): go-style, concurrency.

## Readiness and drain

- **Once Shutdown starts, new connections are refused** (a dial at +0.10 s), and one the kernel had
  completed but the server never accepted got a reset (darwin; Linux not run). So readiness goes false
  *before* Shutdown. With a 2 s drain delay: `/readyz` 503 and other routes 200 from +0.01 to +1.77 s,
  refused from +2.03 s; in-flight request 200 at +2.52; Shutdown nil at +2.55. Reported by: none — test or review.
- **Kubernetes (docs, not run)**: the kubelet runs `preStop`, then sends SIGTERM, while the control
  plane removes the pod from EndpointSlices; terminating endpoints are never ready, so `/readyz` going
  false matters only to checkers that probe the pod. The drain delay (in the app or a `preStop` `sleep`)
  covers endpoint and load-balancer propagation; the grace period (default 30 s) must exceed drain
  delay plus shutdown timeout, or SIGKILL follows.

## Build and deploy

- **GOMAXPROCS follows the container CPU limit `(main go ≥1.25)`, Linux only (docs)**: the cgroup
  quota (v2 `cpu.max`, v1 `cpu.cfs_quota_us`/`cpu.cfs_period_us`), i.e. the *limit*, not the request,
  rounded up, at least 2 unless fewer CPUs, updated up to once per second. A main module at go ≤1.24
  keeps the host count (`containermaxprocs=0`); setting `GOMAXPROCS` stops the updates. Reported by: (docs).
- **GOMEMLIMIT has no default**: `debug.SetMemoryLimit(-1)` returned `math.MaxInt64`, and the go1.27.1
  runtime does not read a cgroup memory limit. Set `GOMEMLIMIT` below the container limit yourself.
  Reported by: none — test or review.
- **A scratch image has no time zone database or CA certificates (docs).** `time.LoadLocation` tries
  `ZONEINFO`, system directories, embedded `time/tzdata`, then `$GOROOT/lib/time/zoneinfo.zip`
  (source): on scratch, `unknown time zone`; `import _ "time/tzdata"` in `main` adds 410 KB. Linux
  `crypto/x509` reads fixed paths (`/etc/ssl/certs/ca-certificates.crt`, `/etc/ssl/cert.pem`, …); with
  none, TLS fails `x509: certificate signed by unknown authority`: copy a bundle there, set
  `SSL_CERT_FILE`, or `import _ "golang.org/x/crypto/x509roots/fallback"`, used only without system
  roots (forced on darwin by `GODEBUG=x509usefallbackroots=1`: 120 roots, a public host verified,
  +167 KB). darwin found its zone database even with `ZONEINFO` empty. Reported by: none — test or review.
- **On darwin (and Windows, docs) `SSL_CERT_FILE` counts only with main go ≥1.27** (GODEBUG
  `x509sslcertoverrideplatform`): go1.27.1 ignored it for a go 1.26 module unless the GODEBUG was 1,
  and used it for a go 1.27 one; go1.26.8 ignored it at every setting. Reported by: (docs) + run.
- **Build info depends on how the binary was built** (`debug.ReadBuildInfo`). `go build` in a
  repository sets `vcs.revision`, `vcs.modified` and `Main.Version`: the tag, a pseudo-version, or
  `…+dirty` with any modified or untracked, not git-ignored file (a binary the last build wrote there:
  list it in `.gitignore`); `go run`, `-buildvcs=false` and builds outside a repository silently give
  `(devel)`. `-ldflags "-X main.version=…"` is **silently ignored** for a missing symbol, a `const` and
  a `var` set by a run-time call. `-ldflags "-s -w"` cut 2.48 MB to 1.62 MB and kept the module and VCS
  lines; `-trimpath` drops the `-ldflags` value from them. Reported by: none — test or review.
- **`CGO_ENABLED` defaults by build host**: 1 natively with a C compiler (darwin), 0 when cross-compiling
  (the linux/amd64 binary was static); set it explicitly. With 0, Linux DNS uses the pure Go resolver
  and `os/user` parses `/etc/passwd`, so NSS or LDAP users are invisible (docs).
- **`golang.org/x/sync` v0.24.0 declares `go 1.26.0`**: a `go 1.26` module requiring it fails
  `go build` (`go: updates to go.mod needed`); `go mod tidy` writes `go 1.26.0`, the same language version.

## Gotchas

- Agent returns from `main` when `ListenAndServe` returns, or wraps it in `log.Fatal` - every deploy cuts in-flight requests.
- Agent derives the Shutdown context from the signal context, or obeys contextcheck there - Shutdown drains nothing.
- Agent sets only `ReadHeaderTimeout` to satisfy G112 - bodies and idle connections stay unbounded.
- Agent sets `WriteTimeout` below the slowest handler or upload, or extends only the read deadline - the response is dropped, no error.
- Agent ends an SSE loop on `r.Context().Done()` only, or cancels `BaseContext` - Shutdown waits out its deadline, or aborts every request.
- Agent closes a channel in a `RegisterOnShutdown` hook without `sync.Once` - a second Shutdown panics the process.
- Agent keeps only `defer stop()` - a second Ctrl-C cannot kill a hung shutdown.
- Agent writes 500 in a recover middleware after the handler wrote - the client gets a 200 with a mixed body.
- Agent expects `r.Context()` to end on disconnect before the body is read to EOF (one `Decode` is not enough) - it does not, unless a body read was in progress.
- Agent calls `slog.SetDefault` and leaves `ErrorLog` nil - panics are logged at INFO.
- Agent returns `ctx.Err()` from a worker on shutdown - every SIGTERM exits 1.
- Agent shuts down with no drain delay behind a load balancer - connections are refused while traffic still arrives.
- Agent ships a scratch image without `time/tzdata` or CA certificates, or assumes a default GOMEMLIMIT - it fails only in the container.
- Agent passes `-X` for a `const` or a misspelled symbol - the build succeeds and the value is unchanged.

## Official sources

- [net/http Server](https://pkg.go.dev/net/http#Server), [Server.Shutdown](https://pkg.go.dev/net/http#Server.Shutdown), [Server.RegisterOnShutdown](https://pkg.go.dev/net/http#Server.RegisterOnShutdown), [ResponseController](https://pkg.go.dev/net/http#ResponseController), [ErrAbortHandler](https://pkg.go.dev/net/http#ErrAbortHandler), [os/signal NotifyContext](https://pkg.go.dev/os/signal#NotifyContext), [context.WithoutCancel](https://pkg.go.dev/context#WithoutCancel), [slog.NewLogLogger](https://pkg.go.dev/log/slog#NewLogLogger), [errgroup](https://pkg.go.dev/golang.org/x/sync/errgroup)
- [runtime.GOMAXPROCS](https://pkg.go.dev/runtime#GOMAXPROCS), [debug.SetMemoryLimit](https://pkg.go.dev/runtime/debug#SetMemoryLimit), [debug.BuildInfo](https://pkg.go.dev/runtime/debug#BuildInfo), [GODEBUG](https://go.dev/doc/godebug), [time/tzdata](https://pkg.go.dev/time/tzdata), [crypto/x509](https://pkg.go.dev/crypto/x509), [net name resolution](https://pkg.go.dev/net#hdr-Name_Resolution), [cmd/link](https://pkg.go.dev/cmd/link), [x509roots/fallback](https://pkg.go.dev/golang.org/x/crypto/x509roots/fallback)
- Release notes [Go 1.25](https://go.dev/doc/go1.25), [Go 1.26](https://go.dev/doc/go1.26), [Go 1.27](https://go.dev/doc/go1.27); [gosec rules](https://github.com/securego/gosec#available-rules); Kubernetes: [Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination), [Container lifecycle hooks](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)
