# database/sql and SQLite

Applies to the Go 1.27.1 toolchain with a go.mod `go` line of 1.26 or later, `database/sql`,
modernc.org/sqlite v1.60.1 (driver `sqlite`, SQLite 3.53.4) and goose v3.29.0 unless a rule carries
a version tag; modernc v1.60.1 itself requires `go 1.26.0`. **database/sql** rules hold for any
driver, **SQLite/modernc** rules for this driver only (PostgreSQL: [postgres-pgx](postgres-pgx.md)).
The pool opens, recycles and replaces connections on its own and SQLite compares whatever text the
driver wrote, so settings vanish, a second connection sees another database and time comparisons go
wrong after a one-connection test passed. Measured on darwin/arm64.

Contents: [Opening and the pool](#opening-and-the-pool) · [Per-connection state](#per-connection-state) ·
[In-memory databases](#in-memory-databases) · [Locking and concurrency](#locking-and-concurrency) ·
[Self-deadlocks and stale reads](#self-deadlocks-and-stale-reads) · [Rows](#rows) ·
[QueryRow and Exec](#queryrow-and-exec) · [Transactions](#transactions) · [NULL](#null) ·
[Time values in SQLite](#time-values-in-sqlite) ·
[Placeholders, IN lists and injection](#placeholders-in-lists-and-injection) ·
[Error codes, statements, cancellation](#error-codes-statements-cancellation) ·
[Migrations with goose](#migrations-with-goose) · [Gotchas](#gotchas)

## Opening and the pool

```go
func OpenSQLite(ctx context.Context, path string) (*sql.DB, error) {
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)") // wait for the write lock instead of failing with SQLITE_BUSY
	q.Add("_pragma", "journal_mode(WAL)")  // readers do not block the writer; persists in the file
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")   // BEGIN takes the write lock: no SQLITE_BUSY on read-then-write
	q.Set("_time_format", "sqlite") // "2006-01-02 15:04:05.999999999-07:00" instead of t.String()
	q.Set("_timezone", "UTC")       // store every time.Time in UTC so text comparison orders them

	db, err := sql.Open("sqlite", path+"?"+q.Encode())
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	// SQLite allows one writer at a time; extra connections only add readers.
	// Keep idle = open so connections (and their PRAGMAs and prepared statements)
	// are reused rather than reopened.
	n := max(4, runtime.NumCPU())
	db.SetMaxOpenConns(n)
	db.SetMaxIdleConns(n)
	if err := db.PingContext(ctx); err != nil { // sql.Open does not connect
		_ = db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return db, nil
}
```

`_ "modernc.org/sqlite"` registers the driver. Removing any key but `synchronous(NORMAL)` failed a test.

- **`sql.Open` does not connect** (database/sql; modernc reads the DSN at the first connection): a
  missing directory and `?_txlock=bogus` returned nil and failed at `PingContext`.
- **Pool defaults** (database/sql): `MaxOpenConns` 0 (unlimited), `MaxIdleConns` 2, no lifetime or
  idle time; releasing 5 held connections left `Open=2 Idle=2 MaxIdleClosed=3`. Each closed
  connection takes its PRAGMAs and prepared statements along. Watch `db.Stats()` (`WaitCount`,
  `InUse`, `MaxIdleClosed`).

Reported by: none — test or review.

## Per-connection state

**SQLite/modernc.** `foreign_keys`, `busy_timeout`, `synchronous` and most PRAGMAs belong to one
connection. After `db.Exec("PRAGMA foreign_keys=ON")`, a `db` call made while a Tx held conn#1 ran
on a new conn#2 with `foreign_keys=0 busy_timeout=0`. Its orphan `INSERT` was stored (`err = <nil>`;
conn#1 rejected the same row `(787)`, or failed `(517)` in WAL once conn#2 had committed after the Tx
read) while the Tx held no lock that blocks it (rollback journal: before the Tx read; WAL: before it
wrote); otherwise it failed at once with `database is locked (5)`,
busy_timeout being 0 there too. With `SetMaxOpenConns(1)` and `SetConnMaxIdleTime(200ms)` the PRAGMA was
gone after 1.5 s idle; an [interrupted query](#error-codes-statements-cancellation) also replaces it.

- **Put PRAGMAs in the DSN.** modernc's `newConn` ends with `applyQueryParams(c, query,
  defensiveMode)`, which runs `"pragma " + v` for each `_pragma` value on every connection the pool
  opens: three connections held at once each read `foreign_keys=1 busy_timeout=5000 synchronous=1`.
  Shorthand keys (`_foreign_keys=1&_busy_timeout=5000`) did the same `(modernc v1.60.1)`.
- `journal_mode=WAL` persists in the file (a later DSN without keys read `wal`, `foreign_keys=0`).
  A `_pragma` value is SQL text (`foreign_keys(1);ATTACH …` ran the ATTACH): keep the DSN constant.
- **SQLite URI keys need the `file:` prefix**: `<path>?mode=ro` opened read-write and wrote;
  `file:<path>?mode=ro` failed `attempt to write a readonly database (8)`.

Reported by: none — test or review.

## In-memory databases

**SQLite/modernc with the database/sql pool.** Each connection to `:memory:` is its own empty
database. After `CREATE TABLE t` and 2 rows through `db.Exec`, `SELECT count(*) FROM t` gave:

| DSN and pool | result |
|---|---|
| `:memory:`, default pool | `2` for sequential calls (the idle connection was reused); `no such table: t (1)` while a Tx held conn#1, and for 7 of 8 concurrent calls |
| `:memory:` + `SetMaxOpenConns(1)` | `2` |
| … + `SetConnMaxIdleTime` or `SetConnMaxLifetime` 200 ms, 1 s later | `no such table`: the data left with the connection |
| … + `SetMaxIdleConns(0)` | `no such table` on the next call |
| `file::memory:?cache=shared` | `2` on every connection |

- **Shared-cache names are process-wide**: a second `*sql.DB` with the same
  `file::memory:?cache=shared` (or `file:testA?mode=memory&cache=shared`) saw the first one's rows
  and its `CREATE TABLE t` failed `table t already exists`: parallel tests share one database.
- **Shared-cache table locks wait without limit**: behind an uncommitted INSERT, another
  connection waited 3 s for the commit, ignoring `busy_timeout(1000)` and a 500 ms ctx deadline; from
  the goroutine holding the Tx it never returned.
- **In tests use a file in `t.TempDir()`** with the production DSN:
  `OpenSQLite(t.Context(), filepath.Join(t.TempDir(), "test.db"))` ([testing](testing.md)).

Reported by: none — test or review.

## Locking and concurrency

**SQLite/modernc.** One writer at a time; each pooled connection is a separate lock holder. 16
goroutines × 50 operations on one `*sql.DB`, successes of 800 over 7 runs (counts vary from run to
run and other runs fell slightly outside these ranges; zero versus non-zero failures never changed); the tx is `BEGIN; SELECT count(*); INSERT; COMMIT`; failures were
`database is locked (5) (SQLITE_BUSY)` and, in WAL, `database is locked (517)`:

| configuration | rollback journal: autocommit INSERT / read-then-write tx | WAL: same |
|---|---|---|
| default pool, no busy_timeout | 6–18 / 0–17 | 28–69 / 36–64 |
| `db.Exec("PRAGMA busy_timeout=5000")` | 8–82 / 12–65 | 38–130 / 36–67 |
| DSN `_pragma=busy_timeout(5000)` | **800** / **348–565** | **800** / **20–75** |
| DSN busy_timeout + `_txlock=immediate` | 800 / 800 (tx: 603–972 ms) | 800 / 800 (tx: 202–856 ms) |
| `SetMaxOpenConns(1)`, no busy_timeout | 800 / 800 (tx: 210–451 ms) | 800 / 800 (tx: 67–167 ms) |

- **busy_timeout does not help a deferred transaction that reads, then writes.** Tx A reads,
  connection B commits an insert, A's `INSERT` fails **at once** (busy_timeout 3000): code 5 in
  rollback mode (B then waited until A rolled back), 517 in WAL (A's snapshot is stale). Only a rerun
  of the whole transaction helps; `_txlock=immediate` or `SetMaxOpenConns(1)` prevents it.
- **With `_txlock=immediate`, read transactions queue behind writers**: `BeginTx(ctx, nil)` for a
  read failed `database is locked (5)` after 1.016 s (busy_timeout 1000) while a write tx was open;
  `BeginTx(ctx, &sql.TxOptions{ReadOnly: true})` started at once (modernc issues a deferred `BEGIN`).
- **modernc does not enforce `TxOptions`**: an `INSERT` in a `ReadOnly: true` tx committed;
  `LevelSerializable` and `LevelReadCommitted` were accepted without error.
- **A ctx deadline does not cut a busy wait short**: with busy_timeout 3000 and a 300 ms ctx, a
  blocked `INSERT` returned `context deadline exceeded` after 3.03–3.07 s. With `_txlock=immediate` a
  blocked `BeginTx` returned `database is locked (5)` instead, also after 3.04 s. Keep busy_timeout
  below the request deadline. `SetMaxOpenConns(1)` was fastest in every run, but it turns the next
  section into hangs.

Reported by: none — test or review.

## Self-deadlocks and stale reads

A `db.QueryRowContext` inside `WithTx`'s function, where `tx` was meant, runs on another connection:

- **database/sql, `SetMaxOpenConns(1)`**: it waits for the connection the Tx holds: `context
  deadline exceeded` with a 500 ms ctx, forever with `context.Background()`. So did `db.ExecContext`
  while a `*sql.Rows` was open, and any call after a never-scanned `*sql.Row` (`_ =
  db.QueryRowContext(…)` keeps its connection until `Scan` or until its ctx ends; `Row.Err()` alone
  did not release it).
- **SQLite, larger pool**: it returned the value from before the Tx's own UPDATE, with no error;
  a `db.Exec` write inside a write Tx failed `database is locked (5)` after the full busy_timeout.

Run every statement on `tx`; helpers take a `Querier` ([Rows](#rows)), which `*sql.DB`, `*sql.Tx`
and `*sql.Conn` satisfy. Reported by: none — test or review.

## Rows

```go
// User is one row of users.
type User struct {
	ID        int64
	Name      string
	Email     sql.Null[string]
	CreatedAt time.Time
}

// Querier is satisfied by *sql.DB, *sql.Tx and *sql.Conn.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ListUsers returns users created at or after since, oldest first.
func ListUsers(ctx context.Context, q Querier, since time.Time, limit int) ([]User, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT id, name, email, created_at FROM users
		 WHERE created_at >= ? ORDER BY created_at, id LIMIT ?`, since, limit)
	if err != nil {
		return nil, fmt.Errorf("query users: %w", err)
	}
	defer rows.Close() //nolint:errcheck // read-only: iteration errors come from rows.Err
	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil { // a canceled ctx ends the loop early; only Err tells
		return nil, fmt.Errorf("list users: %w", err)
	}
	return users, nil
}
```

- **A canceled ctx ends the loop without an error from `Next`** (database/sql, as the next two):
  canceled at row 1 000 of 200 000, the loop stopped after about 1 090 rows and `rows.Err()`
  returned `context canceled` (or `Scan` did, when the cancel fell between `Next` and `Scan`).
  Without the check this `ListUsers` loop returned a partial list (1–42 of 20 000 users) and no error
  in 6 and 8 of 25 runs (two batches; the others failed at `Scan`); with it, every run returned an
  error. Reported by:
  `golangci:rowserrcheck (opt-in)`, `gopls:sqlrowserr` (table below).
- **`rows.Close` matters on early exit**: `Next` returning false closes the rows, but a `return`
  inside the loop without `Close` leaked a connection per call (third call on 2 connections blocked).
  Reported by: `golangci:sqlclosecheck (opt-in)`.
- **`defer rows.Close()` before `if err != nil`** panicked on a failed query. Reported by:
  `staticcheck SA5001`. errcheck (standard, go-style baseline) reports every `defer rows.Close()`,
  hence the marked line; `defer func() { _ = rows.Close() }()` also passes every linter.
- **SQLite: inserting into the table being scanned, on the same connection**, showed the cursor its
  own inserts; the loop ran until killed.
- **Rows handed to another function are invisible to every linter** (`go vet` reported no shape):

| shape | `golangci:rowserrcheck (opt-in)` | `golangci:sqlclosecheck (opt-in)` | `gopls:sqlrowserr` |
|---|---|---|---|
| no `Close`, no `Err` | yes | yes | yes |
| `defer Close`, no `Err` / `Err`, no `Close` | yes / — | — / yes | yes / — |
| a helper returns the rows; the caller has neither | yes (caller) | yes (caller) | no |
| `consume(rows)` that neither closes nor checks | **no** | **no** | **no** |
| `_, err := db.QueryContext(ctx, "INSERT …")` | yes | yes | — |

The INSERT shape is also `golangci:gocritic sqlQuery (opt-in)`; `db.Query` without ctx is
`golangci:noctx (opt-in)`; a `Stmt` never closed is sqlclosecheck.

## QueryRow and Exec

**database/sql**, except where marked. Reported by: none — test or review.

- **`QueryRow` takes the first row silently**: two rows matched, `Scan` returned the first, `<nil>`.
- **Errors arrive at `Scan`**: a syntax error still returned a non-nil `*sql.Row`. No match is
  `sql.ErrNoRows` (match with `errors.Is` once wrapped); `SELECT max(id) … WHERE` with no match
  returned one NULL row, not `ErrNoRows`.
- **`RowsAffected() == 0` is not an error**: `UPDATE`/`DELETE … WHERE id = 999` returned 0, `<nil>`.
  SQLite counted `UPDATE u SET name = name` as 1 (matched, not changed rows).
- **Use `ExecContext` when no rows come back**: a `QueryContext` INSERT whose `*sql.Rows` was
  dropped kept its connection; on a 1-connection pool the next query deadlocked.

## Transactions

```go
func WithTx(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	// After Commit, Rollback is a no-op that returns sql.ErrTxDone.
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
```

**database/sql.** Tested: commit; an error rolls back; a panic in `fn` rolls back, propagates and
leaves the pool usable. Without the deferred Rollback, a leaked tx whose ctx stayed alive kept
SQLite's write lock: the next transaction failed `database is locked (5)` after the full busy_timeout
(at `BeginTx` with `_txlock=immediate`, at its first write otherwise). Once the leaked tx's ctx was
canceled, database/sql rolled it back and the next transaction succeeded at once. `defer tx.Rollback()` and an ignored `tx.Commit()`
are `golangci:errcheck (standard)`; a Tx never committed on any path is reported by nothing.

- **Commit after the ctx was canceled** returned `context canceled` when called at once and
  `sql.ErrTxDone` 10 ms later, after database/sql's background rollback; nothing was committed
  either way (200 runs each). Do not branch on which one. Reported by: none — test or review.
- **The Tx's ctx governs**: after it ended, `tx.ExecContext(context.Background(), …)` returned
  `ErrTxDone`; statements from `tx.PrepareContext`/`tx.StmtContext` were closed after Commit.

## NULL

**database/sql.** Scanning NULL into `string`, `int`, `bool` or `time.Time` fails at `Scan` the first
time a row holds NULL (`converting NULL to string is unsupported`). Scan nullable columns into
`sql.Null[T]` `(toolchain ≥1.22)` or a pointer; as arguments a nil `*string` and `sql.Null[string]{}`
store NULL, `""` an empty string. Reported by: none — test or review.

## Time values in SQLite

**SQLite/modernc.** SQLite has no time type. modernc binds a `time.Time` as text, **by default
`t.String()`**: `2026-10-12 09:30:15.123456789 +0900 KST`, and from `time.Now()` with the monotonic
`m=+0.025766959` appended. Go parses it back exactly, so round-trip tests pass, while SQL
comparisons, `ORDER BY` and date functions see only text. Input 09:30:15.123456789 KST (00:30:15Z),
machine zone Asia/Seoul:

| DSN keys | stored text | `Scan` into `time.Time` (DATETIME column) |
|---|---|---|
| none | `2026-10-12 09:30:15.123456789 +0900 KST` | same instant, zone KST |
| `_time_format=sqlite` | `2026-10-12 09:30:15.123456789+09:00` | same instant, zone KST |
| `_time_format=sqlite&_timezone=UTC` | `2026-10-12 00:30:15.123456789+00:00` | same instant, zone UTC |
| `_time_format=datetime` | `2026-10-12 09:30:15` | **`09:30:15 UTC`: 9 h off, no error** |
| `_time_format=datetime&_timezone=UTC` | `2026-10-12 00:30:15` | `00:30:15 UTC`, sub-second dropped |
| `_time_integer_format=unix_milli&_inttotime=1` | `1791765015123` (integer) | `00:30:15.123 UTC` |

SQL over three rows: A = 00:30Z bound as a KST time, B = 02:00Z bound as UTC, C = 01:00Z written by
SQL `datetime(…)` (the `CURRENT_TIMESTAMP` format). Correct: `> 01:30Z` → [B], `>= 01:00Z` → [C B],
ascending → [A C B]:

| DSN keys | `> ?` UTC arg | `> ?` KST arg | `>= ?` 01:00Z | `ORDER BY` | `julianday(col) > julianday(?)`, KST arg |
|---|---|---|---|---|---|
| none | [A B] | [] | [A B] | [C B A] | [] (`datetime(col)` NULL) |
| `_time_format=sqlite` | [A B] | [] | [A B] | [C B A] | [B] |
| `_time_format=sqlite&_timezone=UTC` | [B] | [B] | **[B]** | [A C B] | [B] |
| `_time_format=datetime` | [A B] | [] | [A B C] | [C B A] | [] (UTC arg: [A B]) |
| `_time_format=datetime&_timezone=UTC` | [B] | [B] | [B C] | [A C B] | [B] |
| unix_milli + `_inttotime=1`, C as `unixepoch(…)*1000` | [B] | [B] | [B C] | [A C B] | [] (needs `/1000, 'unixepoch'`) |

- **Store every time in UTC, in one format.** `_time_format=datetime&_timezone=UTC` was right in
  every column and writes `CURRENT_TIMESTAMP`'s text, at whole seconds. `_time_format=sqlite&
  _timezone=UTC` (in `OpenSQLite`) keeps nanoseconds and failed only equality with a
  `CURRENT_TIMESTAMP` value (`"…01:00:00"` sorts before `"…01:00:00+00:00"`): use it when SQL never
  writes times. Integers worked when SQL wrote integers too.
- **Mixed formats in one column compare wrongly** (C against A and B); the DSN changes only new
  writes, so switching it on an existing database needs a data migration.
- **`Scan` into `time.Time` parses only columns declared DATE, DATETIME or TIMESTAMP.** A TEXT,
  INTEGER or untyped column and `SELECT max(created_at)` failed `unsupported Scan, storing
  driver.Value type string into type *time.Time`. `_texttotime=1` parses only values with no
  declared type (an untyped column, `max()`); TEXT and INTEGER columns still failed, so declare time
  columns DATETIME. A DATE/DATETIME/TIMESTAMP column scanned into `string` returned RFC 3339 with
  every DSN, not the stored text; `CAST(col AS TEXT)` returned the stored text (not with
  `_texttotime=1`, which reformats the CAST too).

Reported by: none — test or review. The `OpenSQLite` tests bind times in two zones; removing
`_timezone=UTC` or `_time_format` failed them.

## Placeholders, IN lists and injection

- **A slice is not expanded** (database/sql): `IN (?)` with a `[]int64` failed `sql: converting
  argument $1 type: unsupported type []int64, a slice of int64`. Build `strings.Repeat("?,",
  len(ids)-1) + "?"` with a `[]any` of the values, or in SQLite pass one JSON array to `IN (SELECT
  value FROM json_each(?))`. SQLite took 32 766 parameters and failed at 32 767.
- **SQLite/modernc** accept `?`, `?2`, `$1`, and `:id`, `@id`, `$id` with `sql.Named` (names are
  case-sensitive). **An extra argument is ignored**: one `?` with two arguments returned `<nil>`.
- **Only `args` are parameters** (any driver). Identifiers (`ORDER BY` column, table name) cannot be
  parameters: map input to a fixed allowlist. vet, staticcheck, golangci standard and gopls reported
  no formatted query; `golangci:gosec (opt-in)` reported these:

| shape | gosec |
|---|---|
| `q := fmt.Sprintf("… name = '%s'", name)`; `db.ExecContext(ctx, q)` | G201 |
| the same `Sprintf` inline in `ExecContext`, or in a helper that returns the query | **none** |
| `"… name = '" + name + "'"`, `strings.Join` into `IN ('…')` | G202 |
| `strings.Builder` with `WriteString(name)` | **none** |
| `"… IN (" + ph + ")"` with only `?` in `ph` (safe) | G202, false positive: `//nolint:gosec // G202: only placeholders are concatenated` |

## Error codes, statements, cancellation

- **SQLite/modernc error codes.** Match with `errors.AsType[*sqlite.Error](err)` (through `%w`) and
  compare `se.Code()` with `modernc.org/sqlite/lib` constants. modernc enables extended codes, so a
  duplicate `INTEGER PRIMARY KEY` is 1555 (`SQLITE_CONSTRAINT_PRIMARYKEY`) although its message reads
  `UNIQUE constraint failed: acct.id`; a check for 2067 (`SQLITE_CONSTRAINT_UNIQUE`) alone misses it.
  NOT NULL 1299, FOREIGN KEY 787, CHECK 275; all `Code()&0xff == 19`. `Code()&0xff == 5` covers busy
  5 and 517. PostgreSQL: [postgres-pgx](postgres-pgx.md).
- **Prepared statements** (database/sql) are prepared per connection behind the scenes. Counted at
  the driver: 1 prepare in total for 5 executions on an idle pool; with `SetMaxIdleConns(0)`, 6 (one
  more per execution), so under churn they save nothing. Statements from a Tx die with it (`sql: statement is closed`).
- **Cancellation** (SQLite/modernc): an endless recursive CTE with a 200 ms deadline returned `context
  deadline exceeded` after 202 ms from `QueryRowContext(…).Scan`, `ExecContext` and `rows.Next`,
  file or `:memory:`, and the pool stayed usable; with `context.Background()` it ran until killed.
  After an interrupt on a file database, database/sql replaces the connection (the driver reports it
  invalid), so `db.Exec`'d PRAGMAs are lost; `:memory:` connections are kept.

Reported by: none — test or review.

## Migrations with goose

`(goose v3.29)` `goose.NewProvider(goose.DialectSQLite3, db, fsys)` over an `embed.FS`, then
`p.Up(ctx)`, takes one connection from `db` and runs each migration in its own transaction on it; a
failing migration rolled back alone. Schema `child.parent_id REFERENCES parent ON DELETE CASCADE`,
DSN with `foreign_keys(1)` unless marked:

| migration | result |
|---|---|
| `PRAGMA foreign_keys = ON` / `OFF`, then an orphan insert | a no-op inside the transaction: stored with a DSN without `foreign_keys(1)`, `(787)` with it |
| table rebuild (`CREATE parent_new`, copy, `DROP TABLE parent`, rename), with or without `PRAGMA defer_foreign_keys = ON` | **ok, child rows 0**: `DROP TABLE` ran the cascade |
| NO TRANSACTION: `foreign_keys = OFF`, rebuild, no `ON` | children kept; the pool then read `foreign_keys=0` and accepted an orphan |
| NO TRANSACTION, the file below | children kept; all 4 connections `foreign_keys=1`; orphan rejected |
| the file below, a statement failing before `COMMIT` | the connection went back to the pool with the tx open and `foreign_keys=0`. database/sql hands out the most recently returned idle connection, so the next 3 writes took this one, whether it was the only connection or 2 were open: each returned `<nil>`, and all were gone after `Close` (never committed). After 4 connections were held at once and released, writes got another connection and failed `database is locked (5)` after busy_timeout |

```sql
-- +goose NO TRANSACTION
-- +goose Up
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
INSERT INTO parent_new SELECT id, COALESCE(name, '') FROM parent;
DROP TABLE parent;
ALTER TABLE parent_new RENAME TO parent;
COMMIT;
PRAGMA foreign_keys = ON;
-- ...
```

- **Rebuild a referenced table only in this shape** (SQLite's documented procedure) and assert
  `SELECT count(*) FROM pragma_foreign_key_check` is 0 in the migration test.
- **Run migrations on their own `*sql.DB` and close it before opening the app's pool.** After the
  failing migration, `Close` rolled the open tx back (version stayed 1) and a new pool had
  `foreign_keys=1` on every connection and wrote normally.
- **A Go migration without a transaction (`GoFunc{RunDB: …}`) on a `MaxOpenConns(1)` pool
  deadlocks**: goose holds the only connection and runs the function on `db`; `Up` returned only at
  the 3 s ctx deadline (`context deadline exceeded`), and in 10 ms with 2 connections. goose refuses
  this shape only when a session locker is configured (source), and SQLite has none.

Reported by: none — test or review.

## Gotchas

- Agent sets PRAGMAs with `db.Exec` after `sql.Open` - one pooled connection gets them; foreign keys stay off on the rest.
- Agent opens `:memory:` with a default pool - each connection is an empty database; a shared-cache name is shared by parallel tests.
- Agent relies on busy_timeout for read-then-write transactions - SQLITE_BUSY at once; `_txlock=immediate` prevents it.
- Agent adds `_txlock=immediate` and opens read transactions with `nil` options - reads queue behind writers.
- Agent sets `TxOptions.ReadOnly` or an isolation level for modernc - neither is enforced.
- Agent expects a short ctx to bound a busy wait - the call returns after the full busy_timeout, from `BeginTx` with `_txlock=immediate` as SQLITE_BUSY, not a ctx error.
- Agent calls `db` inside a transaction - a hang at `MaxOpenConns(1)`, a stale read with a larger pool; an unscanned `*sql.Row` also keeps its connection.
- Agent omits `rows.Err()` - a canceled request returns a partial list as success.
- Agent binds `time.Time` with the default DSN or without `_timezone=UTC` - comparisons and `ORDER BY` across zones are wrong; `datetime` reads back shifted.
- Agent formats a value into SQL inline with `Sprintf` - injection, and gosec reports only the assigned-variable shape.
- Agent checks only `SQLITE_CONSTRAINT_UNIQUE` - a duplicate INTEGER PRIMARY KEY (1555) slips through.
- Agent rebuilds a referenced table in a transactional goose migration - `foreign_keys = OFF` is a no-op; `DROP TABLE` deletes the child rows.
- Agent runs NO TRANSACTION migrations on the app's pool - a PRAGMA or an open transaction stays on a pooled connection, which database/sql hands out next; writes on it return nil and are lost.

## Official sources

- Package [database/sql](https://pkg.go.dev/database/sql); Go docs on [managing connections](https://go.dev/doc/database/manage-connections), [transactions](https://go.dev/doc/database/execute-transactions), [cancelling operations](https://go.dev/doc/database/cancel-operations) and [SQL injection](https://go.dev/doc/database/sql-injection)
- [modernc.org/sqlite v1.60.1](https://pkg.go.dev/modernc.org/sqlite@v1.60.1) (DSN keys under `Driver.Open`)
- SQLite: [PRAGMA foreign_keys](https://sqlite.org/pragma.html#pragma_foreign_keys), [transactions](https://sqlite.org/lang_transaction.html), [WAL](https://sqlite.org/wal.html), [in-memory databases](https://sqlite.org/inmemorydb.html), [shared cache](https://sqlite.org/sharedcache.html), [isolation](https://sqlite.org/isolation.html), [date and time functions](https://sqlite.org/lang_datefunc.html), [result codes](https://sqlite.org/rescode.html), [limits](https://sqlite.org/limits.html), [table rebuild procedure](https://sqlite.org/lang_altertable.html#otheralter)
- [goose v3.29.0](https://pkg.go.dev/github.com/pressly/goose/v3@v3.29.0) and [gosec rules](https://github.com/securego/gosec)
