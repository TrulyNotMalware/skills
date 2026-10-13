# FastAPI basics: app, dependencies, routing, threads

Applies to FastAPI 0.142 on Starlette 1.7 and Python 3.14. Statements tagged with a version were
observed on that version; re-check them when the project is on an older release.

Contents: [Application and lifespan](#application-and-lifespan) · [Dependencies](#dependencies) ·
[Routing](#routing) · [Responses](#responses) ·
[`def` and `async def` handlers](#def-and-async-def-handlers) ·
[Context variables and middleware](#context-variables-and-middleware) ·
[Annotations](#annotations) · [Gotchas](#gotchas)

## Application and lifespan

```python
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[dict[str, object]]:
    async with httpx.AsyncClient(timeout=10.0) as http:
        yield {"http": http}


def create_app() -> FastAPI:
    app = FastAPI(lifespan=lifespan)

    @app.get("/ping")
    async def ping(request: Request) -> dict[str, bool]:
        http: httpx.AsyncClient = request.state.http
        return {"closed": http.is_closed}

    return app
```

- Create long-lived resources (HTTP clients, engines, pools, producers) once in `lifespan` and
  release them after the `yield`. A dict yielded by `lifespan` is copied into `request.state` for
  every request. The copy is **shallow**: reassigning `request.state.n` affects only that request,
  while mutating a yielded list or dict changes it for all requests. Values set with
  `app.state.x = ...` are a separate object and are read as `request.app.state.x`, not
  `request.state.x`.
- A context variable set inside `lifespan` is not visible in request handlers (the server runs the
  lifespan in its own task). Keep startup values in the lifespan state.
- The lifespan of an application attached with `app.mount("/child", child)` does **not** run when
  the parent starts; the child's routes answer while its startup code never ran. Initialize the
  child's resources from the parent's `lifespan`. `include_router` has no such issue, because a
  router has no application of its own.
- **`lifespan` and `@app.on_event` do not combine.** When `lifespan=` is passed, handlers registered
  with `@app.on_event("startup")`/`("shutdown")` are never called, with no error or warning about
  it (FastAPI 0.142). Handlers registered on an included `APIRouter` (`@router.on_event`) still
  run, so a half-migrated application runs some of its startup code and not the rest. Without
  `lifespan`, `@app.on_event` handlers run once, but `@router.on_event` handlers of an included
  router run **twice** per startup and shutdown (FastAPI 0.142). The deprecation warning is
  visible under pytest but not in the log of `uvicorn module:app`. Move every handler into
  `lifespan` when migrating.
- Lifespan runs once **per process**. With several workers, each worker has its own clients, caches
  and in-memory state. Anything that must be shared goes to an external store.
- `add_middleware` after the application has started raises
  `RuntimeError: Cannot add middleware after an application has started`. Register middleware and
  instrumentation in the factory, not inside `lifespan`.
- Among the middleware added by the application, the last one added is the outermost:
  `add_middleware(A); add_middleware(B)` runs `B` first. Starlette's `ServerErrorMiddleware` is
  always outside all of them. A response produced for an **unhandled** exception therefore passes
  through no user middleware: with `CORSMiddleware` added the usual way, a `500` from an unhandled
  exception carries no CORS headers (also with an `exception_handler(Exception)`), and the browser
  reports a CORS error instead of the failure. `HTTPException` responses keep the headers. If
  error responses must carry them, wrap the whole application:
  `asgi = CORSMiddleware(app, allow_origins=[...])` and serve `asgi`. The wrapper is not a
  `FastAPI` object; keep using the inner `app` for `dependency_overrides`, `app.state` and
  `include_router`.

## Dependencies

Declare dependencies with `Annotated` and give reused ones a module-level alias.

```python
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException

app = FastAPI()


async def current_user(authorization: Annotated[str | None, Header()] = None) -> str:
    if authorization is None:
        raise HTTPException(status_code=401, detail="Missing credentials")
    return authorization.removeprefix("Bearer ")


CurrentUser = Annotated[str, Depends(current_user)]


@app.get("/me")
async def me(user: CurrentUser) -> dict[str, str]:
    return {"user": user}
```

- A dependency result is **cached for the duration of one request**: a dependency used by several
  sub-dependencies runs once and they all receive the same object. Pass `use_cache=False` to run it
  again for that parameter. The cache key includes the scope: the same `yield` dependency declared
  once with the default scope and once with `scope="function"` runs twice and yields two objects.
  The same holds for `Security(dep, scopes=[...])` with different scope lists.
- `async def` dependencies run on the event loop; plain `def` dependencies run in the threadpool,
  also when the route itself is `async def`. Keep dependencies that do no blocking I/O `async def`.
- Things read at import time (`settings = get_settings()` at module level, a module-level client)
  cannot be replaced through `app.dependency_overrides`. Read them through a dependency.

### Dependencies with `yield`

Code after the `yield` runs **after the response has been sent and after background tasks**
(default `scope="request"`, FastAPI 0.142):

```text
dependency enter -> handler returns -> response sent -> background tasks -> dependency exit
```

Consequences:

- An exception raised after the `yield` cannot change the response. Over a real server the client
  already has its `200`; the error is only logged. `HTTPException` raised there is ignored the same
  way. In-process test clients re-raise the exception in the test by default, so the `200` is
  visible in tests only with `raise_server_exceptions=False` / `raise_app_exceptions=False`.
- So a session dependency that commits after the `yield` reports success for writes that then fail
  to commit. Commit inside the handler or service, or use `scope="function"`.
- `Depends(dep, scope="function")` (FastAPI 0.121+) runs the exit code when the handler function
  returns, before the response is sent. A failure there becomes a `500`, and an `HTTPException`
  raised there is returned to the client. The resource is then already closed while the response is
  streamed and while background tasks run.
- In a generator endpoint (a handler that `yield`s,
  [streaming-background](streaming-background.md#generator-endpoints)) the `scope="function"` exit code
  runs **before** the handler body starts, so the body receives a closed session. An `AsyncSession`
  used after `close()` silently begins a new transaction. A write that relies on the dependency's
  commit is never committed, the response is `200`, and the connection stays checked out until
  garbage collection, which logs `SAWarning: The garbage collector is trying to clean up
  non-checked-in connection`. With SQLite its open write transaction makes every other writer fail
  with `database is locked` after 5 s until then. A body that calls `await session.commit()` itself
  persists and returns the connection (SQLAlchemy 2.1, aiosqlite).
- A default-scope dependency with `yield` cannot depend on a `scope="function"` one: the route
  definition raises `DependencyScopeError` (FastAPI 0.142). A plain dependency without `yield` (a
  repository factory) can, and the check does not look through it: a request-scoped `yield`
  dependency that reaches the function-scoped session that way starts fine, and its exit code runs
  after the session is already closed.
- With the default scope the resource is still open during background tasks and while a
  `StreamingResponse` body is generated. A long stream therefore holds its database connection for
  the whole stream.

```python
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

engine = create_async_engine("sqlite+aiosqlite:///:memory:")
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
app = FastAPI()


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session  # closing without a commit rolls back


SessionDep = Annotated[AsyncSession, Depends(get_session)]


@app.post("/things", status_code=201)
async def create_thing(session: SessionDep) -> dict[str, bool]:
    await session.execute(text("select 1"))  # the writes
    await session.commit()  # before the response is built
    return {"created": True}
```

Session and transaction rules are in [sqlalchemy-async](sqlalchemy-async.md#transactions).

- A `yield` dependency that catches an exception must re-raise it. If it swallows the exception,
  the client gets `500`, also when the original was an `HTTPException(404)`. The server log shows
  `FastAPIError: Response not awaited ...` with the default scope, and with `scope="function"` an
  `UnboundLocalError` about `response` from inside FastAPI's routing code, which does not mention
  the dependency.
- The dependency sees every exception the handler raises, including `HTTPException`, and a request
  deadline applied around the app in middleware (`asyncio.timeout` or an AnyIO cancel scope) as
  `CancelledError`. With the session opened by `async with SessionLocal()` as above, closing already
  rolls back an uncommitted transaction and returns the connection on every exit: after an
  `HTTPException(409)` that followed a flush, and after such a deadline, the row was absent, no
  connection stayed checked out and the next writer was not blocked (SQLAlchemy 2.1, aiosqlite). An
  added `except Exception: await session.rollback(); raise` changes nothing there, and it does not
  run for the middleware deadline. An `asyncio.timeout` inside the handler arrives as `TimeoutError`
  and does run it, with the same result. Without the `async with`, close
  the session in `finally`. A client disconnect does not cancel such a handler: it ran on and committed.

## Routing

- Routes match in declaration order. Declare fixed paths before parameterized ones:
  `/users/me` declared after `/users/{user_id}` with `user_id: int` answers `422`, because `me` is
  parsed as the id.
- A path declared as `/items/` answers `/items` with a `307` redirect to `/items/`, for every
  method, and a path declared as `/items` redirects `/items/` the other way. Clients that do not
  follow redirects fail. Pick one style for the whole API. With a router prefix, use an empty path for the collection:
  `APIRouter(prefix="/users")` + `@router.get("")` serves `/users`.
- `FastAPI(redirect_slashes=False)` turns the redirect into a `404`.
- Collection-typed parameters are query parameters only when declared with `Query()`.
  `tags: list[str] = []` on a `GET` handler is treated as a request body: `?tags=a` is ignored and
  the handler receives `[]` with status `200`. The same holds for `set`, `tuple`, `dict` and
  `list[str] | None = None`. Without a default the request fails with `422` and `loc: ["body"]`.
  Write `tags: Annotated[list[str], Query()] = []`.
- `docs_url=None` disables only Swagger UI. `/redoc` and `/openapi.json` stay reachable. To hide
  the API description, pass `openapi_url=None`, which removes all three.
- Put a router's prefix on the `APIRouter` that declares the routes, not in
  `include_router(router, prefix=...)`: only the former is part of `route.path` (`/v1/items/{item_id}`
  vs `/items/{item_id}`), which metrics use as a label
  ([config-observability](config-observability.md#metrics)).
- `app.frontend("/", directory="dist")` (FastAPI 0.142) serves a built frontend behind all API
  routes, with an `index.html` fallback for any unknown `GET` whose `Accept` includes `text/html`.
  A browser opening a mistyped API URL therefore gets `200` and the app page; a client sending
  `application/json` or `*/*` gets `404`. Its default `fallback="auto"` prefers a `404.html` from
  the build: when the build contains one, every single-page-app deep link answers `404` with that
  page. Pass `fallback="index.html"` for single-page apps. A missing directory stops the app at
  import with `RuntimeError`, except under `FASTAPI_ENV=development` (`fastapi dev` sets it), where it
  only warns: the API answers and the frontend path returns `500`.

## Responses

- The return annotation and `response_model=` both **filter** the returned data: fields that are
  not on the model are removed, including extra fields of a returned subclass instance. Without
  either, the handler's return value is sent as is. A response model configured with
  `extra="allow"` removes nothing.
- A returned **model instance** is not validated again field by field (`revalidate_instances="never"`
  is the Pydantic default): an instance changed after creation, or built with `model_construct()`,
  is sent with values that break its field constraints and status `200`. Its
  `model_validator(mode="after")` and `mode="wrap"` validators **do** run again on the way out
  (return annotation or `response_model=`; not with `response_model=None`): one that mutates is
  applied twice (`"Dr. Dr. Kim"`, a list appended twice), and an invariant check turns a mutated
  instance into a `500`. Field validators and `mode="before"` validators do not run again. Returned
  dicts and ORM objects are validated (a dict's `after` validator ran once; Pydantic 2.13, FastAPI 0.142).
- `ORJSONResponse` and `UJSONResponse` are deprecated (FastAPI 0.142); the first response through
  one logs a `FastAPIDeprecationWarning`, visible under `uvicorn module:app`. Any non-default
  `response_class` or `default_response_class` also skips FastAPI's direct Pydantic-to-JSON path
  (from source): with a return type, a `NaN` field is `null` by default but a `500` with
  `response_class=JSONResponse`, and an `int` beyond 64 bits is a `500` with `ORJSONResponse`.
- Filtering and validation are skipped when the handler returns a `Response` object
  (`JSONResponse(...)`) or when the route sets `response_model=None`, whatever the return
  annotation says. With `response_model=None` and an ordinary return value (such as a dict),
  headers, cookies and the status code set on an injected `response: Response` are still applied.
  When returning a separate `Response` object, set those values on that object instead; values on
  the injected response (in the handler or in a dependency) are not copied to it. Values a `yield`
  dependency sets after its `yield` never reach the client, also with `scope="function"`.
- Returned data that does not validate against the response model is a `500`
  (`ResponseValidationError`), not a `422`. It is a server bug, and unit tests that call the
  handler function directly never see it.

## `def` and `async def` handlers

| Handler | Runs on | Blocking call inside |
|---|---|---|
| `async def` | the event loop | stalls **every** request of the process |
| `def` | AnyIO worker threads (default limit 40) | occupies one worker thread |

Measured with five concurrent requests to a handler that waits 0.3 s: `time.sleep` in `async def`
took 1.5 s in total (serialized), `time.sleep` in `def` 0.3 s, `await asyncio.sleep` 0.3 s.

- In `async def`, call only awaitable I/O. For a blocking library without an async API, make the
  handler `def`, or wrap the call: `await run_in_threadpool(fn, arg)` (`fastapi.concurrency`) or
  `await anyio.to_thread.run_sync(fn, arg)`.
- The threadpool is bounded (40 threads). `def` handlers, `def` dependencies, `run_in_threadpool`
  and sync background tasks share it. Once all threads wait on slow calls, further requests queue,
  including `async def` handlers that have a `def` dependency. Only handlers that are `async def`
  all the way down keep answering. To raise the limit, set
  `anyio.to_thread.current_default_thread_limiter().total_tokens = 100` in `lifespan`. The limiter
  belongs to the running loop, so at import time the call raises `NoEventLoopError`. Measured: 60
  concurrent `def` requests that sleep 0.5 s took 1.06-1.11 s at 40, 0.57-0.58 s at 100.
- Pure-Python CPU-bound work gains nothing from either model on a GIL build. In `async def` it
  stalls the loop; in `def` the loop stays responsive but the threads run one at a time. Move it
  to a process pool or a task queue. Extensions that release the GIL (bcrypt, hashlib, numpy) do
  run in parallel in `def` handlers.
- `asyncio.run()` inside an `async def` handler fails with `500` (a loop is already running).
  Inside a `def` handler it succeeds, on a **new** loop in the worker thread: objects bound to the
  application's loop (engines, clients, locks created in `lifespan`) must not be used there. They
  fail intermittently (`... is bound to a different event loop`, `Event loop is closed`) and can
  be left bound to the dead loop, so later `async def` handlers fail too. Use
  `anyio.from_thread.run(coro_fn, *args)` instead: from a `def` handler or dependency it runs the
  coroutine on the application's loop. In a thread AnyIO did not start (your own
  `ThreadPoolExecutor`) it raises `NoEventLoopError`. `asyncer.syncify` (asyncer 0.0.18) behaves the
  same, except that `raise_sync_error=False` silently falls back to a new loop.
- Calling an `async def` function without `await` creates a coroutine object and runs nothing.
  When the result is discarded, Python reports it only as a
  `RuntimeWarning: coroutine ... was never awaited` and the request succeeds. When the coroutine is
  returned from the handler, serialization fails with `500`.

## Context variables and middleware

- A value set in a pure ASGI middleware is visible in the handler and its dependencies.
- A value set inside a `def` handler or `def` dependency is set in the worker thread's copy of the
  context and is **not** visible to the middleware after the call, or to anything else on the loop.
  That includes the handler itself: a context variable set by a `def` dependency is unset in the
  handler that depends on it. Set request context in `async def` dependencies or middleware.
- A value set inside the handler is not visible to a `BaseHTTPMiddleware` after `call_next`
  (the handler runs in a separate task; verified on Starlette 1.7). A pure ASGI middleware does see
  it. Prefer pure ASGI middleware when request-scoped context must flow both ways.
- Background tasks see the context as it was at the end of an `async def` handler. Values set in a
  `def` handler or `def` dependency are not visible to them.

## Annotations

FastAPI reads a handler's signature when the route decorator runs. Every type in a route or
dependency signature must be resolvable at that moment. Lazy annotations (the default on Python
3.14) do not change this: a model class defined **below** the handler that uses it is not found,
with or without the future import.

Do not add `from __future__ import annotations` to modules that declare routes or dependencies
inside a function (an app factory, a test):

```python
from __future__ import annotations  # turns every annotation into a string

from fastapi import FastAPI
from pydantic import BaseModel


def create_app() -> FastAPI:
    app = FastAPI()

    class Body(BaseModel):
        name: str

    @app.post("/local")
    async def local(body: Body) -> dict[str, str]:  # "Body" is not in module globals
        return {"name": body.name}

    return app
```

FastAPI cannot resolve the string `"Body"` because the class is local. The application **starts
without an error** and treats the parameter as a query parameter: the endpoint answers `422` asking
for `?body=`. `Annotated[..., Depends(...)]` written or aliased inside the function fails the same
way. The first loud sign is `/openapi.json` answering `500` with a `PydanticUserError` about a type
that "is not fully defined"; `/docs` still returns `200` and shows a load error in the browser.
Without the future import the same code works. With the import,
define models and dependency aliases at module level.

## Gotchas

- Agent commits in a default request-scoped session dependency after `yield` - the response is already sent; a failed commit is logged and the client keeps its `200`. Commit before returning, or use `scope="function"`.
- Agent concludes from a test that a failure after `yield` in a default request-scoped dependency is reported - the test client re-raised it; a real client received `200`.
- Agent raises `HTTPException` after `yield` in a default-scope dependency - it never reaches the client.
- Agent catches an exception in a `yield` dependency and does not re-raise - every failure becomes a `500`, including intended 4xx responses.
- Agent adds a `lifespan` to an app that still has `@app.on_event` handlers - those silently stop running, while `@router.on_event` handlers keep running.
- Agent tests with `httpx.ASGITransport` or a bare `TestClient(app)` and expects startup state - lifespan does not run; see [testing](testing.md#lifespan-in-tests).
- Agent declares `/users/me` below `/users/{user_id}` - `422` instead of the fixed route.
- Agent mixes `/items` and `/items/` - `307` redirects; clients that do not follow redirects fail.
- Agent writes `tags: list[str] = []` on a `GET` handler - parsed as a body; the query string is ignored.
- Agent sets a context variable in a `def` dependency - the handler and everything after it see the old value.
- Agent sets `docs_url=None` to hide the API in production - `/redoc` and `/openapi.json` remain public.
- Agent calls `requests`, `time.sleep`, a sync database driver, or bcrypt in an `async def` handler - the whole process stalls for the duration.
- Agent moves every blocking call to `def` handlers on a hot path - 40 threads, then queueing.
- Agent calls a coroutine function without `await` and discards the result - nothing runs and no exception is raised.
- Agent adds `CORSMiddleware` and debugs a "CORS error" in the browser - it is an unhandled `500`, which bypasses the middleware.
- Agent mounts a sub-application with its own `lifespan` - the child's startup never runs.
- Agent returns a model instance it modified after creation - field constraints are not re-checked (`200` with invalid values), but `after` and `wrap` model validators run again.
- Agent mutates fields in a `model_validator(mode="after")` of a model that handlers return - returned instances get the change twice.
- Agent sets `default_response_class=ORJSONResponse` for speed - deprecated; it skips Pydantic's JSON serializer, and integers beyond 64 bits become `500`.
- Agent injects a `scope="function"` session into a generator endpoint - it is committed and closed before the body runs; writes that rely on that commit are lost, and the connection (with SQLite, the write lock) is held until garbage collection.
- Agent serves a single-page-app build that contains a `404.html` with `app.frontend()` - deep links answer `404`; pass `fallback="index.html"`.
- Agent tests `app.frontend()` only under `fastapi dev` - a missing build directory only warns there, and the deployed app fails at import.
- Agent sets the threadpool size at import time - `NoEventLoopError`; set `total_tokens` in `lifespan`.
- Agent sets a cookie on the injected `Response` and returns a `JSONResponse` - the cookie is dropped.
- Agent mutates a list or dict yielded by `lifespan` through `request.state` - the change is shared by all requests.
- Agent uses `asyncio.run()` in a `def` handler to reach async code - it runs on another loop; loop-bound clients and engines fail intermittently, later also in `async def` handlers. Use `anyio.from_thread.run`.
- Agent passes `raise_sync_error=False` to `asyncer.syncify` to silence an error - the coroutine runs on a new loop, like `asyncio.run()`.
- Agent wraps the app in `CORSMiddleware(app, ...)` and sets `dependency_overrides` on the wrapper - the wrapper has no such attribute; use the inner app.
- Agent keeps state in module globals or `app.state` and deploys with several workers - each process has its own copy.
- Agent adds `from __future__ import annotations` to a module with locally defined models or dependencies - body and dependencies become query parameters; startup succeeds.
- Agent defines a model below the handler that uses it - the parameter becomes a query parameter (`422`), also on Python 3.14.
- Agent returns `JSONResponse(...)` from a handler with a response model - nothing is filtered or validated.
- Agent reads a module-level `settings` object in handlers - `dependency_overrides` cannot replace it in tests.

## Official sources

- [FastAPI: Lifespan events](https://fastapi.tiangolo.com/advanced/events/)
- [FastAPI: Dependencies with yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)
- [FastAPI: Concurrency and async / await](https://fastapi.tiangolo.com/async/)
- [Starlette: Middleware](https://www.starlette.io/middleware/)
- [PEP 649: Deferred evaluation of annotations](https://peps.python.org/pep-0649/)
