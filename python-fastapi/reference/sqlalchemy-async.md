# SQLAlchemy 2 async with FastAPI

Applies to SQLAlchemy 2.1 with `asyncpg` 0.31 on PostgreSQL. Async SQLAlchemy never performs
implicit I/O: every place where sync SQLAlchemy would quietly run a query (lazy load, refresh of an
expired attribute) raises `MissingGreenlet` instead. Most rules below follow from that.

Install with the extra: `sqlalchemy[asyncio]`. `greenlet` is a dependency of the `asyncio` extra
only (SQLAlchemy 2.1). Without it, `from sqlalchemy.ext.asyncio import ...` raises `ImportError`.

Contents: [Engine and session](#engine-and-session) · [Transactions](#transactions) ·
[Concurrency](#concurrency) · [Loading relationships](#loading-relationships) ·
[Server-generated values](#server-generated-values) · [Column types](#column-types) ·
[Identity map](#identity-map) · [Gotchas](#gotchas)

## Engine and session

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, object]]:
    engine = create_async_engine(
        "postgresql+asyncpg://app:secret@localhost:5432/app",
        pool_size=10,
        max_overflow=5,
        pool_timeout=5,
        pool_pre_ping=True,
    )
    try:
        yield {"sessionmaker": async_sessionmaker(engine, expire_on_commit=False)}
    finally:
        await engine.dispose()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.state.sessionmaker() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]
```

- One engine per process, created in `lifespan` and disposed after the `yield`. One session per
  request, never a module-level session.
- Pool connections belong to the event loop that created them. An engine created at import time and
  used from another loop (a second `asyncio.run`, a test with its own loop) fails when it **reuses
  a pooled connection** from the earlier loop. The message depends on the configuration: with
  `pool_pre_ping=True` a `RuntimeError: ... attached to a different loop`; without it an asyncpg
  `InterfaceError: cannot rollback; the transaction is in error state` that does not mention loops.
  The broken connection is then discarded, so failures alternate (every second test or run), which
  looks like flakiness. Creating the engine in `lifespan` avoids this in the application; for tests
  see [testing](testing.md#pytest-asyncio-configuration).
- Total connections are `(pool_size + max_overflow) x worker processes x replicas`. Keep that under
  the server's `max_connections`.
- `pool_timeout` limits only the wait for a free pool connection. It does not limit how long a
  query, a lock wait, or a transaction runs; use the server settings for that (`statement_timeout`,
  `lock_timeout`, `idle_in_transaction_session_timeout`, for example through
  `connect_args={"server_settings": {...}}`).
- `pool_pre_ping` and `pool_recycle` act when a connection is **checked out**. They do not protect
  a connection that is already in use: when the server ends an idle-in-transaction session while
  the handler awaits something else, the next statement fails with
  `InterfaceError: ... the underlying connection is closed`. After `await session.rollback()` the
  session reconnects and works again; objects loaded before are expired.
- `engine.dispose()` closes pooled connections, not connections that are still checked out.
- Set `expire_on_commit=False`. With the default (`True`), reading any attribute of an object after
  `commit()`, the primary key included, raises `MissingGreenlet` while the session is open and
  `DetachedInstanceError` after it is closed.
- `expire_on_commit=False` covers commits only. `rollback()` expires every loaded object; reading
  one afterwards raises `MissingGreenlet`. Reload objects after a rollback. A savepoint rollback
  expires only the objects that were changed inside the savepoint.

## Transactions

- A session begins a transaction on first use (autobegin), **including reads**. `in_transaction()`
  is `True` after a plain `select`.
- Pending changes are flushed automatically before **any** statement the session executes, `text()`
  and Core statements included. An invalid pending object therefore fails at the next unrelated
  read, with `IntegrityError: (raised as a result of Query-invoked autoflush ...)`.
- Closing a session without `commit()` rolls back. A handler that adds objects, flushes, and
  returns `201` without committing has written nothing, and nothing reports it.
- `async with session.begin():` raises `InvalidRequestError: A transaction is already begun on this
  Session` when anything (an authentication dependency, an existence check) has already used the
  session. Inside request handling, call `await session.commit()` explicitly. Use
  `async with sessionmaker.begin() as session:` only where the code owns the whole session (jobs,
  scripts, consumers).
- Commit once per request, in the handler or service that owns the use case. Repositories flush;
  they do not commit.
- After a failed statement the session is unusable until `await session.rollback()`. After a failed
  flush or commit the next statement raises `PendingRollbackError`; after a failed `execute()`
  (Core or `text()` statement) it raises `DBAPIError: current transaction is aborted, commands
  ignored until end of transaction block`. To recover from an expected failure and continue,
  isolate it in a savepoint. Objects that were pending before the savepoint are flushed when the
  savepoint begins and survive its rollback. Without the leading `flush()` in the function below,
  an invalid **earlier** object would fail inside the `try`: the function would return `False` for
  a name that is new. With the leading `flush()`, that `IntegrityError` reaches the caller.

```python
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Tag(Base):
    __tablename__ = "tag"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(unique=True)


async def add_tag_if_new(session: AsyncSession, name: str) -> bool:
    await session.flush()  # earlier pending objects fail here, not inside the savepoint
    try:
        async with session.begin_nested():
            session.add(Tag(name=name))
            await session.flush()
    except IntegrityError:
        return False
    return True
```

- The session holds its connection from the first statement until commit, rollback, or close. A
  handler that reads and then awaits a slow outbound call keeps the connection checked out for the
  whole call. Observed with `pool_size=1`, `max_overflow=0`, `pool_timeout=1`, three concurrent
  handlers, a 0.6 s await after a read: the third fails with
  `TimeoutError: QueuePool limit of size 1 overflow 0 reached`. With `commit()` before the await
  all three finish in 0.6 s. With the defaults (`max_overflow=10`, `pool_timeout=30`) the same
  code shows up as latency first and as errors only under sustained load. Finish database work,
  commit, then call other services.
- With the default dependency scope the session closes after the response and after background
  tasks ([fastapi-basics](fastapi-basics.md#dependencies-with-yield)). A background task that uses
  the request's session therefore works, silently, and holds a connection from its first statement
  until the task ends. If the handler did not commit or roll back, the connection is held for the
  whole task even when the task never touches the session. Background tasks should open their own
  session.

## Concurrency

An `AsyncSession` is not safe for concurrent use. What `asyncio.gather` or a `TaskGroup` over one
shared session does depends on the state of the session:

| Shared session, concurrent... | Result |
|---|---|
| reads, session already holds its connection | pass, but run **one after the other**: no speed-up |
| first statements of the session (connection not yet checked out) | `InvalidRequestError: This session is provisioning a new connection; concurrent operations are not permitted`; always with `pool_pre_ping=True`, otherwise when the pool has to open a connection |
| `flush()` | `InvalidRequestError: Session is already flushing` |
| `commit()` next to other statements, `stream()` | `InterfaceError: ... another operation is in progress` and related state errors |

So the code can pass when an earlier dependency has already used the session and fail when it has
not, and it never runs queries in parallel. For parallel queries, give each task its own session:

```python
import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


async def count(sessionmaker: async_sessionmaker[AsyncSession], table: str) -> int:
    async with sessionmaker() as session:
        result = await session.execute(text(f"select count(*) from {table}"))  # trusted name
        return result.scalar_one()


async def counts(sessionmaker: async_sessionmaker[AsyncSession]) -> list[int]:
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(count(sessionmaker, t)) for t in ("author", "post")]
    return [t.result() for t in tasks]
