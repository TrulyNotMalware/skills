# Streaming, SSE, WebSockets, and long-running work

Applies to FastAPI 0.142, Starlette 1.7, uvicorn 0.54, sse-starlette 3.x. The common thread: once
the response has started, the status code, the headers and the error handling are fixed, and
whatever goes wrong afterwards is visible only in the server log.

Contents: [Choosing the shape](#choosing-the-shape) · [StreamingResponse](#streamingresponse) ·
[Server-Sent Events](#server-sent-events) · [WebSockets](#websockets) ·
[BackgroundTasks](#backgroundtasks) · [Long-running work](#long-running-work) · [Gotchas](#gotchas)

## Choosing the shape

| Work | Shape |
|---|---|
| Finishes well within client and proxy timeouts | plain response |
| Produces output incrementally, client consumes as it arrives | `StreamingResponse` (bytes), SSE (events) |
| Long, may outlive the connection, must survive a disconnect or a restart | accept with `202` and a job id; run in a worker; expose status and a result endpoint; push progress over SSE or WebSocket if wanted |
| Short side effect after the response (email, audit row) | `BackgroundTasks`, and only if losing it on a crash is acceptable |

Holding an HTTP connection open for minutes fails at whichever layer times out first, and each
layer reports it differently: httpx gives up when no data arrives for 5 s (its default read
timeout is per read, so a response that keeps sending data can run longer), load balancers and
proxies have their own limits, while uvicorn alone **never** times a request out (`--timeout-keep-alive`
closes idle connections between requests only). A long request therefore works on the developer's
machine and fails behind the first proxy. Do not tune timeouts up to make a long synchronous
request work; move the work out of the request.

## StreamingResponse

```python
import asyncio
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()


@app.get("/export")
async def export() -> StreamingResponse:
    async def rows() -> AsyncIterator[bytes]:
        for i in range(3):
            await asyncio.sleep(0)  # a real source awaits I/O here
            yield f"row {i}\n".encode()

    return StreamingResponse(rows(), media_type="text/plain")
```

- Status and headers are sent as soon as the `StreamingResponse` is returned, before the generator
  produces anything. An exception anywhere in the generator, even before the first `yield`,
  cannot change them: the client receives `200`, a truncated or empty body and a closed
  connection (`curl` exit 18, httpx `RemoteProtocolError: ... incomplete chunked read`), and the
  exception goes to the server log as `Exception in ASGI application`. Validate and fail
  **before** returning the response.
- A sync generator works too; Starlette iterates it in the threadpool, chunk by chunk. On a client
  disconnect it stops after the chunk in flight, but its `finally` does not run then: the
  cancelled task's traceback keeps the generator alive until the next cyclic garbage collection,
  which comes within some dozens of requests on a busy server and never on an idle one. Own the sync source from an async generator
  (`async for chunk in iterate_in_threadpool(src)` from `starlette.concurrency`) and call
  `src.close()` in its `finally`.
- A `yield` dependency with the default scope (database session) stays open for the whole stream
  ([fastapi-basics](fastapi-basics.md#dependencies-with-yield)). The session holds a pool
  connection for that long only while its transaction is open: after a read without `commit()`
  the connection stays checked out during the stream, after `commit()` it is back in the pool.
  Commit before streaming, and page through the data for long exports.
- On client disconnect an async generator is cancelled at its next **own** `await`
  (`CancelledError`, `finally` runs). uvicorn's `send` never suspends after a disconnect, so a
  generator whose only suspension point is the `yield` runs to the end, writing into the void
  ([asyncio-concurrency](asyncio-concurrency.md#cancellation)).
- `GZipMiddleware` still streams (chunks arrive as produced), but it holds status and headers back
  until the first body chunk, and it never compresses `text/event-stream`.
- Test clients buffer the whole stream ([testing](testing.md#choosing-a-client)).

## Server-Sent Events

```python
import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from sse_starlette.sse import EventSourceResponse

app = FastAPI()


@app.get("/events")
async def events(request: Request) -> EventSourceResponse:
    async def source() -> AsyncIterator[dict[str, str]]:
        for i in range(3):
            await asyncio.sleep(0.1)
            yield {"event": "tick", "id": str(i), "data": json.dumps({"i": i})}

    return EventSourceResponse(source())
```

- Prefer `sse-starlette` over a hand-written `StreamingResponse(media_type="text/event-stream")`.
  Besides the framing it sets `Cache-Control: no-store` and `X-Accel-Buffering: no`; without the
  latter, nginx buffers the stream and events arrive in batches, or never.
- FastAPI 0.142 also ships its own `fastapi.sse.EventSourceResponse` and `ServerSentEvent`, with no
  extra dependency: declare `response_class=EventSourceResponse` and write the handler as an async
  generator that yields `ServerSentEvent(event=..., data=...)`. It sends `Cache-Control: no-cache`
  and `X-Accel-Buffering: no`, and a `: ping` comment after 15 s without an event. Differences
  from `sse-starlette` (3.5): it has no `send_timeout` (passing one is a `TypeError`), so a client
  that stops reading is not cut off; it does not end streams at shutdown (next point); and a
  generator that never awaits does not hang the server, because FastAPI awaits between events
  itself. Event ids and `Last-Event-ID` handling are your job with either.
- With `fastapi.sse`, the generator's `finally` runs promptly when a client that was keeping up
  disconnects. When the client goes away while the stream is blocked on a full send buffer (large
  events, slow or stalled reader), the server logs `Exception in ASGI application`
  (`anyio.BrokenResourceError`) and the generator is not closed: its `finally` had not run 20 s
  later. Release anything that matters (subscriptions, locks) from a `yield` dependency rather
  than from the generator's `finally`.
- **An open `fastapi.sse` or `StreamingResponse` stream blocks server shutdown** (uvicorn 0.54).
  After SIGTERM or Ctrl+C uvicorn logs `Waiting for connections to close` and waits until the
  client disconnects or the generator ends; the generator is not cancelled. Run with
  `--timeout-graceful-shutdown N`: the stream is then cancelled after N seconds. Without the flag
  the orchestrator ends the wait with SIGKILL. `sse-starlette` watches for the shutdown itself
  and ends its streams at once.
- An event stream has no end. Clients (`EventSource`) reconnect automatically and send
  `Last-Event-ID`; `sse-starlette` does nothing with it. Give events ids, read
  `request.headers.get("last-event-id")`, and resume from it yourself.
- Each open stream is a coroutine holding a connection; per-worker limits and the load balancer's
  idle timeout apply. `sse-starlette` sends periodic `ping` comments so idle proxies do not close
  the connection.
- A client that stays connected but stops reading blocks the generator in `send` indefinitely
  (`send_timeout` defaults to `None`). Pass `EventSourceResponse(..., send_timeout=seconds)`: the
  stream then ends with `SendTimeoutError` and the generator is closed (`finally` runs).
- **An event generator must suspend on its own `await` in every iteration** (waiting for the next
  event does that naturally). A generator that yields in a loop without awaiting is never
  cancelled after the client disconnects, because `send` no longer suspends: an endless one then
  spins on the event loop forever and the whole process stops answering requests.

## WebSockets

- `await websocket.accept()` first. Sending before accepting is a `RuntimeError` on the server
  and an `HTTP 500` for the connecting client.
- A send after your own `close()` raises `WebSocketDisconnected` (import it from
  `starlette.websockets`; `fastapi` does not re-export it). A send after the **client** left
  raises `WebSocketDisconnect(code=1006)`. The first `receive_*` after the client left raises
  `WebSocketDisconnect` with the client's close code, a second one `WebSocketDisconnected`. Catch
  `WebSocketDisconnect` around the receive loop; do not treat it as an error.
- A WebSocket handler is one long-lived coroutine. Blocking calls inside it stall the whole
  process like in any `async def` handler, and there is no threadpool fallback: a `def` WebSocket
  handler runs its body on the event loop and then fails with
  `TypeError: 'NoneType' object can't be awaited`, an HTTP `500` at the handshake.
- An unhandled exception after `accept()` drops the socket without a close frame; the client sees
  1006, not 1011.
- Broadcasting from a process-local set of connections reaches the connections of **that worker**
  only. With several workers or replicas, route messages through a broker.
- `dependency_overrides` apply to WebSocket routes. Pure ASGI middleware sees websocket scopes;
  `@app.middleware("http")` and `BaseHTTPMiddleware` never run for them. Exception handlers run
  for WebSocket routes, but a handler that returns an HTTP response works only **before**
  `accept()` (it becomes the handshake rejection, e.g. `403`); after `accept()` the same handler
  fails inside the server (`Expected ASGI message 'websocket.send' ...`) and the client sees an
  abnormal close (1006). After `accept()` the only way to signal a failure is a close code.

## BackgroundTasks

- Tasks run after the response, in the order added, on the request's task. The client already has
  its `200` when they start; an exception in one is logged as `Exception in ASGI application` and
  the remaining tasks of that response do **not** run.
- Tasks run only when the endpoint's **own** response is sent. If the endpoint or a later
  dependency raises (`HTTPException`, a custom exception with a handler, a `422`, an unhandled
  error), the handler's response is sent instead and every task already added is discarded. Write
  audit records for failed requests before raising, not as a background task.
- Setting `Response(background=BackgroundTask(...))` on a returned response **replaces** the
  injected `BackgroundTasks`: only the explicit task runs and the injected ones are silently
  dropped. Add everything to the injected container, or pass that container as `background=`.
- They are in-process and in-memory. On SIGTERM uvicorn waits for running tasks
  (`Waiting for background tasks to complete`, unlimited by default); with
  `--timeout-graceful-shutdown N` they are cancelled when the limit expires (logged as
  `Cancel N running task(s), timeout graceful shutdown exceeded`, followed by
  `Exception in ASGI application` with a `CancelledError`), and
  a crash or SIGKILL (Kubernetes after `terminationGracePeriodSeconds`) loses them outright. There is no
  retry in any case. Use them for work whose loss is acceptable. For anything else, write a job
  row or publish a message inside the request's transaction and let a worker pick it up.
- A background task that uses the request's database session works, silently; it holds a pool
  connection for as long as that session's transaction is open
  ([sqlalchemy-async](sqlalchemy-async.md#transactions)).

## Long-running work

```python
import asyncio
import uuid
from enum import StrEnum

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class JobState(StrEnum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class Job(BaseModel):
    id: str
    state: JobState
    result: str | None = None


JOBS: dict[str, Job] = {}  # per process; a real service keeps this in a database or cache


@app.post("/jobs", status_code=202)
async def submit(request: Request) -> JSONResponse:
    job = Job(id=uuid.uuid4().hex, state=JobState.queued)
    JOBS[job.id] = job
    await enqueue(job.id)  # hand off to a worker, e.g. a queue message
    return JSONResponse(job.model_dump(), status_code=202, headers={"Location": f"/jobs/{job.id}"})


@app.get("/jobs/{job_id}")
async def status(job_id: str) -> Job:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return job


async def enqueue(job_id: str) -> None:
    await asyncio.sleep(0)  # placeholder for the real hand-off
```

- Accept fast, return `202` with an id and a `Location` for the status, and do the work in a
  worker process (queue consumer, scheduler). The request's own process is the wrong place: a
  fire-and-forget task dies with the worker, and a `BackgroundTasks` entry, although it survives
  the client's disconnect, has no durability against a crash, a kill, or a task cancellation.
- Make submission idempotent (client-supplied key or content hash) because clients retry `202`
  requests that timed out on the way back.
- Progress and completion can be pushed over SSE or WebSocket, but the status endpoint must exist
  anyway: push channels reconnect and miss events.
- Job state kept in the process (as in the snippet) diverges between processes; `--workers 2` on
  one host already answers `404` for a job another worker accepted. It works for a single process
  only.

## Gotchas

- Agent validates inside the streaming generator - the client gets `200` plus a truncated body when it fails.
- Agent streams a long export from a request-scoped session without committing first - the connection is held for the whole stream.
- Agent hand-rolls SSE with `StreamingResponse` - no `X-Accel-Buffering`, nginx batches or swallows the events.
- Agent gives SSE events no ids - reconnecting clients lose or repeat events.
- Agent writes an endless event generator that never awaits - after one client disconnects the loop spins and the service hangs.
- Agent adds an SSE endpoint with `fastapi.sse` or `StreamingResponse` and leaves the uvicorn command unchanged - with one client connected the server no longer stops on SIGTERM; add `--timeout-graceful-shutdown`.
- Agent releases a subscription in the `finally` of a `fastapi.sse` generator - it does not run when a stalled client disconnects; release it in a `yield` dependency.
- Agent passes `send_timeout` to `fastapi.sse.EventSourceResponse` - `TypeError`; only `sse-starlette` has it.
- Agent leaves `send_timeout` unset - a client that stops reading pins a generator forever.
- Agent sends on a WebSocket before `accept()` - `500` for the client, `RuntimeError` in the log.
- Agent keeps a `set` of WebSocket connections for broadcast - each worker broadcasts to its own clients only.
- Agent uses `BackgroundTasks` for work that must happen - lost on crash, SIGKILL or an expired graceful-shutdown timeout, no retry, the response was already `200`.
- Agent adds several background tasks and one fails - the rest are skipped without notice.
- Agent adds an audit task and then raises `HTTPException` - the task never runs.
- Agent returns `JSONResponse(..., background=BackgroundTask(x))` while also using injected `BackgroundTasks` - the injected tasks are dropped.
- Agent relies on `finally` in a sync streaming generator - it does not run at disconnect.
- Agent runs a long job with `asyncio.create_task` inside the request process - it dies with the worker; return `202` and hand off.
- Agent stores job state in a module dict with more than one worker or replica - status queries hit a process that never saw the job.
- Agent registers `@app.middleware("http")` for auth and expects it to cover WebSockets - it never runs for them.
- Agent raises `HTTPException` in a WebSocket handler after `accept()` - abnormal close 1006, server-side error.
- Agent raises the server and proxy timeouts to make a long request fit - a different layer times out next; uvicorn itself has no request timeout, so the problem only shows behind a proxy.
- Agent writes a `def` WebSocket handler - it runs on the loop and ends in a `500` handshake.
- Agent expects `sse-starlette` to resume from `Last-Event-ID` - the header is delivered, nothing else.

## Official sources

- [Starlette: Responses (StreamingResponse)](https://www.starlette.io/responses/#streamingresponse)
- [Starlette: WebSockets](https://www.starlette.io/websockets/)
- [Starlette: Background tasks](https://www.starlette.io/background/)
- [sse-starlette](https://github.com/sysid/sse-starlette)
- [FastAPI: WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
