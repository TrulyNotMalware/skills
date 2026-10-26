# PostgreSQL with pgx

Applies to the Go 1.27.1 toolchain with a go.mod `go` line of 1.26.0 or later, pgx v5.11.0
(`pgx`, `pgxpool`, `pgconn`, `pgtype`, `stdlib`) and golangci-lint v2.14 unless a rule carries a
version tag. Every server behaviour below was measured against PostgreSQL 17.11 from darwin/arm64
(`runtime.NumCPU()` 8); "(docs)" and "(source)" mark what was read, not run. What all
`database/sql` drivers share is in [database-sql](database-sql.md); this file covers pgx and where
`database/sql` + `pgx/v5/stdlib` differs. pgx fails on paths a happy test never takes: an ignored
error discards the whole transaction at commit, an unscanned row pins a connection until shutdown
hangs, a timeout costs a reconnect by default, and a `timestamp` column shifts by the local offset.

Contents: [Choosing pgxpool or database/sql](#choosing-pgxpool-or-databasesql) · [Opening a pool](#opening-a-pool) ·
[Errors](#errors) · [Context cancellation and timeouts](#context-cancellation-and-timeouts) ·
[Transactions](#transactions) · [Rows and connection leaks](#rows-and-connection-leaks) · [Types](#types) ·
[Statement cache and PgBouncer](#statement-cache-and-pgbouncer) · [Gotchas](#gotchas)

## Choosing pgxpool or database/sql

20 goroutines each ran `SELECT pg_sleep(1)` on a default-configured pool:

| Pool | Cap | During the burst | Wall time |
|---|---|---|---|
| `sql.Open("pgx", dsn)` | none (`MaxOpenConns` 0) | 20 server backends; afterwards 18 closed (`MaxIdleConns` 2) | 1.2 s |
| `pgxpool.New(ctx, dsn)` | `max(4, runtime.NumCPU())` = 8 | 8 acquired, 12 waiting | 3.1 s |
| `stdlib.OpenDBFromPool(pool)` | the pgxpool's 8 | pgxpool 8 acquired while `db.Stats()` said `open=20 inuse=20` | 3.1 s |

- **`pgxpool` for PostgreSQL-only code; database/sql + stdlib when a library needs `*sql.DB`**
  (goose, sqlc's database/sql mode). `sql.Open("pgx", …)` gets database/sql's unbounded pool: size
  it ([database-sql](database-sql.md)). With `OpenDBFromPool` read `pool.Stat()`; closing the
  `*sql.DB` left the pool open (`pool.Ping` still nil).
- **`pool_*` DSN keys work only through `pgxpool.ParseConfig`**: pgx sends unknown keys to the
  server as runtime parameters. `sql.Open("pgx", dsn+"?pool_max_conns=5")` returned nil, then every
  connection failed with `unrecognized configuration parameter "pool_max_conns" (SQLSTATE 42704)`;
  so did `pgx.Connect`. Real parameters travel the same way (`timezone=` set the session zone).
  Reported by: none — test or review.

## Opening a pool

```go
// OpenPool opens a pool with explicit sizing and fails fast if the database is unreachable.
// pgxpool.NewWithConfig does not connect; Ping does.
func OpenPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn) // the error text masks the password but shows user, host and db
	if err != nil {
		return nil, fmt.Errorf("parse database config: %w", err)
	}
	cfg.MaxConns = 10 // default max(4, runtime.NumCPU())
	cfg.MinIdleConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.ConnConfig.RuntimeParams["application_name"] = "orders-api"

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}
```

`ParseConfig` defaults `(pgx v5.11)` and their DSN keys, as in `postgres://app@example.com:5432/app?pool_max_conns=20`:

| Setting | Default | DSN key |
|---|---|---|
| `MaxConns` / `MinConns` / `MinIdleConns` | `max(4, NumCPU)` / 0 / 0 | `pool_max_conns` / `pool_min_conns` / `pool_min_idle_conns` |
| `MaxConnLifetime` (+ jitter) / `MaxConnIdleTime` | 1 h (+ 0) / 30 min | `pool_max_conn_lifetime` (`_jitter`) / `pool_max_conn_idle_time` |
| `HealthCheckPeriod` / `PingTimeout` | 1 min / none | `pool_health_check_period` / `pool_ping_timeout` |
| `ConnConfig.ConnectTimeout` | 0: only the ctx bounds the dial | `connect_timeout` |
| `ConnConfig.DefaultQueryExecMode` | `cache_statement`, 512 statements per connection | `default_query_exec_mode` |

- **`NewWithConfig` does not connect, even with `MinConns` 1**: a wrong password returned nil in
  0 s; the first `Ping` failed with `password authentication failed … (SQLSTATE 28P01)`.
- **A hand-built `&pgxpool.Config{…}` panics** in `NewWithConfig` (`config must be created by
  ParseConfig`) at run time. Start from `ParseConfig`.
- **Parse errors quote the DSN with the password masked**, user, host and database intact:
  ``cannot parse `postgres://app:xxxxx@example.com:5432/app?pool_max_conns=0`: pool_max_conns too small``.
  Reported by: none — test or review, for this section.

## Errors

```go
var (
	ErrNotFound       = errors.New("not found")
	ErrDuplicateEmail = errors.New("email already registered")
)

type User struct {
	ID    int64
	Email string
	Name  *string // nullable column
}

type UserRepo struct {
	db *pgxpool.Pool
}

const uniqueViolation = "23505" // SQLSTATE unique_violation

// Create maps a unique violation by SQLSTATE and constraint name.
func (r *UserRepo) Create(ctx context.Context, email string) (int64, error) {
	var id int64
	err := r.db.QueryRow(ctx, `INSERT INTO users (email) VALUES ($1) RETURNING id`, email).Scan(&id)
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok &&
		pgErr.Code == uniqueViolation && pgErr.ConstraintName == "users_email_key" {
		return 0, ErrDuplicateEmail
	}
	if err != nil {
		return 0, fmt.Errorf("insert user: %w", err)
	}
	return id, nil
}
```

| No row, through | `Is(err, pgx.ErrNoRows)` | `Is(err, sql.ErrNoRows)` |
|---|---|---|
| pgxpool `QueryRow().Scan`, `CollectOneRow`, `CollectExactlyOneRow`, also after `%w` | true | true |
| `database/sql` + stdlib `QueryRowContext().Scan` | **false** | true |

- **Match `sql.ErrNoRows`**: `pgx.ErrNoRows` wraps it `(pgx ≥5.7)`, so one check covers both APIs.
  Reported by: `golangci:errorlint (opt-in)` for `err == pgx.ErrNoRows`; none — test or review
  for `pgx.ErrNoRows` on a database/sql path, and for every bullet below.
- **Extra rows are dropped silently**: on two rows `QueryRow().Scan` and `CollectOneRow` returned
  the first and nil; `CollectExactlyOneRow` returned `pgx.ErrTooManyRows`.
- **`*pgconn.PgError` is the same type on both APIs and through `%w`** (`errors.As` below a `go
  1.26` line). Compare `Code` with a local constant (`github.com/jackc/pgerrcode` has names, docs).
  `Error()` omits `Detail`, which holds row values (`Key (email)=(a@x) already exists.`).
- **NOT NULL (23502) has an empty `ConstraintName`**; `ColumnName` names the column. Failed
  inserts still consume sequence values (the fifth attempt got id 5, one row stored).
- **Placeholders are `$1`, `$2`**: `?` reached the server and failed with `syntax error at or near
  "::"` or `at end of input` (SQLSTATE 42601) on both APIs.

## Context cancellation and timeouts

`SELECT pg_sleep(10)` with a 200 ms ctx unless stated; the server watched via `pg_stat_activity`:

| Configuration | Returned | Error | `Is(DeadlineExceeded)` | Connection | Server query |
|---|---|---|---|---|---|
| pgxpool, default | 200 ms | `timeout: context deadline exceeded` (`pgconn.Timeout` true, `SafeToRetry` false) | true | destroyed | gone at +0.3 s |
| pgxpool + `CancelOnServer` | 340 ms | `canceling statement due to user request (SQLSTATE 57014)` | **false** | kept | canceled |
| pgxpool + `statement_timeout=100ms`, ctx 1 s | 110 ms | `canceling statement due to statement timeout (SQLSTATE 57014)` | **false** | kept | canceled |
| pgxpool + `statement_timeout=200ms` | 200 ms | ctx won: `timeout: context deadline exceeded` | true | destroyed | gone |
| database/sql + stdlib | 200 ms | `timeout: context deadline exceeded` | true | replaced | gone |

```go
const queryCanceled = "57014" // statement_timeout, or a cancel request

// IsQueryTimeout reports a query stopped by the caller's deadline or canceled
// by the server (statement_timeout, CancelRequestContextWatcherHandler).
func IsQueryTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	pgErr, ok := errors.AsType[*pgconn.PgError](err)
	return ok && pgErr.Code == queryCanceled
}

// CancelOnServer makes a context deadline send a cancel request at once and wait up
// to 1 s for the server to stop the query, instead of closing the connection.
func CancelOnServer(cfg *pgxpool.Config) {
	cfg.ConnConfig.BuildContextWatcherHandler = func(pc *pgconn.PgConn) ctxwatch.Handler {
		return &pgconn.CancelRequestContextWatcherHandler{Conn: pc, DeadlineDelay: time.Second}
	}
}
```

- **By default every deadline or cancel that lands during a query costs a connection**: pgx sends a
  cancel request on a new connection and closes the old one (`pgconn` `asyncClose`); the next
  query ran on a new backend, for a deadline and for a plain cancel (`context canceled` at 201 ms).
  Through a proxy that refused the cancel connection, `pg_sleep(10)` kept running its full 10 s.
  A ctx already canceled before the call returned `context canceled` and kept the connection.
- **With `statement_timeout` or `CancelOnServer` a timeout is 57014, not `context.DeadlineExceeded`**,
  so `errors.Is` alone files it as a database failure. With the handler a plain cancel also ends
  as 57014 (at 312 ms, `Is(err, context.Canceled)` false): read the caller's `ctx.Err()` when the
  difference matters. Reported by: none — test or review.
- **`statement_timeout`** (`cfg.ConnConfig.RuntimeParams["statement_timeout"] = "5s"` or the DSN)
  kept the connection, and also bounded a query whose ctx had no deadline (57014 at 107 ms).

## Transactions

The shape is database/sql's ([database-sql](database-sql.md)) with a ctx on each call.
`pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{}, fn)` wraps `fn`; its ctx covers only BEGIN, COMMIT
and ROLLBACK (doc), so pass a ctx to every statement inside `fn`.

```go
// Wrong: the ignored duplicate-key error aborts the transaction. BeginFunc then
// returns "commit unexpectedly resulted in rollback" and the first row is lost too.
func insertTwice(ctx context.Context, pool *pgxpool.Pool) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		_, _ = tx.Exec(ctx, `INSERT INTO t VALUES ('a')`)
		_, _ = tx.Exec(ctx, `INSERT INTO t VALUES ('a')`) // duplicate key, ignored
		return nil
	})
}
```

| Case (pgxpool, `MaxConns` 2) | Result |
|---|---|
| Commit, then the deferred Rollback | `pgx.ErrTxClosed`; row kept |
| a statement fails, the next one runs, then Commit | next: `current transaction is aborted … (SQLSTATE 25P02)`; Commit: `pgx.ErrTxCommitRollback`; 0 rows |
| `tx.Rollback(canceledCtx)` | `timeout: context already done: context canceled`; connection closed; server rolled back |
| `tx.Commit(canceledCtx)` | the same error; **not committed**; connection closed |
| `sp, _ := tx.Begin(ctx)`, a failure in `sp`, `sp.Rollback(ctx)` | savepoint rolled back; outer transaction continues and commits |
| two transactions never ended, then a query with a 500 ms ctx | `context deadline exceeded`: each open Tx holds a connection |
| `pool.Exec(ctx, "BEGIN")` | nil; the connection is destroyed on release, so BEGIN never spans two calls |

- **One failed statement poisons the transaction** (25P02 for every later one); when fn drops the
  first error the caller sees only `ErrTxCommitRollback`. Return the first error (fn's error and
  a panic in fn both rolled back); wrap a statement that may fail in a savepoint (`tx.Begin`).
- **A request ctx canceled before Commit rolls the write back.** Not run: a cancel while COMMIT is
  in flight, where the server may commit while the client gets an error.
- **`defer tx.Rollback(ctx)`** is `golangci:errcheck (standard)`: write
  `defer func() { _ = tx.Rollback(ctx) }()`. The rest of this section: none — test or review.

## Rows and connection leaks

```go
// List returns up to limit users. CollectRows closes rows and returns rows.Err.
func (r *UserRepo) List(ctx context.Context, limit int) ([]User, error) {
	rows, err := r.db.Query(ctx, `SELECT id, email, name FROM users ORDER BY id LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	users, err := pgx.CollectRows(rows, pgx.RowToStructByName[User])
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
}
```

```go
// Wrong: each of these keeps one connection; pool.Close then blocks forever.
func leak(ctx context.Context, pool *pgxpool.Pool, b *pgx.Batch) {
	_ = pool.QueryRow(ctx, `SELECT 1`) // never scanned

	rows, _ := pool.Query(ctx, `SELECT g FROM generate_series(1, 3) g`)
	rows.Next() // abandoned after one row, never closed

	br := pool.SendBatch(ctx, b)
	_, _ = br.Exec() // results never closed
}
```

- **Each leak holds a connection, and shutdown never finishes**: with `MaxConns` 2, abandoned rows
  plus an unscanned `QueryRow` made the next query fail at its 300 ms deadline (rows read to the
  end released theirs). `pool.Close()` "blocks until all connections are returned" (doc): with one
  unscanned `QueryRow` it was still blocked after 3 s (a fatal deadlock with no other goroutine).
- **Iterating by hand**: `defer rows.Close()` after the error check (pgx's `Close` returns nothing,
  so errcheck stays quiet), then `rows.Err()` after the loop: `SELECT 10/(5-g) FROM
  generate_series(1,10) g` gave `Query` nil, four rows, then `division by zero (SQLSTATE 22012)`
  only from `rows.Err()`. `CollectRows` returns it, and returns a `Query` error again, so the pgx
  idiom `rows, _ := pool.Query(…)` + `CollectRows` loses nothing.
- **`SendBatch` results need `Close`** like rows; on a single `pgx.Conn` the next call fails with
  `conn busy`. In a batch a failing query and every later one return the same error, as does
  `Close`. **`CopyFrom` is all-or-nothing**: a duplicate in the second row stored neither.
- **`RowToStructByName` is strict**: one NULL in a `string` field failed the whole `CollectRows`
  with no rows (`cannot scan NULL into *string`); a column with no field and a field with no column
  both failed, unless `RowToStructByNameLax` (field left zero). Untagged fields matched columns
  case-insensitively; `db:"…"` tags name them.
- **Linters see none of the pgx forms**: none — test or review (`staticcheck SA4004` flags only a
  loop that always returns on its first pass); `golangci:rowserrcheck (opt-in)`,
  `golangci:sqlclosecheck (opt-in)` and `gopls:sqlrowserr` cover database/sql rows only.

## Types

Reported by, for this section: none — test or review. A `time.Time` of 15:00 Asia/Seoul (06:00
UTC) written by both APIs and read back; server zone Asia/Seoul, session `timezone` Asia/Seoul or
America/New_York:

| Column | Process `TZ` | Read back (both APIs, either session zone) | `Equal(input)` |
|---|---|---|---|
| `timestamptz` | Asia/Seoul | `15:00:00 +0900 KST`, Location `time.Local` | true |
| `timestamptz` | UTC | `06:00:00 +0000 UTC`, Location `time.Local` | true |
| `timestamp` | either | `15:00:00 +0000 UTC` | **false: 9 h off** |

- **`timestamp` stores the wall clock and drops the zone**: a non-UTC `time.Time` (`time.Now()` in
  a process whose zone is not UTC) reads back shifted by its offset. Store instants in `timestamptz`.
- **`timestamptz` comes back in `time.Local`** `(pgx ≥5.11 text format; binary always)`: the
  instant is right, rendering follows the process `TZ`. `.UTC()` before rendering, or set the
  codec's `ScanLocation` (docs).
- **`numeric` into `float64` loses digits without an error**: `12345678901234567.89` became
  `1.2345678901234568e+16`. Scan into `string` or `pgtype.Numeric` (exact).
- **NULL into `string` fails at `Scan`**; `*string`, `pgtype.Text` and `sql.NullString` read it.
  `text[]` ↔ `[]string` works both ways (NULL → nil slice, `'{}'` → empty); jsonb scans into a
  struct, `map[string]any` (numbers as `float64`) or `[]byte`, and SQL NULL into a struct fails.
- **database/sql + stdlib scans `text[]` into `*[]string` and `jsonb` into a struct only on
  go1.27** `(toolchain ≥1.27)` `(pgx ≥5.11)`: the same module (`go 1.26` line) built by go1.26.8
  failed with `unsupported Scan, storing driver.Value type string into type *[]string` (`[]uint8`
  for jsonb). pgx's stdlib implements Go 1.27's `driver.RowsColumnScanner` behind a go1.27 tag.

```go
// postTags scans text[] through database/sql + stdlib on any toolchain.
func postTags(ctx context.Context, db *sql.DB, id int64) ([]string, error) {
	m := pgtype.NewMap()
	var tags []string
	err := db.QueryRowContext(ctx, `SELECT tags FROM posts WHERE id = $1`, id).Scan(m.SQLScanner(&tags))
	return tags, err
}
```

`SQLScanner` finds the PostgreSQL type by the destination's Go type: `[]string` is known, a struct
or map for `jsonb` is not (`cannot find registered type for *main.Doc`, both toolchains) until its
pointer type is registered: after `m.RegisterDefaultPgType(&doc, "jsonb")` a struct and a
`map[string]any` scanned on go1.26.8 and go1.27.1; `RegisterDefaultPgType(Doc{}, "jsonb")` still
failed. Or scan `jsonb` into `[]byte` and `json.Unmarshal`.

## Statement cache and PgBouncer

pgxpool, `MaxConns` 3, each connection warmed with the query, then `ALTER TABLE`, then the query
twice more on each connection:

| `default_query_exec_mode` | ALTER | First run on each connection | Second |
|---|---|---|---|
| `cache_statement` (default) | `ADD COLUMN` or a column `TYPE` change | `cached plan must not change result type (SQLSTATE 0A000)` | ok |
| `cache_describe` | `ADD COLUMN` | `bind message has 2 result formats but query has 3 columns (SQLSTATE 08P01)` | ok |
| `cache_describe` | column `TYPE` change | ok, new type decoded | ok |
| `exec`, `simple_protocol` | both | ok | ok |

- **A migration under a live pool fails once per pooled connection per cached statement**: pgx
  drops the entry on the error, without retrying, and the next call re-prepares. `Query` without
  arguments is cached too; `Exec` without arguments always uses the simple protocol (source).
  Reported by: none — test or review.
- **PgBouncer transaction or statement pooling** (docs, not run): ≥1.21 with
  `max_prepared_statements` > 0 supports the default mode; otherwise set
  `cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec` (DSN `default_query_exec_mode=exec`).
  `cache_describe` and `simple_protocol` also work, `exec` is preferred, never `describe_exec`.

## Gotchas

- Agent checks `errors.Is(err, pgx.ErrNoRows)` in code that also runs through database/sql - the not-found branch never runs there.
- Agent puts `pool_max_conns` in a DSN for `sql.Open("pgx", …)` - every connection fails with SQLSTATE 42704.
- Agent treats a nil error from `pgxpool.NewWithConfig` as a reachable database - a wrong password surfaces at the first query.
- Agent ignores a statement's error inside `BeginFunc` - the whole transaction rolls back at commit.
- Agent passes the request ctx to Commit - a client that disconnects before Commit rolls the write back.
- Agent classifies timeouts with `errors.Is(err, context.DeadlineExceeded)` only - `statement_timeout` arrives as 57014.
- Agent calls `pool.QueryRow` without `Scan`, breaks out of rows without `Close`, or skips `br.Close()` - the connection never returns and shutdown hangs.
- Agent writes a non-UTC `time.Time` into a `timestamp` column - it reads back shifted by the offset.
- Agent scans `numeric` into `float64` - digits are lost without an error.
- Agent scans `text[]` or `jsonb` through database/sql and tests on go1.27 only - a go1.26 build fails at run time; for jsonb `SQLScanner` also needs the pointer type registered (`&doc`, not `Doc{}`).
- Agent runs `ALTER TABLE` under a warmed pool - each connection fails once with 0A000.
- Agent keeps the default cached-statement mode behind PgBouncer transaction or statement pooling - use `exec` or `simple_protocol` (also `cache_describe`), unless PgBouncer ≥1.21 has `max_prepared_statements` > 0.

## Official sources

- pgx v5.11.0: [pgx](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.11.0) (package doc: PgBouncer), [pgxpool](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.11.0/pgxpool), [pgconn](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.11.0/pgconn), [pgtype](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.11.0/pgtype), [stdlib](https://pkg.go.dev/github.com/jackc/pgx/v5@v5.11.0/stdlib), [CHANGELOG](https://github.com/jackc/pgx/blob/v5.11.0/CHANGELOG.md)
- Package [database/sql/driver](https://pkg.go.dev/database/sql/driver) (`RowsColumnScanner`) and the [Go 1.27 release notes](https://go.dev/doc/go1.27)
- PostgreSQL 17: [error codes](https://www.postgresql.org/docs/17/errcodes-appendix.html), [date/time types](https://www.postgresql.org/docs/17/datatype-datetime.html), [numeric types](https://www.postgresql.org/docs/17/datatype-numeric.html), [statement_timeout](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-STATEMENT-TIMEOUT), [canceling requests](https://www.postgresql.org/docs/17/protocol-flow.html#PROTOCOL-FLOW-CANCELING-REQUESTS)
- PgBouncer [max_prepared_statements](https://www.pgbouncer.org/config.html#max_prepared_statements)
