# Redis: caching, locks, rate limits, and job queues

Applies to `redis` 8.1 (`redis.asyncio`) against Redis 8, and `arq` 0.25 as the job-queue example.
`arq` 0.25's worker (`arq` CLI, `run_worker`) does not start on Python 3.14
(`RuntimeError: There is no current event loop`, it calls `asyncio.get_event_loop()`); run workers
on 3.13, or set a loop before the worker is built (`asyncio.set_event_loop(asyncio.new_event_loop())`
before `run_worker(...)`, or at the top of the module that defines `WorkerSettings` for the CLI).
Enqueueing works.
Redis answers fast and rarely raises, which is exactly why the mistakes below stay hidden.

Contents: [Client](#client) · [Keys and expiry](#keys-and-expiry) · [Locks](#locks) ·
[Pipelines and atomicity](#pipelines-and-atomicity) · [Job queues (arq)](#job-queues-arq) ·
[Gotchas](#gotchas)

## Client

```python
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import redis.asyncio as redis
from fastapi import Depends, FastAPI, Request


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, object]]:
    client = redis.from_url(
        "redis://localhost:6379/0",
        decode_responses=True,
        socket_timeout=2.0,
        socket_connect_timeout=2.0,
        health_check_interval=30,
    )
    try:
        yield {"redis": client}
    finally:
        await client.aclose()


def get_redis(request: Request) -> redis.Redis:
    return request.state.redis


Redis = Annotated[redis.Redis, Depends(get_redis)]
```

- Defaults (redis 8.1): `socket_timeout` and `socket_connect_timeout` are 5 seconds (older
  releases had `None`, and `socket_timeout=None` hangs forever on a stalled server);
  `max_connections=100`; `decode_responses=False`. Set the timeouts explicitly per workload
  rather than relying on the version's default.
- Without `decode_responses=True` every value comes back as `bytes`: `await r.get("k")` is
  `b"v"`, and an integer stored with `set` is `b"1"` while `incr` returns `int`. Code that
  compares to `str` silently never matches. Pick one setting per client.
- Values are strings. A JSON round trip turns `datetime`, `Decimal` and `UUID` into `str`; parse
  with a Pydantic model (`Model.model_validate_json`) rather than `json.loads`.
- The client is a pool bound to the loop that first used it. A module-level client used from a
  second loop (a test, a `def` handler's `asyncio.run`) fails with `Event loop is closed`; create
  it in `lifespan` ([http-clients](http-clients.md#one-client-per-process-created-in-lifespan)
  has the same rule for httpx).
- `max_connections` is a hard limit: the default pool raises `MaxConnectionsError: Too many
  connections` immediately instead of waiting. Use `BlockingConnectionPool` (with a `timeout`) if
  waiting is preferred to failing.
- A `socket_timeout` shorter than a blocking command's own timeout (`BLPOP ... timeout=2` with
  `socket_timeout=0.5`) raises a client-side `redis.exceptions.TimeoutError` before the server answers. Give
  blocking commands a client whose `socket_timeout` exceeds their wait, or `None`.
- A server that is down fails at once with `ConnectionError` for a client from
  `redis.from_url(...)` (no retries), but a client built with `redis.Redis(host=...)` retries ten
  times with backoff first (about 4 s here). A server that is up but slow blocks a `from_url`
  client for `socket_timeout`, and a `redis.Redis(host=...)` client for about eleven times that
  (59 s at the defaults), because it retries timeouts too. Catch both around every cache access,
  or the cache becomes a hard dependency; and know which constructor the project uses before
  reasoning about latency. The exceptions are `redis.exceptions.TimeoutError` and
  `redis.exceptions.ConnectionError`, which are **not** the builtins of the same name:
  `except TimeoutError:` without the import catches nothing. Catch `redis.exceptions.RedisError`.
- That default retry resends the **whole command**, on a lost reply and on a read timeout alike.
  When the reply is lost after the server executed it, one `incr()` call runs twice on the server
  and returns `2`; when replies are slower than `socket_timeout`, it ran eleven times and still
  raised. A `from_url` client runs it once and raises, leaving the caller unsure whether it ran. Non-idempotent
  commands (`INCR`, `LPUSH`, `XADD`) need either no automatic retry or a dedupe key.

## Keys and expiry

- `SET key value` on a key that has a TTL **removes the TTL** (the key becomes persistent).
  Re-setting a cached value without `ex=`/`keepttl=True` turns a 5-minute cache entry into a
  permanent one. `HSET`, `INCR` and other in-place updates keep the TTL.
- `delete("user:*")` deletes nothing (a literal key named `user:*`) and returns `0`. Enumerate
  with `scan_iter("user:*")` and delete the matches; `KEYS` blocks the server (5 ms for 50k keys
  here, seconds in a large keyspace) and is the wrong tool in a request.
- Every cache key needs a TTL; a keyspace without expiry grows until `maxmemory` and then either
  evicts (`allkeys-lru`) or refuses writes (`noeviction`), depending on the server, not on your code.

## Locks

- `SET key token NX EX seconds` is the lock. Releasing with a plain `DELETE` removes **whoever's**
  lock is there: after the TTL expired and another worker took the lock, the first worker's
  `delete` frees it for a third. Release only if the token matches (a Lua script, or
  `redis.asyncio.lock.Lock`), and treat the TTL as the maximum critical-section time.
- `client.lock(name, timeout=...)`: `release()` after the lock expired raises
  `LockNotOwnedError`; the work done meanwhile was not protected. Choose `timeout` above the
  worst-case duration, or extend the lock while working.
- Create a **new** `Lock` object per acquisition. The token lives on the object, so a `Lock`
  stored on the app or a module and shared by requests defeats the ownership check: after A's
  lock expired and B acquired through the same object, A's late `release()` succeeds and deletes
  B's lock.
- A lock held across an `await` of an outbound call is a lock held for that call's timeout.

## Pipelines and atomicity

- `client.pipeline()` is a `MULTI`/`EXEC` transaction by default. It does **not** roll back: a
  command that fails while **executing** (`INCR` on a string) raises `ResponseError` and the other
  commands are applied anyway. A command rejected while being **queued** (wrong arity, unknown
  command) aborts the whole transaction and nothing is applied. Check-then-set logic needs `WATCH` (`pipeline(transaction=True)` with
  `watch`) or a Lua script.
- Rate limiting with `GET` then `INCR` is a race between requests. `INCR` followed by `EXPIRE`
  "when the count is 1" has its own hole: a request that dies between the two leaves a counter
  with no TTL, and every later request sees a count above 1 and never sets one, so the client is
  limited forever. Decide on the value `INCR` returns and set the expiry atomically (a Lua script,
  or `EXPIRE key seconds NX` on every hit). A `Semaphore` in the process limits one worker only.

## Job queues (arq)

```python
from arq import create_pool
from arq.connections import RedisSettings


async def enqueue_report(report_id: str) -> str | None:
    pool = await create_pool(RedisSettings(host="localhost", port=6379))
    try:
        job = await pool.enqueue_job("build_report", report_id, _job_id=f"report:{report_id}")
        return job.job_id if job else None  # None: this id is queued, running, or finished and kept
    finally:
        await pool.aclose()
```

- `enqueue_job` with an existing `_job_id` returns **`None`** instead of a job: deduplication is
  silent. It applies while the job is queued or running **and while its result is kept**
  (`keep_result`, 1 hour by default), so re-enqueueing a finished job under the same id is dropped
  for an hour. The check looks only at the job and result keys: with a short `_expires` the job
  key can vanish while the job is still running, and the same id is then accepted again. Code
  that ignores the return value believes it enqueued something.
- Enqueueing a function name the worker does not know succeeds; the job fails on the worker with
  `JobExecutionFailed: function 'x' not found`.
- A failing job is **not retried** by default: a plain exception or a `job_timeout` marks it
  failed after one try. `max_tries` (default 5) counts `arq.Retry` and re-runs after a worker
  shutdown (`CancelledError`); after that many, the job fails with `max 5 retries exceeded`.
- `Job.status()` reports `complete` for failed jobs too; check `result_info().success`, or call
  `job.result()`, which re-raises the job's exception. With `keep_result=0` there is nothing to
  check: status is `not_found`, `result_info()` is `None`, `result()` raises `ResultNotFound`.
- Defaults: `job_timeout=300`, `keep_result=3600`, `max_jobs=10` per worker, `poll_delay=0.5`.
  A job longer than `job_timeout` is cancelled and marked failed.
- Jobs must be idempotent: a worker stopped with SIGTERM re-queues its running job immediately; a
  worker killed with SIGKILL leaves it `in_progress` until the in-progress key expires (the
  largest timeout among the worker's functions + 10 s, counted from the job's start; about 5
  minutes by default), and only then is it re-run. During that
  window the same `_job_id` cannot be enqueued again. Nothing signals the partial work.

## Gotchas

- Agent passes `socket_timeout=None` "to avoid timeouts" - requests hang forever when Redis stalls.
- Agent runs an `arq` worker on Python 3.14 - it fails at startup.
- Agent forgets `decode_responses` - `bytes` values, comparisons never match.
- Agent stores a model with `model_dump_json` (or `json.dumps(..., default=str)`) and reads it back with `json.loads` - datetimes and decimals come back as strings.
- Agent keeps a module-level client - `Event loop is closed` in tests.
- Agent switches from `from_url` to `Redis(host=...)` - a dead server now costs seconds of retries per call.
- Agent sets `max_connections` and expects queueing - immediate `MaxConnectionsError`.
- Agent runs `BLPOP` with a client that has a short `socket_timeout` - client-side `TimeoutError`.
- Agent refreshes a cached value with a plain `set` - the TTL is gone.
- Agent calls `delete("prefix:*")` - nothing deleted, returns `0`.
- Agent releases a lock with `delete` - releases someone else's lock after expiry.
- Agent keeps one `Lock` object on the app and shares it between requests - a late release frees another request's lock.
- Agent uses `Redis(host=...)` for counters - a lost or slow reply makes the default retry run `INCR` again.
- Agent writes `except TimeoutError:` around a Redis call - redis-py's `TimeoutError` is a different class; nothing is caught.
- Agent holds a lock across a slow outbound call - the lock expires mid-work.
- Agent treats a pipeline as a rollback-capable transaction - after an execution error the other commands stay applied.
- Agent implements a rate limit with `get` then `incr` - concurrent requests slip through.
- Agent sets the rate-limit expiry only when the count is 1 - one crashed request leaves a counter without TTL and a client blocked forever.
- Agent ignores the return value of `enqueue_job` with `_job_id` - duplicates are silently dropped as `None`.
- Agent expects failed jobs to be retried - only `arq.Retry` (and worker shutdown) retries.
- Agent re-enqueues a finished job with the same `_job_id` - dropped while the result is kept.
- Agent checks `status() == "complete"` as success - failed jobs are `complete` too.

## Official sources

- [redis-py: Asyncio examples](https://redis.readthedocs.io/en/stable/examples/asyncio_examples.html)
- [redis-py: Connection pools](https://redis.readthedocs.io/en/stable/connections.html)
- [Redis: SET command (EX, NX, KEEPTTL)](https://redis.io/docs/latest/commands/set/)
- [Redis: Distributed locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)
- [arq documentation](https://arq-docs.helpmanual.io/)
