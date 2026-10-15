---
name: python-fastapi
description: >
  Conventions and pitfalls for Python + FastAPI backends (Pydantic v2, SQLAlchemy 2 async, pytest).
  Use when writing, reviewing, refactoring, or debugging FastAPI code: lifespan, Depends and yield
  dependencies, routing, request and response models, def vs async def, middleware, Pydantic
  validators and settings, SQLAlchemy AsyncSession, transactions, MissingGreenlet, pagination,
  Alembic migrations, asyncio tasks, cancellation and timeouts, exception handlers, streaming,
  generator endpoints and JSON Lines, SSE, WebSockets, background jobs, httpx and retries, JWT auth,
  CORS, webhooks, SSRF, logging, metrics, tracing, health checks, Kafka (aiokafka), Redis and arq,
  tests (pytest-asyncio, TestClient, AsyncClient, DB fixtures), pyproject, uv, ruff, mypy, uvicorn
  and fastapi run. Also use when FastAPI "silently does the wrong thing" (a write that is not
  committed, a handler that blocks every request, a test that passes while the real server fails).
  Not for Django, Flask, or data-science notebooks.
---

# Python + FastAPI

FastAPI code fails quietly more often than loudly. The framework accepts almost any function
signature, runs sync and async code side by side, and sends the response before default request-scoped
dependency cleanup runs. Most agent mistakes come from code that imports, starts, and passes
direct-call unit tests, but behaves differently once a real request goes through the ASGI stack,
or once the process runs under a real server with more than one worker. This skill lists those
cases. Read the matching reference file before editing that area.

## Target versions

Verified 2026-09-30 by running code on these versions, extended 2026-10-13, 2026-10-14 and 2026-10-15.
Version-bound statements in this skill and its references are tagged `(FastAPI 0.142)` or similar;
when the project upgrades, re-check those first.

| Component | Baseline | Notes |
|---|---|---|
| Python | 3.14 | Lazy annotations (PEP 649); `asyncio.get_event_loop()` no longer creates a loop |
| FastAPI | 0.142.x | Starlette 1.7; `Depends(scope=...)` from 0.121; native OpenTelemetry (`telemetry=`), whose exporter auto-setup needs `FASTAPI_OTEL_AUTO_CONFIGURE=true` from 0.143; fastapi-cli 0.0.32 |
| Pydantic | 2.13.x | pydantic-settings 2.15 |
| SQLAlchemy | 2.1.x async | asyncpg 0.31; `greenlet` only through the `asyncio` extra |
| Server | uvicorn 0.54 | `--workers` spawns, it does not fork |
| HTTP client | httpx 0.28 | Starlette 1.7 prefers `httpx2` (2.13) for `TestClient`; see testing |
| Tests | pytest 9.1, pytest-asyncio 1.4 | anyio 4.15 underneath |
| Auth | PyJWT 2.15, bcrypt 5.0 | passlib 1.7.4 does not work with bcrypt 5 |
| Messaging, cache | aiokafka 0.14, redis 8.1, arq 0.25 | the arq 0.25 worker does not start on Python 3.14; arq 0.28 fixes it but requires `redis<6` |
| Tooling | ruff 0.16, mypy 2.3, uv 0.13 | |
| Where the project uses them | Alembic 1.20, tenacity 9.2, SQLModel 0.0.48, asyncer 0.0.18 | |

The project's own files win over this table. Read `pyproject.toml`, the lock or requirements files,
and the root `AGENTS.md`/`CLAUDE.md` before changing anything version- or convention-related.
Check the installed versions (`pip list`), not the declared ranges.

## Workflow

