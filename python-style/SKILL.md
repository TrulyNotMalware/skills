---
name: python-style
description: >
  How to write Python: complete type annotations, Pythonic idioms, naming and code conventions, and
  the pitfalls that run without error. Use when writing, reviewing, refactoring, or debugging any
  Python code (scripts, CLIs, libraries, services, pytest tests and mocks): function signatures and
  type hints (parameters, return types, generics, Protocol, TypedDict, dataclasses, Enum), mypy or
  ruff findings, default arguments, comprehensions, truthiness and None, string, number and datetime
  handling, exceptions and cleanup, context managers, thread and process pools, logging, imports,
  naming, lint and type-check configuration, and ty or pyright instead of mypy. Also use when Python
  code "works but returns the wrong thing" (a default that is shared between calls, a zero treated
  as missing, a comparison that is always False, a check that never runs). Framework specifics live
  elsewhere: use python-fastapi together with this skill for FastAPI, Pydantic, SQLAlchemy and
  asyncio service code.
---

# Python style

Python lets almost anything run. A function without annotations, a default list, a `zip` over
lists of different length and `limit or 10` all execute and return something plausible. This
skill is about writing Python that says what it means: every signature typed, the direct idiom
instead of the clever one, and the handful of constructs that are wrong without an error. Read
the matching reference before writing or reviewing code in that area.

## Target versions

Verified 2026-10-01 by running code on these versions, extended 2026-10-13, 2026-10-14 and 2026-10-19.
Version-bound statements are tagged `(Python 3.14)`, `(ruff 0.16)`, `(mypy 2.3)`, `(pytest 9.1)`,
`(ty 0.0.86)` or `(pyright 1.1.414)`.

| Component | Baseline | Notes |
|---|---|---|
| Python | 3.14 | Lazy annotations (PEP 649); `except A, B:` without parentheses; inline type parameters (PEP 695) are since 3.12 |
| ruff | 0.16 | Linter and formatter; `B909` and `PLW1514` are still preview rules |
| mypy | 2.3 | `strict = true`; no implicit `Optional` |
| pytest | 9.1 | The testing reference; `unittest.mock` from the standard library |
| ty, pyright | 0.0.86, 1.1.414 | Only where a project uses them instead of mypy; they report less by default |

The project's own configuration wins. Read `pyproject.toml` (or `ruff.toml`, `mypy.ini`,
`setup.cfg`) and the root `AGENTS.md`/`CLAUDE.md` first, and check `python --version` of the
interpreter that actually runs the code.

## Workflow

1. **Read the surrounding code first.** Match its naming, import style, error classes, logging
   and test layout. Consistency with the codebase beats this skill's defaults, except for the
   annotation rule below, which applies to all code you write or touch.
2. **Open the relevant reference** from the table below.
3. **Write the signature before the body**: parameter types, return type, and the exceptions it
   raises. If the signature is hard to write, the function is doing too much.
4. **Run the project's formatter, linter and type checker**, then the tests. A finding is fixed
   in the code, not silenced; a `# noqa` or `# type: ignore` carries its code and a reason.
5. For behavior that no tool reports (see Gotchas), write a test with the edge value: `0`, `""`,
   an empty list, two inputs of different length, a second iteration.

## Always-on rules

- **Annotate every function completely**: each parameter and the return type, `-> None`
  included, in private helpers, nested functions, tests and fixtures alike. Containers carry
  their type arguments (`list[str]`, not `list`). Never leave an annotation out because it is
  "obvious".
- No `Any` unless the value really is unknown at a boundary; prefer `object` plus narrowing, and
  convert to a typed value at once.
- `X | None` with an explicit `is None` check. Never `value or default` when `0`, `""` or an
  empty container is a valid value.
- No mutable or computed default arguments; use `None` and create the value inside.
- A fixed set of values is an `Enum`/`Literal`; a record is a `@dataclass`/`TypedDict`; neither
  is a bare `str` or `dict[str, Any]`.
