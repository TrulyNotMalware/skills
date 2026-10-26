# Kafka with franz-go

Applies to the Go 1.27.1 toolchain (this file's claims were not re-run on 1.27.3) with a go.mod `go`
line of 1.26.0 or later (franz-go declares it) and franz-go v1.22.1 (`kgo`; `kadm` v1.19.0) unless a
rule carries a version tag. Measured against Kafka 4.3 (KRaft, 3 brokers, classic group protocol);
rows marked "unreachable broker" ran with no broker. The client fails as duplicates, lost records
and unenforced deadlines, none of which shows in a test that produces, consumes and closes against a
healthy broker: test a crash, a shutdown in the middle of a poll, a second group member and a
deadline shorter than the call.

Contents: [Producing](#producing) · [Producer contexts](#producer-contexts) ·
[Producer shutdown](#producer-shutdown) · [Consumer offsets](#consumer-offsets) ·
[Rebalances](#rebalances) · [A consumer that commits after processing](#a-consumer-that-commits-after-processing) ·
[Gotchas](#gotchas)

## Producing

`Producer` holds one client; acks=all and idempotent writes are the defaults. Without
`RecordDeliveryTimeout` a record for an unreachable broker never completes (measured below), so the
client sets one.

```go
type Producer struct {
	cl *kgo.Client
	wg sync.WaitGroup // promises that have not run yet
}

func NewProducer(brokers []string, topic string) (*Producer, error) {
	cl, err := kgo.NewClient(kgo.SeedBrokers(brokers...), kgo.DefaultProduceTopic(topic),
		kgo.RecordDeliveryTimeout(30*time.Second)) // the minimum is 1 s
	if err != nil {
		return nil, err
	}
	return &Producer{cl: cl}, nil
}

// PublishAsync buffers the record and returns. The record keeps the ctx it was produced
// with, and a canceled ctx fails it before it is sent, so detach it from the request.
func (p *Producer) PublishAsync(ctx context.Context, key, value []byte) {
	p.wg.Add(1)
	p.cl.Produce(context.WithoutCancel(ctx), &kgo.Record{Key: key, Value: value}, func(r *kgo.Record, err error) {
		defer p.wg.Done()
		if err != nil {
			slog.Error("kafka produce failed", "topic", r.Topic, "err", err)
		}
	})
}

// Close flushes buffered records for up to timeout, closes, and waits for every promise.
// It detaches ctx: the canceled signal ctx would fail the flush at once. Call it after
// the last PublishAsync (after the HTTP server's Shutdown).
func (p *Producer) Close(ctx context.Context, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	err := p.cl.Flush(ctx)
	p.cl.Close() // fails what is still buffered with kgo.ErrClientClosed
	p.wg.Wait()
	if err != nil {
		return fmt.Errorf("kafka flush: %w", err)
	}
	return nil
}
```

`PublishAsync` suits work that outlives the request. In a request path that must not hang while
the brokers are down, call `p.cl.TryProduce` instead: it fails at once with `kgo.ErrMaxBuffered`
when the buffer is full.

The synchronous `Publish` is `ProduceSync(ctx, &kgo.Record{Key: key, Value: value}).FirstErr()`:
78–610 ms for the first call over 9 runs (median 98; metadata, producer ID), 6–11 ms after. Give
each form its own client ([Producer contexts](#producer-contexts)). Defaults, read with `cl.OptValue` unless marked:

| Setting | Default | Note |
|---|---|---|
| `RequiredAcks`, idempotent writes | all in-sync replicas (-1); on | idempotence requires acks=all (source) |
| `ProducerLinger` | 10 ms `(franz-go ≥1.20.0)`, 0 before (docs) | `ProduceSync` stops lingering for partitions the client already knows `(franz-go ≥1.20.7)`: with `ProducerLinger(3s)` the first call on a new client took 3.07 s, later calls 5–8 ms |
| `MaxBufferedRecords` / `MaxBufferedBytes` | 50 000 / unlimited | `Produce` blocks when full |
| `RecordRetries` / `RecordDeliveryTimeout` | `math.MaxInt64` / none | a dead broker holds a record forever |
| partitioner | keyed: murmur2, Java-compatible; nil key: sticky per 64 KiB batch (source) | each of 6 keys stayed on one partition over 3 rounds |

- **`Produce` blocks while the buffer is full, bounded only by its ctx.** `MaxBufferedRecords(5)`,
  unreachable broker: the 6th `Produce` with a 300 ms ctx returned after 302 ms (promise: `context
  deadline exceeded`), a 7th with `context.Background()` was still blocked after 3 s, `TryProduce`
  failed at once with `kgo.ErrMaxBuffered`. `PublishAsync`'s detached ctx never ends: in a request
  path that must not hang while the brokers are down, use `TryProduce`.
  `RecordDeliveryTimeout(3*time.Second)` ended the block after 3.0 s (the buffered records timed
  out). Reported by: none — test or review.
- **With the defaults a record for a dead broker never completes**: unreachable broker, 15 s later
  the promise had not run and `BufferedProduceRecords()` was 1. `RecordDeliveryTimeout(3*time.Second)`
  failed it after 3 s with `records have timed out before they were able to be produced, last err:
  unable to dial: …` (`kgo.ErrRecordTimeout`; under 1 s is rejected: `record timeout 500ms is less than allowed 1s`). Once a request is on
  the wire an idempotent producer fails nothing until the broker answers (docs). Reported by: none
  — test or review.

## Producer contexts

- **A buffered record keeps the ctx it was produced with.** 200 `Produce` calls, each ctx canceled
  right after the call (an HTTP handler returning): all 200 failed with `context canceled`. The
  contextcheck linter is silent, since passing `r.Context()` is what it asks for. Detach with
  `context.WithoutCancel(ctx)` (keeps trace IDs). Reported by: none — test or review.
- **Only the first buffered record's ctx counts** ("Only the first record's context in a batch is
  considered", then "all buffered records for the relevant partition are failed", docs). Unreachable
  broker, records waiting for topic metadata:

  | Buffered in this order | Then | Result |
  |---|---|---|
  | a detached record only | the caller's ctx is canceled | stays buffered; `Close` fails it with `client closed` |
  | a request-ctx record, then a detached one | the request ctx is canceled | **both** fail with `context canceled` |
  | a detached record, then a request-ctx one | the request ctx is canceled | neither fails; `Close` fails both |
  | `Publish` with a 300 ms ctx, then `PublishAsync` | the deadline passes | `Publish` returns at 300 ms; the async record fails too |
  | `PublishAsync`, then `Publish` with a 300 ms ctx | — | **`Publish` still blocked after 3 s**; `client closed` at `Close` |

  On a live broker, with both records lingering in one partition's batch, rows 2 and 3 came out the
  same. `ProduceSync` waits only for its records' promises (source), so its ctx bounds it only when its
  record leads. Keep request-bound and fire-and-forget records on separate clients. Reported by:
  none — test or review.

## Producer shutdown

| Shutdown | Buffered | Result |
|---|---|---|
| `Close()` without `Flush`, linger 3 s | 1000 | `Close` returned in under 1 ms; all 1000 promises `client closed` (`kgo.ErrClientClosed`) |
| `Flush(ctx)`, then `Close()` | 1000 | `Flush` nil; all 1000 written in 9–87 ms |
| `Flush` with a 1 ms ctx, then `Close()` | 1000 | `context deadline exceeded`; all 1000 `client closed` |
| `Flush` with a 2 s ctx, unreachable broker | 1 | `context deadline exceeded` after 2 s, record still buffered; `Close` failed it |
| `Close()`, records produced with a nil promise, unreachable broker | 3 | nothing reported anywhere |

- **`Close` does not wait for the promises**: it fails the buffered records with `kgo.ErrClientClosed`
  and hands them to a promise goroutine. When `Close` returned, none, some or all of the promises had
  run (148 runs, broker reachable or not, 1–1000 records); the rest ran within 1 ms. A `main` that
  returns right after `Close` can exit before the failures are logged; `Producer` above counts its
  promises in a `sync.WaitGroup` and waits after `Close` (every result seen in 118 of 118 runs).
  Reported by: none — test or review.
- **Detach the flush from the signal.** Given the canceled signal ctx, a `Close(ctx)` that passed it
  to `Flush` returned `context canceled` at once and wrote 0 of 1 000 records; `Close(ctx,
  10*time.Second)` above wrote all 1 000 in 12–99 ms. Checkpoints from promises: [daemon](daemon.md);
  stop budget: [lifecycle-deploy](lifecycle-deploy.md). Reported by: none — test or review.

## Consumer offsets

One partition of 30 records, `PollRecords(ctx, 10)` (poll 1 = offsets 0–9, poll 2 = 10–19); the
process ends by `os.Exit(1)` (crash) or as shown; a new process in the same group restarts.
Session 6 s, autocommit every 5 s (default).

| Commit mode | Processed / polled | End | Committed | On restart |
|---|---|---|---|---|
| default autocommit, 6 s after processing | 15 / 20 | crash | 10 | 10–14 again |
| default autocommit, under 5 s after start | 15 / 20 | crash | none | 0–14 again |
| `GreedyAutoCommit()`, 6 s | 15 / 20 | crash | 20 | **15–19 lost** |
| `DisableAutoCommit()`, `CommitRecords` after each record | 15 / 20 | crash before the 15th commit | 14 | 14 again |
| `AutoCommitMarks()`, `MarkCommitRecords` after each record, 6 s | 15 / 20 | crash | 15 | exact |
| default autocommit | 15 / 20 | `Close()` | 10 | 10–14 again |
| default autocommit | **20 / 20** | `Close()` | **10** | **10–19 again** |
| default autocommit | 15 / 20 | `CommitUncommittedOffsets`, `Close()` | 20 | **15–19 lost** |
| default autocommit | 20 / 20 | `CommitUncommittedOffsets`, `Close()` | 20 | exact |
| `DisableAutoCommit()`, commit every 10 records | 15 / 20 | `Close()` | 10 | 10–14 again |
| the same + `OnPartitionsRevoked` committing the last processed record | 15 / 20 | `Close()` | 15 | exact |

- **Default autocommit commits the poll before the last one, on a clean `Close` too** (franz-go
  v1.22.1). Polled records become committable at the start of the next poll, and the revoke that
  `Close` runs commits only those, by design ("a revoke between poll N and N+1 commits none of poll
  N's records", source). The one exact shutdown under default autocommit: stop polling, finish the
  last poll, `CommitUncommittedOffsets(ctx)`, `Close()`; that call commits every polled record,
  processed or not. Reported by: none — test or review.
- **After a crash the partition waits for the session timeout**: the restart got its first record
  after 5.3–6.1 s with a 6 s session and 44 s with the default 45 s; after a clean `Close`,
  0.1–0.3 s (the member leaves the group).
- **A new group reads the whole topic**: the start offset defaults to `NewOffset().AtStart()`
  (source; Java defaults to latest); `kgo.ConsumeStartOffset(kgo.NewOffset().AtEnd())` is "latest"
  (docs). Group defaults (source): classic protocol (KIP-848 only with `ServerSideBalancer()`),
  cooperative-sticky, session 45 s, heartbeat 3 s, rebalance timeout 60 s.

## Rebalances

Both members `DisableAutoCommit()`; A owns both partitions of a 2-partition topic, polls 40 records
of one of them and works 20 s on them; B joins at 2 s. Session 6 s, rebalance timeout 10 s.

| A's options | What happened |
|---|---|
| default | the rebalance moved the busy partition to B: revoked at 2.6 s, mid-work; B polled **the same 40 records** at 3.2 s and both processed them; B committed; A got the partition back after B closed and its commit at 20 s succeeded |
| `BlockRebalanceOnPoll()` (1- and 2-partition topics) | the rebalance waited; A was kicked after the 10 s rebalance timeout and B got the records at 12.1–12.3 s; A's commit at 20 s failed with `UNKNOWN_MEMBER_ID`; A's `OnPartitionsRevoked` ran at 20.2 s (after `AllowRebalance`), `OnPartitionsLost` never |

- **Without `BlockRebalanceOnPoll` a partition can move while its records are processed** (whenever
  the balancer gives it to the new member; on a 1-partition topic it stayed with A), and the old
  owner's commit can rewind the new owner's (docs). With manual commits, commit what was handled in
  `OnPartitionsRevoked`. Reported by: none — test or review.
- **With `BlockRebalanceOnPoll`, `Close` hangs after any poll, even one that returned only an
  error**, until `AllowRebalance`: still blocked after 8 s (60 s after an error-only poll). Use `CloseAllowingRebalance()`, and finish each poll within the rebalance timeout or
  the member is kicked. Reported by: none — test or review.
- Heartbeats run on a client goroutine: a slow handler alone kept A in the group for 20 s with a
  6 s session. `OnPartitionsRevoked` also runs with empty maps at every session end (4 calls with
  `map[]`); do not call `Close` from inside it (docs).
- **A poll returns your ctx and `Close` as fetch errors**: `PollFetches` with a 2 s ctx on an empty
  topic → no records, one error `context deadline exceeded` (topic `""`, partition -1); `Close` from
  another goroutine → `IsClientClosed()` true, `client closed`, and later polls return at once.
  Check both before treating a fetch error as fatal. Reported by: none — test or review.

## A consumer that commits after processing

```go
// ...
func Consume(ctx context.Context, brokers []string, group, topic string,
	handle func(context.Context, *kgo.Record) error,
) (err error) {
	var mu sync.Mutex
	var done []*kgo.Record // handled, not yet committed; kept until a commit succeeds
	var lastErr error      // the last failed commit of done
	commitDone := func(ctx context.Context, cl *kgo.Client) error {
		mu.Lock()
		defer mu.Unlock()
		if len(done) == 0 {
			return nil
		}
		if err := cl.CommitRecords(ctx, done...); err != nil {
			lastErr = fmt.Errorf("kafka commit: %w", err)
			return lastErr
		}
		done, lastErr = done[:0], nil
		return nil
	}

	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
		kgo.DisableAutoCommit(),
		kgo.BlockRebalanceOnPoll(),
		kgo.OnPartitionsRevoked(func(ctx context.Context, cl *kgo.Client, _ map[string][]int32) {
			if err := commitDone(ctx, cl); err != nil {
				slog.Error("kafka commit on revoke", "err", err)
			}
		}),
	)
	if err != nil {
		return fmt.Errorf("kafka consumer: %w", err)
	}
	defer func() {
		cl.CloseAllowingRebalance() // its revoke commits what was handled; Close would hang
		mu.Lock()
		defer mu.Unlock()
		if err == nil && len(done) > 0 { // canceled, and no commit took the handled records
			err = errors.Join(fmt.Errorf("kafka: %d handled records not committed", len(done)), lastErr)
		}
	}()

	for {
		fetches := cl.PollRecords(ctx, 500)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return nil
		}
		fetches.EachError(func(t string, p int32, err error) {
			slog.Warn("kafka fetch", "topic", t, "partition", p, "err", err)
		})
		var handleErr error
		for _, r := range fetches.Records() {
			if handleErr = handle(ctx, r); handleErr != nil {
				break
			}
			mu.Lock()
			done = append(done, r)
			mu.Unlock()
		}
		if ctx.Err() != nil {
			return nil // the revoke in CloseAllowingRebalance commits what was handled
		}
		commitErr := commitDone(ctx, cl)
		cl.AllowRebalance()
		if err := errors.Join(handleErr, commitErr); err != nil {
			return err
		}
	}
}
```

At least once: commits follow the handler, after each poll and in the revoke that rebalances and
`Close` run. It returns nil on cancellation unless handled records are still uncommitted after the
close, else the first handler or commit error. On the cluster,
30 records valued 0–29: a handler failing at value 20 → that error, 20 committed; a run canceled
after 5, with a handler that returns `ctx.Err()` once canceled → `nil`, 25 committed; the next run
started at 25. A handler that ignores its ctx finishes the whole poll first (all 10, 30 committed),
so a shutdown waits for up to 500 handler calls. Topic deleted mid-run, then canceled: `kafka: 5
handled records not committed` plus the commit error (the version that only logged the revoke's
error returned nil). A member kicked during a slow handler, then canceled: nil and 5 committed —
the client rejoined and the close's second revoke committed; a final commit returning its own
error reported a failure here.

- **The first version committed nothing.** It cleared the list before `CommitRecords` and, at
  shutdown, committed with the canceled ctx: the commit failed, the list was gone, the revoke had
  nothing left — 0 offsets after 30 handled records, and `Consume` returned `context canceled`.
  Keep the list until a commit succeeds; after cancellation leave the commit to the revoke, which
  gets the client's ctx, and return an error if the list is not empty after the close. Reported by:
  none — test or review.
- **At least once means idempotent handlers**: every offsets row not marked "exact", and both
  rebalance rows, deliver records twice. A handler slower than the rebalance timeout (60 s default)
  gets the member kicked when a rebalance starts meanwhile (a member joins or leaves; alone, a 65 s
  handler stayed in the group and committed). The next commit then fails with `UNKNOWN_MEMBER_ID`
  and `Consume` returns it, although the close's revoke, after the client rejoined, committed the
  handled records (offset 30 of 30, the new member had polled all 30 too).

## Gotchas

- Agent passes `r.Context()` to franz-go `Produce` for a fire-and-forget record - the handler returns and the buffered record fails with `context canceled`.
- Agent mixes request-ctx and detached records on one franz-go client - the leading record's ctx fails the records behind it, or `ProduceSync` blocks past its deadline.
- Agent produces with a detached or background ctx in a request path - with the brokers down and the buffer full, the handler blocks forever.
- Agent leaves `RecordDeliveryTimeout` unset - a record for a dead broker waits forever and its promise never runs.
- Agent passes the canceled signal ctx to `Flush` at shutdown - it returns `context canceled` at once and nothing is written.
- Agent calls `Close` without `Flush`, passes a nil promise, or returns from `main` right after `Close` - buffered records fail with `ErrClientClosed`; `Close` does not wait for the promises, so nothing may log it.
- Agent relies on default autocommit and a clean `Close` - the last poll is re-delivered after every restart.
- Agent calls `CommitUncommittedOffsets` at shutdown with records of the last poll unprocessed - they are lost.
- Agent uses `DisableAutoCommit` without a commit in `OnPartitionsRevoked` - a rebalance or `Close` re-delivers handled records.
- Agent uses `BlockRebalanceOnPoll` and calls `Close` instead of `CloseAllowingRebalance` - it hangs.
- Agent clears the handled list before the commit succeeds, commits with the canceled ctx at shutdown, or only logs the revoke's commit error - nothing is committed and the consumer still returns nil.
- Agent treats every fetch error as fatal - its own ctx deadline and `Close` arrive as fetch errors.

## Official sources

- [franz-go kgo v1.22.1](https://pkg.go.dev/github.com/twmb/franz-go/pkg/kgo@v1.22.1) (`Produce`, `ProduceSync`, `BlockRebalanceOnPoll`, `DisableAutoCommit`, `ConsumeStartOffset`), its [CHANGELOG](https://github.com/twmb/franz-go/blob/v1.22.1/CHANGELOG.md), [kadm v1.19.0](https://pkg.go.dev/github.com/twmb/franz-go/pkg/kadm@v1.19.0)
- [Kafka consumer configs](https://kafka.apache.org/documentation/#consumerconfigs) (`auto.offset.reset`, `session.timeout.ms`)
