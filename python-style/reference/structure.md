# Naming, modules, errors, logging and tooling

Applies to Python 3.14, ruff 0.16, mypy 2.3. Layout and formatting are the formatter's job
(`ruff format`); this file covers what a formatter cannot decide. The project's existing
conventions win over everything here.

Contents: [Naming](#naming) · [Functions and classes](#functions-and-classes) ·
[Modules and imports](#modules-and-imports) · [Errors](#errors) · [Logging](#logging) ·
[Comments and docstrings](#comments-and-docstrings) · [Tooling](#tooling) · [Gotchas](#gotchas)

## Naming

| Thing | Style | Example |
|---|---|---|
| module, package, function, method, variable | `snake_case` | `order_service.py`, `parse_port` |
| class, exception, type alias, type parameter | `CapWords` | `OrderService`, `ConfigError`, `T` |
| constant | `UPPER_SNAKE` | `MAX_RETRIES` |
| internal to a module or class | leading underscore | `_normalize`, `self._cache` |

- Exception classes end in `Error`. ruff `N818`. Classes, functions, arguments and local variables
  are covered by `N801`-`N806`, module names by `N999`; no ruff rule checks `UPPER_SNAKE`
  constants, so that row is a review item.
- Name things for what they are in the domain, not for their type: `users`, not `user_list`;
  `is_active`, `has_items`, `can_retry` for booleans.
- **Do not shadow builtins**: `id`, `type`, `list`, `dict`, `input`, `filter`, `format`, `hash`,
  `max`, `min`. The builtin is gone for the rest of that scope. ruff `A001`, `A002`.
- **Do not name a module after a standard-library or dependency module** (`random.py`,
  `logging.py`, `queue.py`). Other imports of that name then get your file: `AttributeError:
  module 'random' has no attribute 'randint'` (on Python 3.14 the message suggests renaming the
  file). Modules the interpreter has already loaded at startup, such as `types`, are not
  affected at runtime, but the name is still confusing. ruff `A005` reports the standard-library
  names; nothing reports a dependency name.
- A name with a leading underscore is private to its module or class. Do not import or call it
  from elsewhere, and do not use double leading underscores (name mangling) for privacy.

## Functions and classes

```python
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True, kw_only=True)
class RetryPolicy:
    attempts: int = 3
    backoff_seconds: float = 0.5
    retry_on: tuple[type[Exception], ...] = (TimeoutError,)
    tags: list[str] = field(default_factory=list)


def fetch(url: str, *, policy: RetryPolicy | None = None, verify_tls: bool = True) -> bytes:
    policy = RetryPolicy() if policy is None else policy
    return f"{url} {policy.attempts} {verify_tls}".encode()
```

- Boolean parameters, and option-like parameters of a function you are designing, are
  keyword-only (after `*`). `fetch(url, True, False)` says nothing at the call site. ruff
  `FBT001`-`FBT003` cover the booleans. Do not change the signature of an existing public
  function for this; that breaks its callers.
- One function does one thing and returns one type. A function that returns a value in one
  branch and falls off the end in another returns `None`; with a return annotation mypy reports
  it ([typing](typing.md#annotate-everything)).
- More than about five parameters, or a group of parameters that travels together, is a
  dataclass.
- `@dataclass` for records; `frozen=True` unless mutation is needed, `slots=True` so a misspelled
  attribute assignment fails also on a mutable one, `kw_only=True` when there are more than two
  or three fields. `frozen=True` does not freeze what the fields contain: a `list` field can
  still be appended to.
- A dataclass with `eq=True` (the default) and without `frozen=True` is unhashable (`TypeError`),
  so it cannot be a dict key or a set member. A frozen one is hashable only if every field is:
  `RetryPolicy` above has a `list` field, so `hash(RetryPolicy())` raises as well.
- Plain functions in a module before a class that only groups them. `@staticmethod` is rarely
  needed; `@classmethod` for alternative constructors; `@property` only for cheap, side-effect
  free access.
- Composition and `Protocol` before inheritance. Mark overrides with `@override`.

## Modules and imports

- Absolute imports (`from myapp.orders import service`), one import per line, grouped standard
  library / third party / first party. ruff `I` sorts them. No `from module import *`.
- Imports at the top of the file. An import inside a function is acceptable only to break a
  cycle or to defer a heavy optional dependency, with a comment saying which.
- **No work at import time**: no network calls, file reads, environment parsing with side
  effects, or object construction that needs configuration. Importing a module must be safe in a
  test, a script and a worker alike. Put the work in a function and call it from `main()`.
- Scripts and entry points end with:

```python
def main() -> int:
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- A circular import shows up as `ImportError: cannot import name 'f' from 'a'` or as an
  `AttributeError` on a partially initialised module. Fix the structure (move the shared piece
  to a third module); do not paper over it with function-level imports everywhere.
- `__all__` in a package's `__init__.py` when it re-exports names; keep `__init__.py` otherwise
  empty.
- `from app.config import DEBUG` binds the object the name refers to at import time. Rebinding the
  name later (`config.configure(...)` with `global`, `config.DEBUG = True`, a test's
  `mock.patch("app.config.DEBUG", ...)`) is not seen through it; changing that same object in
  place (an item of an imported dict) is. For module-level values that are rebound after import,
  import the module (`from app import config`) and read `config.DEBUG`. **Nothing** reports it;
  ruff `PLW0603` flags only a `global` statement in the owning module.

## Errors

- One base exception per package (`class OrdersError(Exception)`), specific subclasses below it.
  Callers can catch the base; nobody has to catch `Exception`.
- Do not name an exception class after a builtin (`ConnectionError`, `TimeoutError`). In its module,
  and in every module that imports the name, `except ConnectionError` then catches only yours: a
  `ConnectionResetError` from a socket escapes, and so does the `TimeoutError` of `asyncio.timeout`.
  ruff `A001` reports the class and `A004` the import; mypy does not. Use a prefixed name, and
  inherit from both (`class OrdersTimeoutError(OrdersError, TimeoutError)`) when existing
  `except TimeoutError` handlers should catch it.
- Raise built-in exceptions for programmer errors (`ValueError`, `TypeError`, `KeyError`), your
  own for domain failures. Do not raise bare `Exception`.
- Catch bare `Exception` only at an isolation boundary: one item of a batch, one message in a
  worker loop, the outermost frame of a thread. Record the failure with its traceback
  (`logger.exception(...)` or `exc_info=True`) and continue; everywhere else catch the specific
  exception. ruff `BLE001` (ruff 0.16) accepts a handler that re-raises or logs with
  `logger.exception` or `exc_info=True`, and reports one that only does `pass`, `continue` or
  stores the exception, or logs with `logger.error(...)` or `logger.warning("%s", e)` and no
  traceback. It also accepts a re-raise or log inside one `if` branch while the other branch
  swallows the error, and it recognises the logger by name: `logger`, `log` and `self.logger`
  pass, `_log`, `self._log` and `audit` are reported even with `.exception(...)`.
- `copy.copy`, `pickle` and process pools rebuild an exception as `type(exc)(*exc.args)` and then
  restore its attributes, so that call must work. A required parameter that is not in `args`
  (positional or keyword-only) makes it a `TypeError`, and when a `ProcessPoolExecutor` worker
  raises such an exception the caller gets `BrokenProcessPool` instead: the real error is lost and
  the pool is unusable. A first parameter that is not the message comes back as a garbled message,
  and an unpicklable attribute (a lock) reaches the caller as a pickling `TypeError`. **Nothing**
  reports it. Give extra fields keyword-only parameters with defaults and pass only the message to
  `super().__init__`. Passing every argument (`super().__init__(message, code)`) also works when
  every parameter is positional, and makes `str(exc)` the tuple. A `__reduce__` works too, but a
  subclass with another constructor inherits it and breaks the same way unless it defines its own.

```python
class ApiError(Exception):
    def __init__(self, message: str, *, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


class RateLimitError(ApiError):
    def __init__(self, message: str, *, retry_after: int = 0) -> None:
        super().__init__(message, status_code=429)
        self.retry_after = retry_after
```

- Do not return `None`, `False` or `-1` to signal failure from a function that normally returns
  a value. Raise, or make the absence part of the type (`User | None`) when "not found" is an
  ordinary outcome.
- A `DeprecationWarning` is shown under the default warning filters only when it is attributed to
  `__main__`. `warnings.warn` with the default `stacklevel=1` attributes it to the module that calls
  `warn`: shown for a function defined in the main script, never for one in a library module. With
  `stacklevel=2`, or `@warnings.deprecated` (Python 3.13+), it is attributed to the caller: shown
  for calls written in the main script, hidden for calls from any other module, which is where a
  library is usually called from. pytest and `python -X dev` show all of them.
  Pass `stacklevel=2` (ruff `B028`), and use `FutureWarning`, shown by default, for a change end
  users must notice at runtime. mypy reports calls to `@deprecated` functions, typeshed's included
  (`datetime.utcnow`), only with the `deprecated` error code, which `strict` does not enable
  (mypy 2.3); the configuration below enables it.
- The details are in [idioms](idioms.md#exceptions).

## Logging

```python
import logging

logger = logging.getLogger(__name__)


def parse_amount(order_id: int, raw: str) -> int:
    logger.info("parsing amount for order %s", order_id)
    try:
        return int(raw)
    except ValueError:
        logger.exception("bad amount for order %s", order_id)
        raise
```

- One module-level `logger = logging.getLogger(__name__)`. No `print` outside command-line
  output; ruff `T201`.
- Pass arguments, do not format: `logger.info("user %s", user)`. An f-string is formatted even
  when the level is disabled. ruff `G004`.
- Inside `except`, `logger.exception(...)` records the traceback; `logger.error(...)` does not.
  ruff `TRY400`. Log an exception or re-raise it, not both at every level; the example above logs
  and re-raises only because it is the one boundary that logs, so its callers must not log again.
- A stdlib logger takes no arbitrary keyword arguments. `logger.error("failed", error=str(e))`
  (structlog style, as popular guides write it) raises `TypeError` inside the `except` block, and
  the caller gets that instead of the exception you meant to raise. Use format arguments or
  `extra={"error": ...}`; an `extra` key that is a `LogRecord` attribute (`filename`, `module`,
  `message`) is a `KeyError`. Both errors happen only when the call's level is enabled: a
  `logger.debug(..., error=e)` passes every test run at INFO and raises once DEBUG is on. mypy
  reports the keyword (`call-arg`), but not through a `LoggerAdapter` or an `Any`-typed logger;
  ruff `G101` reports a clashing key in a literal `extra`.
- Configure logging once, in the entry point. Library and module code never calls
  `logging.basicConfig` or adds output handlers; the one exception is a `logging.NullHandler`
  on a library's top-level logger.
- Never log secrets, tokens or whole request bodies.

## Comments and docstrings

- A comment says why, not what. Delete comments that repeat the code, commented-out code, and
  notes about the editing history.
- Public modules, classes and functions get a docstring: one summary line in the imperative,
  then details only when they add something the signature does not say. Do not restate the
  types; the annotations are the source of truth.

## Tooling

```toml
[tool.ruff]
line-length = 100
target-version = "py314"

[tool.ruff.lint]
select = [
    "E", "W", "F", "I", "N", "UP", "B", "A", "C4", "SIM", "ANN", "RET", "PTH", "DTZ", "ISC",
    "G", "T20", "BLE", "PERF", "FBT", "PGH", "PLE", "PLW", "TRY", "RUF", "COM818",
]
ignore = ["TRY003"]

[tool.mypy]
python_version = "3.14"
strict = true
warn_unreachable = true
enable_error_code = ["ignore-without-code", "deprecated"]
```

- Before reporting a change as done, run `ruff check` without `--fix` and read it, then
  `ruff check --fix`, `ruff format` and `mypy`. Fixing or formatting first erases evidence: a
  missing comma between two strings in a list is merged into one literal and is not reported
  afterwards ([idioms](idioms.md#strings-numbers-and-time)).
- ruff and mypy overlap but neither replaces the other: `ANN` insists on `-> None` for every
  `__init__`, which mypy `strict` does only when no parameter is annotated; mypy rejects a bare
  `list` or `dict`, which ruff does not.
- ruff `F811` (a name redefined before it is used) skips function and class definitions whose
  names match `dummy-variable-rgx`, and the default pattern matches names that start with `_` (and
  do not also end with one). Two module-level `def _parse` (a merge that kept both sides) are not
  reported, not even with `--select ALL --preview`, and the first one is dead code; a repeated
  `import json as _json` is reported. mypy reports it (`no-redef`, on by default). Without
  mypy, set `dummy-variable-rgx = "^_$"`; an unused local `_name = f()` then reports `F841`.
- Before relying on a rule to guard something, write the violation once and see the tool report
  it. A selected rule can still skip the case: `F811` above, `B005` on `".csv"`
  ([idioms](idioms.md#strings-numbers-and-time)).
- Adopt the selection above only in a new project. In an existing one, keep its rule set and
  write code that would also pass these.
- The configuration above assumes the project's oldest supported Python is 3.14. When
  `requires-python` is lower, each tool needs the floor separately. mypy checks against the
  interpreter it runs under and pyright against the Python it finds (`python` on `PATH`, or
  `--pythonpath`); neither reads `requires-python`, so set mypy `python_version` and pyright
  `pythonVersion` to the floor. ty reads `requires-python` (ty 0.0.86). ruff takes its target from
  `requires-python` unless `target-version` is set; with a higher `target-version` its unsafe `UP`
  fixes write `type X = ...` and `def f[T]`, which the floor cannot parse. ruff does not check
  standard-library APIs against the floor (`itertools.batched` on 3.11); mypy and pyright with the
  floor set, and ty, do.
- `# noqa: CODE` and `# type: ignore[code]` always carry the code and, when it is not obvious, a
  reason.
- What no tool reports is listed in [idioms](idioms.md): `value or default`, shared rows,
  a consumed generator, `bool("False")`, `float` money, a bare-name `case` at module level.

## Gotchas

- Agent names a parameter `id`, `type` or `list` - the builtin is shadowed for the rest of the function.
- Agent creates `logging.py`, `random.py` or `queue.py` in the project - the standard-library module can no longer be imported.
- Agent adds a positional `bool` parameter - call sites read `f(x, True, False)`.
- Agent reads configuration or opens a connection at module level - importing the module in a test has side effects or fails.
- Agent writes a script without the `__main__` guard - importing it runs it.
- Agent fixes a circular import with scattered function-level imports - the cycle is still there.
- Agent logs with an f-string - formatted even when the level is off, and ruff `G004` fails.
- Agent uses `logger.error` in an `except` block - no traceback in the log.
- Agent calls `logging.basicConfig` in a library module - importing it installs a root handler, and the application's own `basicConfig` then does nothing.
- Agent uses a mutable `@dataclass`, or a frozen one with a `list` field, as a dict key - `TypeError`.
- Agent assumes `frozen=True` makes a dataclass deeply immutable - list and dict fields can still be changed.
- Agent returns `None` on failure from a function annotated `-> User` - callers crash later, far from the cause; mypy reports it only because the annotation is there.
- Agent restates the parameter types in the docstring - they drift from the annotations.
- Agent gives a custom exception a constructor that `type(exc)(*exc.args)` cannot call - it cannot be copied or unpickled, and in a `ProcessPoolExecutor` the caller gets `BrokenProcessPool` instead of the error.
- Agent logs structlog-style keyword arguments through a stdlib logger - the `TypeError` raised in the `except` block replaces the real exception; in a `debug` call only once DEBUG is enabled.
- Agent imports a setting with `from config import DEBUG` - later changes and test patches are not seen.
- Agent catches `Exception` in a batch or worker loop and logs only the message - the traceback is lost; use `logger.exception` or `exc_info=True`.
- Agent runs `ruff format` or `ruff check --fix` before reading the lint output - a missing comma between two strings is merged away and nothing reports it.
- Agent sets ruff `target-version` above `requires-python` and applies unsafe fixes - the code no longer parses on the oldest supported Python.
- Agent names an exception class `ConnectionError` or `TimeoutError` - `except ConnectionError` in that module and its importers no longer catches `ConnectionResetError`, and `except TimeoutError` misses `asyncio.timeout`.
- Agent deprecates with `warnings.warn(..., DeprecationWarning)` and no `stacklevel=2` - nobody sees the warning outside a test run or `python -X dev`; even with it, only a main script's direct calls show it.
- Agent relies on ruff `F811` to find a helper defined twice - definitions whose names start with `_` are skipped and the first one is dead code.

## Official sources

- [PEP 8: style guide](https://peps.python.org/pep-0008/), [PEP 257: docstrings](https://peps.python.org/pep-0257/)
- [dataclasses](https://docs.python.org/3.14/library/dataclasses.html), [logging HOWTO](https://docs.python.org/3.14/howto/logging.html)
- [ruff rules](https://docs.astral.sh/ruff/rules/), [mypy configuration](https://mypy.readthedocs.io/en/stable/config_file.html)