1. **Read the project's existing patterns first.** Find one existing router, service, model and
   test and follow their style (dependency aliases, error shape, settings access, test client).
   Consistency with the codebase beats this skill's defaults.
   FastAPI ships its own agent skill inside the package (`fastapi/.agents/skills/fastapi/`, from
   0.133.1), matched to the installed version; `python -c "import fastapi, pathlib;
   print(pathlib.Path(fastapi.__file__).with_name('.agents'))"` prints where it is. Use it for
   current API shapes and style. This
   skill adds what fails silently; where the two differ on behavior (`fastapi run` for a service
   that streams, `def` as the default for dependencies), follow the measured statement here.
2. **Open the relevant reference** from the table below before writing code in that area.
3. **Verify through the ASGI stack, not around it.** Dependency resolution, response filtering,
   parameter sources, and cleanup order are invisible to tests that call the handler function
   directly. Prove a change with a request through a test client.
4. **Know what the in-process test clients hide.** They re-raise server exceptions, buffer streams,
   run background tasks before returning, ignore timeouts and do not enforce `Content-Length`.
   For shutdown, streaming, disconnects, timeouts and anything about workers, run a real server.
5. Run the project's linter, type checker and tests before reporting completion.

When **diagnosing** (unexpected `422`, a value that is not persisted, a hanging service, startup
state that is missing, flaky tests), gather evidence before editing: the full traceback from the
server log, the exact request, the installed versions, and whether the code runs on the event loop
or in a worker thread. To find what blocks the loop, run the server with `PYTHONASYNCIODEBUG=1`:
asyncio logs each step that holds the loop longer than 100 ms and its duration, under the stdlib
loop and uvloop alike. The task it names is uvicorn's request cycle, not the route, so match the
time against the access log. A `dictConfig` with `disable_existing_loggers=True` silences it unless
the config lists the `asyncio` logger. Report the broken mechanism, the concrete reason, the minimal
fix, and how you verified it. Do not add `try/except`, retries, or `def` in place of `async def`
just to make a symptom disappear.

## Always-on rules

- Annotate every function completely: each parameter and the return type, `-> None` included, in
  handlers, dependencies, private helpers, tests and fixtures alike. Give containers their type
  arguments (`list[str]`, not `list`). Never leave an annotation out because it is "obvious".
- Declare dependencies and parameters with `Annotated[...]`; give reused dependencies a module-level
  alias.
- Create clients, engines, pools, producers and consumers once in `lifespan` and close them there.
  No `@app.on_event`, nothing loop-bound at import time.
- `async def` handlers call only awaitable I/O. Blocking calls go to a `def` handler or the
  threadpool; CPU-bound work goes to another process.
- Finish the commit before sending a success response: in the handler/service, or in a
  `scope="function"` dependency's exit code. Default request-scoped exit code is cleanup only.
- Separate request and response models. Every handler declares its response type; ORM objects are
  never the response model.
- Read configuration through a dependency, not from a module-level object.
- No process-local state for anything that must be shared between workers.
- Every task started with `asyncio.create_task` has an owner that keeps the reference, observes
  its failure, and cancels it at shutdown.
- Every network client has explicit timeouts; every cache key has a TTL; every message consumer
  and job is idempotent.

## Reference routing

