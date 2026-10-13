# Idioms and silent pitfalls

Applies to Python 3.14 and ruff 0.16. Each pitfall names what reports it: a ruff rule, mypy, or
**nothing**. The ones marked "nothing" need review and tests, because the code runs and returns
a plausible value.

Contents: [Prefer the direct construct](#prefer-the-direct-construct) ·
[Defaults and shared state](#defaults-and-shared-state) · [Iteration](#iteration) ·
[Truthiness and comparisons](#truthiness-and-comparisons) ·
[Strings, numbers and time](#strings-numbers-and-time) · [Exceptions](#exceptions) ·
[Resources and processes](#resources-and-processes) · [Gotchas](#gotchas)

## Prefer the direct construct

```python
import itertools
from collections import Counter, defaultdict
from pathlib import Path


def summarize(lines: list[str], limit: int | None = None) -> dict[str, list[int]]:
    positions: defaultdict[str, list[int]] = defaultdict(list)
    for number, line in enumerate(lines, start=1):
        if word := line.strip().lower():
            positions[word].append(number)
    limit = len(positions) if limit is None else limit
    return dict(itertools.islice(positions.items(), limit))


def most_common(words: list[str]) -> str | None:
    return Counter(words).most_common(1)[0][0] if words else None


def squares(values: list[int]) -> list[int]:
    return [value * value for value in values if value >= 0]


def read_names(path: Path) -> list[str]:
    with path.open(encoding="utf-8") as handle:
        return [line.rstrip("\n") for line in handle]


def pairs(names: list[str], ages: list[int]) -> dict[str, int]:
    return dict(zip(names, ages, strict=True))
```

- Iterate over the values, not over indexes: `for item in items`, `enumerate(items, start=1)`
  when the position is needed, `zip(a, b, strict=True)` for two sequences,
  `itertools.pairwise`/`batched` for windows and chunks.
- A comprehension for building a list, set or dict from another iterable; a plain loop when the
  body has side effects or needs more than one statement. Do not nest more than two `for`
  clauses in one comprehension.
- Unpack instead of indexing: `first, *rest = parts`, `for key, value in mapping.items()`.
- `collections` (`defaultdict`, `Counter`, `deque`), `itertools` and `functools` before a
  hand-written loop that does the same.
- `pathlib.Path` for file paths, `with` for everything that has to be closed, f-strings for
  formatting (but not in logging calls, see [structure](structure.md#logging)).
- `x is None` / `x is not None`; `isinstance(x, T)`, not `type(x) == T`; `key in mapping`, not
  `key in mapping.keys()`; `not in`, `is not` as single operators.
- Return early instead of nesting. Give boolean and optional parameters as keywords at the call
  site (`retry(times=3, backoff=True)`).

## Defaults and shared state

- **A default value is created once, when the `def` runs.** `def add(x: int, acc: list[int] =
  [])` appends to the same list on every call; `def stamp(now: datetime = datetime.now())`
  freezes the time of import. Use `None` and create the value inside. ruff `B006`, `B008`. When
  `None` is itself a meaningful argument, use a private sentinel object as the default instead,
  so that "not passed" and "passed `None`" stay distinct.
- `[[0] * 3] * 3` is three references to one row. Write `[[0] * 3 for _ in range(3)]`.
  **Nothing** reports it.
- `dict.fromkeys(keys, [])` gives every key the same list. Write `{key: [] for key in keys}`.
  ruff `RUF024`.
- A mutable class attribute (`items: list[int] = []` in a plain class) is shared by all
  instances. ruff `RUF012`. In a `@dataclass` the same line is a `ValueError` at class
  definition (and ruff `RUF008`); use `field(default_factory=list)`.
- Closures capture variables, not values: `[lambda: i for i in range(3)]` returns `2` three
  times. Bind the value (`lambda i=i: i`) or use `functools.partial`. ruff `B023`.
- `functools.cache` on a method keeps every instance alive for the life of the process (the
  cache holds `self`). ruff `B019`. On an `async def` it caches the coroutine object, and the
  second call fails with `RuntimeError: cannot reuse already awaited coroutine`.

## Iteration

- `zip` stops at the shortest input without a word: `list(zip([1, 2, 3], "ab"))` has two
  elements. Pass `strict=True` unless truncation is the intent. ruff `B905`.
- Removing from a list while iterating over it skips elements: removing every `2` from
  `[1, 2, 2, 3]` leaves `[1, 2, 3]`. Build a new list. The same on a `dict` raises
  `RuntimeError`, so only the list case is silent. ruff reports it only in preview (`B909`).
- A generator can be consumed once; the second `list(gen)` is empty, with no error. Functions
  that iterate twice take a `Sequence`, or call `list()` once at the top. **Nothing** reports it.
- `any([])` is `False` and `all([])` is `True`. A check like `all(item.ok for item in items)`
  passes for an empty input.

## Truthiness and comparisons

- **`value or default` replaces every falsy value, not only `None`.** `limit or 10` turns a
  legitimate `0` into `10`; `name or "anonymous"` replaces `""`. Write
  `default if value is None else value`. **Nothing** reports it.
- `if x:` on an `int | None` treats `0` like `None`. Compare with `is None` when `0`, `""` or an
  empty container is a valid value.
- `bool("False")` is `True`: every non-empty string is truthy. Parse flags from the environment
  explicitly (`value.lower() in {"1", "true", "yes"}`). **Nothing** reports it.
- A member of a plain `Enum` does not equal its value: `Color.RED == "red"` is `False`, with no
  error at runtime. mypy reports it only under `strict` (`comparison-overlap`); ruff does not.
  Compare members with members, or use `StrEnum`/`IntEnum` when the value has to interoperate.
  `f"{Color.RED}"` is `"Color.RED"`; with `StrEnum` it is `"red"`.
- `is` compares identity. `x is 1000` or `name is "admin"` works or not depending on interning;
  Python emits a `SyntaxWarning` and ruff reports `F632`. Use `==` for values.
- **A bare name in a `case` captures; it does not compare.** With `NOT_FOUND = 404`, `match
  code: case NOT_FOUND:` matches every code and rebinds the name. Use a dotted name
  (`HTTPStatus.NOT_FOUND`, an `Enum` member) or a literal. With a later `case` it is a
  `SyntaxError`. As the last or only case it runs: inside a function ruff reports the
  upper-case local (`N806`) and mypy with `warn_unreachable` reports the code after the `match`
  when the case returns; at module level **nothing** reports it.

## Strings, numbers and time

- `strip`, `lstrip` and `rstrip` take a **set of characters**, not a prefix or suffix:
  `"report.txt".rstrip(".txt")` is `"repor"`. Use `removeprefix`/`removesuffix`. ruff `B005`
  reports it only when the argument repeats a character (`".txt"`, `"https://"`);
  `rstrip(".csv")` is not reported.
- Two string literals next to each other are joined: `["a", "b" "c"]` has two elements. A missing
  comma in a list is therefore silent at runtime. ruff `ISC001` (one line) and `ISC004` (in a
  collection) report it only until the file is rewritten (ruff 0.16): `ruff format` merges the pair
  into one literal when it fits the line, `ruff check --fix` merges a one-line pair (the `ISC001`
  fix is safe), `--unsafe-fixes` wraps it in parentheses, and then nothing reports it. Read
  `ruff check` without `--fix` first ([structure](structure.md#tooling)).
- A trailing comma makes a tuple: `timeout = 30,` is `(30,)`. ruff `COM818`; mypy too when the
  variable is annotated or used as a number.
- `float` is binary: `0.1 + 0.2 != 0.3`, and `round(2.5)` is `2` (round half to even). Use
  `decimal.Decimal` built from strings, or integer minor units, for money. **Nothing** reports a
  `float` used for an amount.
- `float()` parses `"nan"` and `"inf"`, `json.loads` accepts `NaN` and `Infinity`, and with NaN
  `==` and every ordering comparison are `False` (`!=` is `True`). `if x < 0 or x > 1: raise` lets
  NaN through; a lower bound alone (`if x < 0`) lets NaN and `inf` through. When validating a
  parsed float, check `math.isfinite(x)` and write the range as `not lo <= x <= hi`. `sorted()` of
  a list containing NaN is not sorted. **Nothing** reports it; ruff `PLW0177` flags only a
  comparison with NaN written into it (`float("nan")`, `math.nan`), not one with a parsed value.
- `datetime.now()` and `datetime.utcnow()` return naive values; `utcnow` is deprecated. Use
  `datetime.now(UTC)`. Comparing a naive with an aware value with `<` raises `TypeError`, but
  `==` just returns `False`. ruff `DTZ` reports the naive constructors.
- Aware values in the **same** zone are compared and subtracted by their wall-clock fields. The
  two `01:30` of a daylight-saving change in `ZoneInfo("America/New_York")` (`fold=0` and
  `fold=1`) are equal and zero seconds apart, although they are one hour apart in UTC. Convert
  to UTC before comparing instants or measuring elapsed time; keep zone-local values for
  calendar arithmetic and display.
- `time.monotonic()` for measuring durations; wall-clock time can jump.
- `open()` and `Path.read_text()` without `encoding=` use the locale's encoding on Python 3.14,
  so the same file reads differently on Windows or under a non-UTF-8 locale. Always pass `encoding="utf-8"`. ruff
  reports it only in preview (`PLW1514`); `python -X warn_default_encoding` reports it at
  runtime.
- `hash()` of a `str` differs between processes. Do not persist it, send it to another process,
  or rely on the iteration order of a `set` of strings; use `hashlib` and `sorted`.
- `json.dumps` turns non-string keys into strings (`{1: "a"}` comes back as `{"1": "a"}`) and
  escapes non-ASCII by default (`ensure_ascii=False` keeps it readable). `Decimal` and
  `datetime` raise `TypeError`, which is at least loud.

## Exceptions

```python
import logging

logger = logging.getLogger(__name__)


class ConfigError(Exception):
    """The configuration file is missing or malformed."""


def parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError as exc:
        raise ConfigError(f"port is not a number: {raw!r}") from exc
    if not 0 < port < 65536:
        raise ConfigError(f"port out of range: {port}")
    return port
```

- Catch the narrowest exception that the code can handle, and handle it. `except Exception:
  pass` hides bugs; ruff `BLE001`. A bare `except:` also catches `KeyboardInterrupt`,
  `SystemExit` and `asyncio.CancelledError` (none of them is an `Exception`); ruff `E722`.
- The reverse also holds: cleanup in `except Exception:` (roll back, then `raise`) does not run on
  `KeyboardInterrupt`, `sys.exit()` or `asyncio.CancelledError`. Under `asyncio.timeout`, a handler
  inside the `async with` block sees the cancellation and is skipped; one around the block sees the
  `TimeoutError` it becomes and runs. Put cleanup that must always run in `finally`, behind a flag
  set after the commit ([example](#resources-and-processes)). **Nothing** reports it; `BLE001` is
  silent because the handler re-raises.
- Keep only the call that raises the expected exception in `try` and put the rest in `else`. In
  `try: entry = cache[key]; return entry["size"]` with `except KeyError:`, a misspelled key on the
  second line is handled as a cache miss. ruff `TRY300` reports only some shapes: `return value`
  after other statements is reported, `return entry["size"]`, a returned call and an assignment
  are not. Do not rely on it to find a wide `try`.
- Translate with `raise NewError(...) from exc` so the original traceback stays attached. ruff
  `B904`. Re-raise unchanged with a bare `raise`.
- `return` (or `break`) inside `finally` swallows the exception in flight and overrides the
  value returned from `try`. Python 3.14 emits a `SyntaxWarning`; ruff `B012`.
- `assert` is removed under `python -O`. Use it for tests and internal invariants, never to
  validate input or permissions.
- Python 3.14 accepts `except ValueError, TypeError:` without parentheses. It means "either of
  them", not the Python 2 "as"; with `as exc` the parentheses are still required. `ruff format`
  removes the parentheses when `target-version` is `py314`, so a project that must also run on
  older versions sets a lower `target-version`.

## Resources and processes

- `subprocess.run([...])` does not raise when the command exits with a non-zero status (a
  missing executable does raise `FileNotFoundError`). Pass `check=True` (ruff `PLW1510`), give
  the arguments as a list, and do not use `shell=True` with anything that contains outside
  input (ruff `S602`, if the project enables the `S` rules).
- Open files, locks, sockets and temporary directories with `with`. ruff `SIM115` reports an
  `open()` outside one.
- In a `@contextmanager` (or `@asynccontextmanager`) generator, code after a `yield` that is not
  inside `try`/`finally` is skipped when the `with` body raises, for `yield` and `yield value`
  alike: the lock is not released, the directory not restored. Put the cleanup in a `finally`
  around the `yield`. ruff reports it only in preview (`RUF075`); mypy does not. A transaction
  that, once `begin()` has returned, rolls back on every exit that does not commit,
  `BaseException` included (a `begin()` that raises is not rolled back):

```python
from collections.abc import Generator
from contextlib import contextmanager
from typing import Protocol


class Connection(Protocol):
    def begin(self) -> None: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...


@contextmanager
def transaction(conn: Connection) -> Generator[Connection]:
    conn.begin()
    committed = False
    try:
        yield conn
        conn.commit()
        committed = True
    finally:
        if not committed:
            conn.rollback()
```

- An executor keeps a worker's exception in the `Future` until `.result()` is called.
  `pool.submit(fn)` with the future never read, `pool.map(...)` whose iterator is never consumed,
  and `wait(futures)` all return normally, in `ThreadPoolExecutor` and `ProcessPoolExecutor` alike,
  and nothing is logged. Call `.result()` on every future (`as_completed`) or consume `pool.map`.
  **Nothing** reports it.

## Gotchas

- Agent writes `limit = limit or 100` - a caller's `0` becomes `100`; nothing reports it.
- Agent writes `def f(items: list[str] = [])` or `def f(now: datetime = datetime.now())` - one shared list, one frozen timestamp.
- Agent builds a grid with `[[0] * n] * n` - every row is the same list.
- Agent zips two lists of different length without `strict=True` - the extra items disappear.
- Agent removes items from the list it is iterating - of adjacent matches, every second one survives.
- Agent passes a generator to a function that loops over it twice - the second loop sees nothing.
- Agent compares a member of a plain `Enum` with a string - always `False` at runtime; only mypy `strict` reports it.
- Agent matches against a constant with `case NOT_FOUND:` - it matches everything.
- Agent uses `rstrip(".txt")` to drop an extension - it eats trailing `t`, `x` and `.` characters.
- Agent reads a flag with `bool(os.environ.get("DEBUG"))` - `"false"` and `"0"` are `True`.
- Agent stores money in `float` - sums drift and `round` rounds half to even.
- Agent uses `datetime.now()` for a stored timestamp - a naive value in the server's local time.
- Agent opens a text file without `encoding=` - breaks on Windows or under a non-UTF-8 locale.
- Agent catches `Exception` and logs "failed" - the cause and the traceback are gone; use `logger.exception` or re-raise.
- Agent validates input with `assert` - the check disappears under `-O`.
- Agent runs `subprocess.run(cmd)` and continues - a failed command goes unnoticed without `check=True`.
- Agent decorates a method with `functools.cache` - instances are never freed.
- Agent drops a comma between two string literals in a list - two entries merge into one; after `ruff format` or `ruff check --fix` nothing reports it.
- Agent validates a parsed float with `x < 0 or x > 1` - `float("nan")` passes.
- Agent wraps a lookup and the code that uses its result in one `try/except KeyError` - a bug's `KeyError` is handled as the expected miss.
- Agent rolls back in `except Exception:` and re-raises - Ctrl+C, `sys.exit()` or a cancelled task skips the rollback.
- Agent puts cleanup after a `yield` that is not inside `try`/`finally` in a `@contextmanager` - it is skipped whenever the `with` block raises.
- Agent submits work to an executor and never reads the futures - every exception in the workers is lost.

## Official sources

- [Python tutorial: more on defining functions](https://docs.python.org/3.14/tutorial/controlflow.html#more-on-defining-functions)
- [What's new in Python 3.14](https://docs.python.org/3.14/whatsnew/3.14.html)
- [ruff: flake8-bugbear (B)](https://docs.astral.sh/ruff/rules/#flake8-bugbear-b)
