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
  `True`), `exclude`, and `tracer_provider`/`meter_provider`/`logger_provider` to use explicit
  providers instead of the globals. `auto_configure: False` stops the automatic exporter
  set-up; `OTEL_SDK_DISABLED=true` disables the SDK entirely, your own provider included; `telemetry={"tracing": False}` turns request spans off.
  `auto_configure` adds its OTLP processor **on top of** whatever the provider already has, so a
  process whose provider is configured elsewhere exports every span twice while
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set; pass `auto_configure: False` there.
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
- Agent configures its own exporter and leaves `OTEL_EXPORTER_OTLP_ENDPOINT` set - spans are exported twice.
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

## Official sources

- [uvicorn: Settings (logging)](https://uvicorn.dev/settings/#logging)
- [Python: logging.config](https://docs.python.org/3.14/library/logging.config.html)
- [structlog: Context variables](https://www.structlog.org/en/stable/contextvars.html)
- [prometheus-client: Multiprocess mode](https://prometheus.github.io/client_python/multiprocess/)
- [OpenTelemetry FastAPI instrumentation](https://opentelemetry-python-contrib.readthedocs.io/en/latest/instrumentation/fastapi/fastapi.html)
