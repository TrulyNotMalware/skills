# Testing services

Applies to the Go 1.27.1 toolchain with a go.mod `go` line of 1.26.0 or later, go-cmp v0.7.0,
goleak v1.3.0, testcontainers-go v0.44.0 and modernc.org/sqlite v1.60.1 unless a rule carries a
version tag (tags and Reported-by labels as in the go-style skill, versions-tools). A recorder
test passes on a handler the real server answers differently, a JSON test fails on formatting and
passes on a lost digit, and a stuck test server hangs the package until `-timeout`. Table tests,
helpers, `t.Context()`, the result cache and synctest basics: the go-style skill, testing.

Contents: [The shape to aim for](#the-shape-to-aim-for) · [Recorder or server](#recorder-or-server) ·
[Testing through the mux](#testing-through-the-mux) · [httptest.Server lifecycle](#httptestserver-lifecycle) ·
[Fake time](#fake-time) · [Databases in tests](#databases-in-tests) · [Goroutine leaks](#goroutine-leaks) ·
[The race detector](#the-race-detector) · [Comparing JSON responses](#comparing-json-responses) · [Gotchas](#gotchas)

## The shape to aim for

```go
// newServer starts h on a loopback listener and closes it when the test ends.
func newServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// do sends a request through the real server and returns what the client received.
func do(t *testing.T, srv *httptest.Server, method, path string) (int, http.Header, string) {
	t.Helper()
	// t.Context() is canceled when the test ends, so a stuck request cannot hold srv.Close.
	req, err := http.NewRequestWithContext(t.Context(), method, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, string(body)
}

func TestGetItem(t *testing.T) {
	// NewRoutes, NewHandler, NewStore, Item and Hits are the app's own types, elided here.
	routes := NewRoutes()
	srv := newServer(t, NewHandler(NewStore(Item{ID: 7, Name: "lamp"}), routes))

	status, header, body := do(t, srv, http.MethodGet, "/items/7")
	if ct := header.Get("Content-Type"); status != http.StatusOK || ct != "application/json" {
		t.Fatalf("GET /items/7 = %d %q, want 200 application/json", status, ct)
	}
	if diff := diffJSON(t, `{"id": 7, "name": "lamp"}`, body); diff != "" {
		t.Errorf("GET /items/7 body mismatch (-want +got):\n%s", diff)
	}
	if got := routes.Hits("GET /items/{id}"); got != 1 { // the middleware saw the mux's pattern
		t.Errorf(`hits for "GET /items/{id}" = %d, want 1`, got)
	}
}
```

It drives the handler `main` serves over a real connection and checks what the client received:
status, `Content-Type`, the JSON by value ([diffJSON](#comparing-json-responses)), the route
label. A `Content-Type` set after `WriteHeader` failed it, and so did a wrapper between counter and
mux. Add an unknown path and a wrong method to a route table: the mux answers them in `text/plain`
(`404 page not found`; 405 with `Allow: GET, HEAD`), and with a `/` catch-all both got 200.

## Recorder or server

`httptest.NewRecorder` calls the handler as a function: no network, and none of what the server
adds or enforces. The same handlers both ways:

| Handler or setup | `ResponseRecorder` | Real server (`httptest.NewServer`, `srv.Client()`) |
|---|---|---|
| `GET /items/{id}` handler called directly | `r.PathValue("id")` is `""` | always routed by the mux |
| `Header().Set` after `WriteHeader` or the first `Write` | in `rec.Header()`, not in `rec.Result().Header` | not sent; a late `Content-Type` is replaced by a sniffed `text/plain; charset=utf-8` |
| `WriteHeader(201)` then `WriteHeader(500)` | 201, nothing logged | 201, `http: superfluous response.WriteHeader call from …` logged |
| `WriteHeader(103)` (Early Hints) then `WriteHeader(201)` | 103 in `Code` and `Result()`, no `Content-Type` (snapshot at the 103) | 201 with its headers; the 103 came first as an interim response |
| `Server.WriteTimeout` 100 ms, handler sleeps 300 ms | 200 `late` | client error `EOF` |
| `http.MaxBytesReader(w, r.Body, 10)`, 100-byte body | 413 | 413; the server closes the connection only given its own writer (behind a `statusWriter`-style wrapper it was reused; [http-server](http-server.md)) |
| `ResponseController.SetWriteDeadline` | `feature not supported` | nil |

- **Assert on `rec.Result()`, never `rec.Header()`** (the handler's live map); `Result()`
  snapshots headers at the first write, as the server does. Reported by: none — test or review.
- **A recorder suits handler logic** (decoding, validation, status mapping) sent through the
  handler `main` uses (`h.ServeHTTP(rec, req)`). Timeouts, connection close, deadlines, `Hijack`,
  streaming and the superfluous-`WriteHeader` log need a real server; server timeouts and shutdown:
  [lifecycle-deploy](lifecycle-deploy.md). Reported by: none — test or review.

## Testing through the mux

- **A handler called directly gets `""` from every `r.PathValue`**: `getItem` answered 404 for
  item 7, which exists, so a "missing item is 404" test written that way passes for any ID. Route
  through the mux, or call `req.SetPathValue("id", "7")` (`r.Pattern` stays empty). Reported by:
  none — test or review.
- **Test the handler `main` serves, middleware included.** The mux sets `r.Pattern` on the
  `*Request` it receives; with `r.WithContext`, `http.StripPrefix` or `http.TimeoutHandler` between
  it and an outer middleware, the middleware read `""`, and through `StripPrefix` into a nested mux
  the outer pattern (`/api/`). Design: [http-server](http-server.md). Reported by: none — test or
  review.

## httptest.Server lifecycle

- **`Close` (registered with `t.Cleanup` where the server is created) waits for every active
  request and does not cancel its `r.Context()`**; it closes only the listener and idle and new
  connections (source). One request in flight from another goroutine when `Close` ran:

  | Handler | Request | `Close` returned |
  |---|---|---|
  | `time.Sleep(7 * time.Second)` | `srv.Client()` | after 7 s, when the handler returned |
  | `time.Sleep(3 * time.Second)` | context `t.Context()`, test returned | after 3 s |
  | `<-r.Context().Done()` | `srv.Client()` with `Timeout` 7 s | after 7 s, when the client gave up |
  | `<-r.Context().Done()` | `srv.Client()`, no timeout, `context.Background()` | **never**: `panic: test timed out` at `-timeout`, stack in `httptest.(*Server).Close` |
  | `<-r.Context().Done()` | context `t.Context()`, test returned | at once |
  | `<-r.Context().Done()` | `srv.CloseClientConnections()` before `Close` | at once, client `EOF` |

  After 5 s `Close` logs `httptest.Server blocked in Close after 5 seconds … in state active`;
  the default `-timeout` is 10 minutes (docs) and its panic ends the test binary. Give requests
  that may outlive the test `t.Context()`, and make streaming handlers return on
  `r.Context().Done()`. Reported by: none — test or review.
- **Use `srv.Client()`, not `http.DefaultClient`.** Against `NewTLSServer` the default client
  failed with `x509: certificate signed by unknown authority`; against `NewTestServer` `(go ≥1.27)`
  (`srv.URL` is `http://example.com`) it reached the real example.com and got a 404 from its CDN.
  `srv.Client()` has no `Timeout`. Reported by: none — test or review.

## Fake time

`httptest.NewTestServer` `(go ≥1.27)` serves over an in-memory network that a synctest bubble
sees, so client and server timeouts run on the fake clock. The snippet needs `go 1.27` in go.mod:

```go
// slowHandler answers after a minute unless the client goes away first.
func slowHandler(w http.ResponseWriter, r *http.Request) {
	select {
	case <-time.After(time.Minute):
		_, _ = io.WriteString(w, "late")
	case <-r.Context().Done():
	}
}

func TestClientTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := httptest.NewTestServer(t, http.HandlerFunc(slowHandler)) // in-memory; closed by Cleanup
		client := srv.Client()
		client.Timeout = 30 * time.Second

		// Any host reaches the in-memory server.
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://api.example.com/orders", nil)
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		resp, err := client.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		var te interface{ Timeout() bool }
		if !errors.As(err, &te) || !te.Timeout() {
			t.Fatalf("GET error = %v, want a timeout", err)
		}
		if got := time.Since(start); got != 30*time.Second { // fake time: exact
			t.Errorf("timed out after %v, want 30s", got)
		}
	})
}
```

It passed in 0.00 s of wall time (the fake clock starts at 2000-01-01 00:00:00 UTC). The error
text is `context deadline exceeded`, without the `(Client.Timeout exceeded while awaiting headers)`
of a loopback client, so match `Timeout()`, not the message.

- **`NewTestServer` in a go 1.26 module**: the 1.27 toolchain compiles it, but `go vet` and
  `go test` fail with `httptest.NewTestServer requires go1.27 or later (file is go1.26)` under a
  `go 1.26.0` line (`module is go1.26` under `go 1.26`; `-vet=off` passes); go1.26.8 reports
  `undefined`. Below go 1.27, test timeouts in real time with `httptest.NewServer` outside a
  bubble. Reported by: `vet+test` (stdversion); `compiler` on a 1.26 toolchain.
- **`httptest.NewServer` inside a bubble hangs until `-timeout`**: real network I/O does not count
  as blocked, so the clock never moves and no deadlock is reported. Reported by: none — test or review.
- **A handler that ignores its context holds the cleanup**: with `time.Sleep(time.Minute)` the test
  passed in 1 ms while the registered `Close` waited in fake time and logged the 5-second warning.
  Reported by: none — test or review.

## Databases in tests

- **SQLite: a fresh file per test in `t.TempDir()`** with the production DSN and pool settings
  ([database-sql](database-sql.md) has the opener and the details). `":memory:"` is one database
  per connection (modernc v1.60): sequential calls reuse one connection and work, but a held
  `db.Conn` or `Tx` sent the next query to an empty database (`no such table: items`), and 4
  parallel subtests failed that way in 20 to 30 of 40 per `-count=10` run, varying by run.
  `SetMaxOpenConns(1)` makes it consistent; a held `Conn` then blocks every other query. Reported
  by: none — test or review.
- **testcontainers-go v0.44 without Docker fails at once**: `postgres.Run` returned in 0 s with a
  nil container and `rootless Docker not found, failed to create Docker provider`. Calling
  `CleanupContainer` before the error check (the documented order) is safe on nil, and removal
  uses `context.Background()` (source), unaffected by the canceled `t.Context()`.

  ```go
  // newPostgres starts PostgreSQL for one test and returns its connection string.
  func newPostgres(t *testing.T) string {
  	t.Helper()
  	if os.Getenv("TEST_REQUIRE_DOCKER") == "" { // set in CI: there a missing Docker must fail
  		testcontainers.SkipIfProviderIsNotHealthy(t)
  	}
  	ctr, err := postgres.Run(t.Context(), "postgres:17-alpine",
  		postgres.WithDatabase("app"), postgres.WithUsername("app"), postgres.WithPassword("app"),
  		postgres.BasicWaitStrategies())
  	testcontainers.CleanupContainer(t, ctr) // before the error check; nil is a no-op
  	if err != nil {
  		t.Fatal(err)
  	}
  	dsn, err := ctr.ConnectionString(t.Context(), "sslmode=disable")
  	if err != nil {
  		t.Fatal(err)
  	}
  	return dsn
  }
  ```

- **A skipped integration test looks green.** After `SkipIfProviderIsNotHealthy` (takes
  `*testing.T`) skipped, `go test ./...` printed `ok`; only `-v` or `-json` show the skip. It is
  documented for CI where Docker is optional; where it is required, the variable above made the
  test fail at once. Reported by: none — test or review. PostgreSQL: [postgres-pgx](postgres-pgx.md).

## Goroutine leaks

```go
// verifyNoLeaks fails the test if it leaves goroutines behind. Call it first:
// its Cleanup then runs last, after srv.Close and every other Cleanup.
func verifyNoLeaks(t *testing.T) {
	t.Helper()
	ignore := goleak.IgnoreCurrent() // taken now: goroutines earlier tests left behind
	t.Cleanup(func() { goleak.VerifyNone(t, ignore) })
}
```

What go.uber.org/goleak v1.3 reported, tests run in the order listed:

| Setup | Result |
|---|---|
| `defer goleak.VerifyNone(t)` (the README shape), server closed by `t.Cleanup` | FAIL: the test server's own `Serve` and connection goroutines, because the deferred check runs before Cleanup |
| `t.Cleanup(func() { goleak.VerifyNone(t, goleak.IgnoreCurrent()) })`, one goroutine leaked | PASS: `IgnoreCurrent` ran at cleanup time and ignored the leak |
| `verifyNoLeaks` above, one goroutine leaked; no leak | FAIL naming the goroutine; PASS |
| Unclosed response body (own `Transport`), then a clean test, both with `defer goleak.VerifyNone(t)` | request context `context.Background()`: FAIL, FAIL (the second reports the first's `persistConn.readLoop` and `writeLoop`); `t.Context()`: FAIL, PASS |
| The same pair, both with `verifyNoLeaks` | `context.Background()`: FAIL, PASS; `t.Context()`: PASS, PASS (the unclosed body is never reported) |
| Unstopped worker; then a stopped worker without `IgnoreCurrent` | FAIL, FAIL: the second blames the first |
| `goleak.VerifyTestMain(m)` in `TestMain`, one test leaks | every test PASS, then `goleak: Errors on successful test run`; the package FAILs, no test named |

- **Use `verifyNoLeaks`, not `defer VerifyNone`**: it runs after `srv.Close` and blames no test for
  an earlier leak. It misses an unclosed body on a request made with `t.Context()`, which is
  canceled before Cleanup and so closes the connection first; a deferred `VerifyNone` runs before
  the cancel and reports it. Unclosed bodies are bodyclose's job (below).
- **`VerifyNone` cannot run beside `t.Parallel`** (goleak docs): other tests' goroutines count as
  leaks. Use `VerifyTestMain` there, then run tests one at a time to find the leak.
- `srv.Close()` and `CloseIdleConnections()` did not end the read loop of a connection whose body
  was still open. Reported by: the plain `resp, err := c.Do(req)` shape: `golangci:bodyclose
  (opt-in)`; a conditional `Close` in a helper, a worker never stopped: none — test (goleak).

## The race detector

Requests sent one at a time never overlap; send them concurrently through a real server and run
with `-race`. 200 POSTs per worker through `srv.Client()`; per cell, three sets of five
`go test -count=1` processes (two sets under `-race`), with results varying by set:

| Shared state | Workers | `go test` | `go test -race` |
|---|---|---|---|
| `map[string]int`, `m[k]++` | 2 | 0 to 3 of 5 `fatal error: concurrent map writes`, the rest pass | FAIL every run (`DATA RACE`) |
| `map[string]int` | 8 or 64 | `fatal error` every run | FAIL every run |
| `int`, `n++` | 2 | pass, counts exact | FAIL every run |
| `int` | 8 | pass; counts short in 3 to 5 of 5 | FAIL every run |
| `int` | 64 | pass; counts short every run | FAIL every run |

- **A racing counter passes plain `go test` and loses updates** in most runs; a racing map killed
  the binary through the runtime's own check in every run at eight or more workers.
  Reported by: `-race`; vet, staticcheck, gopls and a wide golangci set are silent. Map basics:
  the go-style skill, concurrency.
- **`-race` reports a racing pair once per process.** Under `-race -count=5` the first iteration
  failed and the next four passed with the counter still short (1524, 1499, 1489, 1509 of 1600);
  check a fix with fresh `-count=1` runs. Reported by: `-race`, first occurrence only.

## Comparing JSON responses

```go
// diffJSON compares two JSON documents, ignoring whitespace, key order and escaping.
func diffJSON(t *testing.T, want, got string) string {
	t.Helper()
	var w, g any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatalf("want is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(got), &g); err != nil {
		t.Fatalf("response is not JSON: %v\n%s", err, got)
	}
	return cmp.Diff(w, g)
}
```

| Comparison (encoding/json, go-cmp v0.7) | Result |
|---|---|
| `json.NewEncoder(w).Encode(v)` body against `json.Marshal(v)` | differ only by the `"\n"` that `Encode` appends |
| The same fields declared in another order | different text: fields are written in declaration order |
| `"a<b>&c"` in a hand-written golden string; `float64` 1e21 | never match: the body has `a\u003cb\u003e\u0026c` and `1e+21` |
| Map keys over 20 `Marshal` calls | identical and sorted: map order is not a source of flaky output |
| Decode into the response struct, `cmp.Diff` | equal, but unknown fields in the response are dropped silently |
| Decode into `any` against a Go literal `map[string]any{"id": 7}` | differ: `int(7)` against `float64(7)` |
| `diffJSON` | catches an extra field, `null` against absent, `[]` against `null`, `7` against `"7"`, array order |
| `diffJSON` on `9007199254740993` against `…992`, `7` against `7.0`, `1e21` against `1e+21` | all equal (`float64`); `Decoder.UseNumber` tells all three apart |

Compare by value, not as text; where IDs or amounts exceed 2^53, decode into the typed struct or
use `UseNumber` (go-style skill, types-data). Reported by: none — test or review.

## Gotchas

- Agent calls a handler directly with a recorder - `r.PathValue` is `""`, so a "not found" test passes for any ID.
- Agent asserts on `rec.Header()`, or tests timeouts and `SetWriteDeadline` with a recorder - late headers pass the test and never reach the client; server limits never apply.
- Agent tests the mux without its middleware - a wrapper that hides `r.Pattern` ships unnoticed.
- Agent sends a request from a goroutine with `context.Background()` to a handler that waits on `r.Context()` - `srv.Close` never returns and the binary dies at `-timeout`.
- Agent uses `http.DefaultClient` against a test server - a TLS server fails; a `NewTestServer` URL reaches the real example.com.
- Agent uses `httptest.NewTestServer` in a go 1.26 module - `go test` fails on stdversion; a 1.26 toolchain cannot build it.
- Agent starts `httptest.NewServer` inside `synctest.Test` - the fake clock never moves and the test hangs until `-timeout`.
- Agent uses `":memory:"` SQLite in tests - a second pooled connection sees an empty database, in some runs only.
- Agent calls `SkipIfProviderIsNotHealthy` unconditionally - a CI runner without Docker reports `ok`.
- Agent defers `goleak.VerifyNone` with the server closed by `t.Cleanup` - the server's own goroutines are reported; with `IgnoreCurrent()` inside a Cleanup closure every leak is ignored.
- Agent checks shared handler state without `-race`, or re-runs a race with `-count=N` - the counter passes; only the first iteration fails.
- Agent compares response bodies as strings - a newline, escaping or field order fails the test; decoding both sides into `any` lets IDs above 2^53 compare equal.

## Official sources

- Package [net/http/httptest](https://pkg.go.dev/net/http/httptest) (Server, NewTestServer, ResponseRecorder) and [Go 1.27 release notes](https://go.dev/doc/go1.27)
- Package [testing/synctest](https://pkg.go.dev/testing/synctest), [cmd/go: testing flags](https://pkg.go.dev/cmd/go#hdr-Testing_flags) and the [Data Race Detector](https://go.dev/doc/articles/race_detector)
- [goleak v1.3.0](https://pkg.go.dev/go.uber.org/goleak@v1.3.0), [go-cmp](https://pkg.go.dev/github.com/google/go-cmp/cmp) and [SQLite in-memory databases](https://www.sqlite.org/inmemorydb.html)
- [testcontainers-go v0.44.0](https://pkg.go.dev/github.com/testcontainers/testcontainers-go@v0.44.0) and [its documentation](https://golang.testcontainers.org/)
