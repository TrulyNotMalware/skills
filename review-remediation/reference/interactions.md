# Interactions between fixes

Fixes that are each correct can combine, with each other or with code that was already there,
into a defect that no single finding described. Re-check each batch of fixes for these
patterns. Each one comes from a recorded incident, and each states the condition under which
it applies. Outside that condition, treat it as a question to ask, not as a known defect.

Contents: [Acknowledgement change + a resend branch](#acknowledgement-change--a-resend-branch) ·
[Errors now surface + deduplication that answers retries](#errors-now-surface--deduplication-that-answers-retries) ·
[Clearing managed state + work scheduled at commit](#clearing-managed-state--work-scheduled-at-commit) ·
[A new inner transaction per request](#a-new-inner-transaction-per-request) ·
[Attempt counters reused as a budget](#attempt-counters-reused-as-a-budget) ·
[Refunding attempts + a queue ordered by priority](#refunding-attempts--a-queue-ordered-by-priority) ·
[A fix in one mode or profile only](#a-fix-in-one-mode-or-profile-only) · [Gotchas](#gotchas)

## Acknowledgement change + a resend branch

- **Condition:** the consumer now commits offsets after processing (for example Spring Kafka's
  container mode `AckMode.RECORD`, which is not manual acknowledgement), the listener performs an
  external side effect (a send) and then a synchronous status update, and the code already has a
  branch such as "resend when the row is still IN_PROGRESS".
- **What happens:** the send succeeds, the status update fails (a database outage), the listener
  throws, the record is redelivered with the row still IN_PROGRESS, and the branch sends again.
  In one case one outage produced three sends.
- Before the change, with client auto-commit, this redelivery was not observed. Do not read that as
  "auto-commit is safe": auto-commit is also at-least-once as long as every record from a poll is
  processed before the next poll or close (the `KafkaConsumer` Javadoc's condition, kafka-clients
  4.2.1); break that and the committed offset can run ahead of processing, and records are lost.
- **Check:** what does each redelivery do after a partly completed side effect? Is there a test
  that pins the resend as expected behavior?

## Errors now surface + deduplication that answers retries

- **Condition:** a fix makes a failure return 5xx so that the sender retries; a deduplication
  layer answers a retry that arrives while the first attempt is still running with success; the
  sender stops retrying after a success, and nothing else recovers the work.
- **What happens:** the first attempt fails late, the sender already has a success for the retry,
  and the event is lost.
- **No remedy was recorded for this case.** Forgetting failed attempts (a lesson from a
  separate case with a wrong dedup key) does not help here: once the in-flight duplicate got
  a success, the sender does not retry again. What to answer for a duplicate that arrives while
  the first attempt is in flight (success, an error, or a wait) depends on the sender's retry
  rules; decide it explicitly and test it.

## Clearing managed state + work scheduled at commit

- **Condition:** an operation clears or detaches managed entities before commit, and something was
  scheduled at commit for those entities.
- **Example (Hibernate 7.4 through Spring Data JPA):** `@Lock(OPTIMISTIC_FORCE_INCREMENT)` raises
  the version in a callback just before commit. A later `@Modifying(clearAutomatically = true)`
  bulk update removes the entity from the persistence context, so the increment is silently
  skipped, and the bulk JPQL update itself does not touch `@Version`. Reproduced: one row
  updated, version still 0. The forced increment, and the conflict it was meant to cause, is
  lost.
- Kotlin and Spring details live in the kotlin-spring-boot skill.

## A new inner transaction per request

- **Condition:** on every request, an outer transaction holds a pooled connection while a
  `REQUIRES_NEW` inner transaction asks for another.
- **What happens:** at pool-size concurrency each request waits for its second connection; in one
  case every such request timed out (10 of 10 reproductions).
- **A bigger pool is not the fix:** the inner transaction can still commit while the outer one
  rolls back. That case moved the write after the outer commit.

## Attempt counters reused as a budget

- **Condition:** one counter serves both as an attempt or ownership marker and as the give-up
  budget, and it counts attempts that never sent anything (rate-limited, reclaimed from a queue).
- **What happens:** sustained rate limiting alone (about 50 minutes of 429 responses in one
  case) made the code give up on healthy messages.
- **Recorded remedy:** keep the ownership token and the send budget in separate fields.
- **A second case:** a claim token made of the attempt count alone collided after a manual
  requeue reset the count. A late finisher from an old claim matched a newer claim, gave its attempt back,
  and the newer claim's paid result was discarded (a review lane's probe). The token became the pair of
  attempt count and claim timestamp, pinned by a test that fails when the timestamp comparison is removed.

## Refunding attempts + a queue ordered by priority

- **Condition:** jobs make calls that cost money or quota; a failed job is retried after a delay and gives
  up after N attempts; a fix gives the attempt back and stops the run for failures that are not the item's
  fault (bad credentials, exhausted quota, rate limits, an outage); the queue hands out the highest-priority
  due job first.
- **What happened, one fix after another (each defect reproduced by a review lane's probe):**
  1. No refund except for 401 and 403: an exhausted credit balance (a 400) or a mistyped model name (a 404)
     failed every queued job for good.
  2. Refund without a bound: an item that always produced a refundable failure (a timeout on that input)
     was refunded forever, stayed first in line and stopped every run. Nothing behind it was processed.
  3. Refund once, tracked by the kind of the last error stored on the job: a revoked key that lasted
     several runs was charged from the second run on, which is defect 1 at a slower rate. A scheduled
     requeue of failed jobs reset the counters and removed the bound again.
  4. Confirm against a second item before blaming the provider: one rate-limit response charged a healthy
     item because the next item succeeded; two bad items at the head confirmed each other on every run; an
     error raised after a successful response (a code defect) was confirmed by every probe, at two paid
     calls per run.
  5. Probe only items without a failure history: a probe that itself hit a rate limit decided nothing, yet
     both items kept their refunds, so the bad item was again never charged; and a rate-limit refund
     overwrote the stored error kind that marked an item as suspect.
- **Recorded remedy:** classify a failure by whose fault it can be.
  - Never the item's (credentials, model name, credit, quota, and capacity signals such as 429, 503, 529):
    always refund, never probe.
  - Possibly the item's (timeouts, other 5xx, network errors): refund, then probe one item that has no such
    failure in its history. Charge the first item only if the probe succeeds or fails for an item-level
    reason; keep both refunds if the probe fails the same way; when the probe decides nothing, or there is
    no such item, refund once and charge the next time.
  - Code defects (an unexpected exception): refund once, never probe, because every probe is another paid
    call that fails the same way.
  - That case kept the suspect marker as a prefix when an unrelated refund was stored, and counted
    requeues in a suffix that later failures carry over. Separate fields would be cleaner and were not
    built. Requeue became a manual step that skips jobs already requeued once.
  - Each rule is pinned by a test that fails when the rule is removed.
- **Check:** for each failure class, who pays an attempt when it repeats for ten runs, and what stops one
  item from holding the head of the queue?

## A fix in one mode or profile only

- **Condition:** the application has modes or profiles that load different beans or code paths
  (for example a CDC relay mode and a polling mode, or two mutually exclusive configuration
  classes).
- **What happens:** a recovery path added in one mode does not exist in the other; removing a
  bean from one configuration class can leave zero implementations in production.
- **Check:** list the modes, and confirm that the fix and every bean it relies on exist in each.

## Gotchas

- Agent switches to commit-after-processing and keeps a "resend if IN_PROGRESS" branch - every
  redelivery after a failed status update repeats the send.
- Agent makes errors visible to the sender while a dedup answers in-flight retries with success -
  a late failure of the first attempt loses the event.
- Agent adds `clearAutomatically = true` next to a forced version increment - the increment, and
  the conflict it was meant to cause, is silently lost.
- Agent enlarges the connection pool to fix `REQUIRES_NEW` timeouts - the inner commit still
  survives an outer rollback.
- Agent counts rate-limited attempts toward a give-up limit - healthy work is abandoned during
  sustained rate limiting.
- Agent refunds attempts for provider-wide failures without a bound - one input that always times out
  holds the head of the queue forever.
- Agent treats "the next item succeeded" as proof that the first item was at fault - a single 429
  charges a healthy item.
- Agent schedules a requeue of failed jobs - every per-job bound is reset on each run.
- Agent adds a fix to the mode it is reading - the other mode or profile still lacks it.
