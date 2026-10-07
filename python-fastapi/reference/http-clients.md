# Outbound HTTP with httpx

Applies to httpx 0.28 (the project baseline; `httpx2` 2.13 behaves the same in what is listed here
unless noted). An `httpx.AsyncClient` is a connection pool with a lifecycle; most mistakes come from
treating it like a function.

Contents: [One client per process, created in lifespan](#one-client-per-process-created-in-lifespan) ·
[Timeouts](#timeouts) · [Errors](#errors) · [Retries](#retries) ·
[Requests and responses](#requests-and-responses) · [Testing](#testing) · [Gotchas](#gotchas)

## One client per process, created in lifespan

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Request


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, object]]:
    async with httpx.AsyncClient(
        base_url="https://api.example.com",
        timeout=httpx.Timeout(5.0, connect=2.0),
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
    ) as client:
        yield {"http": client}


def get_http(request: Request) -> httpx.AsyncClient:
    return request.state.http


HttpClient = Annotated[httpx.AsyncClient, Depends(get_http)]
```

- A client per request (`async with httpx.AsyncClient() as c:` inside a handler) discards the
  connection pool every time: 50 sequential requests took 0.16 s with a client per call and
  0.02 s with a shared client on localhost; against a TLS host the difference is a handshake per
  request.
- The shared client also shares its **cookie jar**: a `Set-Cookie` from a call made for one user
  is sent on the next call made for another user. Per-request `cookies=` does not help (it is
  merged with the jar, and it is deprecated in 0.28). Give the client a jar that stores nothing
  and pass per-user credentials as an explicit header, which wins over the jar:

```python
from http.cookiejar import CookieJar, DefaultCookiePolicy

import httpx

client = httpx.AsyncClient(
    base_url="https://api.example.com",
    cookies=CookieJar(policy=DefaultCookiePolicy(allowed_domains=[])),
)


async def whoami(session_cookie: str) -> httpx.Response:
    return await client.get("/me", headers={"Cookie": f"session={session_cookie}"})
```

- A client's pooled connections belong to the event loop that opened them. A module-level client
  used from a second loop (a test with its own loop, an `asyncio.run` in a sync script) fails on
  the first request that touches a stale pooled connection (`RuntimeError: Event loop is closed`);
  each stale connection fails one request and is then dropped (N idle connections mean up to N
  consecutive failures), so it presents as **flaky tests**, not a consistent failure. `keepalive_expiry=0` avoids it at the cost of a connection
  per request. Create the client in `lifespan` and inject it.
- Using the lifespan client through `asyncio.run` inside a `def` handler poisons the shared pool,
  and which request fails depends on the pool's state. If the pool holds an idle connection from
  the server loop, the call itself fails with `RuntimeError: ... is bound to a different event
  loop`. If not, the call **succeeds** and leaves behind a connection bound to a closed loop: the
  next request that picks it up (usually a later async handler) fails with `Event loop is
  closed`, and if it is still pooled at shutdown, `aclose()` fails too
  (`Application shutdown failed`).
- After `aclose()` every request raises `RuntimeError: Cannot send a request, as the client has
  been closed`. A client created in `lifespan` is closed at shutdown. `BackgroundTasks` finish
  before that; `lifespan` neither waits for nor cancels a fire-and-forget task, so under SIGTERM
  a task still pending is not resumed and its request is dropped without an error, and wherever
  the loop keeps running after the client closed it hits the `RuntimeError` above
  ([asyncio-concurrency](asyncio-concurrency.md#tasks-and-ownership)).

## Timeouts

- The default is 5 seconds for **each** of connect, read, write and pool acquisition. `timeout=None`
  disables all of them.
- The read timeout applies to each read, **not to the whole response**. A server that sends a
  chunk every 0.5 s delivers a 2.5 s response under `timeout=1.0` without error, and a server that
  drips forever is never cut off. Bound the whole call with `async with asyncio.timeout(...)` when
  total latency matters.
- **An outer deadline must not cancel requests that are queued for a pool slot** (httpx 0.28,
  httpcore 1.0.9, HTTP/1.1). When `asyncio.timeout` or `asyncio.wait_for` cancels requests while
  others wait in the pool queue, the pool can hand the freed slots to waiting requests that are
  being cancelled too. Those connection objects never start (the pool reports them as
  `CONNECTING`; no socket is involved) and are never removed. With `max_connections=10` and a
  stalled upstream, 30 concurrent calls cut off after 1 s lost all 10 slots, on the stdlib loop
  and on uvloop; from then on every request fails with `PoolTimeout` although the upstream has
  recovered, until the client is recreated. Smaller bursts lose fewer slots or none, and the
  losses add up. A shorter httpx timeout does not prevent it: it is per read, so against a
  dripping upstream the outer deadline still does the cancelling. Keep the queue outside the pool
  instead: every call on that client takes a shared semaphore no larger than `max_connections`,
  as below, and a `client.stream(...)` call keeps it until the response is closed.

```python
import asyncio

import httpx


async def fetch(client: httpx.AsyncClient, slots: asyncio.Semaphore, url: str) -> httpx.Response:
    # slots = asyncio.Semaphore(n), n <= max_connections, created in lifespan next to the client
    async with asyncio.timeout(3.0), slots:
        return await client.get(url)
```

- The pool timeout is what fails first under load: with `max_connections=2` and four concurrent
  1 s requests, the third and fourth wait for a connection; with `pool=0.5` they fail with
  `PoolTimeout`, with the default they succeed after 2 s. Size `limits` for the concurrency the
  service really has, and treat `PoolTimeout` as "the client is saturated", not "the upstream is
  down".

## Errors

- **Status codes never raise.** A `500` comes back as a normal `Response`; call
  `response.raise_for_status()` or check `response.is_success`. Code that stores `response.json()`
  from a `gather` without checking stores error bodies as data.
- Exception hierarchy (httpx 0.28): `HTTPError` splits into `HTTPStatusError` (raised only by
  `raise_for_status()`) and `RequestError`. Under `RequestError`: `TransportError` with
  `TimeoutException` (`ConnectTimeout`, `ReadTimeout`, `WriteTimeout`, `PoolTimeout`),
  `NetworkError` (`ConnectError`, `ReadError`, ...), `ProtocolError`, `ProxyError`; and, next to
  `TransportError`, `TooManyRedirects` and `DecodingError`. `ConnectTimeout` is **not** a
  `ConnectError`: an `except (httpx.ConnectError, httpx.ReadTimeout)` misses connection timeouts
  and pool timeouts. Catch `httpx.RequestError` for "could not get a response" and
  `httpx.HTTPStatusError` for "the server answered with an error"; `except TransportError` alone
  misses redirect loops and decoding failures.
- A connection refused is `ConnectError: All connection attempts failed`; a host that drops
  packets is `ConnectTimeout` after the connect timeout; a DNS failure is a
  `ConnectError` carrying the resolver's message, which does not name the host (read
  `exc.request.url`). A dead **proxy** fails with the same text as a refused
  upstream.
- `raise_for_status()` also raises on a `3xx` when redirects are not followed, and `is_success`
  is `False` for it.

## Retries

- A transport passed explicitly replaces the client's own: `limits=` and `http2=` given to
  `AsyncClient` are then ignored (the pool stays at 100 connections, HTTP/1.1). Pass them to the
  transport: `httpx.AsyncHTTPTransport(retries=3, limits=limits, http2=True)`.
- `httpx` does not retry by default. `httpx.AsyncHTTPTransport(retries=3)` retries **connection
  failures only** (`ConnectError`, `ConnectTimeout`; observed 4 attempts with 0/0.5/1.0 s
  backoff), never a request that was sent (`ReadTimeout`, `RemoteProtocolError`), never a
  response (`503`: exactly one request).
- A hand-written retry loop must decide by method and status: retry idempotent requests
  (`GET`, `PUT`, `DELETE`) on transport errors and on `502`/`503`/`504`; do not retry `POST`
  without an idempotency key, and honor `Retry-After` on `429`/`503`. Add jitter.

## Requests and responses

- Redirects are **not followed** by default (`follow_redirects=False`); a `302` is returned as the
  response. Enable it per client or per request when the API uses redirects. A followed
  `301`/`302`/`303` turns a `POST` into a `GET` without the body (the original `Content-Type`
  header is kept); `307`/`308` resend method and body.
- `json=` sends `application/json`; `data=` with a dict sends a form body
  (`application/x-www-form-urlencoded`); `content=` sends bytes with **no** `Content-Type` unless
  `headers=` sets one; `data=` with bytes or a string does the same and only warns. A FastAPI
  upstream answers `422` to a JSON body sent with `content=` or as a form
  ([pydantic-models](pydantic-models.md#request-bodies-in-fastapi)).
- `response.content`/`.json()` hold about twice the body size in memory (105 MB peak for a 52 MB
  body); `client.stream(...)` with `aiter_bytes()` stays at a few MB, while `stream` followed by
  `aread()` is as expensive as `.content`. Pass large bodies through with a `StreamingResponse`.
- Open the upstream stream **inside** the body generator. Leaving `async with client.stream(...)`
  before the body is iterated closes the upstream response first: the caller gets a `200` with an
  empty, aborted body and the log shows `httpx.StreamClosed`.

```python
from collections.abc import AsyncIterator

import httpx
from fastapi.responses import StreamingResponse


def proxy_download(http: httpx.AsyncClient) -> StreamingResponse:
    async def body() -> AsyncIterator[bytes]:
        async with http.stream("GET", "/big") as upstream:
            async for chunk in upstream.aiter_bytes():
                yield chunk

    return StreamingResponse(body(), media_type="application/octet-stream")
```
- HTTP/2 needs the `h2` extra and `http2=True`. `AsyncClient(http2=True)` without `h2` raises
  `ImportError` when the client is built (a transport built with `http2=True` fails only at its
  first TLS request). With both, HTTP/2 is negotiated through ALPN over **TLS only**: an
  `http://` upstream stays HTTP/1.1 (no h2c) unless `http1=False` forces prior-knowledge HTTP/2.
- `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (upper or lower case) are read from the environment when
  the client is **constructed** (`trust_env=True`), and requests to `localhost` and `127.0.0.1`
  go through the proxy too. `NO_PROXY=localhost` does not exempt `127.0.0.1` and vice versa, and
  CIDR notation is not understood; `NO_PROXY=*` or `trust_env=False` exempts everything. A proxy
  variable set for the container silently routes internal calls through the proxy, and a dead
  proxy looks like a dead upstream.

## Testing

- `respx` mocks at the transport level and works with a shared client. Unmatched requests raise
  `AllMockedAssertionError`. Routes that never fire raise at exit with `respx.mock(...)` called
  with parentheses or a `MockRouter()`, but pass silently with the bare `@respx.mock` decorator
  and the `respx_mock` pytest fixture (`assert_all_called=False` there), as long as every request
  that was made hit some registered route. `respx` 0.23 imports
  `httpx` only and cannot mock an `httpx2` client.
- Do not mock `httpx` for tests of timeouts and retries; run a small local server (a FastAPI app
  under uvicorn in a fixture) that sleeps, drips, or returns the status codes under test.

## Gotchas

- Agent creates `httpx.AsyncClient()` inside a handler or dependency - no connection reuse.
- Agent keeps a module-level client - pooled connections belong to the first loop; tests fail intermittently with `Event loop is closed`.
- Agent calls the shared client with `asyncio.run` in a `def` handler - intermittent `500`s: either that call fails, or it succeeds and the next async handler fails.
- Agent sets `timeout=10` to bound a call - it bounds each read; a slow-dripping response takes as long as it likes.
- Agent wraps calls on a shared client in `asyncio.timeout` without a semaphore - after one overload of a slow upstream the pool slots are gone and every call fails with `PoolTimeout` until restart.
- Agent sets `timeout=None` "to be safe" - the request can hang forever and hold a pool slot.
- Agent treats `PoolTimeout` as an upstream outage - the local pool is saturated.
- Agent forgets `raise_for_status()` - `5xx` bodies are processed as data.
- Agent calls an upstream that sets a session cookie through the shared client - the cookie is replayed for every later user.
- Agent returns `StreamingResponse(r.aiter_bytes())` from inside `async with client.stream(...)` - the upstream is closed before the body is read; truncated `200`.
- Agent adds `transport=AsyncHTTPTransport(retries=3)` to a client with `limits=` - the limits silently stop applying.
- Agent catches `ConnectError` and `ReadTimeout` - `ConnectTimeout` and `PoolTimeout` escape; catch `RequestError`.
- Agent sets `http2=True` against an `http://` upstream - still HTTP/1.1; without `h2` installed the client cannot even be built.
- Agent relies on `AsyncHTTPTransport(retries=...)` for flaky upstreams - only connection failures are retried.
- Agent retries a `POST` on timeout - a duplicate write when the first request went through.
- Agent expects a `302` to be followed - it is returned as the response; with `follow_redirects=True` a `POST` through `302` arrives as a `GET` without body.
- Agent sets `NO_PROXY=localhost` and calls `127.0.0.1` - proxied anyway.
- Agent uses the bare `@respx.mock` decorator and registers a route the code never calls - the test passes; an unregistered request still fails.
- Agent sends JSON with `content=` - no `Content-Type`, upstream `422`.
- Agent loads a large response with `.content` - the whole body in memory.
- Agent uses the lifespan client from a fire-and-forget task - at shutdown the task is dropped and the request never happens.

## Official sources

- [httpx: Async support](https://www.python-httpx.org/async/)
- [httpx: Timeouts](https://www.python-httpx.org/advanced/timeouts/)
- [httpx: Resource limits](https://www.python-httpx.org/advanced/resource-limits/)
- [httpx: Exceptions](https://www.python-httpx.org/exceptions/)
- [httpx: Transports (retries)](https://www.python-httpx.org/advanced/transports/)
