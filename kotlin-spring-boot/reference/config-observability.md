# Configuration and observability

Profiles and externalized configuration, Actuator health, Micrometer metrics and observations,
tracing, logs, and graceful shutdown on Boot 4.1. Typed property binding (`@ConfigurationProperties`, placeholders,
secrets in `toString()`) is in [kotlin-spring-basics](kotlin-spring-basics.md#configuration-properties).
Database migrations are out of scope here. Property names and defaults below were read from the Boot
4.1.1 configuration metadata on 2026-09-29.

Contents: [Configuration sources and profiles](#configuration-sources-and-profiles) ·
[Actuator and health](#actuator-and-health) · [Metrics (Micrometer)](#metrics-micrometer) ·
[Observations and tracing](#observations-and-tracing) · [Logs](#logs) ·
[Graceful shutdown](#graceful-shutdown) · [Gotchas](#gotchas)

## Configuration sources and profiles

- Precedence, low to high (simplified): packaged `application.yaml` → packaged
  `application-<profile>.yaml` → external `application.yaml` next to the jar or in `config/` →
  external profile files → OS environment variables → system properties → command-line arguments.
  A `spring.config.import` overrides the document that imports it, not everything else. Know where
  the deployed value actually comes from before editing a file.
- Profile documents override **key by key**; lists are replaced as a whole, maps merge
  ([kotlin-spring-basics](kotlin-spring-basics.md#configuration-properties)).
- Activate profiles from outside (`SPRING_PROFILES_ACTIVE=prod`). Setting `spring.profiles.active` inside
  `application-<profile>.yaml` fails startup (`InvalidConfigDataPropertyException`); inside an
  `on-profile` document of an imported file it is **not** rejected and silently overrides the active
  profiles, which is worse.
- Profile groups (`spring.profiles.group.prod: prod-db, prod-kafka`) must be declared in the base
  (non-profile-specific) configuration. Declaring a group does not activate it; activating `prod`
  activates its members.
- `spring.config.activate.on-profile` inside a multi-document YAML scopes that document to a profile.
- `spring.config.import=optional:file:./secrets.yaml` or `configtree:/run/secrets/` (mounted
  Kubernetes/Docker secrets as files). Without `optional:`, a missing import fails startup, which is
  what you want for required config.
- Secrets never go into committed YAML, not even as defaults. Use `${ENV_VAR}` placeholders and
  validate that required ones are present ([placeholder pitfall](kotlin-spring-basics.md#configuration-properties)).
- Keep per-environment differences in configuration, not in `@Profile` beans. Profile-specific beans
  hide behavior differences that tests on another profile never execute.

## Actuator and health

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health, info, prometheus   # default: health only; prometheus needs micrometer-registry-prometheus
  endpoint:
    health:
      show-details: never  # liveness/readiness probe groups are on by default in Boot 4.1
```

- Expose only what is needed. `heapdump` and `threaddump` leak memory contents and internals,
  `loggers` allows runtime changes, and `env`/`configprops` reveal configuration (values are
  sanitized by default; do not turn that off). Keep them off the public network or behind
  authentication.
- **Defining any `SecurityFilterChain` makes Boot's default actuator security back off.** Without a
  custom chain, Boot permits `/actuator/health` and secures the rest; with one, the actuator paths
  fall under your rules (for example `anyRequest().authenticated()` turns `/actuator/health` into
  401 and breaks probes). Secure `/actuator/**` explicitly and permit the probe paths the platform
  calls.
- A separate management port (`management.server.port`) is network separation only if the network
  enforces it; it adds no authentication by itself.
- **Liveness vs readiness:** liveness answers "should this process be restarted?", readiness answers
  "should it get traffic?". Do not put external dependencies (DB, Kafka, downstream APIs) into
  **liveness**: a database outage then restarts every pod in a loop without fixing anything. Be careful
  with readiness too: a dependency **shared by all replicas** in readiness takes every replica out of
  the load balancer at once during its outage. Include only what makes this instance unable to serve,
  and alert on shared dependencies instead.
- **An `OutOfMemoryError` does not change the liveness state.** `LivenessState` turns `BROKEN` only
  when code publishes it, and `catch (e: Exception)` or `runCatching` boundaries report an OOM as an
  ordinary failure, so a pod with a damaged heap stays Ready and keeps taking traffic. Start container
  JVMs with `-XX:+ExitOnOutOfMemoryError` so the kubelet restarts the pod. Put the flag where the
  container starts (the image `ENTRYPOINT` or the Pod's `JAVA_TOOL_OPTIONS`): a launcher script that
  Kubernetes never runs does not count.
- With a separate management port, the probe can succeed while the application port is broken. Set
  `management.endpoint.health.probes.add-additional-paths=true` to also expose `/livez` and `/readyz`
  on the main port, and permit them in the security chain.
- `/actuator/health/liveness` and `/readiness` exist by default in Boot 4.1
  (`management.endpoint.health.probes.enabled` defaults to `true`).
- Custom `HealthIndicator` beans (`org.springframework.boot.health.contributor` in Boot 4, module
  `spring-boot-health`) join the default `health` group. Assign them to a probe group deliberately
  (`management.endpoint.health.group.readiness.include=readinessState,db`).
- Groups have their own `show-details`/`show-components` settings; the global ones are not inherited
  by the liveness/readiness groups.
- Health checks run on every probe. Keep them cheap and bounded: set real timeouts on the dependency
  calls inside the indicator. `management.endpoint.health.logging.slow-indicator-threshold` (default
  10s) only **logs** slow indicators; it does not time them out. `management.endpoint.health.cache.time-to-live`
  caches the top-level `/actuator/health` operation, but not the probe-group paths
  (`/health/liveness`, `/health/readiness`); cache expensive results inside the indicator if needed.

## Metrics (Micrometer)

```kotlin
@Component
class OutboxMetrics(registry: MeterRegistry, private val outbox: OutboxRepository) {
    init {
        Gauge.builder("outbox.pending.oldest.age.seconds") { outbox.oldestPendingAgeSeconds() }
            .register(registry)
    }
    private val sent = Counter.builder("outbox.sent").register(registry)
    fun recordSent() = sent.increment()
}
```

- **Tag cardinality is the main risk.** Never use user IDs, order IDs, raw URLs, exception messages,
  or timestamps as tag values. Each distinct value creates a new time series. Use bounded sets
  (status, outcome, type).
- A `Gauge` holds a **weak reference** to its state object. If nothing else references the object,
  it is garbage-collected and the gauge reports `NaN`. Keep the state in a bean field or register
  with a function that reads from a long-lived bean, as above.
- `@Timed`, `@Counted`, and `@Observed` need their aspects. In Boot 4.1 enable annotation support with
  `management.observations.annotations.enabled=true` (default `false`) and add
  `spring-boot-starter-aspectj` (Boot 4's AOP starter). Without both the annotations do nothing,
  silently.
- Percentiles: histogram buckets (`management.metrics.distribution.percentiles-histogram.<meter>=true`)
  can be aggregated across instances on the server; client-side `percentiles` cannot. But buckets
  multiply time series by every tag combination, and backend support varies. Enable them only for
  meters that need them, bound them (`minimum-expected-value`/`maximum-expected-value`, or explicit
  `slo` buckets), and do not configure both for the same meter (the Prometheus registry cannot publish
  both under one name).
- Name meters with dots (`outbox.sent`); the registry converts to the backend's convention
  (`outbox_sent_total` in Prometheus).

## Observations and tracing

- The Observation API (`ObservationRegistry`) lets one instrumentation feed several handlers: with a
  meter registry and a tracer configured, an observation produces both a timer and a span.
- Instrumented out of the box: Spring MVC server requests, `@Scheduled` tasks, Kafka (when enabled,
  below), and `RestClient`/`WebClient` **built from the Boot-configured builders** that you inject
  (`RestClient.Builder` from `spring-boot-starter-restclient`, `WebClient.Builder`). A client created
  with `RestClient.create()` has no observation registry: no `http.client.requests` metric and no
  `traceparent` header to the next service (verified on 4.1.1).
- JDBC is **not** observed automatically (neither `JdbcClient` nor JPA queries); add datasource
  instrumentation (for example Datasource Micrometer) if you need query spans.
- Instrument your own boundaries with `Observation.createNotStarted(...).observe { }` or `@Observed`.
- Tracing in Boot 4: `spring-boot-starter-opentelemetry` (Micrometer Tracing with the OpenTelemetry
  bridge). Export endpoint: `management.opentelemetry.tracing.export.otlp.endpoint`. Boot 3's
  `management.otlp.tracing.endpoint` still appears in the metadata as deprecated (error level) but
  binds to nothing: setting it neither fails startup nor exports anything.
- OTLP **metrics** are separate from OTLP traces: they need `micrometer-registry-otlp` and
  `management.otlp.metrics.export.url` (for example `http://collector:4318/v1/metrics`). Setting the
  tracing endpoint does not export metrics.
- **Sampling defaults to 10%** (`management.tracing.sampling.probability=0.1`). In development or low
  traffic, set it to `1.0` or traces "randomly" go missing.
- Propagation: W3C `traceparent` is produced; W3C and B3 are accepted by default. Check what the
  gateway and other services send before changing `management.tracing.propagation.*`.
- Kafka: producer and listener observations are off by default in Spring Kafka. Enable them
  (`spring.kafka.template.observation-enabled=true`, `spring.kafka.listener.observation-enabled=true`)
  to get trace context across the broker.
- Context crosses threads only when propagated: `@Async` executors, custom thread pools, and coroutines
  lose the current span and MDC unless the executor or coroutine context propagates them
  ([coroutines](coroutines.md#spring-integration)). Boot does **not** propagate by default. Define a
  `ContextPropagatingTaskDecorator` bean (or set `spring.task.execution.propagate-context=true`, which
  registers one); Boot's auto-configured executor picks it up. It restores only
  values whose `ThreadLocalAccessor` is registered: MDC's `Slf4jThreadLocalAccessor` is not registered
  automatically, so register it (as for coroutines) or MDC stays empty. Manually created
  `Executors.new...()` pools and a `ThreadPoolTaskExecutor()` built without Boot's builder get none of
  this, and `@Scheduled` runs do not receive a request's context at all
  ([scheduling-executors](scheduling-executors.md#async-and-executor-beans)).

## Logs

- Structured logs are built in: `logging.structured.format.console=ecs` (or `logstash`, `gelf`). Do
  not add a Logstash encoder dependency to get JSON logs.
- With tracing on the classpath, Boot adds `traceId`/`spanId` to MDC and the default log pattern
  (`logging.pattern.correlation`). Structured formats include MDC entries.
- Log with lambdas (`log.info { "sent $id" }`) so messages are built only when enabled.
- **Log injection:** values from requests (headers, command names, user input) can contain newlines or
  control characters that forge log lines. Sanitize them before logging (replace `\p{Cntrl}`), or rely
  on a structured (JSON) format that escapes them.
- Never log secrets, tokens, full request bodies, or personal data by default. `data class`
  `toString()` includes every property; override it or log selected fields.
- Log the exception object (`log.error(e) { "..." }`), not `e.message`, so the stack trace and cause
  chain survive.
- Testing logging configuration: Logback's `LoggerContext` is JVM-wide, so tests that start several
  application contexts in one JVM can see each other's logging setup (a `logging.structured.*` test
  passes or fails depending on order). Run such tests in their own JVM (`forkEvery = 1` for that test
  task, or a separate task).

## Graceful shutdown

- Boot 4.1 defaults (metadata): `server.shutdown=graceful` and
  `spring.lifecycle.timeout-per-shutdown-phase=30s`. On SIGTERM the lifecycle processor stops phases from
  highest to lowest, each up to the phase timeout. Kafka listener containers (`Integer.MAX_VALUE - 100`)
  stop before the web server drain (`Integer.MAX_VALUE - 1024`), where the server stops taking new requests
  and waits for active ones; the scheduler and `@Async` executors (`Integer.MAX_VALUE / 2`) stop after it.
- **Add the waits up against the platform's grace period.** Kubernetes kills the container after
  `terminationGracePeriodSeconds` (default 30 s). The `preStop` delay, the web drain, later lifecycle
  phases, and executor waits (`spring.task.execution.shutdown.await-termination-period`,
  `spring.task.scheduling.shutdown.await-termination-period`) all come out of that one budget. With
  both defaults at 30 s, a slow drain alone uses all of it and the rest is cut off.
- Kubernetes starts removing the pod from Service endpoints at the same time as it starts the pod's
  shutdown (`preStop` hook, then SIGTERM), so requests can still arrive after shutdown starts. A short
  `preStop` sleep lets routing catch up before the server stops accepting (Boot's deployment docs
  suggest it).
- **Running `@Scheduled` jobs** (observed on Boot 4.1.1): a running job is waited for in the scheduler's
  lifecycle phase, up to `timeout-per-shutdown-phase`; a job still running is interrupted at destroy time,
  after the remaining phases. That holds for the platform
  `ThreadPoolTaskScheduler` and for `fixedDelay` jobs on virtual threads. On virtual threads, `fixedRate`
  and `cron` runs are **not** waited for: the JVM exits mid-run and `finally` blocks do not run, unless
  `spring.task.scheduling.shutdown.await-termination=true` with an `await-termination-period`. On the
  platform scheduler, `await-termination=true` replaces the phase wait with the period and does not
  interrupt at the end; without a period it does not wait at all. `@Async` executors are covered in
  [scheduling-executors](scheduling-executors.md#async-and-executor-beans).
- **Count the phases that can wait, one after another** (Framework 7.0, Boot 4.1.1). A phase waits, up to
  `timeout-per-shutdown-phase`, only while one of its beans has work in flight, and beans in the same phase
  share one wait. The Kafka listener containers, the web drain and a scheduler with a running job are three
  separate phases (above); ordinary `SmartLifecycle` beans (`Integer.MAX_VALUE`) can add a fourth. With each
  phase held busy and a 1 s timeout, every phase added the full second (observed). An executor with
  `waitForTasksToCompleteOnShutdown` (or `acceptTasksAfterContextClose`) skips its phase wait and waits at
  destroy time, after every phase, only for its await-termination period; without a period it does not wait.
- **The phase timeout bounds `stop(Runnable)` callbacks, not a blocking `stop()`** (spring-kafka 4.1.1, from
  source). `DefaultKafkaProducerFactory` is a `SmartLifecycle` in phase `Integer.MIN_VALUE` without a
  `stop(Runnable)` override; its `stop()` closes every producer it holds synchronously, one after another, each
  waiting up to `physicalCloseTimeout` (30 s by default) for unsent records. A factory that is not a bean is
  closed only if its owner calls `destroy()` or `reset()`, at destroy time with the same wait. Set the timeout
  and count each producer's close.
- **A Kafka listener container waits for the work in hand only up to the phase timeout** (spring-kafka 4.1.1,
  from source): with `stopImmediate` the current record, otherwise the rest of the poll. Its destroy-time
  `stop()` does nothing because the container is already marked not running, so a slower record keeps running
  unwatched, possibly after its producer factory and `DataSource` are closed, until the JVM exits. Its side
  effects must be claim-based or idempotent, as for SIGKILL.
- Make long jobs resumable (claim leases, idempotent steps): SIGKILL and crashes never wait.

## Gotchas

- Agent exposes `heapdump`/`threaddump`/`loggers` on the public port - keep them internal or authenticated.
- Agent adds a custom `SecurityFilterChain` and forgets `/actuator/**` - Boot's default actuator security is gone.
- Agent builds `RestClient.create()` and expects traces downstream - inject the Boot `RestClient.Builder`.
- Agent puts a shared dependency (DB) into readiness - every replica drops out at once.
- Agent relies on `slow-indicator-threshold` as a timeout - it only logs.
- Agent adds the database or Kafka to the liveness probe - an outage restarts every pod; use readiness.
- Agent sets `-XX:+ExitOnOutOfMemoryError` in a launcher script but not in the container `ENTRYPOINT` - an OOM in the pod is logged as a failure and the pod stays Ready.
- Agent tags metrics with IDs or URLs - unbounded cardinality.
- Agent registers a `Gauge` on a temporary object - it is collected and reports `NaN`.
- Agent adds `@Timed`/`@Observed` without `management.observations.annotations.enabled=true` - nothing is recorded.
- Agent configures `management.otlp.tracing.endpoint` in Boot 4 - it is inert; use `management.opentelemetry.tracing.export.otlp.endpoint`.
- Agent adds a `ContextPropagatingTaskDecorator` and expects MDC in `@Async` - register the MDC accessor too.
- Agent uses `spring-boot-starter-aop` - Boot 4's starter is `spring-boot-starter-aspectj`.
- Agent wonders why traces are missing locally - sampling is 10% by default.
- Agent enables Kafka but expects traces across the broker - enable template and listener observations.
- Agent logs request values unsanitized - newline/control-character log injection.
- Agent activates profiles inside a profile-specific document - activation belongs outside.
- Agent sets shutdown timeouts (phase, executor await, `preStop`) one by one - add them up against the pod's grace period, or the pod is killed mid-drain.
- Agent adds up only the timeouts it configured - the Kafka containers, the web drain and a scheduler with a running job are three default phases that can each wait the full phase timeout, and each producer a `DefaultKafkaProducerFactory` holds closes synchronously for up to `physicalCloseTimeout`, outside the phase timeout.
- Agent sets `spring.task.*.shutdown.await-termination=true` without a period - on platform threads shutdown then stops waiting for running work at all.

## Official sources

- [Externalized configuration](https://docs.spring.io/spring-boot/reference/features/external-config.html)
- [Actuator endpoints and health](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html)
- [Kubernetes probes](https://docs.spring.io/spring-boot/reference/actuator/endpoints.html#actuator.endpoints.kubernetes-probes)
- [Observability](https://docs.spring.io/spring-boot/reference/actuator/observability.html)
- [Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- [Structured logging](https://docs.spring.io/spring-boot/reference/features/logging.html#features.logging.structured)
