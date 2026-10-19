# Testing with pytest and unittest.mock

Applies to Python 3.14, pytest 9.1, ruff 0.16, mypy 2.3. Framework-free; for FastAPI clients,
lifespan, async and database fixtures, see the testing reference of the python-fastapi skill. Most
pitfalls here are reported by **nothing**: the test passes.

Contents: [Writing tests](#writing-tests) · [Captured output](#captured-output) ·
[Mocks and patches](#mocks-and-patches) · [Floats](#floats) ·
[Which copy of the package is tested](#which-copy-of-the-package-is-tested) · [Gotchas](#gotchas)

## Writing tests

```python
import sys
from unittest.mock import MagicMock

import pytest


class PaymentClient:
    def charge(self, cents: int) -> str:
        return f"charged {cents} through the provider"


class Checkout:  # the code under test, normally imported from your package
    def __init__(self) -> None:
        self.client = PaymentClient()  # the dependency is stored at construction

    def pay(self, cents: int) -> str:
        return self.client.charge(cents)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock()
    # Patch where Checkout looks the name up ("shop.service.PaymentClient").
    monkeypatch.setattr(sys.modules[__name__], "PaymentClient", lambda: client)
    return client


def test_pay_charges_once(client: MagicMock) -> None:
    client.charge.return_value = "ok"
    assert Checkout().pay(100) == "ok"  # built inside the test, after the patch
    client.charge.assert_called_once_with(100)


def test_pay_prints_nothing(
    client: MagicMock, capsys: pytest.CaptureFixture[str]
) -> None:
    Checkout().pay(100)
    client.charge.assert_called_once_with(100)
    assert capsys.readouterr().out == ""
```

- Annotate tests and fixtures like any other function: `-> None` on a test, the value type on a
  fixture that returns, `Iterator[T]` on one that yields. The built-in fixtures have types:
  `pytest.MonkeyPatch`, `pytest.CaptureFixture[str]`, `pytest.LogCaptureFixture`, `Path` for
  `tmp_path`.
- Assert the precondition, do not guard the assertion with it. `if out.exists(): assert ...`
  passes when nothing was written; `assert out.exists()` first fails.
- Pick input values for which the buggy and the fixed code give different results: with one row,
  or rows that are all equal, "first" and "last" agree and a test of either passes. Run a new
  regression test once against the code before the fix and see it fail (the procedure is in the
  review-remediation skill).

## Captured output

- pytest captures output by putting its own `sys.stdout` and `sys.stderr` in place, and it does so
  again between fixture setup and the test call. A fixture that does
  `monkeypatch.setattr(sys, "stdout", buf)` is undone before the test body runs: the output goes to
  pytest and `buf` stays empty. An assertion that something was written fails, and passes under
  `-s`, so it looks flaky; an assertion that nothing was written (`buf.getvalue() == ""`) passes
  with the bug present. The same with `--capture=fd` and `--capture=sys` (pytest 9.1).
  **Nothing** reports it.
- Read output with `capsys.readouterr()`, as above. `capfd` also sees what a subprocess writes,
  which `capsys` misses. Redirecting inside the test body (`contextlib.redirect_stdout`) works too.
  Assert log records with `caplog.records`, not by reading a stream.

## Mocks and patches

- `@patch(...)` on a test, and `with patch(...)` inside it, replace the name only while the test
  function runs. An object built earlier, in `setup_method` or a fixture, that stores the
  dependency at construction (`self.client = PaymentClient()`) keeps the real one: the test runs the
  real dependency, and passes unless it asserts on the mock, which records no call. An object that
  looks the name up at call time sees the patch. Build the object in the test body or patch in the
  fixture that builds it, and assert the expected calls on the mock (`assert_called_once_with`) so
  that a misplaced patch fails. Making a field lazy (created on first use) moves construction into
  the test, so patches that did nothing start to apply. **Nothing** reports it; ruff `ARG001`
  (functions) or `ARG002` (methods), if enabled, flags the mock parameter only when the test never
  uses it.
- `reset_mock()` clears the recorded calls but keeps `return_value` and `side_effect`, on child
  mocks too. A mock reused across cases still answers with the previous case's value or exception.
  Pass `reset_mock(return_value=True, side_effect=True)`, or take a new mock from a
  function-scoped fixture. **Nothing** reports it.
- A mock that must never be called, set up with `side_effect=AssertionError(...)`, fails the test
  only if that exception reaches pytest. A broad `except Exception:` in the code under test
  swallows it (`AssertionError` is an `Exception`) and the test passes. ruff `BLE001` reports that
  handler when it passes, returns, stores the exception or logs it without the traceback, and not
  when it logs with `logger.exception` or `exc_info=True`, which swallows it all the same (ruff
  0.16). Check afterwards with `mock.assert_not_called()` or `mock.call_count == 0`, which read the
  recorded calls.

- `create_autospec(...)` is typed as returning `Any` (typeshed), so returning it straight from an
  annotated fixture or helper (`-> MagicMock`, `-> NonCallableMagicMock`, `-> PaymentClient`) is
  mypy `no-any-return` under `strict` (mypy 2.3). Bind it to an annotated local first
  (`mock: MagicMock = create_autospec(PaymentClient, instance=True)` and `return mock`) or `cast`
  it. `MagicMock(spec=PaymentClient)` is typed `MagicMock` and passes as is, but checks only
  attribute names, not call signatures.

## Floats

- `pytest.approx(expected)` accepts a difference up to the larger of `rel=1e-6` times the
  expected value and `abs=1e-12`. For a tiny expected value the absolute part wins:
  `0.0 == pytest.approx(1e-200)` is `True`, so a result that underflowed to zero passes. Pass
  `abs=0` with a `rel` when the magnitude matters (`pytest.approx(1e-200, rel=1e-9, abs=0)`
  rejects `0.0`), and test an expected `0.0` separately: there only `abs` applies, and `abs=0`
  means exact. **Nothing** reports it.

## Which copy of the package is tested

This matters when the tests must run against the installed package rather than the source tree:
a non-editable install, a compiled extension, files generated at build time. Measured with the
package installed from a wheel and the source edited afterwards (pytest 9.1):

| Layout | Run | Imports |
|---|---|---|
| package at the repository root | `pytest`, no `tests/__init__.py`, no root `conftest.py` (a `tests/conftest.py` is fine) | installed |
| package at the repository root | `pytest` with `tests/__init__.py` or a root `conftest.py` | source |
| package at the repository root | `pytest --import-mode=importlib`, with or without those files | installed |
| package at the repository root | `python -m pytest`, either import mode | source |
| `src/` layout | `pytest` or `python -m pytest`, either import mode, any of those files | installed |
| package at the repository root | `pythonpath = ["."]` in the pytest configuration, either import mode | source |
| `src/` layout | `pythonpath = ["src"]` in the pytest configuration, either import mode | source |

- `python -m` puts the current directory first on `sys.path` whatever the import mode, so
  `--import-mode=importlib`, which popular guides suggest for this, does not keep the source tree
  out on its own. Run the `pytest` command, or use a `src/` layout without `pythonpath`.

- Importing from `conftest.py` (`from tests.conftest import PASSWORD`) in a `tests/` directory
  without `__init__.py` imports the file twice under the default `--import-mode=prepend` (and
  `append`): pytest loads it as the top-level module `conftest` (its directory goes on
  `sys.path`), and the import creates a second module `tests.conftest` from the same file once the
  repository root is importable (`pythonpath = ["."]`, `python -m pytest`). The tests pass
  (pytest 9.1; fixtures come from the copy pytest loaded); `--import-mode=importlib` and
  `consider_namespace_packages = true` load it once. mypy trips over the same layout on its own:
  checking `tests` as a directory without `explicit_package_bases`, it finds any module that
  another file imports as `tests.x` under two names (`x` and `tests.x`, `conftest` or a helper
  module alike), stops at `Source file found twice under different module names` and checks
  nothing else (mypy 2.3); a single-file target passes. `tests/__init__.py` fixes both (with the
  package at the repository root, `pytest` then imports the source tree, table above);
  `explicit_package_bases = true` fixes mypy only.

## Gotchas

- Agent patches `sys.stdout` or `sys.stderr` in a fixture - pytest's capture undoes it before the test runs; an assertion that nothing was printed passes with the bug present.
- Agent builds the object under test in `setup_method` or a fixture and patches the dependency it stores at construction with `@patch` on the test - the object keeps the real dependency, and a test that does not assert on the mock passes.
- Agent calls `reset_mock()` between cases - the previous case's `return_value` and `side_effect` remain.
- Agent returns `create_autospec(...)` straight from a fixture annotated `-> MagicMock` - mypy `no-any-return` under `strict`; bind it to an annotated local or `cast` it.
- Agent relies on `side_effect=AssertionError` to prove a mock is never called - a broad `except` in the code under test swallows it; use `assert_not_called()`.
- Agent compares a tiny float with `pytest.approx(expected)` - a result that underflowed to `0.0` passes.
- Agent runs `python -m pytest`, or adds `tests/__init__.py`, to test the installed package - with the package at the repository root the source tree is imported instead.
- Agent imports from `tests/conftest.py` (`from tests.conftest import X`) in a `tests/` directory without `__init__.py` - under the default import mode pytest imports the file twice (`conftest` and `tests.conftest`) and the tests pass; `mypy tests` stops at `Source file found twice` for any `tests.x` import; add `tests/__init__.py`.
- Agent guards an assertion with `if path.exists():` - the test passes when nothing was written.

## Official sources

- [pytest: how to capture stdout/stderr output](https://docs.pytest.org/en/stable/how-to/capture-stdout-stderr.html)
- [pytest: import mechanisms and sys.path](https://docs.pytest.org/en/stable/explanation/pythonpath.html), [pytest.approx](https://docs.pytest.org/en/stable/reference/reference.html#pytest-approx)
- [unittest.mock: where to patch](https://docs.python.org/3.14/library/unittest.mock.html#where-to-patch)
