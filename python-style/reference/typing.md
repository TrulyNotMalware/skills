# Type annotations

Applies to Python 3.14, mypy 2.3, ruff 0.16. The rule of this skill is that **no annotation is
left out**. This file gives the reasons, the modern spelling, and the places where a fully
annotated program is still wrong.

Contents: [Annotate everything](#annotate-everything) · [Modern spelling](#modern-spelling) ·
[Imports used only in annotations](#imports-used-only-in-annotations) ·
[What a fully annotated program still gets wrong](#what-a-fully-annotated-program-still-gets-wrong) ·
[Precise types instead of `str` and `dict`](#precise-types-instead-of-str-and-dict) ·
[Gotchas](#gotchas)

## Annotate everything

```python
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import contextmanager


class Counter:
    def __init__(self, start: int = 0) -> None:
        self._value = start

    def bump(self, by: int = 1) -> int:
        self._value += by
        return self._value


def numbers(limit: int) -> Iterator[int]:
    yield from range(limit)


async def ticks(limit: int) -> AsyncIterator[int]:
    for i in range(limit):
        yield i


@contextmanager
def counting(start: int) -> Iterator[Counter]:
    yield Counter(start)


def apply(fn: Callable[[int], str], value: int) -> str:
    return fn(value)


def test_bump() -> None:
    assert Counter().bump() == 1
```

- Every parameter and every return type is written, `-> None` included: `__init__`, private
  helpers, nested functions, tests, fixtures, scripts' `main()`. `*args: int` and
  `**kwargs: str` are annotated with the type of one element.
- Generators return `Iterator[T]`, async generators `AsyncIterator[T]`. A function decorated with
  `@contextmanager` is annotated as the generator it is (`Iterator[T]`), not as a context manager.
- When a caller needs `close()`/`aclose()`, say so: a generator the caller wraps in
  `contextlib.closing`/`aclosing`, or returns where a `Protocol` or `Callable` promises a
  `Generator`/`AsyncGenerator`, is annotated `Generator[T, None, None]`/`AsyncGenerator[T, None]`.
  `Iterator`/`AsyncIterator` declare no `close`, so `aclosing(fn())` is a mypy `type-var` error and
  `functools.partial(fn)` does not satisfy such a protocol, although the code runs (mypy 2.4).
- Containers carry their type arguments: `list[str]`, `dict[str, int]`, `tuple[int, ...]`. A bare
  `list` is `list[Any]`.
- Annotate a variable only where inference has nothing to go on: an empty container
  (`names: list[str] = []`), a value that starts as `None`, a module constant that is part of the
  interface.

Why it matters beyond documentation:

- **By default, mypy skips the body of a function that has no annotations at all.**
  `def total(): return 1 + "a"` is not reported. One signature annotation switches the check on.
  `check_untyped_defs` checks unannotated bodies too; `strict` includes that option, but is not
  required to enable it.
- An unannotated parameter is `Any`, and nothing done with it is ever reported, also under
  `strict`: `def f(x): return x.no_such_attribute + 1` passes apart from the missing-annotation
  error itself.
- A return annotation is what catches the forgotten branch. `def f(x: int) -> int:` with an `if`
  that returns and no `else` is `Missing return statement`; without the annotation it silently
  returns `None`.

## Modern spelling

```python
from typing import Self


class Node[T]:
    def __init__(self, value: T, parent: Node[T] | None = None) -> None:
        self.value = value
        self.parent = parent
        self.children: list[Node[T]] = []

    def add(self, child: Node[T]) -> Self:
        self.children.append(child)
        return self


type Pair[T] = tuple[T, T]


def first[T](items: list[T]) -> T:
    return items[0]
```

- `X | None`, not `Optional[X]`; `list[int]`, not `typing.List[int]`; `Callable`, `Iterator`,
  `Sequence`, `Mapping` from `collections.abc`, not from `typing`. ruff `UP006`, `UP035`, `UP045`
  flag the old forms.
- Type parameters are declared inline (Python 3.12+), as in `first`, `Node` and `Pair` above. ruff `UP047` flags a module-level `TypeVar` used for a generic function.
- A default of `None` needs `| None` in the annotation. `def f(x: int = None)` is an error in
  mypy 2.3; there is no implicit `Optional`.
- **Annotations are evaluated lazily on Python 3.14.** A class can be named in an annotation
  before it is defined, without quotes, and `from __future__ import annotations` is no longer
  needed. Do not add it to new modules.

## Imports used only in annotations

Lazy evaluation makes `if TYPE_CHECKING:` imports work for ordinary code and breaks them for code
that reads annotations at runtime:

| Annotation uses a name imported only under `TYPE_CHECKING` | Result (Python 3.14) |
|---|---|
| plain function, method, `@dataclass` field type | works; the annotation is never evaluated |
| `ClassVar` or `InitVar` itself, in a `@dataclass` | no error; **the attribute silently becomes an ordinary field** and a constructor argument |
| anything that reads `__annotations__` or calls `typing.get_type_hints` | `NameError` at that moment |
| Pydantic model field | the module imports; **the first instantiation fails** with `PydanticUserError: ... is not fully defined` |

- ruff's `TC` rules ask for such imports to be moved into a `TYPE_CHECKING` block, and their fix
  (applied with `--unsafe-fixes`) does it for a Pydantic model too. The result imports, passes
  `mypy --strict`, and fails on first use. Either leave `TC` off, or declare the runtime users:

```toml
[tool.ruff.lint.flake8-type-checking]
runtime-evaluated-base-classes = ["pydantic.BaseModel"]
runtime-evaluated-decorators = ["pydantic.dataclasses.dataclass"]
```

- The setting matches direct subclasses only. A model that derives from a project base class
  (`class Price(AppModel)`) is still rewritten unless that base is listed too, and parameters of
  functions that a framework inspects (FastAPI route handlers, dependency functions) are not
  covered at all. Keep `TC` off for those modules.
- Use `TYPE_CHECKING` to break an import cycle or to avoid an expensive import that only
  annotations need, and only where nothing evaluates the annotations at runtime.

## What a fully annotated program still gets wrong

- **`Any` switches checking off for everything it touches.** `def f(x: Any) -> None:
  x.whatever().more()` passes, also under `strict`; `strict` only objects when the `Any` is
  returned from a function with a concrete return type (`no-any-return`). When the type is
  unknown, write `object`: every use then needs an `isinstance` check first. Reserve `Any` for real boundaries (`json.loads` results, untyped
  libraries) and convert to a typed value right there.
- **`str` is a `Sequence[str]` and an `Iterable[str]`.** `def tags(xs: Sequence[str])` accepts
  `tags("abc")` without complaint and iterates over the characters. Where that would be a bug,
  take `list[str]` or reject `str` explicitly.
- **`bool` is an `int`, and `int` is accepted for `float`.** `count: int = True` passes mypy, and
  `isinstance(True, int)` is `True` at runtime. A function that must reject booleans checks for
  `bool` first.
- `list` is invariant: a `list[int]` is not a `list[object]`, and a `list[str | None]` is not a
  `list[str]`. Parameters that are only read take `Sequence[T]`, `Iterable[T]` or
  `Mapping[K, V]`; return types stay concrete (`list[T]`, `dict[K, V]`).
- `cast(int, value)` checks nothing, neither in mypy nor at runtime. It is an assertion you make
  on your own authority. Prefer `isinstance` narrowing or parsing.
- `# type: ignore` without a code hides every error on the line, including ones added later.
  Write `# type: ignore[arg-type]`; mypy's `ignore-without-code` and ruff's `PGH003` enforce it.
- Annotations are not checked at runtime. `@dataclass class P: x: int` accepts `P("a")` when the
  program runs. Validate external data with a parser (Pydantic, explicit conversion); annotate to
  check your own code.
- mypy reports a coroutine that is called and not awaited (`unused-coroutine`), but not an
  ignored return value of an ordinary function.
- **A decorator typed with `Callable[..., R]` erases the parameters of what it wraps.** Every
  call of the decorated function is then unchecked, although everything is annotated. Keep the
  signature with a parameter specification:

```python
from collections.abc import Callable
from functools import wraps


def traced[**P, R](fn: Callable[P, R]) -> Callable[P, R]:
    @wraps(fn)
    def inner(*args: P.args, **kwargs: P.kwargs) -> R:
        return fn(*args, **kwargs)

    return inner


@traced
def triple(x: int) -> int:
    return x * 3
```

  With `Callable[..., R]` in place of `Callable[P, R]`, `triple("a")` passes `mypy --strict`;
  as written it is an `arg-type` error.

## Precise types instead of `str` and `dict`

```python
import enum
from dataclasses import dataclass
from typing import Final, Literal, NewType, Protocol, TypedDict, assert_never, override

UserId = NewType("UserId", int)
MAX_RETRIES: Final = 3


class Status(enum.StrEnum):
    ACTIVE = "active"
    BLOCKED = "blocked"


@dataclass(frozen=True, slots=True, kw_only=True)
class User:
    id: UserId
    name: str
    status: Status = Status.ACTIVE


class UserRow(TypedDict):
    id: int
    name: str


class Notifier(Protocol):
    def send(self, user: User, text: str) -> None: ...


class EmailNotifier:
    def __init__(self) -> None:
        self.outbox: list[str] = []

    def send(self, user: User, text: str) -> None:
        self.outbox.append(f"{user.name}: {text}")


class LoudNotifier(EmailNotifier):
    @override
    def send(self, user: User, text: str) -> None:
        super().send(user, text.upper())


def label(status: Status) -> str:
    match status:
        case Status.ACTIVE:
            return "ok"
        case Status.BLOCKED:
            return "blocked"
        case _:
            assert_never(status)


def open_mode(mode: Literal["r", "w"]) -> str:
    return mode
```

- A fixed set of values is an `Enum` (or `Literal[...]` for one parameter), not `str`. With
  `assert_never` in the last `case`, mypy reports every member that a `match` forgot when one is
  added later.
- A record is a `@dataclass` (or `TypedDict` for a dict that comes from outside), not
  `dict[str, Any]`. mypy reports a misspelled `TypedDict` key and a misspelled attribute.
  At runtime a dataclass that is neither frozen nor slotted accepts `user.nmae = "x"` and
  silently creates a new attribute; `slots=True` makes it an `AttributeError`, `frozen=True` a
  `FrozenInstanceError`.
- `NewType` keeps identifiers apart: passing an `OrderId` or a plain `int` where a `UserId` is
  expected is an error, at no runtime cost.
- `Protocol` describes what a collaborator must be able to do without a base class. Classes
  match by shape; `EmailNotifier` above never mentions `Notifier`.
- `@override` makes a renamed base method an error (`no base method was found`) instead of a
  subclass method that is never called.
- `Final` forbids reassignment of a constant. `Self` is the return type of methods that return
  their own instance.

## Gotchas

- Agent leaves a helper or a test completely unannotated because the types are "obvious" - mypy skips its body unless `check_untyped_defs` is enabled directly or through `strict`.
- Agent annotates an async generator as `AsyncIterator[T]` and a caller wraps it in `contextlib.aclosing` or binds it to an `AsyncGenerator` protocol - mypy `type-var`/protocol mismatch; write `AsyncGenerator[T, None]` when `aclose()` is part of the contract.
- Agent omits `-> None` on an `__init__` that has annotated parameters - mypy `strict` accepts it, the rule of this skill does not; ruff `ANN204` reports it.
- Agent types a decorator as `Callable[..., R]` - calls of every decorated function lose their argument checks; use `Callable[P, R]`.
- Agent imports `ClassVar` only under `TYPE_CHECKING` - the dataclass turns the class variable into a field.
- Agent annotates a parameter as `Any` to get past an error - every later mistake on that value is hidden.
- Agent takes `Sequence[str]` and is called with a single string - it iterates over characters; nothing reports it.
- Agent uses `isinstance(x, int)` to tell numbers from flags - `True` is an `int`.
- Agent writes `def f(x: int = None)` - mypy error; write `int | None`.
- Agent adds `from __future__ import annotations` out of habit on Python 3.14 - unnecessary, and it turns annotations into strings for libraries that read them.
- Agent lets ruff `TC` move an import used by a Pydantic field under `TYPE_CHECKING` - imports and type-checks, fails on first instantiation.
- Agent silences an error with a bare `# type: ignore` - later errors on that line are hidden too.
- Agent uses `cast` to "convert" a value - nothing is converted or checked.
- Agent returns `dict[str, Any]` from a function - every caller is unchecked; return a dataclass or `TypedDict`.
- Agent trusts annotations to validate input - `P("a")` runs for `x: int`.
- Agent overrides a method without `@override` and later renames the base method - the subclass method silently stops being called.

## Official sources

- [typing documentation](https://docs.python.org/3.14/library/typing.html)
- [PEP 649: deferred evaluation of annotations](https://peps.python.org/pep-0649/), [PEP 695: type parameter syntax](https://peps.python.org/pep-0695/)
- [mypy: existing code and strictness flags](https://mypy.readthedocs.io/en/stable/existing_code.html)
- [ruff: flake8-annotations (ANN)](https://docs.astral.sh/ruff/rules/#flake8-annotations-ann)
