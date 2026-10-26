# HTTP server: routes, handlers and responses

Applies to the Go 1.27.1 toolchain with a go.mod `go` line of 1.26.0 or later, chi v5.3.2, gin v1.12.0
and echo v4.16.0 unless a rule carries a version tag; run over HTTP/1.1 on loopback (darwin/arm64).
The mux, `ResponseWriter` and the file servers answer most mistakes with a well-formed response (a
200 from a catch-all, a sniffed `text/html`, a dropped header, a file from outside the directory)
and log nothing: test through `httptest.NewServer` and assert on what the client receives.

Contents: [Registering routes](#registering-routes) · [Decoding request bodies](#decoding-request-bodies) · [Writing responses](#writing-responses) ·
[Middleware and ResponseWriter wrappers](#middleware-and-responsewriter-wrappers) · [TimeoutHandler](#timeouthandler) ·
[Serving files](#serving-files) · [pprof and expvar](#pprof-and-expvar) · [Frameworks](#frameworks) · [Gotchas](#gotchas)

Elsewhere: timeouts, shutdown, panics, `Recover`, disconnects, `ErrorLog`: [lifecycle-deploy](lifecycle-deploy.md);
CORS, `CrossOriginProtection`, client IP: [security-auth](security-auth.md); `ResponseRecorder` versus a
real server: [testing](testing.md); JSON v1 decoding rules: the go-style skill, types-data.

## Registering routes

```go
func newHandler(logger *slog.Logger) http.Handler {
	s := &itemStore{items: map[int]item{}}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", handleRoot) // only "/"; a bare "/" pattern would match every path and method
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("GET /items/{id}", s.get) // GET also serves HEAD
	mux.HandleFunc("POST /items", s.create)
	mux.HandleFunc("GET /events", handleEvents)

	return accessLog(logger, Recover(logger, mux))
}
```

Handlers use [`decodeJSON`](#decoding-request-bodies) and [`writeError`](#writing-responses);
`accessLog` sits outside `Recover`, which wraps the mux and forwards the same `*Request`, so nothing
between `accessLog` and the mux replaces it; `Recover` is in
[lifecycle-deploy](lifecycle-deploy.md). The rules below need a main `go` line ≥1.22 and no
`GODEBUG=httpmuxgo121=1` (go-style skill, versions-tools). None is reported by any tool; build the
real mux in tests.

- **The most specific pattern wins, whatever the order**: with `/items/`, `/items/{id}`,
  `/items/special`, `/items/7` → `{id}`, `/items/special` → the literal, `/items/7/x` → `/items/`.
- **Overlaps where neither is more specific panic at registration**, naming both call sites:
  `/{a}/b` with `/a/{b}`; `/x/{id}` with `/x/{name}` (names do not count); `GET /a/{x}` with `/a/b`.
- **`/` matches every path and method; `/{$}` only `/`.** With `GET /m`, `POST /m` and `/`, a
  `DELETE /m` or `OPTIONS /m` got 200 from `/`. Without `/`, `DELETE /m` got 405 with `Allow: GET,
  HEAD, POST`. CORS middleware on one route therefore never sees the preflight ([security-auth](security-auth.md)).
- **A `GET` pattern serves `HEAD`** (the handler and its side effects run). The mux's own 404 and 405
  bodies are `text/plain`, not the API's JSON shape.
- **A missing trailing slash or an unclean path redirects with a status set by the toolchain**
  `(toolchain ≥1.26)`; the `go` line does not matter and no GODEBUG switches only this:

  | toolchain (`go` line) | `GET /dir`, only `/dir/` registered; `/a/../items/7` | `POST /dir`, Go client following |
  |---|---|---|
  | go1.25.14 (1.25) | 301 | handler got `GET`, empty body |
  | go1.26.8, go1.27.1 (1.25 or 1.26) | 307; `/dir?q=1` → `/dir/?q=1` (go1.27.1) | handler got `POST` and the body (go1.27.1) |
  | go1.27.1, `GODEBUG=httpmuxgo121=1` | 301; the 1.22 patterns are off | — |

- **`%2F` stays inside one segment and `r.PathValue` unescapes it**: `/seg/a%2Fb` matched
  `GET /seg/{id}` as `"a/b"` ([Serving files](#serving-files)). `{rest...}` matches an empty
  remainder (`/files/` → `""`); a single `{name}` never matches an empty segment.
- **`r.PathValue` and `r.Pattern` are "" when a test calls the handler directly**: route through the
  mux, or call `req.SetPathValue("id", "7")`.

## Decoding request bodies

```go
// requestError is a client error with the status it maps to.
type requestError struct {
	status int
	msg    string
}

func (e *requestError) Error() string { return e.msg }

// decodeJSON reads exactly one JSON value of type T from the request body.
// Errors are *requestError values carrying 400, 413 or 415.
func decodeJSON[T any](w http.ResponseWriter, r *http.Request, maxBytes int64) (T, error) {
	var zero T
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return zero, &requestError{http.StatusUnsupportedMediaType, "Content-Type must be application/json"}
	}

	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBytes))
	dec.DisallowUnknownFields()
	var v T
	if err := dec.Decode(&v); err != nil {
		return zero, decodeError(err)
	}
	// Decode stops after the first value; only io.EOF proves nothing follows it.
	// dec.More() is not enough: it reports false for a trailing "]" or "}".
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
			return zero, decodeError(err)
		}
		return zero, &requestError{http.StatusBadRequest, "body must contain a single JSON value"}
	}
	return v, nil
}
```

`decodeError` maps `*http.MaxBytesError` to 413, the JSON errors below to 400. No tool reports these.

- **`http.MaxBytesReader` past the limit**: reads return `*http.MaxBytesError`, and every request
  below got its 413. Given the server's own writer, the server also closes the connection after
  the reply; no wrapper can pass that on (the hook is an unexported method), so behind
  `statusWriter` the server treats the rest like any unread body. 1 MiB limit, HTTP/1.1:

  | Left past the limit | Server's own writer | Behind `statusWriter` |
  |---|---|---|
  | up to 256 KiB | read, connection closed | read, connection reused |
  | more, with Content-Length | not read (at most one 4 KiB buffer), closed | same |
  | more, chunked | 256 KiB read, closed | same on go1.27.1; up to 512 KiB read on go1.26.8 |

  The second `Decode` can trip it too (`{"name":"a"}` plus 2 MiB of spaces): still a 413.
- **Error kinds**: empty body → `io.EOF`; `{"name":` → `io.ErrUnexpectedEOF`; `{"n":}` →
  `*json.SyntaxError`; a wrong type → `*json.UnmarshalTypeError` (with `Field`); an extra field under
  `DisallowUnknownFields` → `json: unknown field "x"`, a plain error matched by its text.
- **Check the media type with `mime.ParseMediaType`**: `application/json; charset=utf-8` passes, a
  form post gets 415 (and stays out of CORS "simple requests"; docs).
- **A body the handler never reads costs the connection above 256 KiB**: the server drains up to
  `256 << 10` bytes; 250 KiB kept the connection, 260 KiB closed it (Content-Length or chunked).

## Writing responses

`writeJSON` calls `json.Marshal` before touching `w`, so a value that cannot be marshalled still
gets a clean 500 from `writeError`; then it sets `Content-Type`, `WriteHeader` and writes.

```go
var errNotFound = errors.New("not found")

// writeError maps err to a status and writes a JSON error body.
// Headers are set before WriteHeader; anything set after it is dropped.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	status, msg := http.StatusInternalServerError, http.StatusText(http.StatusInternalServerError)
	if reqErr, ok := errors.AsType[*requestError](err); ok {
		status, msg = reqErr.status, reqErr.msg
	} else if errors.Is(err, errNotFound) {
		status, msg = http.StatusNotFound, "not found"
	} else {
		slog.ErrorContext(r.Context(), "request failed", "err", err) // the client gets the generic text
	}
	h := w.Header()
	h.Del("Content-Length")
	h.Set("Content-Type", "application/json")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store") // replaces a cache header the handler may have set
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
```

- **Headers set after `WriteHeader` or the first `Write` are dropped** silently: `WriteHeader(201)`
  then `Content-Type: application/json` sent `text/plain`. `ResponseRecorder.Header()` still shows
  the late header ([testing](testing.md)). Reported by: none — test or review.
- **A second `WriteHeader` changes nothing**; `http: superfluous response.WriteHeader call from
  <func> (file:line)` goes to `Server.ErrorLog`, where `<func>` is the wrapper that calls the server's
  writer (`(*statusWriter).WriteHeader` behind `accessLog`), not the handler. Reported by: none — test or review.
- **Without a `Content-Type`, the first `Write` sniffs one**, even after `WriteHeader`:
  `json.NewEncoder(w).Encode(…)` went out as `text/plain`, and `fmt.Fprintf(w, "%s not found", id)`
  with a query value `<script>…` as **`text/html`** (reflected XSS). Reported by:
  `golangci:gosec (opt-in)` G705 on `Fprintf` of a query value; a static HTML body: none.
- **`http.Error` deletes `Content-Length`, sets `text/plain` and `nosniff`, keeps every other
  header**: after `Cache-Control: public, max-age=3600` and `ETag` the 400 was cacheable; after
  `Content-Encoding: gzip` the Go client read `""` and `gzip: invalid header` (`unexpected EOF` under
  10 bytes). The encoding is kept for compressing middleware ([go.dev/issue/66343](https://go.dev/issue/66343)),
  by `writeError` too: set it only right before writing the encoded body. Reported by: none — test or review.
- **One `Encode` never leaves a partial body**: it marshals to a buffer first (a slice failing at
  element 5000 of 10,000 wrote nothing). A 200 with the error text appended came from `WriteHeader(200)`
  before `Encode`, from one `Encode` per item (NDJSON `0\n1\n2\ninternal\n`) and from a failed write;
  a started stream can only end or abort ([lifecycle-deploy](lifecycle-deploy.md)). Reported by: none — test or review.
- **A "starts with `/`" check lets `http.Redirect` leave the host**: `//evil.example/x` and
  `/\evil.example/x` both reach `evil.example` (browsers read `\` as `/`; docs). Reject `//` and `\`,
  and require `url.Parse` to give no `Scheme` or `Host`. Reported by: `golangci:gosec (opt-in)` G710, checked or not.

## Middleware and ResponseWriter wrappers

```go
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (sw *statusWriter) WriteHeader(code int) {
	// Keep the first final status; 1xx responses other than 101 are interim.
	if sw.status == 0 && (code >= 200 || code == http.StatusSwitchingProtocols) {
		sw.status = code
	}
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Write(p []byte) (int, error) {
	if sw.status == 0 {
		sw.status = http.StatusOK // the client gets 200 once the body starts
	}
	n, err := sw.ResponseWriter.Write(p)
	sw.bytes += int64(n)
	return n, err
}

func (sw *statusWriter) FlushError() error {
	if sw.status == 0 {
		sw.status = http.StatusOK
	}
	return http.NewResponseController(sw.ResponseWriter).Flush()
}

func (sw *statusWriter) Flush() { _ = sw.FlushError() }

func (sw *statusWriter) Unwrap() http.ResponseWriter { return sw.ResponseWriter }

// Hijack serves code that asserts w.(http.Hijacker), such as gorilla/websocket.
func (sw *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(sw.ResponseWriter).Hijack()
}
```

`accessLog` passes the mux `&statusWriter{ResponseWriter: w}` and the same `r`, then logs `r.Pattern`
("unmatched" when empty, never `r.URL.Path`: unbounded labels) and `sw.status`, 0 (nothing written
through the wrapper) as 200. A wrapper recording every
`WriteHeader` logged 500 for a 200 response (a naive recover wrote after the body), and `code >= 200`
alone logged a 101 as 200. None of these is reported by any tool.

- **A wrapper hides every method it does not declare.** An SSE handler sending 5 events 150 ms apart:

  | writer the handler gets | `w.(http.Flusher)` | `http.NewResponseController(w).Flush()` | `ResponseController.Hijack` |
  |---|---|---|---|
  | the server's own | events at 1, 152, 303, 455, 606 ms | same | 101 |
  | embeds `ResponseWriter`, own `WriteHeader` only | assertion false: all at 755 ms (handler return) | `http.ErrNotSupported`, all at 755 ms | `ErrNotSupported` |
  | same plus `Unwrap()` | assertion false: all at 756 ms | streams | 101 |
  | `statusWriter` above | streams | streams | 101 |
  | `http.TimeoutHandler` | assertion false: all at 764 ms | `ErrNotSupported` | `ErrNotSupported` |

  `Unwrap` serves only `ResponseController` (`Hijack`, deadlines, `EnableFullDuplex`); code asserting
  `http.Flusher` or `http.Hijacker` (yours or a library's) needs `Flush` or `Hijack`, and
  `ResponseController.Flush` then stops at `Flush`. A bare `Flush()` makes it return nil where
  nothing flushes; `FlushError` passed `ErrNotSupported` through under `TimeoutHandler`. With only `Unwrap`,
  gorilla/websocket v1.5.3 (asserts) answered the upgrade with 500 and coder/websocket v1.8.15
  (follows `Unwrap`) upgraded; with `Hijack` both did, logged 101 for coder (it calls
  `WriteHeader(101)`) but 200 for gorilla (status still 0): a status written on the hijacked connection never reaches the wrapper.
- **`r.Pattern` after `next` is set only on the `*Request` the mux received** `(toolchain ≥1.23)`:

  | between the middleware and the mux | `r.Pattern` after `next` |
  |---|---|
  | nothing (a `Recover` that forwards the same `*Request` counts as nothing) | `GET /items/{id}`; `/dir/` for its redirect; `/` for a catch-all; "" for 404 and 405 |
  | `r.WithContext(…)`, `http.StripPrefix`, `http.TimeoutHandler` | "" |
  | a top mux sending `/api/` to an inner mux | `/api/` through `StripPrefix`; `GET /api/users/{id}` without |

  Put middleware that calls `r.WithContext` (request IDs, auth) outside the one reading `r.Pattern`:
  `withRequestID(accessLog(mux))` logged `GET /items/{id}`, `accessLog(withRequestID(mux))`
  "unmatched" for every route.
- **Order, for a panic before the first write**: `accessLog(Recover(logger, mux))` logged the 500;
  `Recover(logger, accessLog(h))` logged nothing. After a write, `Recover` aborts the connection
  (client: EOF) and the abort unwinds through `accessLog`: no access-log line in either order.

## TimeoutHandler

- `http.TimeoutHandler(h, 300*time.Millisecond, "timed out")` sent 503 `timed out` at 301 ms, but
  **the handler** (sleeping 1 s, ignoring its context) **kept running** to 1.001 s with
  `r.Context()` canceled; its late `Write` returned `http.ErrHandlerTimeout`.
- **The whole response is buffered until the handler returns** and `Flush`/`Hijack` fail (table
  above): never around streaming, SSE or upgrades. It also hides `r.Pattern`.
- **A panic after the timeout is swallowed**: no `ErrorLog` line, no crash. Before the timeout it is
  re-panicked and logged, and the client gets EOF. Reported by (all three): none — test or review.

## Serving files

```go
func downloads(root *os.Root) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name") // "%2F" in the URL arrives here as "/"
		if strings.ContainsRune(name, '/') || strings.HasPrefix(name, ".") {
			http.NotFound(w, r) // os.Root serves dotfiles; "sub/.env" would pass a prefix check
			return
		}
		f, err := root.Open(name) // fails for a symlink or ".." that leaves the directory
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close() //nolint:errcheck // read-only
		fi, err := f.Stat()
		if err != nil || !fi.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", "application/octet-stream") // never sniffed as text/html
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		http.ServeContent(w, r, name, fi.ModTime(), f) // ServeFile would redirect ".../index.html"
	}
}
```

On `GET /files/{name}` with `root := os.OpenRoot(dir)`: `index.html` and Range (206) served; 404 for
`.env`, `sub%2F.env`, `..%2Fsecret.txt`, a symlink out, a directory. os.Root ran on darwin only.

- **`http.Dir` and `os.DirFS` follow symlinks out of the tree; `os.Root` refuses them; none hides
  dotfiles.** Reported by: none — test or review.

  | request | `FileServer(http.Dir(dir))`, `FileServerFS(os.DirFS(dir))` | `FileServerFS(root.FS())` |
  |---|---|---|
  | `/link-out` (to `../secret.txt`), `/linkdir/secret2.txt` | **200, the secret** | 500 (body `500 Internal Server Error`) |
  | `/.env` | **200** | **200** |
  | `/upload` (no extension, `<script>` inside) | 200 **`text/html`** | 200 **`text/html`** |

- **`ServeFile` checks `..` only in `r.URL.Path`**: `ServeFile(w, r, filepath.Join(dir,
  r.URL.Query().Get("f")))` served `../secret.txt` and `.env`. Reported by: `golangci:gosec (opt-in)`
  G703, also on the confined `ServeFileFS(w, r, root.FS(), f)` (false positive).
- **Hand-written guards leak**: `strings.HasPrefix(filepath.Clean(full), filepath.Clean(base))`
  accepted `../www2/secret`; `filepath.IsLocal` plus `os.Lstat` on the last element served a file
  through a symlinked directory. Reported by: `golangci:gosec (opt-in)` G703 on the file call after
  either guard, as without one, so it does not tell a leaky guard from a sound one.
- **`ServeFile` and `FileServer` 301-redirect any path ending in `/index.html` to `./`** and a
  directory without its slash to `dir/`. `ServeContent` does not, but without a `Content-Type` it
  sniffs too (`index.html` and `upload` became `text/html` in the helper).
- **Build `Content-Disposition` with `mime.FormatMediaType`**: a hand-written `filename="%s"` with
  `a"b.txt` failed to parse; `FormatMediaType` (`filename*=utf-8''…` for non-ASCII) parsed back.
  Reported by: `golangci:gocritic sprintfQuotedString (opt-in)` on `fmt.Sprintf` with `"%s"`;
  concatenation or `%q`: none — test or review.

## pprof and expvar

Importing `net/http/pprof` or `expvar` (blank or named, here or in a dependency) registers
`GET /debug/pprof/…` and `GET /debug/vars` on `http.DefaultServeMux`. With `Handler: nil` (what
`http.ListenAndServe(addr, nil)` passes; docs) or a middleware falling back to the default mux, a
process started with `-db-password=hunter2` showed it at `/debug/pprof/cmdline` and `/debug/vars`.
Serve `pprof.Index`, `Cmdline`, `Profile`, `Symbol`, `Trace` and `expvar.Handler()` from a separate
mux on a loopback address. Reported by: `golangci:gosec (opt-in)` G108 on a blank pprof import only.

## Frameworks

- **chi v5.3.2** sets `r.PathValue` and `r.Pattern` (`/users/{id}`), but **keeps `%2F` escaped**
  (`"a%2Fb"`); `r.Pattern` is "" in a middleware wrapping the router from outside, set in one added
  with `r.Use`. Reported by: none — test or review.
- **gin v1.12.0 reuses `*gin.Context`**: a goroutine reading `c.Param("id")` after the handler
  returned got the next request's ID (`c.Copy()` fixed it). `c` as a `context.Context` never cancels
  unless `ContextWithFallback` is set; after a failed `c.BindJSON`, `c.JSON(422, …)` went out as 400
  `text/plain`. Reported by: `-race` for the reuse (if it happens in the test); none for the rest.
- **echo v4.16.0**: `echo.Context` is not a `context.Context`; `c.Request().Context()` is canceled
  when the client goes away. Reported by: `compiler`.

## Gotchas

- Agent adds a `/` catch-all beside method patterns - wrong methods get its 200 instead of 405.
- Agent expects 301 for a missing trailing slash - toolchain 1.26 sends 307; a 1.25 build turned POST into GET.
- Agent joins `r.PathValue` or a query value into a file path - `%2F`, `..` and symlinks leave the directory.
- Agent decodes `r.Body` without `MaxBytesReader` and a second `Decode` - unbounded body, trailing data accepted.
- Agent sets a header after `WriteHeader` or the first `Write` - it is dropped without a log.
- Agent writes without a `Content-Type` - JSON goes out as `text/plain`, reflected input as `text/html`.
- Agent sets cache or encoding headers before the handler can fail - `http.Error` keeps both, `writeError` the encoding.
- Agent gives a status wrapper only `Unwrap` - `w.(http.Flusher)` fails and the events arrive together; gorilla/websocket upgrades fail with 500.
- Agent reads `r.Pattern` outside `r.WithContext` or `StripPrefix` - every route is "".
- Agent wraps a streaming handler in `TimeoutHandler` - nothing streams and a late panic vanishes.
- Agent serves uploads with `FileServer` - dotfiles, symlinks out of the tree, HTML sniffed as `text/html`.
- Agent imports `net/http/pprof` and serves a nil `Handler` - `/debug/pprof/cmdline` shows the command line.
- Agent checks a redirect target with `strings.HasPrefix(next, "/")` - `//host` and `/\host` leave the site.

## Official sources

- Package [net/http](https://pkg.go.dev/net/http): [ServeMux](https://pkg.go.dev/net/http#ServeMux), [ResponseController](https://pkg.go.dev/net/http#ResponseController), [MaxBytesReader](https://pkg.go.dev/net/http#MaxBytesReader), [Error](https://pkg.go.dev/net/http#Error), [TimeoutHandler](https://pkg.go.dev/net/http#TimeoutHandler), [ServeContent](https://pkg.go.dev/net/http#ServeContent)
- [Routing Enhancements for Go 1.22](https://go.dev/blog/routing-enhancements); redirect statuses in [net/http/server.go at go1.27.1](https://github.com/golang/go/blob/go1.27.1/src/net/http/server.go)
- [os.Root](https://pkg.go.dev/os#Root), [Traversal-resistant file APIs](https://go.dev/blog/osroot), [net/http/pprof](https://pkg.go.dev/net/http/pprof), [mime.FormatMediaType](https://pkg.go.dev/mime#FormatMediaType)
- [chi v5.3.2 mux.go](https://github.com/go-chi/chi/blob/v5.3.2/mux.go), [gin v1.12.0 Context](https://pkg.go.dev/github.com/gin-gonic/gin@v1.12.0#Context), [echo v4.16.0](https://pkg.go.dev/github.com/labstack/echo/v4@v4.16.0)
