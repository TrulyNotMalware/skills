---
name: go-service
description: >
  How to build Go services and long-running daemons on the standard library: net/http servers and
  clients, database/sql, and their lifecycle. Use when writing, reviewing, or debugging
  ServeMux routes and patterns, handlers, JSON request and response bodies, middleware, server
  timeouts, graceful shutdown, signals, http.Client and Transport, database/sql, SQLite
  (modernc), PostgreSQL (pgx v5), transactions, goose migrations, JWT (golang-jwt), bcrypt, CORS
  and cookies, env and viper config, slog, Prometheus, OpenTelemetry, container builds, daemons
  that follow log files (rotation, fsnotify, checkpoints, batching, HTTP or Kafka sinks), Kafka
  (franz-go), Redis (go-redis), and httptest or synctest tests. Also use when a Go service "works
  but does the wrong thing" (a deploy that cuts requests, a route that returns 200 instead of 405,
  a header that never arrives, a client that hangs, foreign keys that are off, "database is
  locked", times that compare wrong, offsets read twice, a shutdown that exits 0).
---

# Go services and daemons

A Go service fails quietly at its edges: the zero values of `http.Server`, `http.Client` and
`sql.DB` mean "no timeout, no limit", the mux answers mistakes with a valid response, the database
pool hides per-connection state, and shutdown paths drop errors. This skill lists those cases with
the measured behaviour. Language-level Go (errors, typed nil, slices, JSON v1, `bufio.Scanner`,
timers, goroutines, errgroup, table tests, the go.mod gates and the tool matrix) is in the go-style
skill; use both together. Read the matching reference before editing that area.

## Target versions

Verified 2026-10-12 by running code on these versions, over HTTP/1.1 on darwin/arm64. Linux-only
behaviour (inotify, cgroups, scratch images, systemd) is marked "(docs)" in the references.

| Component | Baseline | Notes |
|---|---|---|
| Go toolchain | 1.27.1 (supported line: 1.26.8) | 1.27 drains small unread response bodies in the background after `Close` (reuse only once the drain ends); 1.26 sends 307 for mux redirects |
| go.mod `go` line | 1.26.0 | x/sync v0.24.0 and modernc.org/sqlite v1.60.1 declare `go 1.26.0`, so `go mod tidy` rewrites a bare `go 1.26` |
| SQLite | modernc.org/sqlite v1.60.1 | Driver name `sqlite`; pure Go |
| PostgreSQL | pgx/v5 v5.11.0 | Measured against PostgreSQL 17 |
| Auth | golang-jwt/jwt/v5 v5.3.1, x/crypto v0.58.0 | bcrypt |
| Messaging, cache | franz-go v1.22.1, go-redis/v9 v9.23.0 | Measured against Kafka 4.3 and Redis Cluster 8 |
| Daemon | fsnotify v1.10.1, x/sync v0.24.0 | fsnotify measured on kqueue; inotify from docs |
| Config, telemetry | caarlos0/env/v11 v11.4.1, viper v1.21.0, client_golang v1.25.0, otel v1.47.0, otelhttp v0.72.0 | |
| Migrations, tests | goose/v3 v3.29.0, testcontainers-go v0.44.0, goleak v1.3.0 | |
| Routers (short notes) | chi/v5 v5.3.2, gin v1.12.0, echo/v4 v4.16.0 | Fiber is out of scope (not net/http) |

Version tags follow go-style: `(go ≥1.22)` for the module's `go` line, `(main go ≥1.25)` for
GODEBUG behaviour, `(toolchain ≥1.27)`, and `(pgx v5.11)` style for libraries. The project's own
go.mod, lint config and root `AGENTS.md`/`CLAUDE.md` win over this table.

## Workflow

1. **Read how the service is put together first**: `main`/`run`, where the `http.Server`, clients,
   pools and producers are built, the middleware chain, the config loader, and one handler with its
   test. Follow their conventions; they beat the house defaults below, not the always-on rules.
2. **Open the reference** for the area before writing code in it.
3. **Prove behaviour where it happens.** A handler test goes through `httptest.NewServer` and the
   mux with its middleware, not a direct call with a recorder. Database code runs against the real
   engine (a SQLite file in `t.TempDir()`, PostgreSQL for pgx behaviour). Shutdown is tested by
   sending SIGTERM to the built binary during a request.
4. **Run** `go vet ./...`, the project's linter (or the go-style golangci baseline, whose
   bodyclose, noctx, rowserrcheck, sqlclosecheck and gosec matter most here), and
   `go test -race -count=1 ./...`. Most pitfalls in this skill are "none — test or review": the
   reference says which.

## Always-on rules

- **Never serve with `http.ListenAndServe` or a bare `http.Server`.** Set `ReadHeaderTimeout`,
  `ReadTimeout` (or per-request deadlines), `WriteTimeout` above the slowest response, and
  `IdleTimeout`; extend both deadlines with `http.NewResponseController` for long transfers.
- **`main` waits for `Shutdown` to return.** Its context comes from `context.WithoutCancel(ctx)`
  plus a timeout, never from the canceled signal context; streaming handlers stop on a channel
  closed by `RegisterOnShutdown`, because `Shutdown` does not cancel `r.Context()`.
