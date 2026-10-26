# HTTP client

Applies to the Go 1.27.3 toolchain with a go.mod `go` line of 1.26.0 or later, `net/http` as the
client and golangci-lint v2.15 for linter findings, unless a rule carries a version tag. Measured
on go1.27.3 and go1.26.10 over HTTP/1.1 unless a row says otherwise. Every mistake here works
against a healthy upstream on localhost: the hang needs a silent server, the leak needs hours of
traffic, the lost body needs a redirect or a second attempt.

Contents: [Building the client](#building-the-client) · [Timeouts](#timeouts) ·
[Connection reuse](#connection-reuse) · [Response bodies](#response-bodies) ·
[Status codes and size limits](#status-codes-and-size-limits) · [Redirects](#redirects) ·
[Re-sending a request](#re-sending-a-request) · [Linters](#what-the-linters-report) ·
[Gotchas](#gotchas)

## Building the client

```go
// New returns a client for one upstream. Clone keeps DefaultTransport's proxy from
// the environment, 30s dial and 10s TLS handshake timeouts, 90s idle timeout and
// HTTP/2; a bare &http.Transport{} has none of them.
func New(timeout time.Duration) *http.Client {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok { // something (instrumentation, a test) replaced it with another RoundTripper
		panic(fmt.Sprintf("http.DefaultTransport is %T, not *http.Transport", http.DefaultTransport))
	}
	t := base.Clone()
	t.MaxIdleConnsPerHost = 32                          // default 2: concurrent callers redial every round
	return &http.Client{Transport: t, Timeout: timeout} // Timeout covers reading the body too
}
```

Build it once at start-up and share it (a `Client` is safe for concurrent use, docs). One client
serves several hosts (its Transport pools per host); build one per upstream when timeouts, TLS,
redirect policy or pool sizes differ, or when the hosts together keep more idle connections than
`MaxIdleConns` ([Connection reuse](#connection-reuse)). The comma-ok form is for errcheck
(`check-type-assertions`); the one-liner `.(*http.Transport)` panics when something wrapped it.

- **Start from `DefaultTransport.Clone()`, not `&http.Transport{}`.** The bare struct has no
  `Proxy`, no `DialContext`, and zero `TLSHandshakeTimeout`, `IdleConnTimeout` and `MaxIdleConns`.
  With `HTTP_PROXY` set, the bare Transport ignored the proxy
  (`lookup example.invalid: no such host`). Against a TLS listener that never answers, the clone
  failed after 10 s with `net/http: TLS handshake timeout`; the bare Transport was still blocked
  after 13 s. Proxy settings are read once per process and never apply to `localhost` or
  `127.0.0.1`, so a local test cannot show this. Reported by: none — test or review.
- **Setting `TLSClientConfig` or `DialContext` on a hand-built Transport turns HTTP/2 off.**
  Measured by the ALPN list in the ClientHello against an h2-enabled TLS server:

  | Transport | h2 offered | Protocol used |
  |---|---|---|
  | `&http.Transport{}` | yes | (certificate untrusted in the probe) |
  | `TLSClientConfig`, `DialContext`, or both set | **no** | HTTP/1.1 |
  | `{TLSClientConfig: cfg, ForceAttemptHTTP2: true}` | yes | HTTP/2.0 |
  | `{TLSClientConfig: cfg, Protocols: HTTP/1 and HTTP/2}` `(toolchain ≥1.24)` | yes | HTTP/2.0 |
  | `Clone()`, then set `TLSClientConfig` (with or without `DialContext`) | yes | HTTP/2.0 |

  Customise a clone (its `ForceAttemptHTTP2` is already true). Reported by: none — test or review.
- **A new Transport per request leaks; a new Client per request does not.** 200 sequential GETs,
  bodies drained and closed, server without an idle timeout: a new `&http.Transport{}` per request
  left 200 connections open and 400 client goroutines; a new Client with one shared (or nil)
  Transport used 1 connection and 2 goroutines; `CloseIdleConnections()` after each request freed
  the goroutines but still dialed 200 times. Reported by: none — test or review.

## Timeouts

- **The zero `Client.Timeout` waits forever.** `http.Get`, `http.DefaultClient` and `&http.Client{}`
  have none. Against a server that accepts and never answers, `http.Get` was still blocked after
  3 s; against one that sends headers and then one byte per 100 ms, `Do` returned 200 and
  `io.ReadAll` never finished. Set `Client.Timeout` per upstream, or a deadline on each call's
  context. Reported by: none — test or review (`golangci:noctx (opt-in)` flags `http.Get` only for
  its context).
- **`Client.Timeout` covers reading the body after `Do` returns.** With `Timeout: time.Second`
  against the dripping server, `Do` returned at once and the body read failed at 1.001 s with 10
  bytes read. A timeout sized for an API call therefore cuts off a download or a stream. For those,
  leave `Client.Timeout` at zero, set `Transport.ResponseHeaderTimeout` for the wait for headers,
  and give each call a context the caller cancels. Reported by: none — test or review.
- **Timeout errors come in different shapes.** Measured on go1.21.13 through go1.27.1:

  | Case | Error value | `errors.Is(err, context.DeadlineExceeded)` | `net.Error` `Timeout()` |
  |---|---|---|---|
  | `Client.Timeout`, waiting for headers | `*url.Error` | true `(toolchain ≥1.23)`; false on 1.21, 1.22 | true |
  | `Client.Timeout`, reading the body | `*http.timeoutError` (`*http.httpError` on 1.21, 1.22), **not `*url.Error`** | true `(toolchain ≥1.23)`; false on 1.21, 1.22 | true |
  | context deadline, `Do` | `*url.Error` | true | true |
  | context deadline, reading the body | `context.deadlineExceededError`, **not `*url.Error`** | true | true |
  | `ResponseHeaderTimeout` | `*url.Error`: `net/http: timeout awaiting response headers` | true `(toolchain ≥1.23)`; false on 1.21, 1.22 | true |
  | `TLSHandshakeTimeout` | `*url.Error`: `net/http: TLS handshake timeout` | **false** | true |
  | context canceled | `*url.Error` | false (`errors.Is(err, context.Canceled)` true) | false |
  | connection refused | `*url.Error` | false | false |

  ```go
  // IsTimeout reports a client-side timeout from Do or from reading the body: Client.Timeout,
  // a ctx deadline, and the Transport's header and TLS handshake timeouts. Body-read errors
  // are not *url.Error, and the TLS handshake timeout is not context.DeadlineExceeded.
  func IsTimeout(err error) bool {
  	ne, ok := errors.AsType[net.Error](err)
  	return ok && ne.Timeout()
  }
  ```

  Classifying by `errors.As(err, &urlErr)` misses both body-read rows;
  `errors.Is(err, context.DeadlineExceeded)` misses the TLS handshake. Below a `go 1.26` line use
  `errors.As` (see the go-style skill, errors-control). Reported by: none — test or review.

## Connection reuse

- **`MaxIdleConnsPerHost` defaults to 2, so concurrent calls to one host redial.** Clone of
  `DefaultTransport`, 5 rounds of 50 concurrent GETs to one host (handler sleeps 20 ms, bodies read
  and closed):

  | `MaxIdleConnsPerHost` | New connections per round | Idle connections kept |
  |---|---|---|
  | 0 (default, `DefaultMaxIdleConnsPerHost` = 2) | 50, 48, 48, 48, 48 | 2 |
  | 10 | 50, 40, 40, 40, 40 | 10 |
  | 50 | 50, 0, 0, 0, 0 | 50 |

  Set it to the concurrency you expect per upstream. `MaxIdleConns` (100 in `DefaultTransport`)
  caps the idle connections of all hosts together: one shared client with `MaxIdleConnsPerHost`
  32 and 32 concurrent GETs per host redialed 0 per round for 1 to 3 hosts, 28 for 4 and 92 for 6;
  one client per host redialed none. HTTP/2 was not run. Reported by: none — test or review.

## Response bodies

- **Close every body on every path, after the error check.** 20 GETs whose bodies were never read or
  closed left 20 server connections and 40 client goroutines, for 1 KiB and 300 KiB bodies, on both
  toolchains; the 1.27 drain below runs only on `Close`. Reported by: `golangci:bodyclose (opt-in)`,
  with [misses](#what-the-linters-report). After an error from `Do` there is nothing to close (only
  a failing `CheckRedirect` also returns a response, its body closed; docs).
- **`defer resp.Body.Close()` before `if err != nil`** dereferences a nil `resp` on the failure
  path. Reported by: `staticcheck SA5001`, `gopls:SA5001`; `vet` (httpresponse) and
  `gopls:httpresponse` only for a `resp` straight from `http.Get` or `Client.Do`, not from your
  own helper returning `(*http.Response, error)`; none for a deferred closure; not `vet+test`.
- **`(toolchain ≥1.27)` `Close` on an unread body drains it in the background, and the connection
  is reused once the drain ends; 1.26 never reuses it.** The drain reads at most 256 KiB for at most
  50 ms: a Content-Length body only when its whole length is ≤ 256 KiB, however much was already
  read (300 KiB with 100 KiB read: new connection); a chunked body when ≤ 256 KiB remain (same
  case: reused when the next GET came 50 ms or more later, in 0–26 % of runs when it followed at
  once). Not GODEBUG-gated: a `go 1.26` module built by 1.27.3 drains. `Close` returned in under
  1 ms. Server connections for two sequential GETs; the at-once column is a race with the drain,
  given as the range over batches of 20 to 120 runs, and it moved with machine load:

  | Body, closed without reading | go1.26.10 | go1.27.3, next GET 50 or 300 ms later | go1.27.3, next GET at once (a race) |
  |---|---|---|---|
  | 1 KiB, Content-Length or chunked | new connection | reused | reused in 92–100 % of runs |
  | 200 or 256 KiB, Content-Length or chunked | new connection | reused | new connection in most runs (reused in 0–50 %) |
  | 256 KiB + 1 (length); 300 KiB (length or chunked) | new connection | new connection | new connection |
  | 2 KiB with a 20 ms pause mid-body | new connection | reused | new connection (0 of 30 runs on 1.27.3, 0 of 300 on 1.27.1) |
  | 2 KiB with a 100 ms pause mid-body | new connection | new connection | new connection |
  | read to EOF, never closed (1 KiB, 300 KiB) | reused | reused | reused |

  Twenty back-to-back GETs that closed unread bodies dialed 1–2 connections for 1 KiB, 1–3 for
  16 KiB, 2–4 for 64 KiB and 2–6 for 200 KiB on go1.27.1 (45 or more runs each), and always 20
  on go1.26.8 (not re-run on 1.27.3 or 1.26.10).

  ```go
  // DrainClose reads at most 64 KiB of what is left, then closes the body. A body read to
  // EOF is back in the pool before the next request, on 1.26 too; Close alone (1.27 only)
  // drains in the background, and the next request can overtake it. It takes resp:
  // bodyclose reports resp.Body passed to a helper outside a deferred closure.
  func DrainClose(resp *http.Response) {
  	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
  	_ = resp.Body.Close() // read-only body: the read error, if any, was already seen
  }
  ```

  With `DrainClose` the next GET, even one sent at once, reused the connection for 1 KiB and
  60 KiB bodies (length or chunked) in every run on both toolchains (20 to 170 runs per case); a
  300 KiB body still cost a new connection, except a chunked one on 1.27: reused in under 1 % to 45 % of
  runs (batches of 20 to 120) when the next GET followed at once, and always when it came 50 ms or
  more later (the transport drained the remaining 236 KiB). Use `defer DrainClose(resp)` after the
  error check when calls to one host follow closely or the binary may be built before 1.27. HTTP/2
  was not run.

## Status codes and size limits

- **A 4xx or 5xx is a response, not an error.** A 500 and a 404 returned `err == nil`; code that
  checks only `err` decodes an error page as the result. Reported by: none — test or review.
- **`io.LimitReader(body, limit)` truncates without an error.** A 10 MiB body read through a 1 MiB
  limit gave 1,048,576 bytes and `err == nil`. Read `limit+1` and compare the length, as below.
  `http.MaxBytesReader(nil, resp.Body, limit)` also works on a client body and returns
  `*http.MaxBytesError` (`http: request body too large`, although it is a response). Reported by:
  none — test or review.

```go
// StatusError reports a response outside 2xx; net/http returns those with a nil error.
type StatusError struct {
	Code int
	Body string // at most 512 bytes of the body
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("unexpected status %d: %s", e.Code, e.Body)
}

// maxBody bounds how much of a response body DoJSON reads.
const maxBody = 1 << 20

// DoJSON sends in (if not nil) as JSON and decodes a 2xx response into out (if not nil).
func DoJSON(ctx context.Context, c *http.Client, method, url string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(b) // sets GetBody, so 307/308 redirects and retries can resend it
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck // read-only body; the read error is checked below
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if len(data) > maxBody {
		return fmt.Errorf("response body exceeds %d bytes", maxBody)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return &StatusError{Code: resp.StatusCode, Body: string(data[:min(len(data), 512)])}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}
```

Tested: a POST (both headers sent), a POST answered with 307 (re-sent), a 502, a 1 MiB + 10 byte
body, a stalled server, a non-JSON 200 and an unencodable `in`. The status is checked after the
bounded read so the error carries the upstream's text; the `//nolint` is for errcheck (standard),
which reports a bare deferred `Close`.

## Redirects

The default policy follows up to 10 redirects. With `Authorization: Bearer …`, `Cookie: sid=1`
(as a header, no cookie jar) and `X-Custom: kept` set on the original request:

| Redirect | `Authorization`, `Cookie` | `X-Custom` |
|---|---|---|
| a.test → a.test, → a.test:8080 (other port), → sub.a.test (subdomain) | kept | kept |
| sub.a.test → a.test (parent); a.test → b.test | dropped | kept |
| a.test → b.test → a.test | dropped, stays dropped | kept |

| Request body and status | Result |
|---|---|
| POST `*bytes.Reader`, `*bytes.Buffer` or `*strings.Reader`, 307 or 308 | followed; body re-sent (`NewRequest*` set `GetBody`) |
| POST with any other `io.Reader` (`io.MultiReader`, a wrapper type), 307 or 308 | **`err == nil` and `resp` is the 307/308 itself** (`GetBody` nil) |
| POST, 301, 302 or 303 | followed as GET with no body |
| `CheckRedirect` returns `http.ErrUseLastResponse` | `err == nil`, the 3xx response, `Location` readable, body open |
| `CheckRedirect` returns another error | `err` set and `resp` non-nil with the body already closed |
| redirect loop | `stopped after 10 redirects`, `resp` non-nil |

- **`Authorization` and `Cookie` are stripped only on a move to a host that is neither the same
  host nor a subdomain; an ordinary header is never stripped.** `X-Custom` reached b.test: an API
  key in a custom header (`X-Api-Key`) goes wherever `Location` points. Reported by: none — test
  or review.
- **A body without `GetBody` makes a 307/308 come back as the response, with no error.** Code that
  checks only `err` decodes the redirect page; a status check like `DoJSON`'s turns it into an
  error. Wrap payloads in `bytes.NewReader` or set `req.GetBody`. Reported by: none — test or
  review.
- **To stop at the first redirect** (an internal API where a redirect means misconfiguration, or a
  host that must not change), set `CheckRedirect` to a function that returns
  `http.ErrUseLastResponse`: `Do` returns the 3xx with its body open, to close as usual.

## Re-sending a request

Calling `Do` twice with the same `*http.Request` after the first attempt consumed its body
(POST/PUT of "payload"):

| Body / connection for the second attempt | Result |
|---|---|
| `*bytes.Reader` or `*bytes.Buffer`, an idle connection available | 200, server got "payload": the write on the reused connection failed before sending, and the Transport retried on a new connection after rewinding with `GetBody` (one wasted connection) |
| `req.Clone(ctx)` of the consumed request | same: `Clone` shares the body |
| `*bytes.Reader` or `*bytes.Buffer`, no idle connection (closed first) | `Post "…": http: ContentLength=7 with Body length 0` |
| `strings.Reader`, `DisableKeepAlives` | `Put "…": http: ContentLength=7 with Body length 0` |
| any other `io.Reader` (`io.MultiReader`, a wrapper type; no `GetBody`, sent chunked) | **200, server got an empty body**, no error anywhere |
| `req.Body, err = req.GetBody()` before the resend | 200, "payload" |
| a new request per attempt | 200, "payload" |

- **A request whose body was read is single-use.** The resend passes in a test because the test
  has an idle connection; in production the second attempt fails, or with a custom reader sends
  nothing. Build a new request from the payload bytes for every attempt. Retry policy, backoff and
  `Retry-After` for sinks: [daemon](daemon.md). Reported by: none — test or review.
- **The Transport itself re-sends a POST that carries `Idempotency-Key` or `X-Idempotency-Key`.**
  The server read the POST on a reused connection and closed it without answering: without the
  header `Do` failed with `Post "…": EOF` (handler ran once); with either header `Do` returned 200
  and the handler ran twice. Such requests (and GET, HEAD, OPTIONS, TRACE) are retried only on a
  reused connection, with a rewindable body, that failed before any response byte (after a partial
  status line: no retry; source: `isReplayable`, `shouldRetryRequest`). The receiver must
  deduplicate on the key. Reported by: none — test or review.

## What the linters report

| Shape | Reported by |
|---|---|
| `http.Get`, `Head`, `Post`, `PostForm`; the same methods on `*http.Client`; `http.NewRequest` | `golangci:noctx (opt-in)`; it accepts `NewRequestWithContext(context.Background(), …)` and `req.WithContext(context.TODO())` |
| `defer resp.Body.Close()` before the error check | `staticcheck SA5001`, `gopls:SA5001`; `vet` (httpresponse), `gopls:httpresponse` only for a `resp` straight from `http.Get`/`Client.Do`; none in a deferred closure; not `vet+test` |
| body never closed; body read but not closed | `golangci:bodyclose (opt-in)` |
| non-2xx early return that does not close, in a function that returns `resp` on success | none — bodyclose misses it |
| bodies closed in a later loop over a slice; `drain(resp.Body)`, `defer drain(resp.Body)`, also on a `resp` from your own helper | bodyclose reports them (false positives) |
| `drain(resp)`, `defer drain(resp)` on a `resp` from `Do` or from your own helper `(golangci-lint ≥2.15; v2.14 reported the helper form)`; any `drain` inside `defer func() { … }()` | silent (correct) |
| bare `defer resp.Body.Close()` | `golangci:errcheck (standard)`, unless `exclusions.presets: [std-error-handling]` |
| missing timeout, bare Transport, Transport per request, unbounded read, custom reader + 307, resent request | none — test or review |

`golangci:gosec (opt-in)` adds `G107` on `http.Get` with a variable URL and `G704` (SSRF taint) on
some `c.Do(req)` calls, not on `DoJSON`. A leaked connection from an unclosed body also shows up as
`persistConn` goroutines in a leak check ([testing](testing.md)).

## Gotchas

- Agent calls `http.Get` or builds `&http.Client{}` - there is no timeout, and a silent upstream blocks the caller forever.
- Agent builds `&http.Transport{TLSClientConfig: cfg}` - the proxy, the TLS handshake timeout and HTTP/2 are gone.
- Agent creates a Transport per request - one connection and two goroutines leak per call.
- Agent leaves `MaxIdleConnsPerHost` at its default under concurrency - 48 of 50 connections are redialed every round.
- Agent sets `Client.Timeout` on the client used for downloads or streams - the body read is cut off at the timeout.
- Agent classifies timeouts by `*url.Error` or by `context.DeadlineExceeded` - body-read or TLS handshake timeouts fall through.
- Agent defers `Close` before checking `err` - a nil dereference on the failure path that `go test` does not report.
- Agent returns early on a non-2xx status without closing the body - the connection leaks and bodyclose stays silent.
- Agent checks only `err` from `Do` - 4xx and 5xx bodies are decoded as results.
- Agent bounds a body with `io.LimitReader(body, limit)` - an oversized body is truncated with no error.
- Agent posts a custom `io.Reader` and the upstream answers 307 - the 307 comes back with `err == nil`.
- Agent sends an API key in a custom header and follows redirects - the key reaches the other host.
- Agent retries by calling `Do` again with the same request - it passes in tests and fails or sends an empty body in production.
- Agent adds `Idempotency-Key` and counts one `Do` as one delivery - the Transport can send the POST twice.

## Official sources

- [net/http](https://pkg.go.dev/net/http): `Client` (Timeout, CheckRedirect, header forwarding on redirects), `Transport`, `Response.Body`, `DefaultTransport`
- [Go 1.27.1 net/http transport.go](https://cs.opensource.google/go/go/+/refs/tags/go1.27.1:src/net/http/transport.go) (`maxPostCloseReadBytes`, `maxPostCloseReadTime`, `shouldRetryRequest`) and [request.go](https://cs.opensource.google/go/go/+/refs/tags/go1.27.1:src/net/http/request.go) (`isReplayable`)
- [httpresponse analyzer](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/httpresponse) and [staticcheck SA5001](https://staticcheck.dev/docs/checks/#SA5001)
- [bodyclose](https://github.com/timakin/bodyclose) and [noctx](https://github.com/sonatard/noctx)
