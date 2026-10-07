# Scheduling and executors

`@Scheduled` jobs, `@Async` and executor beans, jobs on several instances, and what changes when
virtual threads are on. Bean and property names below were read from the Boot 4.1.1 and Framework
7.0.9 sources on 2026-10-01. Shutdown ordering is in
[config-observability](config-observability.md#graceful-shutdown).

Contents: [Which scheduler runs `@Scheduled`](#which-scheduler-runs-scheduled) ·
[Jobs on several instances](#jobs-on-several-instances) · [`@Async` and executor beans](#async-and-executor-beans) ·
[Testing](#testing) · [Gotchas](#gotchas)

## Which scheduler runs `@Scheduled`

With `@EnableScheduling` and no `TaskScheduler` or `ScheduledExecutorService` bean of your own, Boot
creates one. Which one depends
on `spring.threads.virtual.enabled`:

| Setting | Scheduler | `spring.task.scheduling.pool.size` | `fixedDelay` jobs | `fixedRate` / `cron` jobs |
|---|---|---|---|---|
| Platform threads (default) | `ThreadPoolTaskScheduler` | Used (default **1**) | Share the pool | Share the pool; one run of a job at a time |
| `spring.threads.virtual.enabled=true` | `SimpleAsyncTaskScheduler` on virtual threads | **Ignored** | All run on **one** scheduler thread, one after another | Each run on a new virtual thread; runs of the same job can overlap |

The table is for ordinary blocking methods. A `suspend` or reactive (`Mono`/`Flux`) `@Scheduled` method
is subscribed on each trigger, and only `fixedDelay` waits for it to complete (Framework 7
`ScheduledAnnotationReactiveSupport`), so its `fixedRate`/`cron` runs can overlap on the platform pool
too when the body suspends (`delay`, non-blocking I/O); a body that blocks the thread does not
overlap.

- **With the default pool size of 1, every job shares one thread.** On platform threads, set
  `spring.task.scheduling.pool.size` when jobs must not delay each other.
- Virtual threads are daemon threads. An application with no web server whose only work is scheduled
  jobs can exit right after startup once virtual threads are enabled; set `spring.main.keep-alive=true`
  (default `false`) for such worker processes.
- **On virtual threads, `fixedDelay` jobs still share one thread.** `SimpleAsyncTaskScheduler` keeps
  fixed-delay semantics by running those jobs on its single scheduler thread (Framework 7 Javadoc), so
  one slow `fixedDelay` job delays every other `fixedDelay` job, and `pool.size` has no effect
  (observed on Boot 4.1.1: a 500 ms `fixedDelay` job ran 2 times in 6.5 s next to a 3 s job, versus 13
  times with a 4-thread pool). `spring.task.scheduling.simple.concurrency-limit` does not change this.
- When jobs must stay independent under virtual threads, either define the scheduler yourself (Boot's
  backs off), or move the jobs to `fixedRate`/`cron`. The second option has two costs: two runs of the
  same job may overlap, and on shutdown a running `fixedRate`/`cron` job is not waited for (its
  `finally` never runs) unless `spring.task.scheduling.shutdown.await-termination=true` with a period
  ([config-observability](config-observability.md#graceful-shutdown)):

```kotlin
@Bean
fun taskScheduler(builder: ThreadPoolTaskSchedulerBuilder): ThreadPoolTaskScheduler =
    builder.poolSize(4).build() // keeps Boot's thread name prefix, task decorator and shutdown settings
```

  A `ThreadPoolTaskScheduler` is also an `Executor`, so this bean makes Boot's `applicationTaskExecutor`
  back off: `@Async` methods then run on the scheduler's platform pool instead of virtual threads.
  Set `spring.task.execution.mode=force` to keep Boot's executor ([below](#async-and-executor-beans)).
  (The condition reads the declared return type: the same bean declared as `TaskScheduler` does not
  trigger it.)

- `fixedDelay` starts the next run a fixed time after the previous one **ended**; `fixedRate` starts runs
  on a fixed period regardless of duration. Choose per job.
- **A failing run does not stop the job.** For repeating jobs the exception is logged and the next run
  happens on schedule. Nothing else notices; count failures (with a Micrometer registry, the
  `tasks.scheduled.execution` timer carries `outcome` and `exception` tags) and alert on them.
- Turn a job off per environment with a property-driven cron and the disabled value `-`:
  `@Scheduled(cron = "\${app.jobs.cleanup.cron:-}")`.
- Keep the `@Scheduled` method a thin trigger that calls a service bean. The service owns the
  transaction and can be tested without the scheduler.

## Jobs on several instances

Every instance runs every `@Scheduled` method; Spring does not coordinate a cluster. With two
replicas, each job runs twice per period. Pick one model per job:

| Model | How | Watch out for |
|---|---|---|
| Per-item claim | Each run claims rows with a conditional `UPDATE` that records an owner token and a lease time, then processes the rows it owns | Identifying the claimed rows (below); expired leases need a sweep |
| One lock per run (for example ShedLock) | Only the instance that takes the job's lock runs that period | The lock must outlive the longest run (`lockAtMostFor`), or a second instance starts while the first still runs; a lock that is too long delays the next run after a crash |
| Leader election | One instance runs the jobs | Failover gaps; the leader carries all job load |

- **An affected-row count does not tell you which rows you won.** After
  `UPDATE ... SET status = 'IN_PROGRESS' WHERE status = 'PENDING' LIMIT 10` (MariaDB/MySQL) reports 7,
  selecting "the in-progress rows" also picks up rows another instance claimed. Write a fresh claim
  token in the same `UPDATE` and select by it, use `RETURNING` where the database has it, or claim one
  row at a time by ID. The outbox relay has the same problem
  ([messaging-outbox](messaging-outbox.md#transactional-outbox)).
- **Commit the claim with the work, or give it a lease.** A claim committed in its own transaction,
  followed by a failure (or a crash), leaves the item claimed. Without a lease timestamp and a sweep
  that releases expired claims, the item is never processed again.
- Test claims with two concurrent claimers against the production database engine.

## `@Async` and executor beans

- `@Async` does nothing without `@EnableAsync` (or equivalent configuration); Boot creates the executor
  but does not enable the annotation.
- **Which executor runs `@Async`:** without an `Executor` bean of your own, Boot's
  `applicationTaskExecutor` (a `ThreadPoolTaskExecutor`, or a `SimpleAsyncTaskExecutor` on virtual
  threads when they are enabled). An `AsyncConfigurer` bean whose `getAsyncExecutor()` returns an
  executor takes precedence over all of the following. While Boot's executor configuration is active
  (no `Executor` bean of your own, or `mode=force`), Boot 4.1 wraps every `AsyncConfigurer` bean, and
  a `@Configuration` class that implements `AsyncConfigurer` and also declares `@Bean` methods fails at
  startup ("Illegal factory instance for factory method"). Keep the `AsyncConfigurer` in a class
  without `@Bean` methods.
- **Defining any `Executor` bean makes Boot's executor back off**, including a `ThreadPoolTaskScheduler`
  or an `ExecutorService` from `Executors.new...()`. Then the virtual-thread setting no longer applies
  to `@Async`, `spring.task.execution.*` applies only to executors you build from Boot's builder
  (which always creates platform threads), and Spring picks the executor itself: the unique
  (or `@Primary`) `TaskExecutor` bean, else the bean named `taskExecutor`, else a new
  `SimpleAsyncTaskExecutor`: one new **platform** thread per call, no limit, even with virtual threads
  enabled (observed: 100 tasks on 100 threads). `spring.task.execution.mode=force` keeps
  `applicationTaskExecutor` and routes unqualified `@Async` to it, not to your executor (unless an
  `AsyncConfigurer` returns one).
- **With `@EnableScheduling`, the scheduler is a second `TaskExecutor`.** Boot's `taskScheduler` counts as
  a candidate, so one executor of your own plus scheduling is already ambiguous, and unqualified
  `@Async` falls back to the unbounded `SimpleAsyncTaskExecutor` (Spring logs this only at INFO).
  Without scheduling, a plain `ExecutorService` bean alone (not a `TaskExecutor`) falls back the same
  way.
- Name the executor on each `@Async` (`@Async("mailExecutor")`), or mark one `@Primary`.
- Build your own executors from Boot's builder so that the task decorator (context propagation) and
  shutdown settings apply. The builder starts from `spring.task.execution.pool.*`; set what differs:

```kotlin
@Bean
fun mailExecutor(builder: ThreadPoolTaskExecutorBuilder): ThreadPoolTaskExecutor =
    builder.corePoolSize(2).maxPoolSize(4).queueCapacity(100).threadNamePrefix("mail-").build()
```

- **`ThreadPoolTaskExecutor` grows past `corePoolSize` only when the queue is full.** With an unbounded
  queue (the default when `queueCapacity` / `spring.task.execution.pool.queue-capacity` is unset),
  `maxPoolSize` is never reached and the queue grows without limit. Bound the queue and choose the
  rejection policy: the default throws `TaskRejectedException` to the submitter; `CallerRunsPolicy`
  runs the task on the submitting thread (backpressure, but a request or consumer thread now does the
  work).
- **Tasks waiting in an executor live only in memory.** A crash loses them. At shutdown (observed on
  Boot 4.1.1):
  - Platform threads, defaults: Boot's executor stops taking tasks and waits for running **and queued**
    tasks in its lifecycle phase for up to `spring.lifecycle.timeout-per-shutdown-phase` (30 s). What
    is still running is interrupted, and the rest of the queue dropped, only later at destroy time,
    after the remaining phases (`ExecutorConfigurationSupport.destroy` → `shutdown` → `shutdownNow`,
    spring-context 7.0.9), the same as for a running `@Scheduled` job
    ([config-observability](config-observability.md#graceful-shutdown)).
  - Platform threads, `spring.task.execution.shutdown.await-termination=true`: this replaces that wait.
    Without `await-termination-period` shutdown does not wait at all; with one, it waits that long and
    leaves the remaining tasks to die with the JVM.
  - Virtual threads: no wait by default; running tasks die with the JVM, without an interrupt. With
    `await-termination=true` and a period, it waits up to the period, then interrupts what is left.

  Work that must happen goes through durable state (an outbox or a job table), and the executor only
  speeds it up.
- `@Async` on a method called from the same bean runs synchronously (proxy bypassed). A task that runs
  on another thread never sees the caller's transaction; one that runs on the caller's thread (a self
  call, or `CallerRunsPolicy` when the pool is full) joins it like any synchronous call
  ([kotlin-spring-basics](kotlin-spring-basics.md#dependency-injection)).
- Context propagation: `spring.task.execution.propagate-context=true` registers a
  `ContextPropagatingTaskDecorator`, which Boot's executor and scheduler builders apply. MDC still needs
  its accessor registered ([config-observability](config-observability.md#observations-and-tracing)).
  Executors created with `Executors.new...()` or `ThreadPoolTaskExecutor()` directly get none of it.
  `@Scheduled` runs are not request-scoped anyway: on platform threads they restore the context of the
  thread that registered the job (startup), and on virtual threads they get nothing, because
  `SimpleAsyncTaskScheduler` applies no `TaskDecorator` to `fixedDelay` jobs and decorates
  `fixedRate`/`cron` runs on its trigger thread. Open the span or MDC scope inside the job.

## Testing

- Test the job's service directly. Test the wiring separately in a context test: assert the effective
  scheduler and executor types (`context.getBean<TaskScheduler>()`), so that a configuration change
  such as enabling virtual threads cannot silently serialize the jobs.
- Do not assert timing with `Thread.sleep` in unit tests; trigger the service method instead. Where the
  schedule itself matters, poll with a timeout (Awaitility or Kotest `eventually`).
- Context tests run the jobs on their own unless a property gate turns scheduling off in tests; see
  [testing](testing.md#transactions-time-and-concurrency-in-tests).

## Gotchas

- Agent sets `spring.task.scheduling.pool.size` with virtual threads enabled - it is ignored, and `fixedDelay` jobs share one thread.
- Agent adds a slow `fixedDelay` job under virtual threads - every other `fixedDelay` job waits for it.
- Agent switches a job to `fixedRate` under virtual threads - two runs of the same job can overlap, and shutdown does not wait for a running one.
- Agent assumes a `@Scheduled` job runs once per period - every replica runs it.
- Agent claims rows with `UPDATE ... LIMIT n` and then selects the claimed status - it picks up other instances' rows; select by a claim token.
- Agent commits a claim in its own transaction without a lease - a failure leaves the item claimed forever.
- Agent defines an `Executor` bean and expects virtual threads (or, for an executor not built from Boot's builder, `spring.task.execution.*`) to apply to `@Async` - Boot's executor backed off.
- Agent defines two executor beans and an unqualified `@Async` - it falls back to an unbounded `SimpleAsyncTaskExecutor`.
- Agent implements `AsyncConfigurer` on a `@Configuration` class that also has `@Bean` methods, with Boot's executor active - startup fails because Boot wraps the configurer.
- Agent enables virtual threads in a worker process with no web server - the JVM exits after startup; set `spring.main.keep-alive=true`.
- Agent adds one executor bean in an app with `@EnableScheduling` and leaves `@Async` unqualified - the scheduler is a second `TaskExecutor`, so `@Async` gets a new platform thread per call.
- Agent sets `spring.task.execution.shutdown.await-termination=true` (or the `scheduling` one) without a period - platform-thread shutdown stops waiting for running and queued work.
- Agent defines a bean declared as `ThreadPoolTaskScheduler` - Boot's `@Async` executor backs off and `@Async` runs on the scheduler pool (declare it as `TaskScheduler`, or set `mode=force`).
- Agent sets `maxPoolSize` and leaves the queue unbounded - the pool never grows past `corePoolSize`.
- Agent relies on an executor queue for work that must happen - a crash drops it, and shutdown can (after the phase timeout, or at once on virtual threads).

## Official sources

- [Spring Framework: task execution and scheduling](https://docs.spring.io/spring-framework/reference/integration/scheduling.html)
- [Spring Boot: task execution and scheduling](https://docs.spring.io/spring-boot/reference/features/task-execution-and-scheduling.html)
- [ShedLock](https://github.com/lukas-krecan/ShedLock)