```

Each parallel task uses its own pooled connection and its own transaction, so they do not see each
other's uncommitted changes.

## Loading relationships

- Accessing a relationship that was not loaded raises `MissingGreenlet` while the session is open
  and `DetachedInstanceError` after it is closed. Load what the response needs in the query:
  `selectinload` for collections, `joinedload` for many-to-one.
- Exception: an unloaded many-to-one whose target object is already in the session's identity map
  resolves without I/O and returns normally. The same access passes or fails depending on what
  earlier code in the request happened to load.
- `joinedload` of a collection requires `.unique()` on the result, otherwise `InvalidRequestError`.
- Pagination: `LIMIT` counts rows, not parents. `select(Parent).join(Parent.children).limit(2)`
  returned **one** parent (its first two child rows), also with `selectinload` and `.unique()`.
  Filter with `Parent.children.any(...)` (an `EXISTS`), page the parents, and load the children
  with `selectinload`. `joinedload(Parent.children)` with `.limit()` is safe too: SQLAlchemy applies
  the limit to the parents in a subquery.
- Set `lazy="raise"` on relationships so a missing eager load fails in every environment, including
  sync test helpers (`InvalidRequestError: 'Author.posts' is not available due to lazy='raise'`).
- For a single on-demand load, mix in `AsyncAttrs` and `await obj.awaitable_attrs.posts`. This
  works only for relationships with the default loader: on a `lazy="raise"` relationship
  `awaitable_attrs` raises the same error. Choose one of the two per relationship.
- A response model with `from_attributes=True` reads **every** declared field from the ORM object.
  A field backed by an unloaded relationship makes the response fail with
  `ResponseValidationError` (`500`), after the handler has returned.

## Server-generated values

- `server_default` columns are fetched with the `INSERT` (`RETURNING`) and are readable after
  `flush()`.
- Columns whose `onupdate=` is a SQL expression (`func.now()`) are **expired after every `UPDATE`
  flush** and are not fetched, with default mapper settings. Reading one afterwards raises
  `MissingGreenlet`, also with `expire_on_commit=False`. The typical failure: a `PATCH` handler
  commits and returns the entity; the response model reads `updated_at`; the client gets `500`
  although the change **is committed**, and retries.
  Call `await session.refresh(obj)` after the commit, before returning, or set
  `__mapper_args__ = {"eager_defaults": True}` on the model so the value is fetched with the
  `UPDATE`. A Python callable (`onupdate=lambda: datetime.now(UTC)`) is computed in the process and
  is not expired.
- A test that sends the **same** value again emits no `UPDATE` and passes. Test updates with a
  changed value.
- `await session.refresh(obj)` discards changes to `obj` that have not been flushed. Flush or
  commit first.
- A plain `refresh(obj)` also expires relationships that were populated **without** a loader
  option or an eager `lazy=` setting (children assigned in the constructor, or loaded through
  `awaitable_attrs`); reading them afterwards raises `MissingGreenlet`. Collections loaded with
  `selectinload` stay loaded. Refresh only the columns that are needed:
  `await session.refresh(obj, ["updated_at"])`.

```python
from datetime import datetime

