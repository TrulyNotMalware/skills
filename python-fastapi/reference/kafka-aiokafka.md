# Kafka with aiokafka

Applies to aiokafka 0.14 against Kafka 4.x (KRaft). Kafka delivers at-least-once by default and
loses messages silently whenever the client is used like a function call. Every statement below
was observed against a three-broker cluster.

Contents: [Producer](#producer) · [Consumer](#consumer) ·
[Publishing from a transaction](#publishing-from-a-transaction) · [Gotchas](#gotchas)

## Producer

```python
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from aiokafka import AIOKafkaProducer
from fastapi import FastAPI, Request


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[dict[str, object]]:
    producer = AIOKafkaProducer(
        bootstrap_servers="localhost:9092",
        enable_idempotence=True,  # implies acks="all"
        value_serializer=lambda v: json.dumps(v).encode(),
    )
    await producer.start()
    try:
        yield {"producer": producer}
    finally:
        await producer.stop()  # flushes pending batches


async def publish(request: Request, topic: str, key: str, value: dict[str, Any]) -> None:
    producer: AIOKafkaProducer = request.state.producer
    await producer.send_and_wait(topic, value, key=key.encode())
```

- One producer per process, started in `lifespan`. Starting one per request costs a metadata
  round trip and a connection per request.
- `producer.send(...)` is a coroutine that returns a **future**: `await producer.send(...)`
  enqueues the message and the future resolves when the broker acknowledged it. Calling
  `producer.send(...)` **without `await`** creates a coroutine that is never run: the message is
  dropped, the only trace is a `RuntimeWarning: coroutine ... was never awaited`. An awaited
  `send` whose future is never awaited is delivered by the producer's background sender while the
  loop keeps running, and by `stop()`/`flush()` at the end; a process that exits right after the
  `send` without `stop()` drops it, leaving at most a `ResourceWarning: Unclosed
  AIOKafkaProducer`, and a broker error for it never reaches the caller (at most asyncio logs
  `Future exception was never retrieved` when the future is garbage-collected). Inside a request use
  `send_and_wait`, or keep the future and check it.
- A timeout or cancellation around `send_and_wait` does not cancel the publish. Once the message
  is queued it is still delivered although the caller saw `TimeoutError`; if the timeout hit
  before it was queued, it is not. The caller cannot tell which, so a retry can publish the event
  twice, also with `enable_idempotence=True` (that deduplicates the producer's own retries, not a
  second `send`). Put an event id in the message and dedupe in consumers.
- Defaults (0.14): `enable_idempotence=False`, `acks=1`, `linger_ms=0`. With `acks=1` a leader
  that fails after acknowledging loses the message; a retried send can duplicate. Set
  `enable_idempotence=True` for a producer whose messages matter.
- A serializer error (`TypeError: ... not JSON serializable`) is raised from `send`, before
  anything is queued.
- Sending to a topic that does not exist **succeeds** when the brokers auto-create topics (the
  default in many setups): a misspelled topic name creates a new topic with default partitions
  and no consumer. Create topics explicitly and disable auto-creation in production.
- Ordering holds per partition only. Messages with the same key go to the same partition; an
  application-level resend of a failed message arrives after everything sent in between.

## Consumer

```python
import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from aiokafka import AIOKafkaConsumer
from fastapi import FastAPI

logger = logging.getLogger(__name__)


async def consume(consumer: AIOKafkaConsumer) -> None:
    async for message in consumer:
        try:
            await handle(json.loads(message.value))
        except Exception:
            logger.exception("failed at %s/%s@%s", message.topic, message.partition, message.offset)
            await park(message)  # dead letter; do not stop the partition on one bad message
        await consumer.commit()


def log_if_failed(task: asyncio.Task[None]) -> None:
    if not task.cancelled() and (exc := task.exception()) is not None:
        logger.error("kafka consumer stopped", exc_info=exc)


async def handle(event: dict[str, object]) -> None: ...


async def park(message: object) -> None: ...


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    consumer = AIOKafkaConsumer(
        "orders",
        bootstrap_servers="localhost:9092",
        group_id="order-service",
        enable_auto_commit=False,
        auto_offset_reset="earliest",
    )
    await consumer.start()
    task = asyncio.create_task(consume(consumer), name="kafka-consumer")
    task.add_done_callback(log_if_failed)
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await consumer.stop()
```

- `isolation_level` defaults to `read_uncommitted`: on a topic written by a transactional
  producer, the consumer also receives the messages of **aborted** transactions. Set
  `isolation_level="read_committed"` when only committed events may be processed.
- `auto_offset_reset` defaults to `"latest"`: a **new** consumer group starts at the end of the
  topic and never sees existing messages. A consumer without `group_id` also starts at the end
  and commits nothing.
- Auto-commit (the default, every 5 s) commits the position of the messages **handed to the
  application**, not the position processed. A message whose processing takes longer than the interval is committed while it is
  being handled; if the process dies then, the message is lost (observed: restart continued with
  the next message). `stop()` also commits. This is at-most-once for slow handlers.
- With `enable_auto_commit=False`, `commit()` commits the position after everything returned by
  `getone()`/`getmany()` so far: after `getmany()` returned three messages, one `commit()` marks all three done. A failure
  on the second message loses the third. Process the whole batch before a bare `commit()`, or
  commit explicit offsets per message: `await consumer.commit({tp: message.offset + 1})`. With
  `async for message in consumer` (one message at a time) a bare `commit()` covers exactly the
  messages already handed to the loop.
- Without a commit (crash, or a bug that never calls `commit()`), the next start of the group
  re-reads from the last committed offset: the same messages are delivered again. Handlers must
  be idempotent (dedupe on a message id or an event version).
- **A blocking call in the processing loop stops the heartbeats.** After `session_timeout_ms`
  (default 10 s) the coordinator drops the member and another member may already have received
  the same messages; the consumer logs `Heartbeat session expired` and rejoins. A `commit()`
  issued before the rejoin fails with `CommitFailedError`; one issued after it returns without
  error and commits nothing for the revoked partition. Awaited I/O keeps the heartbeats alive, but a single message
  whose processing exceeds `max_poll_interval_ms` (default 5 minutes, measured between two
  `getone()`/`getmany()` calls) still makes aiokafka leave the group: the next `commit()` raises
  `CommitFailedError` and another member reprocesses the message.
- A `value_deserializer` that raises makes **every** subsequent `getone()` raise the same error:
  the poison message is never skipped and the partition stalls. Deserialize inside the loop,
  where the failure can be parked and committed past.
- The consumer loop is a task owned by the process; cancel it and `stop()` the consumer in the
  shutdown code. If the process exits without `stop()`, the group waits `session_timeout_ms` for
  the dead member before rebalancing; if the process stays alive with the loop dead but the
  consumer not stopped, its partitions stall until `max_poll_interval_ms`
  ([asyncio-concurrency](asyncio-concurrency.md#tasks-and-ownership)).
- **The consumer task can die silently.** An exception that escapes the loop (the dead-letter
  sink is down, `CommitFailedError` after an eviction) ends the task; nothing is logged until
  someone reads the task's result, and the service keeps answering health checks while consuming
  nothing. Add a done callback that logs the failure, as below, and let the readiness check
  report `task.done()`. Each worker
  process runs its own consumer; with more workers than partitions, the extra consumers idle.

## Publishing from a transaction

A handler that commits a database row and then publishes has two failure windows: publish fails
after the commit (row without event), or the process dies between them. Publishing before the
commit has the opposite problem. The usual answer is a transactional outbox: write the event into
an `outbox` table in the same transaction, and let a separate poller (or CDC) publish it. The
poller retries, so consumers must dedupe. `BackgroundTasks` are not an outbox: they are lost with
the process ([streaming-background](streaming-background.md#backgroundtasks)).

## Gotchas

- Agent calls `producer.send(...)` without `await` - the message never leaves the process; only a `RuntimeWarning`.
- Agent creates a producer per request - a connection and a metadata fetch per request.
- Agent keeps `enable_idempotence=False` (the default) for important events - duplicates on retry, loss on leader failover.
- Agent misspells a topic name - auto-created, nobody consumes it, the send succeeds.
- Agent starts a new consumer group with the default `auto_offset_reset` - existing messages are skipped.
- Agent leaves auto-commit on with slow handlers - messages committed while being processed, lost on crash.
- Agent calls a bare `commit()` after handling the first message of a `getmany()` batch - the whole batch is marked done.
- Agent retries `send_and_wait` after a timeout - the first attempt may have been delivered; duplicate event.
- Agent consumes a transactional topic with the default isolation level - aborted messages are processed.
- Agent assumes exactly-once because commits are manual - redelivery after a crash still happens; dedupe.
- Agent blocks inside the consumer loop (sync DB driver, `time.sleep`, CPU work) - heartbeats stop, the group rebalances, commits fail or silently commit nothing, duplicates elsewhere.
- Agent puts JSON parsing in `value_deserializer` - one bad message stalls the partition forever.
- Agent forgets to cancel the consumer task and `stop()` at shutdown - rebalance waits for the session timeout.
- Agent starts the consumer loop as a task and never observes it - the loop dies on the first escaped exception and the service looks healthy.
- Agent processes one message for longer than `max_poll_interval_ms` - the member is evicted even though it awaits.
- Agent publishes after `commit()` in a handler - a row without its event when the publish fails; use an outbox.
- Agent relies on message order across keys or partitions - only per partition.

## Official sources

- [aiokafka: Producer client](https://aiokafka.readthedocs.io/en/stable/producer.html)
- [aiokafka: Consumer client](https://aiokafka.readthedocs.io/en/stable/consumer.html)
- [Kafka: Consumer configuration](https://kafka.apache.org/documentation/#consumerconfigs)
- [Kafka: Producer configuration](https://kafka.apache.org/documentation/#producerconfigs)
