# asyncio in a FastAPI service

Applies to Python 3.14 asyncio and uvicorn 0.54. The event loop runs one coroutine at a time; a
coroutine gives up control only at an `await` that actually suspends. Everything below follows from
that and from the fact that asyncio reports many failures only through the log.

Contents: [Tasks and ownership](#tasks-and-ownership) · [Cancellation](#cancellation) ·
[Timeouts](#timeouts) · [Running things concurrently](#running-things-concurrently) ·
[Threads](#threads) · [Loop API on Python 3.14](#loop-api-on-python-314) · [Gotchas](#gotchas)

## Tasks and ownership

```python
import asyncio
import logging
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

logger = logging.getLogger(__name__)


class TaskOwner:
    """Keeps references to background tasks, logs their failures, cancels them on shutdown."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task[Any]] = set()

    def spawn(self, coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._on_done)
        return task

    def _on_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            logger.error("background task %s failed", task.get_name(), exc_info=exc)

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, TaskOwner]]:
    owner = TaskOwner()
    try:
        yield {"tasks": owner}
    finally:
        await owner.close()
```

- `asyncio.create_task(coro)` without keeping the returned task is fire-and-forget in the worst
  sense: the loop holds only a weak reference. While the task waits on a timer, `loop.sock_*` or an
  httpx call the loop's own bookkeeping keeps it alive, but a task waiting on a bare `Future`, an
  `asyncio.Event`/`Queue`, or an asyncio `StreamReader` that nothing else references is
  garbage-collected mid-run (`Task was destroyed but it is pending!`, the coroutine
  is closed with `GeneratorExit`), so the bug is intermittent. An exception inside an unobserved
  task is reported only when the task object is collected, as
  `Task exception was never retrieved` in the log, and never at all when the process is killed
  first. Keep a reference and read the result, or add a done callback that calls
  `task.exception()` as above; `add_done_callback(tasks.discard)` alone does not observe the
  error.
- **At server shutdown under SIGTERM (Docker, Kubernetes, `--workers`), tasks that nobody awaits
  are dropped without being cancelled**: no `CancelledError` is delivered and `finally` blocks do
  not run (uvicorn 0.54). A task started in `lifespan` and still running when the shutdown code
  after the `yield` runs is simply gone afterwards. Under Ctrl+C (SIGINT) in local development,
  `asyncio.run()` cleanup cancels the remaining tasks **after** the lifespan shutdown code, so
  `finally` runs and the bug is invisible locally. Cancel and await your tasks in the shutdown
  code, as above.
- `BackgroundTasks` are for short work tied to one response. They run after the response on the
  request's task, in order, and an exception in one stops the remaining ones; it is logged as
  `Exception in ASGI application` after the client already has its `200`. For anything that must
  survive a restart use a queue or a job table.
- uvicorn waits for the code after `yield` in `lifespan` without any timeout;
  `--timeout-graceful-shutdown` bounds in-flight requests only. Bound your own cancellation waits.

## Cancellation

- `CancelledError` derives from `BaseException`. `except Exception:` does **not** catch it, so
  ordinary error handling does not break cancellation. `except BaseException:` and a bare
  `except:` do; re-raise it there.
- A coroutine that catches `CancelledError` and returns normally has turned a cancellation into a
  successful result: the task is not marked cancelled and the caller receives the return value.
  A coroutine that swallows `CancelledError` inside a loop and keeps going can no longer be
  stopped: `wait_for`, an enclosing `asyncio.timeout`, `TaskGroup` exit, `asyncio.run` cleanup and
  even `sys.exit()` hang on it. Only do this for cleanup, then re-raise.
- Cancelling a task that awaits `asyncio.gather(...)` cancels the gathered children. Cancelling a
  task that awaits `asyncio.to_thread(...)` does **not** stop the thread; the thread runs to
  completion with nobody waiting for its result, and an exception it raises afterwards is dropped
  without a log line.
- A client disconnect does **not** cancel a normal request handler. The handler runs to the end,
  its writes happen, and the response is discarded. Only a `StreamingResponse` body is cancelled
  when the client goes away, and only at the generator's **own** next suspending `await`
  (`CancelledError` in the generator, `finally` runs). `send` after a disconnect returns
  immediately without suspending, so a generator that only yields is never cancelled: it runs to
  exhaustion at the moment of disconnect, writing every remaining chunk into the void. Add
  `await asyncio.sleep(0)` per chunk when the body is expensive to produce. Behind a
  `BaseHTTPMiddleware` (`@app.middleware("http")`) such a generator is not even exhausted: it
  stays suspended at `yield`, and its `finally` runs neither at disconnect nor at SIGTERM, only
  at a later garbage collection. Even a generator that awaits is occasionally abandoned this way
  behind `BaseHTTPMiddleware` (the disconnect can land while it is parked at `yield`; 2 of 26
  disconnects here). Do not rely on a streaming generator's `finally` for timely cleanup.
- `await request.is_disconnected()` consumes one ASGI message. Called before the request body
  was read, it discards buffered body bytes: `request.body()` then returns only the remainder, or
  waits forever when the whole body was in that message. Read the body first, then poll.

## Timeouts

- `async with asyncio.timeout(seconds):` and `asyncio.wait_for` cancel the awaited work on expiry
  and raise `TimeoutError`. They can only act at an `await` that suspends: a blocking call
  (`time.sleep`, a sync HTTP client) or a CPU loop inside the block runs to completion. If nothing
  suspends after it, the block returns normally, however long it took. The deadline is a timer
  callback that must get a turn on the loop: a single `await asyncio.sleep(0)` after the blocking
  call is not reliably enough (on the stdlib loop the block still returns normally; on uvloop it
  raises `TimeoutError`), a real suspension (`sleep(0.001)`, I/O) raises `TimeoutError` on both,
  after the damage is done.
- `asyncio.shield(coro)` protects the inner work from the cancellation: the timeout still raises,
  and the shielded work keeps running unobserved. Use it only when something else awaits the
  result.
- A timeout only cancels the awaiting task; what happens to the socket is up to the library.
  httpx closes the in-flight connection when its request is cancelled (the pool is empty
  afterwards); a blocking client running in a thread is not interrupted at all. Give network
  clients their own timeouts as well ([http-clients](http-clients.md)).

## Running things concurrently

| Tool | On first failure | Cancelled when the awaiting task is cancelled |
|---|---|---|
| `asyncio.gather(*coros)` | raises that exception; the **other coroutines keep running** | yes |
| `asyncio.gather(..., return_exceptions=True)` | never raises; exceptions are returned as values | yes |
| `asyncio.TaskGroup` | cancels the siblings, then raises an `ExceptionGroup` (for exceptions other than `CancelledError`) | yes |

- Prefer `TaskGroup` for fan-out that belongs to one request: siblings are cancelled, nothing keeps
  running after the response, and every failure that has already happened is in the
  `ExceptionGroup` (siblings that would have failed later show up as cancelled).
- With `return_exceptions=True` an error is just another list element, and a cancelled child is a
  `CancelledError` instance in the list; code that does not check `isinstance(item, BaseException)`
  treats the exception object as data.
- `asyncio.gather(...)` schedules every coroutine as soon as it is called, even if the returned
  future is never awaited.
- A `TaskGroup` child that is cancelled on its own (it raises `CancelledError`, or someone calls
  `task.cancel()` on it) does not fail the group: the siblings finish and the block exits
  normally. Check `task.cancelled()` before reading `task.result()`.
- `gather` over a comprehension starts **everything at once**. Bound fan-out with a semaphore:

```python
import asyncio
from collections.abc import Awaitable, Callable


async def bounded_map[T, R](
    fn: Callable[[T], Awaitable[R]], items: list[T], limit: int
) -> list[R]:
    semaphore = asyncio.Semaphore(limit)

    async def one(item: T) -> R:
        async with semaphore:
            return await fn(item)

    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(one(item)) for item in items]
    return [task.result() for task in tasks]
```

- A semaphore bounds **concurrency**, not rate. `Semaphore(int(requests_per_second))` is
  `Semaphore(0)` for any rate below 1 and blocks forever. Rate limiting needs a token bucket or a
  client-side limiter.
- Sharing one `AsyncSession` between the concurrent tasks is the classic mistake here
  ([sqlalchemy-async](sqlalchemy-async.md#concurrency)).

## Threads

- `await asyncio.to_thread(fn, ...)` runs `fn` in the default executor with a **copy** of the
  current context: `ContextVar` values are readable in the thread, and values set in the thread are
  not visible afterwards. `loop.run_in_executor(None, fn)` does not copy the context; `fn` sees the
  worker thread's own context: the defaults, or whatever an earlier job set on that thread.
- There are two separate pools: asyncio's default executor (`min(32, cpu + 4)` threads) serves
  `to_thread` and `run_in_executor(None, ...)`; AnyIO's 40-token pool serves `def` handlers,
  `def` dependencies and `run_in_threadpool`. Saturating one does not block the other; each
  starves only its own users.
- Do not touch loop-bound objects (locks, clients, sessions) from inside the thread. Return plain
  data and continue on the loop.
- `asyncio.Lock`, `Event`, `Semaphore` created at import time are fine on 3.14; they bind to a
  loop on the first `await` that actually **waits**, not on first use. Shared between two loops (a
  second `asyncio.run`, for example inside a `def` handler or a sync script) they work while
  uncontended and fail only under contention, with
  `RuntimeError: ... is bound to a different event loop`.

## Loop API on Python 3.14

- `asyncio.get_event_loop()` with no running loop and no loop set through
  `asyncio.set_event_loop()` raises `RuntimeError: There is no current event loop` (it no longer
  creates one). Libraries that still call it at start-up fail on 3.14. Use `asyncio.run(...)` at
  the top level and `asyncio.get_running_loop()` inside coroutines.
- `asyncio.get_event_loop_policy()` and the policy system are deprecated. Configure uvloop through
  the server (`uvicorn --loop uvloop`), not by installing a policy.
- `asyncio.run()` inside a running loop raises `RuntimeError`; the coroutine passed to it is never
  awaited.

## Gotchas

- Agent calls `asyncio.create_task(...)` and drops the result - the task may be garbage-collected, and its exception appears only in the log, or nowhere if the process is killed.
- Agent tracks tasks with `add_done_callback(tasks.discard)` only - failures are still unobserved.
- Agent swallows `CancelledError` inside a retry loop - the task can never be stopped and shutdown hangs.
- Agent awaits a long cancellation in the lifespan shutdown code - uvicorn waits without limit.
- Agent starts a task in `lifespan` and never cancels it - under SIGTERM it vanishes without `CancelledError` or `finally`; under Ctrl+C it is cancelled, so local runs look fine.
- Agent writes `except Exception:` around an await and expects to see cancellation - it passes through (correct), but `except BaseException:` or a bare `except:` swallows it.
- Agent catches `CancelledError` to "clean up" and returns - the task looks successful to its caller.
- Agent expects a client disconnect to stop the handler - it runs to completion; only streaming bodies are cancelled, only at the generator's own `await`, and not at all behind `BaseHTTPMiddleware` when the generator never awaits.
- Agent polls `request.is_disconnected()` before reading the body - part of the body is lost, or `body()` hangs.
- Agent wraps a blocking call or a CPU loop in `asyncio.timeout` - it cannot fire during the call, and fires afterwards only at a real suspension.
- Agent reads `task.result()` of a `TaskGroup` child that was cancelled individually - `CancelledError`, although the group succeeded.
- Agent uses `gather` for request fan-out - a failed call leaves its siblings running after the response.
- Agent uses `gather(..., return_exceptions=True)` and processes the list as results - exceptions are silently included as items.
- Agent fans out with `gather` over thousands of coroutines - they all start at once; bound with a semaphore or a `TaskGroup` helper.
- Agent computes `Semaphore(int(rate))` - zero for rates below one, blocks forever.
- Agent cancels a task that runs `to_thread` and expects the thread to stop - it runs to completion.
- Agent sets a `ContextVar` inside `to_thread` and reads it after - the thread had a copy.
- Agent uses `run_in_executor` and reads request context in the function - context is not copied.
- Agent calls `asyncio.get_event_loop()` in a script or fixture on 3.14 - `RuntimeError`, no implicit loop.
- Agent relies on `asyncio.gather` failing fast - it raises on the first failure but the rest continue; the raise itself hides later failures.

## Official sources

- [asyncio: Coroutines and Tasks](https://docs.python.org/3.14/library/asyncio-task.html)
- [asyncio: Event loop](https://docs.python.org/3.14/library/asyncio-eventloop.html)
- [What's new in Python 3.14: asyncio](https://docs.python.org/3.14/whatsnew/3.14.html)
- [Starlette: Background tasks](https://www.starlette.io/background/)
