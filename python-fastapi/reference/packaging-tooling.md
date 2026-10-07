# Project layout, dependencies, linting, type checking, serving

Applies to Python 3.14, ruff 0.16, mypy 2.3, uvicorn 0.54. Follow the project's existing tooling
(`pip` + `requirements.txt`, `uv`, hatch, ...) rather than introducing another; this file lists
what each tool silently does or does not check.

Contents: [Dependencies](#dependencies) · [Linting with ruff](#linting-with-ruff) ·
[Type checking with mypy](#type-checking-with-mypy) · [Serving](#serving) · [Gotchas](#gotchas)

## Dependencies

- Declare the extras you rely on: `sqlalchemy[asyncio]` (without it, importing
  `sqlalchemy.ext.asyncio` fails), `pyjwt[crypto]` for RS256/ES256, `uvicorn[standard]` for
  `httptools`/`uvloop`/`websockets`, `httpx[http2]` for HTTP/2, `pydantic[email]` for `EmailStr`.
  A missing extra fails at first use, not at install, and not always loudly: without
  `pyjwt[crypto]`, `jwt.decode(token, algorithms=["RS256"])` raises `InvalidAlgorithmError`, a
  subclass of `InvalidTokenError`, so the usual `except InvalidTokenError: raise 401` turns a
  missing package into "every token is invalid".
- Pin what you deploy. Ranges in `pyproject.toml` describe compatibility; the deployed set comes
  from a lock file (`uv.lock`, `requirements.txt` from `pip-compile`/`pip freeze`) and is installed
  with `--require-hashes` or `--frozen`/`--locked` where the tool supports it. A `Dockerfile` that
  runs `pip install fastapi` builds a different application every week.
- `requires-python = ">=3.14"` in `pyproject.toml` is enforced only when the project itself is
  installed (`pip install .`); `pip install -r requirements.txt` never reads it, and pip ignores
  `.python-version` (uv uses it to pick the interpreter). Set both, and pin the interpreter in
  the image.
- FastAPI's `standard` extra installs `httpx` (`<1.0`, not `httpx2`), `python-multipart`,
  `email-validator`, `uvicorn[standard]`, `pydantic-settings`, `pydantic-extra-types`, the OpenTelemetry SDK and OTLP
  exporter, `jinja2`, and the `fastapi` CLI (`standard-no-fastapi-cloud-cli` leaves the cloud
  CLI out). Without `python-multipart`, declaring `Form()`, `File()` or `UploadFile` raises
  `RuntimeError: Form data requires "python-multipart"` at route decoration, at import time.
  `uvicorn` without `[standard]` starts without complaint, but a WebSocket upgrade is served as
  plain HTTP with only a warning (`No supported WebSocket library detected`).
- `pip check` reports broken requirement graphs; run it in CI after install.

## Linting with ruff

```toml
[tool.ruff]
line-length = 100
target-version = "py314"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "ANN", "ASYNC", "FAST", "RUF006", "T20"]
```

- `ANN` enforces the rule that no annotation is left out: every parameter (`ANN001`), `*args` and
  `**kwargs` (`ANN002`, `ANN003`), and every return type including `-> None` on `__init__`
  (`ANN201`-`ANN206`), in tests and fixtures too. It also flags `Any` (`ANN401`); keep that on and
  silence it per line where `Any` is really meant. `ANN` and mypy overlap but neither replaces the
  other (ruff 0.16, mypy 2.3): mypy `strict` accepts `def __init__(self, x: int):` without
  `-> None`, and ruff accepts bare `list` and `dict`, which mypy rejects as missing type
  arguments. Run both.

- Put `select` under `[tool.ruff.lint]`. Top-level `select` still works but ruff prints a
  deprecation warning on every run, and the two locations do not merge.
- `ASYNC` catches blocking calls inside `async def` (`time.sleep`, `open`, `subprocess`,
  `requests`) but only in `async def`: a `def` route with the same call is not a finding, and
  neither is a blocking call hidden in a helper function.
- `FAST002` flags `Depends()`/`Query()`-style defaults declared without `Annotated`; `FAST003` flags a path parameter
  missing from the handler signature (the route works and the value is silently ignored).
  `FAST001` (redundant `response_model`) does **not** fire under `target-version = "py314"` or
  with `from __future__ import annotations` in ruff 0.16; do not rely on it.
- `RUF006` flags `asyncio.create_task(...)` whose result is discarded
  ([asyncio-concurrency](asyncio-concurrency.md#tasks-and-ownership)).
- ruff does not know about per-request `httpx.AsyncClient()`, sessions shared across tasks,
  commits after `yield`, or missing `Query()` on list parameters. Those need review or tests.

## Type checking with mypy

```toml
[tool.mypy]
python_version = "3.14"
strict = true
plugins = ["pydantic.mypy"]

[tool.pydantic-mypy]
init_typed = true
init_forbid_extra = true
warn_required_dynamic_aliases = true
```

- Without the plugin, mypy already checks model constructors through pydantic's
  `dataclass_transform` (`Item(name=1)` and a misspelled keyword are both errors). **Enabling
  `pydantic.mypy` without `init_typed` and `init_forbid_extra` is weaker than no plugin**: the
  generated `__init__` takes `Any`, so `Item(name=1)` passes and a misspelled keyword is reported
  only as a missing argument. Set both options whenever the plugin is on.
- `strict = true` requires return annotations on every `def`, including route handlers. A handler
  with neither a return annotation nor `response_model=` has no response model at all: nothing
  is filtered or validated and the OpenAPI schema for the response is empty (`{}`). Annotate
  return types with the response model; mypy then also checks what the handler returns.
- mypy does not check `Depends()` at all: `Depends(...)` returns `Any` and `Annotated` metadata
  is ignored, so a dependency returning `str | None` injected into a `str` parameter passes
  `--strict`. Only direct calls of the dependency function are type-checked.
- Import errors inside functions (`from missing import x` in a function body) compile, pass
  `py_compile`, and survive importing the module; they fail only when the function is first
  called. mypy reports them.

## Serving

- `uvicorn --workers N` **spawns** fresh interpreters: each worker imports the application
  itself, so import-time state is duplicated, not shared. gunicorn with `--preload` forks after
  import and does share import-time engines and clients with the children. Either way, create
  them in `lifespan`. `--reload` disables `--workers` (a warning is logged and one worker runs).
- With several workers there is no shared memory: rate limits, caches, job tables and metrics
  registries are per process ([config-observability](config-observability.md#metrics)).
- `--proxy-headers` is on by default but trusts `X-Forwarded-*` only from
  `--forwarded-allow-ips` (default `127.0.0.1,::1`). In a container behind a load balancer the
  proxy's address is not loopback, so `request.client.host` is the proxy and
  `request.url.scheme` is `http` ([security](security.md#other-headers-and-hosts)).
- `--timeout-graceful-shutdown` bounds in-flight requests and background tasks at shutdown, not
  the `lifespan` shutdown code, which uvicorn awaits without any limit afterwards; without the
  flag uvicorn waits for requests and tasks without limit too, and Kubernetes then sends SIGKILL after
  `terminationGracePeriodSeconds` ([asyncio-concurrency](asyncio-concurrency.md#tasks-and-ownership)).
- `--limit-concurrency N` returns `503` beyond the limit instead of queueing (it counts open
  connections, so the effective bound is `N - 1`); without it, load queues on the event loop and
  the threadpool with no back-pressure.
- Containers: run as a non-root user; set `PYTHONUNBUFFERED=1`, or buffered stdout output
  (`print`, `sys.stdout.write`) is lost on SIGKILL and `os._exit` when stdout is a pipe
  (`logging.StreamHandler` flushes after every record and is not affected; stderr is line
  buffered, so only a partial last line is lost); and make the stop signal reach Python: a shell-form `CMD` can
  leave the shell as the parent process, always with a pipeline, and with `&&`, `;` or `export`
  first on shells that do not exec the last command (bash 3.2 does not; dash and bash 5.3 do).
  The shell does not forward SIGTERM, so uvicorn never sees it and is killed when the grace
  period ends. Use the `exec` form, or `exec uvicorn ...` as the last command.

## Gotchas

- Agent installs `sqlalchemy` without `[asyncio]` - `ImportError`; `pyjwt` without `[crypto]` - every RS256 token is rejected as invalid.
- Agent adds `Form()`/`File()` parameters without `python-multipart` - startup error.
- Agent puts `select` at the top level of `[tool.ruff]` - deprecation warning on every run; entries do not merge with `lint.select`.
- Agent trusts `ASYNC` rules to find blocking calls - only direct calls inside `async def` are found.
- Agent relies on `FAST001` - it is silent on Python 3.14 targets.
- Agent trusts mypy to type-check `Depends()` results - it does not.
- Agent enables the pydantic mypy plugin without `init_typed` and `init_forbid_extra` - checking gets weaker than without the plugin.
- Agent leaves a route handler without a return annotation and without `response_model` - no filtering, no validation, empty response schema.
- Agent creates engines or clients at import time - duplicated per spawned uvicorn worker, shared across gunicorn `--preload` forks.
- Agent uses in-process caches or rate limits with `--workers` - per-process state.
- Agent deploys behind a load balancer with default `--forwarded-allow-ips` - client address and scheme are wrong.
- Agent writes a shell-form `CMD` with a pipeline or without `exec` - depending on the shell, SIGTERM goes to the shell, not to uvicorn.
- Agent omits `PYTHONUNBUFFERED=1` and logs with `print` - the last lines before a kill are missing.
- Agent runs uvicorn without `[standard]` and adds WebSocket routes - upgrades are answered as plain HTTP with a warning.
- Agent puts `select` at both levels of the ruff config - `lint.select` wins and the top-level entries are dropped.
- Agent installs from ranges in the image build - a different dependency set per build.

## Official sources

- [Python Packaging User Guide: pyproject.toml](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/)
- [ruff: Settings](https://docs.astral.sh/ruff/settings/)
- [ruff: FastAPI rules](https://docs.astral.sh/ruff/rules/#fastapi-fast)
- [Pydantic: mypy plugin](https://docs.pydantic.dev/latest/integrations/mypy/)
- [uvicorn: Settings](https://uvicorn.dev/settings/)
- [uvicorn: Deployment](https://uvicorn.dev/deployment/)
