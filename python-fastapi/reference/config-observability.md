# Logging, metrics, tracing, health

Applies to uvicorn 0.54, structlog 26, prometheus-client 0.26, OpenTelemetry SDK 1.45 with
`opentelemetry-instrumentation-fastapi` 0.66b0. Settings themselves are in
[pydantic-models](pydantic-models.md#settings).

Contents: [Logging](#logging) · [Metrics](#metrics) · [Tracing](#tracing) ·
[Health and readiness](#health-and-readiness) · [Gotchas](#gotchas)

## Logging

- **Without a logging configuration, the application's `INFO` and `DEBUG` records are dropped.**
  uvicorn configures only its own loggers (`uvicorn`, `uvicorn.error`, `uvicorn.access`); the
  root logger has no handler, so `logging.getLogger("app").info(...)` prints nothing and
  `WARNING`+ comes out unformatted through Python's last-resort handler. Configure logging in the
  application (a `logging.config.dictConfig` at import time or in the factory).
- `uvicorn.access` has its own handler and `propagate=False`: a JSON formatter on the root logger
  does not touch access logs, so the output mixes JSON lines with uvicorn's text lines. Either
  reconfigure `uvicorn.access` (its handler and formatter) in the same `dictConfig`, or pass
  `--log-config` to uvicorn, or disable access logs (`--no-access-log`) and log requests from your
  own middleware.
- `--log-level` applies to uvicorn's loggers only; it neither raises nor lowers the level of
  application loggers. With the `dictConfig` block below loaded under `uvicorn module:app` it has
  no effect at all: the block runs after uvicorn set its levels and resets them. Set uvicorn's
  levels in `LOGGING`.
- `logging.basicConfig(...)` is a no-op when any handler is already attached to the root logger
  (uvicorn attaches its handlers to its own loggers, not to root, so after uvicorn alone it still
  works; after another library or an earlier `dictConfig` it silently does nothing). Use
  `force=True` or `dictConfig`.

```python
import logging.config

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "pythonjsonlogger.json.JsonFormatter", "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
    "handlers": {"stdout": {"class": "logging.StreamHandler", "stream": "ext://sys.stdout", "formatter": "json"}},
    "root": {"level": "INFO", "handlers": ["stdout"]},
    "loggers": {
        "uvicorn": {"handlers": ["stdout"], "level": "INFO", "propagate": False},
        "uvicorn.access": {"handlers": ["stdout"], "level": "INFO", "propagate": False},
    },
}


def configure_logging() -> None:
    logging.config.dictConfig(LOGGING)
```

- Configure the `uvicorn` logger as well as `uvicorn.access`: `uvicorn.error` propagates to
  `uvicorn`, which keeps uvicorn's text handler otherwise ("Started server process" stays text).
- With `uvicorn.run(app)` from a script, uvicorn applies its own default `log_config` **after**
  your module-level `dictConfig` and resets the uvicorn loggers to text. Pass
  `uvicorn.run(app, log_config=None)`; calling `configure_logging()` inside `lifespan` also works
  but leaves the first two start-up lines in text. With the `uvicorn module:app` command line the
  order is the other way round and the block works.
- With `--workers` the supervisor process never imports the application, so its own lines
  ("Started parent process", ...) stay text; only `--log-config` reaches them.
- `disable_existing_loggers` defaults to `True` in `dictConfig`: loggers created by libraries
  before the call are silenced. Set it to `False`.
- structlog: `structlog.contextvars.bind_contextvars(request_id=...)` in a middleware or an
  `async def` dependency makes the value appear on every log line of the request, provided the
  processor chain contains `structlog.contextvars.merge_contextvars` (a custom chain without it
  drops the bound values silently), including lines
  logged from `run_in_threadpool` and `def` handlers (the context is copied into the thread). A
  value bound in the handler is not visible in a `BaseHTTPMiddleware` after `call_next`. uvicorn
  runs every request in a fresh task with its own context, so nothing leaks between requests
  there; in `ASGITransport` tests, or anywhere the app is awaited inside one long-lived task,
  bound values **do** leak into the next request. Clear at the start of each request
  (`clear_contextvars()`). Values bound inside a `def` handler or dependency are not visible
  afterwards ([fastapi-basics](fastapi-basics.md#context-variables-and-middleware)).
- Never log request bodies or headers wholesale: `Authorization`, cookies, and the `422` echo of
  request input ([web-errors](web-errors.md#validation-errors)) end up in the log.

## Metrics

- Label values must be bounded. `request.url.path` as a label (`/items/1`, `/items/2`, ...)
  creates one series per id. Use the matched route template: `request.scope["route"].path`
  gives `/items/{item_id}`. Three limits: the `route` key exists only **after** routing (in a
  middleware, read it after `call_next`, with `scope.get("route")`; it stays absent for requests
  that match no route); inside a mounted app it is the inner path without the mount prefix
  (`scope["root_path"]`); and a prefix given to `include_router(router, prefix="/v1")` is **not**
  part of it (FastAPI 0.142), so `/v1/items/1` and `/v2/items/2` are both recorded as
  `/items/{item_id}`. A prefix declared on `APIRouter(prefix=...)` is included only for
  routes declared directly on that router; the prefix of a parent router that aggregates
  sub-routers with `include_router` is lost as well. Do not rely on `route.path` for versioned
  APIs; take the template from the native telemetry's `http.route`, which carries every prefix.
- Record request status in a pure ASGI middleware, not in a decorator around the endpoint. Such a
  decorator saw an `HTTPException(404)` only as an exception (recorded `500` while the client got
  `404`) and never ran for a `422`, because validation happens before the endpoint. Reading
  `http.response.start` in a middleware gives the real status, except for an unhandled exception:
  that `500` is built by Starlette's `ServerErrorMiddleware` outside all user middleware. Count an
  exception that escapes `await self.app(...)` as `500` only when no `http.response.start` was sent.
  After the start the client already has its status, so keep it, and count the response as
  incomplete only when no final body message (`more_body` false) was sent: a stream that fails
  midway left a cut body, while a failing `BackgroundTasks` entry raised after a complete `200`.
- **With several workers, each process has its own registry.** `/metrics` answers with whichever
  worker took the scrape (observed values alternating between workers), so every counter looks
  like it goes backwards. Use `prometheus_client`'s multiprocess mode (`PROMETHEUS_MULTIPROC_DIR`
  and `multiprocess.MultiProcessCollector`) or run one process per container and scrape each.
  `PROMETHEUS_MULTIPROC_DIR` must be set **before** `prometheus_client` is imported; set later,
  the collector returns an empty body without an error. Serve `/metrics` from a **separate**
  `CollectorRegistry()` that holds only the `MultiProcessCollector`; adding the collector to the
  default registry that also holds the metric objects duplicates every series or fails with
  `Duplicated timeseries`.
- A `Histogram` with default buckets is 18 series per label set (15 buckets, `_count`, `_sum`,
  `_created`); keep label sets small.
- `Counter.labels(...)` creates the series on first use. Series for routes that were never hit
  do not exist, so a "rate of errors" query returns nothing rather than zero; initialise the
  label sets you alert on at startup.

## Tracing

- **FastAPI 0.142 traces natively.** As soon as a real `TracerProvider` is set, the application
  emits spans (`GET /path`, `fastapi.dependencies`, `fastapi.endpoint`, `fastapi.serialization`)
  without any instrumentation package. With only `OTEL_EXPORTER_OTLP_ENDPOINT` set, FastAPI
  creates a provider and a `BatchSpanProcessor(OTLPSpanExporter)` (and an OTLP metric reader,
  also when tracing is off) at lifespan startup, per
  worker, flushes it at lifespan shutdown and registers an `atexit` flush. It is configured
  through `FastAPI(telemetry={...})`, a dict with the keys `tracing`, `metrics`, `logs`,
  `operation_spans`, `auto_configure` (read `OTEL_EXPORTER_OTLP_*` and add exporters, default
  `True` on 0.142, see the next point), `exclude`, and
  `tracer_provider`/`meter_provider`/`logger_provider` to use explicit providers instead of the globals. `auto_configure: False` stops the automatic exporter
  set-up; `OTEL_SDK_DISABLED=true` disables the SDK entirely, your own provider included; `telemetry={"tracing": False}` turns request spans off.
  `auto_configure` adds its OTLP processor **on top of** whatever the provider already has, so a
  process whose provider is configured elsewhere exports every span twice while
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set; pass `auto_configure: False` there.
- **From FastAPI 0.143 the automatic exporter set-up is opt-in.** `auto_configure` defaults to
  `False` unless `FASTAPI_OTEL_AUTO_CONFIGURE=true` is set. With only `OTEL_EXPORTER_OTLP_ENDPOINT` set,
  0.143.0 exported nothing and logged nothing, where 0.142.4 exported traces and metrics. With the
  variable set to `true` (any case) it exported again; `1` exported nothing. Passing
  `telemetry={"auto_configure": True}` enabled it without the variable. The double export of the
  previous point then also requires one of the two.
- `opentelemetry-instrumentation-fastapi` (`FastAPIInstrumentor.instrument_app`) is optional on
  0.142+; native tracing switches itself off when the contrib middleware is present. Where it is
  used, call it in the factory before the application handles its first event: called from
  inside `lifespan` it **silently does nothing** (the middleware stack is already built), and the
  spans that still appear come from native tracing, not from it.
- Spans exist only when a `TracerProvider` is set. Without it everything is non-recording and
  nothing is exported: no error, no output.
- `SimpleSpanProcessor` exports synchronously on span end; in a request that is a blocking
  network call on the event loop. Use `BatchSpanProcessor` in services.
- uvicorn `--workers` spawns each worker, so a module-level `BatchSpanProcessor` is created per
  worker and exports from every pid; SDK 1.45 also survives a gunicorn `--preload` fork.
- Flush in `lifespan` (`provider.shutdown()` or `force_flush()` after the `yield`). The SDK's
  `atexit` flush runs on Ctrl+C in a single process, but **not on SIGTERM** (uvicorn re-raises the
  signal after the graceful shutdown), so with `--workers` and in containers the last batch is
  lost without it.

## Health and readiness

- Separate liveness (`/livez`: the process answers) from readiness (`/readyz`: dependencies
  reachable). A readiness check that queries the database on every probe adds load and, under
  a database incident, makes every replica unready at once, so nothing serves even the endpoints
  that do not need the database. Check cheaply (a pooled `SELECT 1` with a short timeout) and
  consider degraded rather than unready.
- A `def` health handler waits in the threadpool queue behind slow requests; make it `async def`
  and dependency-free so it reflects the process, not the pool.
- A database error that escapes a health handler is a `500`, not a `503`, and it arrives when the
  driver gives up. Measured under uvicorn with a `SELECT 1` through the session dependency: closed
  port `500` at once, black-holed host `500` after 60 s (asyncpg 0.31's connect timeout), exhausted
  pool `500` after 30 s (`pool_timeout`; `pool_size=1, max_overflow=0`; SQLite, and PostgreSQL 17
  at 30.02 s), and a server that accepts the connection and then stops answering: on a pooled
  connection no response at all (300 s against a fake server; until the server resumed against a
  paused PostgreSQL 17), while a new connect to it fails with `500` after asyncpg's 60 s connect
  timeout.
- `asyncio.timeout` around the check does not bound a stall on an established connection, and
  neither do asyncpg's `timeout` and `command_timeout` in `connect_args`: no response in 15 s
  against the fake server and in 60 s against a paused PostgreSQL 17, on both event loops. The
  cancelled check waits in asyncpg's `Connection.close()`, which SQLAlchemy awaits to clean up
  (`timeout=2`) and which first awaits the server's reply to its cancel request (from source); a
  server that does not process the cancel request never answers it. A stalled new connect is
  bounded (`503` at 2.0 s), and so is a live but slow server: with the check's table locked,
  `asyncio.timeout(2)` answered `503` and `command_timeout=2` answered `500` at 2.0-2.1 s, because
  PostgreSQL answers the cancel request (the connection is then closed, not returned to the pool).
  Run the check in a task the app owns and wait on `asyncio.shield(task)`; the timeout then
  cancels the wait, not the check:

```python
import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

DATABASE_URL = "postgresql+asyncpg://app:secret@localhost:5432/app"
CHECK_WINDOW = 5.0  # seconds a running check may be joined: a few probe periods


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[dict[str, object]]:
    engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
    checks: dict[asyncio.Task[bool], float] = {}  # running checks -> start time
    try:
        yield {"engine": engine, "checks": checks}
    finally:
        for task in checks:
            task.cancel()
        await engine.dispose()


app = FastAPI(lifespan=lifespan)


async def database_ready(engine: AsyncEngine) -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError, TimeoutError):
        return False  # raised, it is logged once no probe waits for it
    return True


def current_check(request: Request) -> asyncio.Task[bool] | None:
    checks: dict[asyncio.Task[bool], float] = request.state.checks
    now = asyncio.get_running_loop().time()
    for task, started in checks.items():
        if now - started < CHECK_WINDOW:
            return task  # join a recent check
    if len(checks) > 1:
        return None  # keep at most one stale check, or stuck ones pile up
    task = asyncio.create_task(database_ready(request.state.engine))
    checks[task] = now
    task.add_done_callback(lambda done: checks.pop(done, None))
    return task


@app.get("/readyz")
async def readyz(request: Request, response: Response) -> dict[str, str]:
    task = current_check(request)
    ready = False
    if task is not None:
        with suppress(TimeoutError):
            async with asyncio.timeout(2):
                ready = await asyncio.shield(task)  # a timeout cancels the wait only
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable"}
    return {"status": "ok"}
```

- With this handler the stalled, closed, black-holed and exhausted-pool cases answered `503` within
  2 s on asyncio and uvloop, also to 20 concurrent probes; the pool served the next check, and
  shutdown on SIGTERM took about 0.2 s (1.4-1.6 s with a probe in flight). Measured against a fake
  server that speaks the PostgreSQL handshake and then stays silent, against a paused
  PostgreSQL 17, and against a black-holed address (connects stuck in `SYN_SENT` for 200 s: every
  probe `503` in 2 s, two checks and two sockets held), with the same results. Without the
  handler, a probe in flight against the black-holed host also holds shutdown: SIGTERM took
  59.6 s, until asyncpg's connect timeout ended the request with a `500`.
- Join only a recent check. A joined check has no bound of its own, and one stuck on a dead socket
  ends only when the socket does (asyncpg 0.31 sets no TCP keepalive, from source). Joining any
  running check kept every probe at `503` for 30 s after the database was back (SQLite simulation:
  only the first connect hangs); with the window, a new check started after 5 s and answered
  `200`. Against a server that stays silent the handler held two checks and two connections, not
  one per probe.
- The limit: with two stuck checks no new one starts, and readiness stays `503` until one ends.
  Against a peer that keeps the socket open and never answers (the fake server) that is never:
  two connects that hung through an 8 s outage kept all 37 probes at `503` for 45 s after it
  ended, and only a process restart (a deploy, or one your alerting triggers; the dependency-free
  `/livez` does not fail) answered `200`. A real PostgreSQL 17 ended the stuck checks itself:
  after an 8 s `docker pause` the first probe after unpause was `200`; after the container was
  removed and recreated, `200` came within 0.5 s of it accepting connections; after a healed
  network partition the next probe was `200` (the stuck check ended 0.5-5 s after the heal).
- Do not cancel a stuck check to replace it: after one cancel it waited in SQLAlchemy's shielded
  close, after a second the task ended but the server still saw the connection open a second
  later, and SQLAlchemy logged two tracebacks at `ERROR`.
- Return `False` from the check instead of raising. On Python 3.14 a shielded check that fails
  after its probes stopped waiting is logged at `ERROR` ("exception in shielded future"): once per
  60 s check against a black-holed host; none with the `bool` check.
- A refused asyncpg connection escapes as the builtin `ConnectionRefusedError`, not as a
  SQLAlchemy error, so `except SQLAlchemyError` alone still gives `500`.
- Exclude probes from access logs, metrics and tracing (a filter on the route path), or they
  dominate all three.
- Do not put secrets or version details that identify vulnerable dependencies into the health
  body of a public endpoint.

## Gotchas

- Agent logs at `INFO` from the application without configuring logging - nothing appears.
- Agent adds a JSON formatter on the root logger - access logs stay in uvicorn's text format.
- Agent passes `--log-level debug` to see application debug logs - it changes uvicorn's loggers only.
- Agent calls `logging.basicConfig` after something else configured the root logger - no effect without `force=True`.
- Agent configures logging at module level and starts with `uvicorn.run(app)` - uvicorn's default config overrides it; pass `log_config=None`.
- Agent uses `dictConfig` with the default `disable_existing_loggers` - library loggers go silent.
- Agent binds request context with structlog and never clears it - values leak into later requests in `ASGITransport` tests.
- Agent reads `scope["route"]` in middleware before `call_next`, or for an unmatched path - `KeyError`.
- Agent versions the API with `include_router(prefix="/v1")`, or a parent `APIRouter(prefix="/v1")` that includes sub-routers, and labels metrics with `route.path` - all versions share one series.
- Agent writes a custom structlog processor chain without `merge_contextvars` - bound request ids never appear.
- Agent configures its own exporter and leaves `OTEL_EXPORTER_OTLP_ENDPOINT` set (FastAPI 0.142; from 0.143 only with `FASTAPI_OTEL_AUTO_CONFIGURE=true` or `telemetry={"auto_configure": True}`) - spans are exported twice.
- Agent upgrades to FastAPI 0.143 and relies on `OTEL_EXPORTER_OTLP_ENDPOINT` alone, or sets `FASTAPI_OTEL_AUTO_CONFIGURE=1` - nothing is exported and nothing is logged; set it to `true` or pass `telemetry={"auto_configure": True}`.
- Agent records request metrics in a decorator around the endpoint - `HTTPException` statuses are counted as `500` and `422` responses are never counted; measure in a pure ASGI middleware.
- Agent counts every exception that escapes the metrics middleware as `500` - a stream that fails after its `200` headers is recorded as `500` while the client got `200`.
- Agent sets `PROMETHEUS_MULTIPROC_DIR` in `lifespan` - too late; `/metrics` is empty.
- Agent labels metrics with `request.url.path` - unbounded series.
- Agent runs `--workers 2` with the default registry - metrics alternate between processes.
- Agent alerts on a counter that no request has touched yet - the series does not exist.
- Agent sets a tracer provider on FastAPI 0.142 and also adds `FastAPIInstrumentor` - native tracing turns itself off, so the `fastapi.dependencies`/`fastapi.endpoint`/`fastapi.serialization` spans disappear.
- Agent calls `instrument_app` inside `lifespan` - it does nothing, silently.
- Agent instruments FastAPI without setting a tracer provider - no spans, no error.
- Agent uses `SimpleSpanProcessor` in a service - an export per span on the request path.
- Agent relies on the SDK's `atexit` flush - it does not run on SIGTERM; flush in `lifespan`.
- Agent makes readiness depend on the database - every replica goes unready together.
- Agent writes the health endpoint as a `def` - it queues behind slow threadpool work.
- Agent lets a database error escape a health check - `500` instead of `503`, after 60 s (black-holed host), 30 s (exhausted pool) or never (a pooled connection to a server that stops answering; a new connect to it is `500` after 60 s).
- Agent bounds a readiness query with `asyncio.timeout` or asyncpg's `command_timeout` - a server that stops answering mid-query on an established connection still hangs the check (a live but slow server is bounded: it answers the cancel request); wait on a shielded task the app owns.
- Agent lets every readiness probe join the running check - one check stuck on a dead socket keeps readiness at `503` after the database is back; join only a recent check.
- Agent catches only `SQLAlchemyError` in a readiness check - a refused asyncpg connection is a builtin `ConnectionRefusedError`; still `500`.

## Official sources

- [uvicorn: Settings (logging)](https://uvicorn.dev/settings/#logging)
- [Python: logging.config](https://docs.python.org/3.14/library/logging.config.html)
- [structlog: Context variables](https://www.structlog.org/en/stable/contextvars.html)
- [prometheus-client: Multiprocess mode](https://prometheus.github.io/client_python/multiprocess/)
- [OpenTelemetry FastAPI instrumentation](https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/fastapi/fastapi.html)
