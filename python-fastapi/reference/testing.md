# Testing FastAPI applications

Applies to pytest 9.1, pytest-asyncio 1.4, httpx 0.28, FastAPI 0.142, SQLAlchemy 2.1. Follow the
project's existing test style first (sync `TestClient` or async `AsyncClient`, fixture layout,
markers). The rules below are about what each choice silently changes.

Contents: [pytest-asyncio configuration](#pytest-asyncio-configuration) ·
[httpx and httpx2](#httpx-and-httpx2) · [Choosing a client](#choosing-a-client) ·
[Dependency overrides](#dependency-overrides) · [Database tests](#database-tests) ·
[What to test through the client](#what-to-test-through-the-client) · [Gotchas](#gotchas)

## pytest-asyncio configuration

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "session"
asyncio_default_test_loop_scope = "session"
```

- `asyncio_mode` defaults to `strict`. In strict mode an `async def` test without
  `@pytest.mark.asyncio` **fails** ("async def functions are not natively supported"), and an async
  fixture declared with plain `@pytest.fixture` is an error; it needs `@pytest_asyncio.fixture`.
  With `auto`, both work without decoration. Check which mode the project uses before adding tests.
- Some projects use AnyIO's pytest plugin instead (it is installed with FastAPI): tests marked
  `@pytest.mark.anyio` run with plain `@pytest.fixture` async fixtures and need no pytest-asyncio
  decorators. Do not mix the two styles in one module: in `auto` mode an `anyio` test also gets the
  `asyncio` marker, and its fixtures run on pytest-asyncio's loop while the test runs on AnyIO's.
  AnyIO's plugin parametrizes `anyio_backend` over asyncio and trio (since 4.12 only over the
  installed backends): with `trio` installed (also transitively) every `anyio` test runs twice,
  and the trio run of asyncio-only code fails with
  `TypeError: trio.run received unrecognized yield message`; before 4.12 the trio run fails even
  without trio installed. Define an `anyio_backend` fixture returning `"asyncio"` in
  `conftest.py`.
- By default every test runs on **its own event loop**. Anything bound to a loop that is created in
  one test or in a wider fixture and reused in another test breaks: pooled asyncpg connections of
  an engine, an `httpx.AsyncClient` with open network connections (`RuntimeError: Event loop is
  closed`), a lock under contention. An `AsyncClient` over `ASGITransport` and an uncontended lock
  happen to work.
- With asyncpg the symptoms are misleading and vary:
  `RuntimeError: ... attached to a different loop`,
  `InterfaceError: cannot perform operation: another operation is in progress`, or
  `InterfaceError: cannot rollback; the transaction is in error state`. They start at the first
  test when a session fixture has already connected, at the second test otherwise, and then appear
  **intermittently** (or at every teardown when a per-test connection fixture is used), because
  the pool discards each broken connection. SQLite (`aiosqlite`) does not reproduce the problem.
- Setting only `asyncio_default_fixture_loop_scope = "session"` is not enough: all async fixtures,
  function-scoped ones included, then run on the session loop while each test still gets its own
  loop. Set the test loop scope as well.
- The shared session loop also carries state over: a task started in one test and not awaited is
  still running during the next tests, and its exception surfaces only as
  `Task exception was never retrieved` after the run, failing no test. With function-scoped loops
  such tasks are cancelled when the loop closes.
- `freezegun.freeze_time` freezes `loop.time()` too (default `real_asyncio=False`): any
  `asyncio.sleep(...)` or `asyncio.timeout` in the code under test never fires and the test hangs
  without an error. Use `freeze_time(..., real_asyncio=True)` or `time-machine`, which leaves the
  monotonic clock alone.

## httpx and httpx2

Starlette 1.7 builds `TestClient` on `httpx2` when it is installed and falls back to `httpx` with a
deprecation warning. FastAPI 0.142's `standard` extra still installs `httpx`. Observed behavior is
the same for `httpx` 0.28 and `httpx2` 2.13 in everything this file describes (redirects, lifespan,
re-raised exceptions, 5 s default timeout, `ASGITransport`). This file uses `httpx`.

When **both** packages are installed, `TestClient` uses `httpx2` without any message, while
application and test code that does `import httpx` keeps using `httpx`. The two have separate
class hierarchies: `except httpx.HTTPError` does not catch what `TestClient` raises, and objects of
one package are not instances of the other's types. Check `pip list` for both before relying on
exception types or `isinstance` checks in tests. With only `httpx` installed, importing
`fastapi.testclient` emits the deprecation warning, which fails the test run in projects that set
`filterwarnings = error`. The warning is `starlette.exceptions.StarletteDeprecationWarning`, a
`UserWarning` subclass rather than a `DeprecationWarning` (Starlette 1.7.0): `-W error::DeprecationWarning`
does not catch it, `-W error` does.

## Choosing a client

| | `TestClient(app)` | `AsyncClient(transport=ASGITransport(app=app))` |
|---|---|---|
| Test function | `def` | `async def` |
| Application runs on | a separate thread; one loop per `with` block, or **one per request** without `with` | the test's loop |
| Lifespan | only inside `with TestClient(app) as client:` | never |
| Redirects | followed | **not followed** (`307` is returned) |
| Unhandled exception in the app | re-raised in the test | re-raised in the test |
| Streaming response | fully buffered before the call returns | fully buffered |
| WebSockets | `with client.websocket_connect(...) as ws:` (the `with` block performs the handshake; a bare call runs nothing) | not available (`404`) |
| `Host` header / `request.client` | `testserver` / `("testclient", 50000)` | `test` from `base_url` / `("127.0.0.1", 123)` |

- Because `TestClient` runs the application on another loop, async fixtures of the test (engine,
  session) cannot be shared with the application. Tests that need to share a database session with
  the application use `AsyncClient`.
- To assert on the `500` response instead of the exception, use
  `TestClient(app, raise_server_exceptions=False)` or
  `ASGITransport(app=app, raise_app_exceptions=False)`. This also applies when the application
  registers `@app.exception_handler(Exception)`: the handler runs, and the exception is re-raised
  in the test anyway, so the handler's body is never seen without the flag. Handlers for specific
  exception classes return their response normally.
- Because a bare `TestClient(app)` runs every request on a fresh loop, an engine created at import
  time fails on the **second request** with the asyncpg `InterfaceError` above; inside `with` it
  fails in the second test. Use `NullPool` for such engines in tests, or create the engine in
  `lifespan`.
- Request timeouts (`timeout=`) have no effect with either in-process client: a handler that takes
  longer simply takes longer and returns `200` (`TestClient` also emits a deprecation warning for
  the argument, an error under `filterwarnings = error`). Bound async tests with
  `asyncio.timeout(...)`, and test real network timeouts against a running server.
- With both clients, background tasks have finished when the call returns. That is a property of
  the in-process transports, not of a real server. A background task that raises fails the test
  (the exception is re-raised after the `200` response was produced); with exceptions disabled the
  test passes and the failure is lost, which is what a real server shows too. Later tasks of the
  same response do not run.
- The default `base_url` is `http://testserver`: `TrustedHostMiddleware` with a real allowlist
  answers `400 Invalid host header`, and cookies marked `Secure` are stored in the jar but **never
  sent** on the plain-`http` requests that follow, so the session looks lost. Tests of host checks, IP allowlists or secure session cookies
  then pass or fail for reasons unrelated to the code; pass `base_url="https://example.com"`.
- Cookies persist on a client instance: after `/login`, every later request of the same client
  sends the session cookie. A client fixture shared across tests carries a login into later tests.
  Per-request `cookies=` is deprecated (a `DeprecationWarning`, an error under
  `filterwarnings = error`); set `client.cookies` instead.
- Neither client yields streaming chunks as they are produced: the whole body is buffered before
  headers are available, and an endless generator hangs the test without an error. Bound the
  generator in tests, or test the generator function directly.

### Lifespan in tests

`ASGITransport` does not send lifespan events: `lifespan` never runs, `app.state` and
`request.state` stay empty, and handlers that do not touch that state pass anyway. Options:

```python
from collections.abc import AsyncIterator

import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
```

| Setup | lifespan runs | `app.state` | `request.state` (yielded dict) |
|---|---|---|---|
| `ASGITransport(app=app)` alone | no | empty | empty |
| `LifespanManager(app)` + `manager.app` | yes | set | set |
| `LifespanManager(app)` + original `app` | yes | set | **missing** |
| `async with app.router.lifespan_context(app)` | yes | set | **missing** |

- Pass `manager.app` to the transport. In the last two rows startup has run, so tests of handlers
  that read only `app.state` pass while handlers reading `request.state` fail.
- Alternatively do not run the lifespan and override every dependency that reads lifespan state, as
  in the database fixtures below.

## Dependency overrides

- The key is the **function object** used in `Depends(...)`. Overriding a different function with
  the same name, or a re-imported copy, has no effect and raises nothing.
- Overrides set on the main app do not reach an application attached with `app.mount(...)`; set
  them on the sub-application object. Dependencies declared on an `APIRouter` are overridable
  through the main app.
- Overrides live on the application instance. With a module-level `app`, an override set in one
  test stays for all later tests. Build the application per test (`create_app()` in a fixture), or
  clear the overrides in fixture teardown, not at the end of the test body (a failing assertion
  skips it).
- An override may declare its own parameters (`Header`, `Query`, other dependencies); FastAPI
  resolves them like for any dependency.
- Values cached outside FastAPI are not affected by overrides or `monkeypatch.setenv`: a settings
  function wrapped in `lru_cache` keeps returning the first object until `cache_clear()`. The leak
  goes both ways: settings created while a test had the variable set are still returned to later
  tests after `monkeypatch` has restored the environment. Clear the cache in a fixture before and
  after, or override the settings dependency.
- Parameters declared by an override are enforced on requests but are not part of the OpenAPI
  schema.

## Database tests

One connection and one outer transaction per test; the application and the test share that
connection; everything is rolled back at the end.

```python
import os
from collections.abc import AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncConnection,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.main import Base, create_app, current_user, get_session


@pytest.fixture(scope="session")
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(os.environ["TEST_DATABASE_URL"])
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture
async def connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    async with engine.connect() as conn:
        transaction = await conn.begin()
        yield conn
        await transaction.rollback()


@pytest.fixture
async def session(connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    maker = async_sessionmaker(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )
    async with maker() as session:
        yield session


@pytest.fixture
def app(connection: AsyncConnection) -> FastAPI:
    app = create_app()
    maker = async_sessionmaker(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with maker() as session:
            yield session

    app.dependency_overrides[get_session] = override_session
    app.dependency_overrides[current_user] = lambda: "alice"
    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
```

- This setup requires the session loop scope from the configuration above (the engine is
  session-scoped).
- With pytest-xdist every worker runs the session-scoped `engine` fixture against the same
  database: concurrent `create_all` fails with `UniqueViolationError ... pg_type_typname_nsp_index`
  and the first worker to finish drops the tables the others still use (observed: 6 passed, 18
  errors with `-n 4`; 24 passed serially). Give each worker its own schema or database (from
  `PYTEST_XDIST_WORKER`), or create the schema once before the workers start.
- `join_transaction_mode="create_savepoint"` is what makes this work; do not drop it. With the
  default mode a `rollback()` in the application (or its failed flush) ends the **outer**
  transaction: rows the test flushed earlier disappear, and later writes are really committed and
  stay in the database after the test unless the test session touches the connection first.
- `commit()` in the application ends a savepoint, not the outer transaction, so committed rows are
  visible to the test and gone after it. After an `IntegrityError` in the application the
  connection stays usable for the next request and for the test session.
- `rollback()` in the **test** session discards what the application committed since the test
  session's transaction began, and that transaction begins with the first flush **or query** the
  test session makes before the request (savepoints are nested on one connection). A test session
  first used after the request does not affect the application's rows.
- Rows added by the test become visible to the application after `flush()`; the test session and
  the application's sessions share the connection.
- The test session and the application's sessions are **different sessions**. Objects loaded in the
  test before the request keep their old values, and a plain re-query (`select(Item)`,
  `session.get`) returns the same identity-mapped object **with the old values**. Before asserting
  on changed data use `await session.refresh(obj)`, `execution_options(populate_existing=True)`, or
  select the columns (`select(Item.qty)`).
- Sequences are not rolled back. Ids keep growing between tests; never assert on a literal id.
- Everything runs on one connection, so this setup cannot show pool exhaustion, lock waits, or
  behavior that needs two concurrent transactions. Test those against the real engine and clean up
  with `TRUNCATE`.
- Do not replace PostgreSQL with SQLite for tests of code that uses PostgreSQL types or semantics
  (`JSONB`, `ON CONFLICT`, advisory locks, timezone handling). The tests pass and prove nothing
  about production. The rollback fixture above is also PostgreSQL-verified: with
  `sqlite+aiosqlite` the outer rollback does not undo the application's commit unless the
  connection is opened with `connect_args={"autocommit": False}`.

## What to test through the client

- Status codes on the failure paths: `401`, `403`, `404`, `409`, `422`. Remove an override to test
  the unauthenticated path.
- The response body as the client sees it (aliases, excluded fields, date formats), not the object
  returned by the handler.
- That a write is really stored: read it back with a **new** request or a fresh query, not from the
  object the handler returned.
- An assertion on a mock's `assert_called` proves only that the test called it. Assert on the
  observable result. For an `AsyncMock`, `assert_called_once_with(...)` also passes when the code
  **forgot the `await`** (the coroutine was created and dropped, `await_count == 0`); pytest
  reports it only as `PytestUnraisableExceptionWarning: coroutine ... was never awaited`. Use
  `assert_awaited_once_with(...)`.
- Patch where a name is **looked up**, not where it is defined: a module doing
  `from app.clients import send` must be patched as `app.service.send`.

## Gotchas

- Agent adds an `async def` test to a strict-mode project without the marker - the test fails as "not natively supported"; add `@pytest.mark.asyncio` or follow the project's mode.
- Agent uses a session- or module-scoped engine with default loop scopes - intermittent asyncpg `InterfaceError` or "different loop" failures.
- Agent sets only the fixture loop scope - tests still run on their own loops, and every async fixture is now on a different loop than its test.
- Agent reproduces a loop problem on SQLite - it does not occur there; use the project's database driver.
- Agent uses `ASGITransport` and expects `lifespan` state - it never ran; use `LifespanManager` with `manager.app`, or overrides.
- Agent writes `TestClient(app).get(...)` without the `with` block - no lifespan.
- Agent mixes `TestClient` with async database fixtures - the application runs on another loop.
- Agent moves a test from `TestClient` to `AsyncClient` - redirects are no longer followed, `307` appears.
- Agent clears `dependency_overrides` at the end of the test body - skipped when an assertion fails; clear in a fixture.
- Agent overrides a function that is not the one in `Depends(...)` - silently ignored.
- Agent sets an environment variable with `monkeypatch` after settings were cached - the old settings are used.
- Agent asserts on a literal primary key - sequences survive the rollback.
- Agent adds `-n auto` to a suite with a session-scoped schema fixture - workers collide on `create_all`/`drop_all`.
- Agent tests an `exception_handler(Exception)` body through the default client - the exception is re-raised before the body can be asserted.
- Agent tests an endless streaming endpoint - the client buffers the whole body and hangs.
- Agent overrides a dependency of a mounted sub-application on the main app - the real dependency runs.
- Agent uses a bare `TestClient(app)` with an import-time engine - the second request fails; `with` only postpones it to the second test; use `NullPool` or create the engine in `lifespan`.
- Agent has `trio` in the environment and uses `@pytest.mark.anyio` - every test runs twice and the trio run fails.
- Agent uses `freeze_time` around code that awaits a sleep or timeout - the test hangs.
- Agent shares a client fixture across tests - cookies from an earlier login leak into later tests.
- Agent tests `Secure` cookies or host allowlists with the default `http://testserver` - wrong result for the wrong reason.
- Agent leaves a task running at the end of a session-loop test - it keeps running through the rest of the suite.
- Agent asserts `assert_called_once_with` on an `AsyncMock` - passes when the `await` is missing; use `assert_awaited_once_with`.
- Agent calls `client.websocket_connect(...)` without `with` - no handshake, the endpoint never runs, the test passes.
- Agent sets `timeout=` on a test client to bound a slow handler - ignored in-process.
- Agent removes `join_transaction_mode="create_savepoint"` from the test sessionmaker - an application rollback ends the outer transaction and tests start leaving rows behind.
- Agent calls `session.rollback()` in a test session that was already used before the request - the application's committed rows vanish with it.
- Agent passes `app` instead of `manager.app` to the transport - `app.state` is set, `request.state` is not.
- Agent asserts on an ORM object loaded before the request, or re-queries it with a plain `select` - it still has the old values; `refresh()` it.
- Agent has both `httpx` and `httpx2` installed - `TestClient` uses `httpx2`; `except httpx.*` in tests catches nothing.
- Agent relies on a background task having run because the test passed - a real server runs it after the response.
- Agent tests PostgreSQL-specific code on SQLite - green tests, untested behavior.
- Agent puts `pytest.skip(allow_module_level=True)` in a `conftest.py` to skip a directory when an environment variable is unset - when that directory or a file in it is the command-line target, pytest loads the conftest as an initial conftest and exits with a traceback (pytest 9.1); skip from a session-scoped fixture instead.
- Agent proves that `lifespan` cancels its background task by checking after `with TestClient(app)` exits - `TestClient` cancels every leftover task when its loop closes, so the test passes without `owner.close()`; wrap `app.router.lifespan_context` and read `task.cancelled()` right after the original lifespan exits.
- Agent writes a thread-race test for a check-then-set done under two separate lock holds and sees it pass on the broken code - the GIL switch interval hides the race; `sys.setswitchinterval(1e-6)`, restored in `finally`, made the broken code fail 5 of 5 runs.
- Agent writes a concurrency test whose second caller waits on an `asyncio.Event` - against a regression the duplicate waits forever and the suite hangs instead of failing; bound it with `asyncio.timeout(1)`.
- Agent re-reads a row from a second session to prove a commit on SQLite with `StaticPool` - every session shares one connection, so the second session sees the first one's **uncommitted** rows; close the first session (which rolls back) before re-reading.
- Agent lets the application's lifespan (run by `TestClient`) populate and clear a module-level engine registry that a session-scoped fixture also fills - every database test collected after a lifespan test fails with the registry empty, and the suite is green in one collection order only; re-install the fixture's engines per test.

## Official sources

- [FastAPI: Testing](https://fastapi.tiangolo.com/tutorial/testing/)
- [FastAPI: Async tests](https://fastapi.tiangolo.com/advanced/async-tests/)
- [FastAPI: Testing dependencies with overrides](https://fastapi.tiangolo.com/advanced/testing-dependencies/)
- [pytest-asyncio: Configuration](https://pytest-asyncio.readthedocs.io/en/stable/reference/configuration.html)
- [SQLAlchemy: Joining a session into an external transaction](https://docs.sqlalchemy.org/en/21/orm/session_transaction.html#joining-a-session-into-an-external-transaction-such-as-for-test-suites)