- **Build each `http.Client` once and share it**, never a Transport per request; use one per
  upstream when timeouts, TLS, redirect policy or pool sizes differ, or the hosts together
  exceed `MaxIdleConns`. Clone `DefaultTransport`, set a timeout
  (`Client.Timeout`, or `ResponseHeaderTimeout` plus a per-call deadline for streams and
  downloads); always close the body, check the status code, and bound how much you read.
- **Pass the request's context to every call that can block** (database, HTTP, Redis, Kafka);
  use `context.WithoutCancel` plus a timeout for work that must finish after the request or signal.
  A franz-go `Produce` record outlives the call: detach its ctx, and in a request path use
  `TryProduce` and set `RecordDeliveryTimeout`, since a detached `Produce` blocks while the buffer
  is full and the brokers are down.
- **Bound and check every request body**: `http.MaxBytesReader`, a second `Decode` that must hit
  `io.EOF`, and an explicit `Content-Type` before the first write.
- **Per-connection database settings go where every new connection gets them** (the DSN, or the
  pool config: pgx `ConnConfig.RuntimeParams`, `AfterConnect`), never `db.Exec`, which reaches one
  pooled connection; set pool limits; check `rows.Err()`; never use the pool (`db`) inside a
  transaction.
- **Store times in one zone and one format**: UTC; `timestamptz` in PostgreSQL; in SQLite a DSN
  with `_time_format=sqlite&_timezone=UTC` (`_time_format=datetime&_timezone=UTC` when SQL itself
  writes timestamps) or integers. `_timezone=UTC` alone keeps the `t.String()` layout: Go-bound
  values still compare right, but `datetime(col)` and `julianday(col)` are NULL.
- **JWTs**: pin the methods, require `exp`, check a non-empty issuer and audience
  (`WithIssuer("")` turns the check off). **Secrets**: refuse to
  start with an empty key; never log headers or whole config structs.
- **Validate configuration at startup** and exit non-zero with the missing names.
- **Advance a checkpoint or commit an offset only after the side effect succeeded**, and make the
  handler idempotent; delivery is at-least-once.
- **On a normal shutdown components return nil**; only real failures become errors, so the exit
  code and the last log line mean something.

## House defaults

The skill author's choices where several approaches are common. Follow the codebase when it has
one.

- **Routing**: `net/http` `ServeMux` with method patterns; chi when a project needs route groups
  and already uses it. Gin and Echo only in projects that already use them.
- **Logging**: `log/slog` with a JSON handler to stdout, a `LevelVar`, and `Server.ErrorLog` set
  through `slog.NewLogLogger` at error level.
- **Config**: environment variables parsed into a struct with caarlos0/env (`notEmpty` for
  required values); keep viper where a project already uses it.
- **PostgreSQL**: native `pgxpool` for PostgreSQL-only code; `database/sql` + `pgx/v5/stdlib` when
  code must also run on another driver. **SQLite**: modernc with `_pragma=` settings,
  `_txlock=immediate`, and a file database (also in tests).
- **Migrations**: goose with embedded SQL files, run before the server starts.
- **Tests**: stdlib `testing` and `httptest.NewServer`; testcontainers for PostgreSQL, Kafka and
  Redis when the project has Docker in CI.

## Reference routing

| Task touches... | Read |
|---|---|
| Route patterns, precedence, 405 and redirects, `PathValue`, decoding JSON bodies, writing responses and errors, content sniffing, middleware and `ResponseWriter` wrappers, `r.Pattern`, `TimeoutHandler`, serving files and `os.Root`, pprof, chi, gin, echo | [reference/http-server.md](reference/http-server.md) |
| `main` and `run`, `http.Server` timeouts, `Shutdown`, SSE and streaming at shutdown, signals, handler panics and recover middleware, client disconnects, `ErrorLog`, worker exit codes, readiness, container builds, GOMAXPROCS, GOMEMLIMIT, tzdata, CA certificates, build info | [reference/lifecycle-deploy.md](reference/lifecycle-deploy.md) |
| `http.Client` and `Transport`, client timeouts and their errors, connection reuse, closing and draining bodies, status codes, body limits, redirects, re-sending requests | [reference/http-client.md](reference/http-client.md) |
| `database/sql` pool, contexts, rows, `QueryRow`, transactions, NULL, SQLite with modernc (PRAGMAs, `:memory:`, "database is locked", time values, error codes), placeholders and injection, goose migrations | [reference/database-sql.md](reference/database-sql.md) |
| pgx v5 and `pgxpool`, `pgx/v5/stdlib`, `PgError` codes, cancellation, `BeginFunc`, connection leaks, `CollectRows`, `timestamp` vs `timestamptz`, arrays and jsonb, the statement cache and PgBouncer | [reference/postgres-pgx.md](reference/postgres-pgx.md) |
| JWT verification with golang-jwt v5, bcrypt, comparing secrets, random tokens, cookies, CORS, `CrossOriginProtection`, client IP and the `Host` header behind proxies | [reference/security-auth.md](reference/security-auth.md) |
| Env and config structs, caarlos0/env, viper, slog setup and redaction, the slog empty-group bug, context logging, Prometheus, OpenTelemetry | [reference/config-observability.md](reference/config-observability.md) |
| A daemon that follows files: process structure with errgroup, `bufio.Reader` follow loops, rotation and copytruncate, fsnotify, checkpoint files, batching and backpressure, an HTTP sink with retries, SIGTERM, SIGHUP, SIGPIPE, systemd | [reference/daemon.md](reference/daemon.md) |
| Kafka with franz-go: producing and flushing, record contexts, consumer offsets and commits, rebalances | [reference/kafka.md](reference/kafka.md) |
| Redis with go-redis v9: `redis.Nil`, context deadlines, timeouts and pool waits, TTLs and locks, cluster slots | [reference/redis.md](reference/redis.md) |
| Recorder or server, testing through the mux, `httptest.Server` lifecycle, `testing/synctest` and `httptest.NewTestServer`, databases in tests, testcontainers, goleak, the race detector, comparing JSON | [reference/testing.md](reference/testing.md) |

