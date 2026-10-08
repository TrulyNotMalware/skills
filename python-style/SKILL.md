---
name: python-style
description: >
  How to write Python: complete type annotations, Pythonic idioms, naming and code conventions,
  and the pitfalls that run without error. Use when writing, reviewing, refactoring, or debugging
  any Python code (scripts, CLIs, libraries, services, tests): function signatures and type hints
  (parameters, return types, generics, Protocol, TypedDict, dataclasses, Enum), mypy or ruff
  findings, default arguments, comprehensions and iteration, truthiness and None handling, string,
  number and datetime handling, exceptions, logging, imports and module layout, naming, and
  pyproject lint/type-check configuration. Also use when Python code "works but returns the wrong
  thing" (a default that is shared between calls, a zero treated as missing, a comparison that is
  always False, a check that never runs). Framework specifics live elsewhere: use python-fastapi
  together with this skill for FastAPI, Pydantic, SQLAlchemy and asyncio service code.
---

# Python style

Python lets almost anything run. A function without annotations, a default list, a `zip` over
lists of different length and `limit or 10` all execute and return something plausible. This
skill is about writing Python that says what it means: every signature typed, the direct idiom
instead of the clever one, and the handful of constructs that are wrong without an error. Read
the matching reference before writing or reviewing code in that area.

## Target versions

Verified 2026-10-01 by running code on these versions. Version-bound statements are tagged
`(Python 3.14)`, `(ruff 0.16)` or `(mypy 2.3)`.

| Component | Baseline | Notes |
|---|---|---|
| Python | 3.14 | Lazy annotations (PEP 649); inline type parameters (PEP 695); `except A, B:` without parentheses |
| ruff | 0.16 | Linter and formatter; `B909` and `PLW1514` are still preview rules |
| mypy | 2.3 | `strict = true`; no implicit `Optional` |

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
- Catch specific exceptions, keep the cause (`raise ... from exc`), never `except Exception:
  pass`.
- Timezone-aware datetimes, `Decimal` or integer minor units for money, `encoding="utf-8"` on
  every text file.
- `logging` with lazy arguments, not `print` or f-strings in log calls. No work at import time.
- Boolean flags are keyword-only parameters.

## Reference routing

| Task touches... | Read |
|---|---|
| Function signatures, return types, generics, `Any` vs `object`, `X \| None`, `TYPE_CHECKING` imports, `Protocol`, `TypedDict`, `NewType`, `Enum` exhaustiveness, `@override`, what mypy does and does not check | [reference/typing.md](reference/typing.md) |
| Loops and comprehensions, default arguments, shared mutable state, closures, `zip`, generators, truthiness and `None`, `match`, strings, floats and money, datetimes, encodings, exceptions, `subprocess`, caching | [reference/idioms.md](reference/idioms.md) |
| Naming, shadowed builtins and module names, keyword-only parameters, dataclass options, imports and import-time work, `__main__` guard, exception hierarchy, logging, comments and docstrings, ruff and mypy configuration | [reference/structure.md](reference/structure.md) |

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
- Agent catches `Exception` and carries on - the bug is hidden and the traceback lost.
- Agent validates input with `assert` - removed under `python -O`.
- Agent lets a linter move a Pydantic field's import under `TYPE_CHECKING` - imports fine, fails
  on first use. See [typing](reference/typing.md#imports-used-only-in-annotations).
- Agent names a file `logging.py` or a parameter `id` - the standard module or builtin is
  shadowed.

## Maintaining this skill

When bumping the target versions: update the table above, then grep this directory for
`Python 3.`, `3.14`, `ruff 0.`, `mypy 2.`, `preview`, `PEP 6` and `PEP 7`, and re-run each tagged
statement. Rule codes change status between ruff releases (preview to stable, renames); re-run
the pitfall-to-rule mapping in `reference/idioms.md`. The change history is kept outside this
directory, in the author's wiki.