| Task touches... | Read |
|---|---|
| App factory, `lifespan`, `Depends` and `yield` dependencies, route order and trailing slashes, router prefixes, `app.frontend()`, response filtering and returned instances, `ORJSONResponse`, `def` vs `async def`, threadpool size, calling async code from `def`, middleware, context variables, annotations | [reference/fastapi-basics.md](reference/fastapi-basics.md) |
| Pydantic v2 models, validators, coercion and strict mode, SQLModel table models, PATCH with `exclude_unset`, aliases, serialization, NaN, shared serializers, request body shapes, `BaseSettings`, environment variables, `NoDecode`, URL settings | [reference/pydantic-models.md](reference/pydantic-models.md) |
| Async engine and session, commit and rollback, savepoints, connection pool, batch jobs and per-item savepoints, concurrent queries, relationship loading, pagination, `MissingGreenlet`, server defaults and `onupdate`, `Enum`/`JSONB`/datetime columns, Alembic migrations and autogenerate | [reference/sqlalchemy-async.md](reference/sqlalchemy-async.md) |
| Background tasks and task ownership, cancellation, timeouts, `gather` vs `TaskGroup`, bounding fan-out, `to_thread`, executors and context variables, client disconnects, shutdown, Python 3.14 loop API | [reference/asyncio-concurrency.md](reference/asyncio-concurrency.md) |
| Exception handlers and matching, error body shape, `422` input echo, status codes without bodies, error headers | [reference/web-errors.md](reference/web-errors.md) |
| `StreamingResponse`, generator endpoints and JSON Lines, Server-Sent Events, WebSockets and disconnect cleanup, `BackgroundTasks`, long-running jobs (`202` + status endpoint, enqueue after commit) | [reference/streaming-background.md](reference/streaming-background.md) |
| Calling other services with `httpx`: client lifecycle, cookie jar, timeouts (per read, pool), exception hierarchy, retries and tenacity, redirects, streaming pass-through | [reference/http-clients.md](reference/http-clients.md) |
| Bearer tokens and JWT verification, FastAPI security schemes, scopes and authorization, password hashing (bcrypt 5, passlib), CORS and CSRF, proxy headers and client IP, webhook signatures and dedupe, SSRF and user-supplied URLs | [reference/security.md](reference/security.md) |
| Logging configuration and uvicorn loggers, structlog context, Prometheus labels, where to measure, multi-worker registries, OpenTelemetry (native and contrib, 0.143 auto-setup), health and readiness endpoints and their status codes and timeouts | [reference/config-observability.md](reference/config-observability.md) |
| Kafka with `aiokafka`: producer lifecycle and `send` futures, idempotence, consumer groups and offsets, commits and redelivery, heartbeats and blocking, poison messages, transactional outbox | [reference/kafka-aiokafka.md](reference/kafka-aiokafka.md) |
| Redis with `redis.asyncio`: client defaults, timeouts and retries, bytes vs str, TTL pitfalls, locks, pipelines, rate limits and failing closed; job queues (`arq`) | [reference/redis-cache-queues.md](reference/redis-cache-queues.md) |
| pytest-asyncio modes and loop scopes, `TestClient` vs `AsyncClient`, lifespan in tests, `dependency_overrides`, database fixtures with rollback, what to assert; framework-free pytest and mock pitfalls are in python-style | [reference/testing.md](reference/testing.md) |
| `pyproject.toml`, extras and dependency groups, lock files and uv (`--locked`, `--frozen`, `uv run`), ruff (`ASYNC`, `FAST`, `RUF006`), mypy with the pydantic plugin, uvicorn workers and proxy flags, `fastapi run`, container basics | [reference/packaging-tooling.md](reference/packaging-tooling.md) |

## Gotchas

These are the failures that start fine and pass direct-call unit tests. Each reference file has its
own, longer list.