## Gotchas

These compile, pass `go vet` and a quick test, and are wrong. Each reference has a longer list and
says which tool, if any, reports each one.

- Agent returns from `main` when `ListenAndServe` returns, or derives the Shutdown context from the signal context - every deploy cuts in-flight requests. See [lifecycle-deploy](reference/lifecycle-deploy.md#the-run-shape).
- Agent sets only `ReadHeaderTimeout` to satisfy gosec - request bodies and idle connections stay unbounded.
- Agent sets `WriteTimeout` below the slowest response - the client gets no response (a flushed stream is cut at the deadline) and `w.Write` returns nil.
- Agent registers a `/` catch-all next to method patterns - wrong methods get 200 instead of 405. See [http-server](reference/http-server.md#registering-routes).
- Agent tests a handler by calling it with a recorder - `r.PathValue` is `""` and late headers look sent. See [testing](reference/testing.md#recorder-or-server).
- Agent gives a `ResponseWriter` wrapper only `Unwrap`, or reads `r.Pattern` before `next` or above a layer that calls `r.WithContext` - code asserting `http.Flusher` stops streaming; every metric label is empty.
- Agent calls `http.Get` or builds a client without a timeout, or a Transport per request - a silent upstream blocks forever; connections leak. See [http-client](reference/http-client.md#timeouts).
- Agent retries by calling `Do` again with the same request - a ContentLength error on a fresh connection, or an empty body for a custom reader; a test with an idle connection passes.
- Agent sets SQLite PRAGMAs with `db.Exec`, or relies on `busy_timeout` for read-then-write transactions - foreign keys stay off on other connections; "database is locked" anyway. See [database-sql](reference/database-sql.md#per-connection-state).
- Agent binds `time.Time` to SQLite with the default DSN, or a non-UTC time to a PostgreSQL `timestamp` - comparisons are wrong or values come back hours off. See [database-sql](reference/database-sql.md#time-values-in-sqlite).
- Agent leaves a pgx `QueryRow` unscanned or `SendBatch` unclosed - a pooled connection is held and `pool.Close()` blocks forever. See [postgres-pgx](reference/postgres-pgx.md).
- Agent keeps franz-go's default autocommit, or closes without flushing - records are re-read after a clean restart, or dropped. See [kafka](reference/kafka.md).
- Agent parses JWTs without `WithValidMethods` and `WithExpirationRequired` - other algorithms and tokens that never expire pass. See [security-auth](reference/security-auth.md#verifying-jwts).
- Agent drops an attribute in slog `ReplaceAttr` with `slog.Attr{}` - on Go 1.22–1.27.1 an emptied group makes JSONHandler write invalid JSON (golang/go#81970, fixed for Go 1.28). See [config-observability](reference/config-observability.md#the-replaceattr-empty-group-bug).
- Agent follows a log file with `bufio.Scanner` or watches the file instead of its directory - the follower stops or misses rotation with no error. See [daemon](reference/daemon.md#following-a-file).
- Agent lets the tailer return `context.Canceled` on SIGTERM and treats `Canceled` as success - a final flush that failed exits 0 with nothing logged (or, if `main` logs every error, the log shows `context canceled` instead of the flush error). See [daemon](reference/daemon.md#process-structure).

## Maintaining this skill

When bumping versions: update the table above, then grep this directory for `toolchain ≥`,
`main go ≥`, `go ≥`, `1.27`, `1.28`, `GODEBUG`, `pgx v5`, `golang-jwt`, `franz-go`, `go-redis`,
`modernc`, `fsnotify`, `goose`, `client_golang`, `otel`, `#81970` and re-run each tagged
statement. Re-run the body-drain measurements first (http-server's `MaxBytesReader` table,
http-client's body drain); they changed between 1.26 and 1.27, while the server timeout, shutdown
and disconnect tables were identical on go1.26.8 and go1.27.1. The change history is kept outside this directory, in the author's wiki.