- Catch specific exceptions and keep the cause (`raise ... from exc`). Catch `Exception` only at an
  isolation boundary (a batch item, a worker loop, a thread's top) and log it with its traceback
  (`logger.exception` or `exc_info=True`); never `except Exception: pass`. Cleanup goes in
  `finally`, not in `except`.
- Timezone-aware datetimes, `Decimal` or integer minor units for money, `encoding="utf-8"` on
  every text file.
- `logging` with lazy arguments, not `print` or f-strings in log calls. No work at import time.
- Boolean flags are keyword-only parameters, in functions you design; leave existing public
  signatures alone.

## Reference routing

| Task touches... | Read |
|---|---|
| Function signatures, return types, generics, `Any` vs `object`, `X \| None`, `TYPE_CHECKING` imports, `Protocol` and `runtime_checkable`, `TypedDict`, `NewType`, `Enum` exhaustiveness, `@override`, context manager return types, what mypy does and does not check, ty or pyright instead of mypy | [reference/typing.md](reference/typing.md) |
| Loops and comprehensions, default arguments, shared mutable state, closures, `zip`, generators, truthiness and `None`, `match`, strings, floats, NaN and money, datetimes, encodings, exceptions and cleanup, `@contextmanager`, `subprocess`, thread and process pool futures, caching | [reference/idioms.md](reference/idioms.md) |
| Writing or fixing tests: fixtures, `monkeypatch`, `unittest.mock` patches and `reset_mock`, captured output (`capsys`, `capfd`, `caplog`), `pytest.approx`, which copy of the package the tests import (`--import-mode`, `python -m pytest`), tests that pass on buggy code | [reference/testing.md](reference/testing.md) |
| Naming, shadowed builtins and module names, keyword-only parameters, dataclass options, imports and import-time work, `from` imports of mutable settings, `__main__` guard, exception hierarchy and constructors, where to catch `Exception`, logging and `extra`, comments and docstrings, ruff and mypy configuration, lint and format order, version floor per tool | [reference/structure.md](reference/structure.md) |

## Gotchas

These run, pass a quick manual check, and are wrong. Each reference file has a longer list and
says which tool, if any, reports the problem.

- Agent leaves a helper, a test or `__init__` completely unannotated - mypy skips its body by
  default; `check_untyped_defs` (also enabled by `strict`) checks it.
  See [typing](reference/typing.md#annotate-everything).
- Agent writes `limit = limit or 100` - a caller's `0` silently becomes `100`.
- Agent writes `def f(items: list[str] = [])` - every call shares one list.
- Agent annotates a value as `Any` to make an error go away - all later checks on it are off.
- Agent accepts `Sequence[str]` and gets a single `str` - it iterates over the characters.
- Agent zips two sequences of different length without `strict=True` - the tail is dropped.
- Agent compares a member of a plain `Enum` with its string value - always `False` at runtime.
- Agent writes `case NOT_FOUND:` against a constant - a bare name captures and matches
  everything. See [idioms](reference/idioms.md#truthiness-and-comparisons).
- Agent uses `rstrip(".txt")` or `strip("https://")` - a character set, not a suffix or prefix.
- Agent reads a flag with `bool(os.environ.get("DEBUG"))` - `"false"` is `True`.
- Agent stores timestamps with `datetime.now()` and money in `float` - naive local time, binary
  rounding.
- Agent catches `Exception` away from an isolation boundary, or logs it without the traceback -
  the bug is hidden and the traceback lost.
- Agent puts cleanup after a `yield` outside `try`/`finally` in a `@contextmanager`, or rolls back
  in `except Exception:` - an error, Ctrl+C or a cancelled task skips it.
  See [idioms](reference/idioms.md#resources-and-processes).
- Agent submits work to a thread or process pool and never reads the futures - every exception
  raised in the workers is lost.
- Agent gives a custom exception a constructor that `type(exc)(*exc.args)` cannot call - it cannot
  be copied or unpickled; in a `ProcessPoolExecutor` the caller gets `BrokenProcessPool` instead of
  the error. See [structure](reference/structure.md#errors).
- Agent runs `ruff format` or `ruff check --fix` before reading the lint output - a missing comma
  between two strings is merged into one literal and nothing reports it afterwards.
  See [structure](reference/structure.md#tooling).
- Agent annotates a `@contextmanager` function `-> Iterator[T]` - current typeshed deprecates that
  overload and ty fails on it; write `Generator[T]`.
- Agent patches `sys.stdout` or `sys.stderr` in a fixture - pytest's capture undoes it; an
  assertion that nothing was printed passes with the bug present.
  See [testing](reference/testing.md#captured-output).
- Agent builds the object under test in `setup_method` or a fixture, the object stores its
  dependency, and the test patches that dependency with `@patch` without asserting on the mock -
  the real dependency runs and the test passes.
- Agent names an exception class `ConnectionError` or `TimeoutError` - `except` clauses in that
  module stop catching the builtin ones.
- Agent deprecates with `DeprecationWarning` and no `stacklevel=2` - nobody sees it outside a test
  run; even with it, only a main script's direct calls show it.
- Agent swaps mypy `strict` for ty or pyright's default mode - unannotated parameters, bare `list`
  and returned `Any` stop being reported.
  See [typing](reference/typing.md#when-the-project-uses-ty-or-pyright).
- Agent validates input with `assert` - removed under `python -O`.
- Agent lets a linter move a Pydantic field's import under `TYPE_CHECKING` - imports fine, fails
  on first use. See [typing](reference/typing.md#imports-used-only-in-annotations).
- Agent names a file `logging.py` or a parameter `id` - the standard module or builtin is
  shadowed.

## Maintaining this skill

When bumping the target versions: update the table above, then grep this directory for `Python 3.`,
`3.14`, `ruff 0.`, `mypy 2.`, `pytest 9.`, `ty 0.`, `pyright 1.`, `typeshed`, `preview`, `PEP 6` and
`PEP 7`, and re-run each tagged statement. Rule codes change status between ruff releases (preview
to stable, renames); re-run the pitfall-to-rule mapping in `reference/idioms.md`.
