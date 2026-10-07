# Kafka messaging, outbox, and CDC

Spring Boot 4.1 manages Spring Kafka 4.1 and kafka-clients 4.2 (resolved 2026-09-29). Design for
**at-least-once** delivery: every consumer must tolerate duplicates, and every "send" must be traced
back to durable state.

Contents: [Dependencies and Boot 4 changes](#dependencies-and-boot-4-changes) ·
[Contracts](#contracts) · [Producing](#producing) · [Consuming](#consuming) ·
[Transactional outbox](#transactional-outbox) · [CDC with Debezium](#cdc-with-debezium) ·
[Testing](#testing) · [Gotchas](#gotchas)

## Dependencies and Boot 4 changes

```kotlin
implementation("org.springframework.boot:spring-boot-starter-kafka")
testImplementation("org.springframework.boot:spring-boot-starter-kafka-test") // @EmbeddedKafka
```

- Auto-configuration moved to `org.springframework.boot.kafka.autoconfigure` (for example
  `KafkaProperties`). Boot 3 import paths do not compile.
- JSON (de)serializers: use `JacksonJsonSerializer` / `JacksonJsonDeserializer` (Jackson 3). The old
  `JsonSerializer` / `JsonDeserializer` are deprecated in Spring Kafka 4.
- Spring Kafka's `spring.json.*` consumer properties (`spring.json.value.default.type`,
  `spring.json.use.type.headers`, `spring.json.trusted.packages`) still configure the deserializer.
- **Kafka's JSON (de)serializers build their own mapper**, not Boot's. `spring.jackson.*` settings and
  Boot's mapper customizers do not apply. The Kotlin module is picked up only through ServiceLoader
  discovery, so `tools.jackson.module:jackson-module-kotlin` must be on that module's classpath;
  without it, Kotlin data classes fail with `InvalidDefinitionException`. Pass a configured mapper to
  the serializer if the wire format needs the same settings as HTTP.

## Contracts

- Publish a stable, versioned envelope (event ID, type, occurred-at, schema version, payload). Never
  serialize JPA entities or internal domain objects as the wire contract.
- Treat the event schema as a public API. Add fields; do not rename or retype them in place.
- With the Kotlin module present, message DTOs follow the same Jackson rules as HTTP DTOs
  ([kotlin-spring-basics](kotlin-spring-basics.md#json-jackson-3)): a missing non-null field without
  a default fails deserialization. On a consumer that is a poison record, not a validation error.
- Choose the record key deliberately. Kafka orders records only **within a partition**, so use the
  aggregate ID as the key when per-aggregate order matters. Listener concurrency above the partition
  count adds idle threads, not throughput.

## Producing

- **Never publish from inside a DB transaction as if it were part of it.** `kafkaTemplate.send(...)`
  inside `@Transactional` can deliver a message for a transaction that later rolls back, or lose it
  when the process dies after commit. When a DB change and a message must agree, use an outbox
  (below).
- `send()` is asynchronous and returns a `CompletableFuture`. A `send()` whose result is never
  observed hides broker errors. Handle the future (log/metric/retry) or block with a timeout where
  the caller needs the outcome.
- kafka-clients defaults to `acks=all` (printed as `acks = -1` in the config dump) and
  `enable.idempotence=true` (since 3.0). Producer idempotence
  deduplicates retries **within one producer session** only. A restarted producer, or an application
  that calls `send()` twice, still creates duplicates. It is not end-to-end exactly-once.
- Kafka transactions (`transactional.id`) make consume-transform-produce atomic **within Kafka**. They
  do not include your database or any HTTP call.
- Synchronizing a Kafka transaction with a DB transaction (Spring's transaction synchronization, or the
  deprecated `ChainedTransactionManager`) commits the two **one after the other**. A crash between the
  commits leaves one side committed. That is best-effort, not atomic; it still needs duplicate
  handling and a recovery story. Prefer the outbox when both must agree.

## Consuming

```kotlin
@Component
class OrderEventsListener(private val handler: OrderEventHandler) {
    @KafkaListener(topics = ["\${app.kafka.order-topic}"], groupId = "order-projection")
    fun on(record: ConsumerRecord<String, OrderEvent>) = handler.apply(record.value())
}
```

- Escape property placeholders in Kotlin annotation strings: `"\${app.kafka.order-topic}"`.
- `suspend fun` listeners are supported, but Spring Kafka bridges them through Reactor. Without both
  `reactor-core` and `kotlinx-coroutines-reactor` on the classpath, the first record throws
  `NoClassDefFoundError` and **the whole listener container stops**. With them, Spring Kafka acknowledges
  the record only when the coroutine completes (possibly out of order), not when the method returns,
  so the "commit follows return" rule below does not apply as is. This relies on the container's
  acknowledgement supporting out-of-order commits (the default does); otherwise Spring Kafka only logs
  a warning and acknowledges immediately. Prefer blocking listeners that
  call blocking services ([transactions](transactions.md#coroutines)).
- **Offset commit follows the listener's return.** The container commits after the listener returns
  normally (default `AckMode.BATCH`; `RECORD` commits per record). If the listener throws, the record
  is redelivered by the error handler. If it "succeeds" by swallowing the exception, the record is
  gone.
- Changing the commit mode changes failure behavior. Moving from auto-commit to container-managed
  or manual acks means a failure after a side effect **redelivers** the record. Code that was
  "fine" because nothing was ever redelivered starts sending duplicates. Re-check every
  redelivery path when you change `AckMode` or `enable.auto.commit`.
- **Idempotent handlers:** keep a processed-events table keyed by `(consumer_name, event_id)`
  (composite primary key, both non-null). In the **same DB transaction** as the state change:
  insert the key **first**, and apply the change only if the insert took effect. `INSERT ... ON
  CONFLICT DO NOTHING` (PostgreSQL) or `INSERT IGNORE` (MariaDB/MySQL) skips only the insert, so the
  code must check the affected-row count and return early. If you rely on a duplicate-key exception
  instead, the transaction is aborted (PostgreSQL) and must be rolled back, not continued. Keep rows at
  least as long as events can be redelivered or replayed. A JVM map or cache with TTL is not a guard
  on its own (other instances, restarts, eviction); it is fine as a same-instance first filter in front
  of the durable key if it records an event only after that key has committed (filled earlier, a
  redelivery after a failed attempt is skipped and the event is lost).
- Handlers with external side effects (HTTP, email, another topic) cannot be made atomic with the
  offset. Use the provider's idempotency key, or record the attempt durably before calling out and
  reconcile unknown outcomes instead of blindly resending.

### Errors, retries, dead letters

```kotlin
import org.springframework.kafka.support.ExponentialBackOffWithMaxRetries // not in org.springframework.util.backoff

@Bean
fun kafkaErrorHandler(template: KafkaTemplate<Any, Any>) =
    DefaultErrorHandler(
        DeadLetterPublishingRecoverer(template),         // default target: "<topic>-dlt", same partition
        ExponentialBackOffWithMaxRetries(3).apply { initialInterval = 500; multiplier = 2.0 },
    ).apply { addNotRetryableExceptions(NonRetryableEventException::class.java) }
```

- `DefaultErrorHandler` retries in-process with the given back-off, then calls the recoverer. Without
  a custom handler, Spring's default is 10 attempts in total (1 + 9 retries, no delay), then the
  record is logged and skipped. That is fast but silent; configure a recoverer.
  In-process retries **sleep the consumer thread**. That delays every partition assigned to that
  consumer, not only the failing one. If processing plus back-off between two polls exceeds
  `max.poll.interval.ms` (default 5 minutes), the consumer is evicted from the group and its partitions
  are reassigned, so the record is processed again elsewhere. Keep in-process back-off short, bound
  `max.poll.records` to what can be processed in time, and use `ContainerPausingBackOffHandler` (pauses
  the partition instead of sleeping) or retry topics for long delays.
- `@RetryableTopic` (non-blocking retries) moves failing records to retry topics. Later records of the
  same key can then **overtake** the retried one, so do not use it where per-key order matters. It
  does not support batch listeners or container-managed Kafka transactions. In Spring Kafka 4.1 the
  back-off attribute is `backOff = BackOff(delay = 1000, multiplier = 2.0)`
  (`org.springframework.kafka.annotation.BackOff`), and `attempts` counts the first delivery.
- Classify failures. Deterministic failures (parse errors, contract violations) are not retryable;
  register them with `addNotRetryableExceptions` so they go straight to the dead-letter topic.
- **Deserialization failures happen before your listener runs.** Without `ErrorHandlingDeserializer`
  wrapping the real deserializer, a bad record fails every poll in a loop. Configure it:
  `spring.kafka.consumer.value-deserializer=org.springframework.kafka.support.serializer.ErrorHandlingDeserializer`
  plus `spring.kafka.consumer.properties.spring.deserializer.value.delegate.class=...JacksonJsonDeserializer`.
- The dead-letter topic must exist (or auto-creation be allowed).
- A record that failed deserialization reaches the recoverer as the raw `byte[]`. A JSON
  `KafkaTemplate` does **not** fail on it; `JacksonJsonSerializer` silently writes it as a Base64 JSON
  string, so the DLT holds a corrupted copy. Give `DeadLetterPublishingRecoverer` a map of templates
  keyed by value type (`ByteArray::class.java` → byte-array template, `Any::class.java` → JSON
  template).
- Dead-lettering breaks ordering for that key. Document how records are replayed from the DLT, and
  make replay an explicit, audited operation.

## Transactional outbox

Write the business change and an outbox row in **one local transaction**. A separate relay publishes
the row and marks it done.

```kotlin
@Transactional
fun submit(orderId: UUID) {
    val order = orders.findByIdOrNull(orderId) ?: throw OrderNotFoundException(orderId)
    order.submit()
    val event = OrderSubmittedV1(orderId = order.id!!, customerId = order.customerId, occurredAt = clock.instant())
    outbox.save(OutboxMessage.of(eventId = UUID.randomUUID(), aggregateId = event.orderId, type = "OrderSubmitted", schemaVersion = 1, payload = codec.encode(event)))
}
```

**Staging through a `BEFORE_COMMIT` listener** is a variant some projects use: the service publishes
a domain event and a `@TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)` writes the
outbox row inside the publisher's transaction. It keeps the row atomic with the change only while
three things hold:

- **The write must run on the publishing thread.** A `@TransactionalEventListener` is invoked there
  even when the application's `ApplicationEventMulticaster` has a task executor (Framework 6.1+:
  transaction-bound listeners do not support asynchronous execution). Two things still move the write
  out of the transaction: `@Async` on the listener method (the callback only hands the work to an
  executor, and the publisher commits without the row), and staging with a plain `@EventListener`
  while the multicaster is asynchronous (every plain listener then runs on the executor).
- A publish outside a transaction is skipped silently (`fallbackExecution = false`). Make the
  publishing method transactional, or set `fallbackExecution = true` only if writing without a
  transaction is acceptable.
- The listener's writes join the publisher's transaction (default `REQUIRED`), and an exception thrown
  in a `BEFORE_COMMIT` listener propagates and rolls the whole unit back. Do not use `REQUIRES_NEW`
  there.

Spring Modulith's `@ApplicationModuleListener` is different (asynchronous, after commit, its own
transaction); see [modulith](modulith.md).

Relay options:

| Relay | How | Watch out for |
|---|---|---|
| Polling | Scheduled job claims `PENDING` rows in a short transaction (`SELECT ... FOR UPDATE SKIP LOCKED` + ownership update, or a conditional `UPDATE ... WHERE status = 'PENDING'`), sends, then marks `SENT` | Multiple instances must not claim the same row; DB prerequisites below |
| CDC + Debezium Outbox Event Router | Debezium tails the log; the router SMT turns outbox **inserts** into events on the target topic | Consumers receive the routed payload, not a change envelope; the table is effectively insert-only |
| CDC + custom relay consumer | Debezium emits raw row changes; your consumer claims the row and sends | You own state filtering, re-reads, and envelope parsing (see CDC section) |
| Spring Modulith event publication registry | Framework-managed persisted events | Only if the project already uses Modulith |

Outbox rules:

- The outbox row is the source of truth for "should be sent". Status transitions
  (`PENDING → IN_PROGRESS → SENT/FAILED`) must be conditional updates that also check ownership, so
  two relays cannot both win. A batch claim must also tell you **which** rows you won: an affected-row
  count does not. Write a claim token in the claiming `UPDATE` and select by it, or claim row by row
  ([scheduling-executors](scheduling-executors.md#jobs-on-several-instances)).
- Mark `SENT` only **after** the send is acknowledged (the `send()` future completed successfully). A
  relay can still publish and crash before the update, or resume after its lease expired, so
  duplicates remain possible: keep the event ID stable across retries and deduplicate downstream.
- **Polling prerequisites:** `SKIP LOCKED` needs PostgreSQL 9.5+, MySQL 8.0+, or MariaDB 10.6+ (InnoDB
  only). Locking reads only lock inside an explicit transaction (not autocommit). Do not translate
  PostgreSQL claim SQL (`RETURNING`, `ON CONFLICT`) mechanically to MariaDB/MySQL.
- **Ordering:** a record key preserves order only for what one producer sends in order. With several
  polling workers, worker A may hold event 1 while worker B skips it and publishes event 2. Where
  per-aggregate order matters, serialize relay work per aggregate (for example claim the oldest
  pending row per aggregate only) and include an aggregate sequence number consumers can check.
- **A redelivered or re-polled row must not be resent blindly.** An `IN_PROGRESS` row can mean
  "another worker is sending right now" or "a worker died mid-send". Decide with an ownership token
  and a claim timestamp, not with status alone; otherwise one DB hiccup produces multiple sends.
- Keep "attempts" and "sends" apart. A counter that also counts attempts that never sent (rate
  limited, requeued, reclaimed) exhausts the retry budget without a single delivery. Count actual
  send attempts only, and keep claim ownership in a separate column.
- Stuck-row recovery compares a claim timestamp with "now". Use **one time source and one time
  representation**: either the DB clock on both sides (`CURRENT_TIMESTAMP` in the query) or an
  application `Clock` bound as a parameter on both sides. The classic failure is zone-less columns
  (`DATETIME` in MariaDB/MySQL, `timestamp without time zone` in PostgreSQL) mapped to
  `LocalDateTime`: a value written by the DB in UTC and compared with a JVM-local cutoff (or the
  reverse) is off by the zone offset. Instant-based types (`timestamptz`, `Instant`) avoid the offset;
  clock skew between hosts remains.
- Do not add a unique constraint on a business key "for idempotency" without checking the intent.
  One command may legitimately produce several outbox rows. Uniqueness belongs on the event ID.
- Retention: delete or archive `SENT` rows on a schedule. A growing outbox slows claims and CDC
  snapshots.

## CDC with Debezium

Two different designs; do not mix their rules.

- **Outbox Event Router (SMT):** Debezium routes outbox *inserts* to topics inside the connector and
  emits only the payload (plus configured headers). Deletes are filtered, updates are not expected.
  Keep the outbox table insert-only (delete old rows by retention). Consumers treat it like any other
  topic: idempotent handling by event ID.
- **Custom relay consumer:** your application consumes raw change events and performs the send. The
  rules below apply to this design.

Custom relay rules:

- **The consumer sees its own writes.** A relay that updates the outbox row (`PENDING → SENT`)
  produces another change event. Filter on the after-image state (process only `PENDING`) or the
  relay reprocesses its own updates.
- Handle every event shape:
  - Tombstones (record value `null`, emitted after deletes for log compaction). Declare the payload
    nullable (`@Payload(required = false) envelope: Envelope?`) and skip them.
  - Delete events have no `after` image.
  - Snapshot reads (`op = "r"`) replay existing rows during the initial snapshot, or when offsets are
    lost or a snapshot is triggered. A normal restart resumes from stored offsets.
- Re-read the current row before acting. The change event is a snapshot of the past. The row may
  already be `SENT` by the recovery job or another consumer.
- Column types can map differently from JPA. Enum, `TIMESTAMP`, and `JSON` columns may arrive as
  strings, epoch numbers, or `null`, depending on connector and converter settings. Parse the
  after-image defensively, and treat a parse failure as non-retryable (dead-letter it).
- Schema changes to the outbox table are contract changes for the CDC pipeline. Version the
  payload and update the parser in the same change.
- **Plan for the connector being down.** Debezium resumes from its stored offsets, but only while the
  database still retains the needed log (WAL/binlog). If retention runs out, events must be recovered
  by a snapshot. Monitor connector state and lag, alert on outbox age (oldest `PENDING` row), and
  document the recovery procedure. With a custom relay, rows claimed but never finished
  (`IN_PROGRESS` after a crash) need a recovery job either way.
- A fallback poller that runs alongside CDC can **duplicate and reorder** events when CDC catches up.
  If you add one, it must claim through the same conditional update as the relay, and consumers must
  deduplicate.

## Testing

- Use `@EmbeddedKafka` or Testcontainers ([testing](testing.md#messaging)); consume with a real
  consumer and assert payload, key, and headers.
- Test the failure paths, not only delivery: a duplicate record, a poison record (goes to DLT once, no
  loop), a handler failure after a side effect (redelivery must not duplicate the effect), and a relay
  crash between send and status update.
- Outbox claim/recovery logic needs the production DB engine for locking (`SKIP LOCKED`) and time
  functions. H2 hides both.

## Gotchas

- Agent calls `kafkaTemplate.send` inside `@Transactional` and calls it atomic - use an outbox.
- Agent ignores the `CompletableFuture` from `send()` - broker errors vanish.
- Agent treats producer idempotence or Kafka transactions as end-to-end exactly-once - consumers still need dedup.
- Agent catches and logs inside the listener - the offset commits and the record is lost.
- Agent changes `AckMode`/auto-commit without re-checking redelivery paths - duplicates appear.
- Agent retries every exception - classify parse/contract errors as not retryable.
- Agent configures `JacksonJsonDeserializer` without `ErrorHandlingDeserializer` - a poison record loops forever.
- Agent uses deprecated `JsonSerializer`/`JsonDeserializer` in Spring Kafka 4 - use the `JacksonJson*` classes.
- Agent resends an `IN_PROGRESS` outbox row on redelivery - decide with ownership and claim time.
- Agent compares a DB timestamp with a JVM-clock cutoff - use one clock on both sides.
- Agent treats CDC as self-healing - monitor connector lag and log retention, alert on outbox age, and recover stuck `IN_PROGRESS` rows.
- Agent applies custom-relay rules (status updates, after-image filters) to a Debezium Outbox Event Router setup - the router expects an insert-only table.
- Agent uses `INSERT ... ON CONFLICT DO NOTHING` and then runs the handler anyway - check the affected-row count.
- Agent encodes the entity as the outbox payload - encode a versioned event DTO.
- Agent adds long in-process retries - the consumer thread sleeps and can exceed `max.poll.interval.ms`.
- Agent sends dead-lettered `byte[]` values through a JSON template - they are silently Base64-corrupted.
- Agent assumes Kafka's JSON deserializer uses Boot's `JsonMapper` - it builds its own; the Kotlin module must be on the classpath.
- Agent writes a `suspend` `@KafkaListener` without Reactor bridge deps - the container stops on the first record.
- Agent forgets CDC tombstones and the relay's own update events - skip `null` values and non-`PENDING` after-images.
- Agent puts `@Async` on a `BEFORE_COMMIT` staging listener, or stages with a plain `@EventListener` under an async multicaster - the row is written outside the publisher's transaction, or not at all.
- Agent claims a batch and trusts the affected-row count - select the claimed rows by a claim token.

## Official sources

- [Spring Kafka reference](https://docs.spring.io/spring-kafka/reference/)
- [Spring Kafka error handling and DLT](https://docs.spring.io/spring-kafka/reference/kafka/annotation-error-handling.html)
- [Kafka delivery semantics](https://kafka.apache.org/documentation/#semantics)
- [Debezium outbox pattern](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
