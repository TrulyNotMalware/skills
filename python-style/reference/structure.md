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

- Exception classes end in `Error`. ruff `N818`; `N801`-`N806` cover the rest of the table.
- Name things for what they are in the domain, not for their type: `users`, not `user_list`;
  `is_active`, `has_items`, `can_retry` for booleans.
- **Do not shadow builtins**: `id`, `type`, `list`, `dict`, `input`, `filter`, `format`, `hash`,
  `max`, `min`. The builtin is gone for the rest of that scope. ruff `A001`, `A002`.
- **Do not name a module after a standard-library or dependency module** (`random.py`,
  `logging.py`, `queue.py`). Other imports of that name then get your file: `AttributeError:
  module 'random' has no attribute 'randint'` (on Python 3.14 the message suggests renaming the
  file). Modules the interpreter has already loaded at startup, such as `types`, are not
  affected at runtime, but the name is still confusing. ruff `A005` reports all of them.
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

## Errors

- One base exception per package (`class OrdersError(Exception)`), specific subclasses below it.
  Callers can catch the base; nobody has to catch `Exception`.
- Raise built-in exceptions for programmer errors (`ValueError`, `TypeError`, `KeyError`), your
  own for domain failures. Do not raise or catch bare `Exception`.
- Do not return `None`, `False` or `-1` to signal failure from a function that normally returns
  a value. Raise, or make the absence part of the type (`User | None`) when "not found" is an
  ordinary outcome.
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
  ruff `TRY400`. Log an exception or re-raise it, not both at every level.
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
enable_error_code = ["ignore-without-code"]
```

- Run `ruff format`, `ruff check` and `mypy` before reporting a change as done. ruff and mypy
  overlap but neither replaces the other: `ANN` insists on `-> None` for every `__init__`,
  which mypy `strict` does only when no parameter is annotated; mypy rejects a bare `list` or
  `dict`, which ruff does not.
- Adopt the selection above only in a new project. In an existing one, keep its rule set and
  write code that would also pass these.
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

## Official sources

- [PEP 8: style guide](https://peps.python.org/pep-0008/), [PEP 257: docstrings](https://peps.python.org/pep-0257/)
- [dataclasses](https://docs.python.org/3.14/library/dataclasses.html), [logging HOWTO](https://docs.python.org/3.14/howto/logging.html)
- [ruff rules](https://docs.astral.sh/ruff/rules/), [mypy configuration](https://mypy.readthedocs.io/en/stable/config_file.html)