- Agent commits after `yield` in a default request-scoped session dependency - the response is sent
  first, so a failed commit still returns `200`.
  See [fastapi-basics](reference/fastapi-basics.md#dependencies-with-yield).
- Agent adds `lifespan` next to existing `@app.on_event` handlers - those handlers silently stop
  running.
- Agent calls blocking code (`requests`, `time.sleep`, sync drivers, password hashing) in an
  `async def` handler - every request of the process waits.
- Agent calls an `async def` function without `await` - nothing runs and nothing is raised.
- Agent declares a list parameter without `Query()` - it becomes a request body and the query string
  is ignored.
- Agent adds `from __future__ import annotations` to a module with locally defined models - they
  become query parameters and the application still starts.
- Agent sets `docs_url=None` for production - `/redoc` and `/openapi.json` stay public; use
  `openapi_url=None`.
- Agent returns an updated ORM entity with an `onupdate=func.now()` column - the commit succeeded,
  the response is `500`. See [sqlalchemy-async](reference/sqlalchemy-async.md#server-generated-values).
- Agent puts `ConfigDict(strict=True)` on a request model with `Decimal`, `UUID` or `datetime`
  fields - every request is rejected with `422`.
- Agent keeps the default `422` body on an endpoint that receives credentials - a missing sibling
  field echoes the password back. See [web-errors](reference/web-errors.md#validation-errors).
- Agent starts work with `asyncio.create_task` and drops the reference - failures are unobserved,
  and under SIGTERM the task vanishes without `finally`.
- Agent returns a `StreamingResponse` (or an sse-starlette response) over an endless generator that
  never awaits - after one client disconnects the event loop spins and the service stops answering.
- Agent writes a generator endpoint (a handler that yields) without a `response_class` - the bytes
  are sent as JSON Lines, or every request fails with `500` when the app or router sets a
  `default_response_class`; an `HTTPException` before the first `yield` arrives as `200` with an
  empty body. See [streaming-background](reference/streaming-background.md#generator-endpoints).
- Agent serves `fastapi.sse` or returned `StreamingResponse` endpoints through `fastapi run` - on
  SIGTERM it waits for each open stream to end, for an endless one until SIGKILL; it has no
  `--timeout-graceful-shutdown`. Start uvicorn directly.
- Agent retries httpx calls on `ConnectionError`, `TimeoutError` or `OSError` (as popular guides
  suggest) - httpx exceptions derive from none of them; nothing is retried.
  See [http-clients](reference/http-clients.md#retries).
- Agent sets `timeout=10` on an httpx call to bound it - the timeout is per read; a dripping
  response runs as long as it likes.
- Agent derives the client IP with `--forwarded-allow-ips '*'` or the wrong hop of
  `X-Forwarded-For` - each client picks its own address and its own rate-limit bucket.
- Agent verifies a webhook signature over the parsed model, or records the event id in its own
  commit before the effect - signatures never match, or a failed event is never retried.
- Agent checks a user-supplied URL's host and then lets httpx resolve it again, or sends the pinned
  request on a shared client - DNS rebinding reaches internal addresses, or another hostname rides
  the first one's TLS connection unchecked.
  See [security](reference/security.md#server-side-request-forgery).
- Agent lets a database or Redis error escape a readiness check or an auth rate limiter - `500`
  after a minute, or no answer at all from a stalled database, instead of a fast `503`; or unlimited
  logins when it fails open.
- Agent combines `allow_origins=["*"]` with `allow_credentials=True` - any origin gets credentialed
  access; nothing rejects it.
- Agent points Alembic's `target_metadata` at `Base.metadata` without importing the model modules -
  autogenerate writes a migration that drops every table.
  See [sqlalchemy-async](reference/sqlalchemy-async.md#migrations-alembic).
- Agent uses a session- or module-scoped engine with pytest-asyncio's default loop scopes -
  intermittent asyncpg errors that do not mention event loops.
- Agent tests only by calling handler functions, or trusts a green in-process test for behavior
  that depends on the server - dependency, validation, streaming and shutdown defects never appear.
- Agent proves task cleanup through `TestClient` - the client cancels leftover tasks itself when its
  loop closes, so a missing `owner.close()` stays invisible. See [testing](reference/testing.md#gotchas).

## Maintaining this skill

When bumping the target versions: update the table above, then grep this directory for version tags
(`FastAPI 0.`, `Starlette 1.`, `Pydantic 2.`, `SQLAlchemy 2.`, `Python 3.`, `pytest-asyncio`,
`PyJWT`, `bcrypt`, `httpx2`, `aiokafka`, `redis 8`, `arq`, `ruff 0.`, `uvicorn 0.`, `fastapi-cli`,
`uv 0.`, `Alembic`, `alembic`, `tenacity`, `SQLModel`, `sqlmodel`, `asyncer`) and re-verify
each tagged statement by running it.