from sqlalchemy import DateTime, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Note(Base):
    __tablename__ = "note"
    id: Mapped[int] = mapped_column(primary_key=True)
    body: Mapped[str]
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


async def edit(session: AsyncSession, note: Note, body: str) -> Note:
    note.body = body
    await session.commit()
    await session.refresh(note, ["updated_at"])
    return note
```

- `onupdate` is applied by SQLAlchemy when it builds the statement: ORM flushes and `update()`
  constructs set it; raw SQL (`text("update ...")`), other applications and manual fixes do not.
  PostgreSQL upserts built with `insert(...).on_conflict_do_update(...)` do **not** apply it
  either; put the column into `set_` explicitly.
  Use a database trigger when the column must always be maintained.

## Column types

- `Enum(PyEnum)` stores the member **name** (`ADMIN`), not the value (`"admin"`), also with
  `native_enum=False`. Renaming a member breaks existing rows. To store values, pass
  `values_callable=lambda e: [m.value for m in e]`.
- In-place changes to a `JSONB`/`JSON` value (`obj.meta["k"] = "v"`) are not detected and are not
  written; the commit succeeds. Assign a **new** dict (`obj.meta = {**obj.meta, "k": "v"}`);
  assigning the same, mutated object back is not detected either. `MutableDict.as_mutable(JSONB)`
  tracks top-level keys only: `obj.meta["a"]["b"] = 1` is still lost. For nested changes build the
  new structure **without touching the old one**
  (`obj.meta = {**obj.meta, "a": {**obj.meta["a"], "b": 1}}`). Mutating the nested value first and
  then assigning a shallow copy (`{**obj.meta}`) is not saved, because the loaded value it is
  compared with was mutated too. After an in-place change call `flag_modified(obj, "meta")`
  (`sqlalchemy.orm.attributes`).
- Use `DateTime(timezone=True)` and timezone-aware values. A naive `datetime` written to a
  `timestamptz` column through asyncpg is interpreted in the **process's local timezone**, so the
  same code stores different instants on a laptop and in a UTC container.

## Identity map

With `expire_on_commit=False`, objects keep their loaded state across commits.
`session.get()` and `select()` return the already loaded object with its old attribute values even
if another transaction has changed the row. Where current data matters, use
`execution_options(populate_existing=True)` or `await session.refresh(obj)`.

- What "current" means depends on the isolation level. With `REPEATABLE READ`, `refresh()` inside
  the running transaction still returns the old row; the change is visible only after the
  transaction ends. With PostgreSQL's default `READ COMMITTED`, each statement sees a newer
  snapshot, so the two queries of a `selectinload` can see different states.
- `update()` and `delete()` statements synchronize loaded objects by default. With
  `execution_options(synchronize_session=False)` the loaded objects keep their old values, also
  after commit, until they are refreshed. Neither form runs ORM relationship cascades:
  `delete(Parent)` with children and no `ON DELETE CASCADE` in the database fails with a foreign
  key violation, while `session.delete(parent)` removes the children. With `ON DELETE CASCADE`
  the rows are deleted, but children already loaded in the session stay readable and
  `session.get()` keeps returning them.

## Gotchas

- Agent flushes and returns without `commit()` - the session closes with a rollback; the client gets `201` and nothing is stored.
- Agent commits in the dependency after `yield` - the response is already sent when the commit fails.
- Agent wraps writes in `async with session.begin():` inside a handler - fails as soon as any dependency has used the session.
- Agent returns an updated entity whose `onupdate` is a SQL expression, without `refresh()` or `eager_defaults` - `500` after a successful commit.
- Agent leaves `expire_on_commit` at its default - any attribute access after commit raises `MissingGreenlet`.
- Agent accesses an unloaded relationship, directly or through a `from_attributes` response model - `MissingGreenlet` / `ResponseValidationError`.
- Agent uses `asyncio.gather` with one shared session - queries run one after the other, or fail, depending on whether the session already holds a connection.
- Agent awaits an outbound HTTP call while the session's transaction is open - the connection stays checked out and the pool runs out; commit first.
- Agent leaves an invalid object pending - the next unrelated query fails through autoflush.
- Agent paginates a query that joins a collection - `LIMIT` cuts child rows, fewer parents than requested.
- Agent uses `on_conflict_do_update` and expects `onupdate` columns to change - they do not.
- Agent reads objects after `rollback()` - they are expired even with `expire_on_commit=False`.
- Agent calls `refresh()` on an object with unflushed changes - the changes are discarded.
- Agent calls a plain `refresh(obj)` on an object whose children were assigned in the constructor - the relationship is expired; refresh named columns only.
- Agent bulk-deletes parents with `delete()` and relies on the ORM cascade - foreign key violation, or stale children left in the session.
- Agent sets `pool_timeout` to bound slow queries - it only bounds waiting for a connection.
- Agent continues with a session after `IntegrityError` without rollback - `PendingRollbackError` or "current transaction is aborted"; use `begin_nested()`.
- Agent reads an unloaded many-to-one that works in one code path - the target was in the identity map; another path raises `MissingGreenlet`.
- Agent passes the request's session to a background task - it works and, once the task uses it, holds a connection until the task ends.
- Agent mutates a JSON column in place, or a nested value under `MutableDict` - the change is silently not saved.
- Agent combines `lazy="raise"` with `awaitable_attrs` on the same relationship - it raises.
- Agent tests an update by re-sending unchanged data - no `UPDATE` is issued and the `onupdate` failure stays hidden.
- Agent assumes `Enum` stores `.value` - it stores the member name.
- Agent relies on `onupdate` for rows changed by raw SQL - the column is not touched.
- Agent writes naive datetimes (`datetime.now()`, `datetime.utcnow()`) - the stored instant depends on the host timezone.
- Agent creates the engine at import time and uses it from more than one event loop - intermittent asyncpg `InterfaceError` or "different loop" errors.
- Agent installs `sqlalchemy` without the `asyncio` extra - no `greenlet`; importing `sqlalchemy.ext.asyncio` fails.
- Agent calls `session.in_transaction()` on an `async_scoped_session` - `AttributeError`: the proxy forwards `begin`, `commit`, `rollback`, `flush`, `refresh` and `execute` but not `in_transaction` (SQLAlchemy 2.0.48 and 2.1.3). Call it on the current session (`session()`), and remember that autobegin makes it `True` after any read.
- Agent passes `poolclass=StaticPool` for every `sqlite+aiosqlite` URL, file databases included - all sessions share one connection, so another request's `close()` (a rollback) discards this request's flushed rows and its commit stores nothing. Use StaticPool only for `:memory:`, no-database and `mode=memory` URLs; SQLAlchemy 2.1.3 deprecates choosing it by itself for `mode=memory`.
- Agent creates two engines from one in-memory SQLite URL (writer and reader) - two separate databases: `create_all` on one, `no such table` on the other.
- Agent routes reads to a replica from `get_bind` by statement type (`Insert`/`Update`/`Delete` to the writer, everything else to the reader) - `refresh()` after `flush()`, a `SELECT` after Core DML, `with_for_update()`, `text()` DML and the pre-`SELECT` of `synchronize_session="fetch"` all hit the reader (verified with two file engines on one SQLite file). Pin the session to the writer after its first write (`after_flush`, and `do_orm_execute` for ORM update/delete) and give locking reads an explicit opt-in.

## Official sources

- [SQLAlchemy: Asynchronous I/O (asyncio)](https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html)
- [SQLAlchemy: Session basics](https://docs.sqlalchemy.org/en/21/orm/session_basics.html)
- [SQLAlchemy: Relationship loading techniques](https://docs.sqlalchemy.org/en/21/orm/queryguide/relationships.html)
- [SQLAlchemy: Mutation tracking](https://docs.sqlalchemy.org/en/21/orm/extensions/mutable.html)
