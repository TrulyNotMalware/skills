# Configuration and observability

Applies to the Go 1.27.3 toolchain with a go.mod `go` line of 1.26.0 or later, caarlos0/env v11.4.1,
viper v1.21.0, prometheus/client_golang v1.25.0 and OpenTelemetry Go v1.47.0 (otelhttp v0.72.0),
unless a rule carries a version tag. Nothing here fails a request: a missing setting reads as zero,
a corrupted log line is still written, a span with no provider goes nowhere. Measured on
darwin/arm64 with `CGO_ENABLED=0` (cgo matters only for the Prometheus process collector).

Contents: [Configuration](#configuration) · [viper](#viper) · [slog setup](#slog-setup) ·
[ReplaceAttr empty-group bug](#the-replaceattr-empty-group-bug) · [Structured calls](#structured-call-pitfalls) ·
[Context logging](#context-logging) · [Secrets in logs](#secrets-in-logs) · [Prometheus](#prometheus) ·
[OpenTelemetry](#opentelemetry) · [Gotchas](#gotchas)

## Configuration

```go
// Config is read once at start-up. Every field has a default or must be set.
type Config struct {
	Addr            string        `env:"ADDR" envDefault:":8080"`
	LogLevel        string        `env:"LOG_LEVEL" envDefault:"info"`
	ShutdownTimeout time.Duration `env:"SHUTDOWN_TIMEOUT" envDefault:"10s"`
	DB              DB            `envPrefix:"DB_"` // without envPrefix: reads URL, MAX_CONNS
}

// DB is filled from DB_URL and DB_MAX_CONNS.
type DB struct {
	URL      string `env:"URL,notEmpty"` // `required` alone accepts DB_URL=""
	MaxConns int    `env:"MAX_CONNS" envDefault:"10"`
}

// Load parses environ (env.ToMap(os.Environ()) in main); the error lists every bad variable.
func Load(environ map[string]string) (Config, error) {
	cfg, err := env.ParseAsWithOptions[Config](env.Options{Environment: environ})
	if err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return Config{}, fmt.Errorf("config: %w", err)
	}
	return cfg, nil
}

func (c Config) validate() error {
	var errs []error
	if c.ShutdownTimeout <= 0 {
		errs = append(errs, fmt.Errorf("SHUTDOWN_TIMEOUT must be positive, got %v", c.ShutdownTimeout))
	}
	if c.DB.MaxConns < 1 {
		errs = append(errs, fmt.Errorf("DB_MAX_CONNS must be at least 1, got %d", c.DB.MaxConns))
	}
	return errors.Join(errs...)
}
```

`run` returns `Load`'s error before anything listens ([lifecycle-deploy](lifecycle-deploy.md)).
env checks types, not ranges: `DB_MAX_CONNS=0` parses and only `validate` rejects it. With
`Options.Environment` set only the map is read, which keeps tests hermetic.

- **`os.Getenv` cannot tell unset from empty**; `os.LookupEnv` returns `ok=false` only when unset.
  Hand-written `n, _ := strconv.Atoi(os.Getenv("WORKERS"))` turns `WORKERS=eight` into 0. Reported
  by: none — test or review (errcheck only with `check-blank`; see the go-style skill, errors-control).
- **caarlos0/env tags `(env v11.4)`**, measured below. `errors.AsType[env.EmptyVarError]` and
  `[env.VarIsNotSetError]` match through `%w`. Reported by: none — test or review.

| tag and environment | result |
|---|---|
| `env:"TOKEN,required"`, TOKEN unset | `env: required environment variable "TOKEN" is not set` (`env.VarIsNotSetError`) |
| same, **`TOKEN=""`** | **no error**, empty string |
| `env:"URL,notEmpty"` (prefix `DB_`), unset or `""` | `env: environment variable "DB_URL" should not be empty` (`env.EmptyVarError`): `notEmpty` implies required |
| `WORKERS=""` with `envDefault:"4"` | 4: an empty value takes the default |
| `WORKERS=eight TIMEOUT=5 DEBUG=yes` | one error naming all three (`parse error on field "Timeout" of type "time.Duration": … missing unit in duration "5"; parse error on field "Workers" …`); those fields stay zero, no default applied |
| nested struct field without `envPrefix`, `HOST=h` | reads `HOST`; two such fields of one type both get `h` |
| `env.Options{RequiredIfNoDef: true}` | every tagged field without `envDefault` is required |

## viper

`v.Get` consults the environment for any key; `v.Unmarshal` fills only keys viper knows (file,
`SetDefault`, bound env), so a struct-only key is zero with no error `(viper v1.21)`. `AutomaticEnv`,
`SERVER_PORT=9000 SERVER_HOST=envhost DB_URL=envurl NAME=envname`, YAML holding `server.port: 8080`:

| setup | port | host | db.url, name |
|---|---|---|---|
| `SetEnvKeyReplacer(strings.NewReplacer(".", "_"))`, no file | 0 | "" | "" |
| replacer + YAML | **9000** | "" | "" |
| YAML, no replacer (looks up `SERVER.PORT`) | 8080 | "" | "" |
| replacer + YAML + `SetDefault("server.host", …)` | 9000 | envhost | "" |
| replacer + YAML + `BindEnv` per key (one argument) | 9000 | envhost | envurl, envname |
| `viper.NewWithOptions(viper.ExperimentalBindStruct())` + replacer, with or without YAML | 9000 | envhost | envurl, envname |
| `ExperimentalBindStruct()`, no replacer, no file | 0 | "" | "", envname (top-level keys need no replacer) |
| replacer + YAML, `SERVER_PORT=abc` | error `'server.port' cannot parse value as 'int'` | | |

- **Every env-only key needs `SetDefault`, `BindEnv` or `ExperimentalBindStruct`**, plus the
  replacer for nested keys. Test the loaded struct with each variable set. Reported by: none — test or review.

## slog setup

```go
// Config is package logsetup's own type, not the service Config above:
// main fills Level from LogLevel.
type Config struct {
	Level    string   // "debug", "info", "warn" or "error"
	Redact   []string // attribute keys whose values are hidden, matched case-insensitively
	OmitTime bool     // drop the time key when the log collector stamps lines itself
}

// New returns a JSON logger and the LevelVar that controls it at run time.
// It does not call slog.SetDefault; main decides that.
func New(w io.Writer, cfg Config) (*slog.Logger, *slog.LevelVar, error) {
	level := new(slog.LevelVar)
	if err := level.UnmarshalText([]byte(cfg.Level)); err != nil {
		return nil, nil, fmt.Errorf("log level %q: %w", cfg.Level, err)
	}
	redact := make(map[string]bool, len(cfg.Redact))
	for _, k := range cfg.Redact {
		redact[strings.ToLower(k)] = true
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		// ReplaceAttr never sees fields inside a struct passed with slog.Any.
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if cfg.OmitTime && len(groups) == 0 && a.Key == slog.TimeKey {
				return slog.Attr{} // drop: safe for top-level built-in keys
			}
			if redact[strings.ToLower(a.Key)] {
				// Replace, never drop: emptying a group corrupts the line (Go 1.22–1.27.3).
				return slog.String(a.Key, "[redacted]")
			}
			return a
		},
	})
	return slog.New(h), level, nil
}
```

`level.Set(slog.LevelDebug)` applies to the next call; a bad level fails start-up (`log level
"verbose": slog: level string "verbose": unknown name`). `AddSource: true` writes an absolute file
path. ReplaceAttr also runs inside groups: test `len(groups) == 0` before touching built-in keys.

- **`slog.SetDefault` rewires both loggers.** Before it, `slog.Info("hello", "k", 1)` goes through
  `log` (`2026/10/12 11:17:21 INFO hello k=1` on stderr, Debug dropped). After it, `log.Printf`
  lines reach the handler as `"level":"INFO"` records (`slog.SetLogLoggerLevel` sets the level),
  `log.Flags()` is 0, and with `Server.ErrorLog` nil net/http's own errors, panics included, arrive
  at INFO ([lifecycle-deploy](lifecycle-deploy.md)). Reported by: none — test or review.
- **`log.SetOutput` after SetDefault undoes the routing**: `log.Printf` prints plain text to the new
  writer while slog stays JSON. Reported by: none — test or review.
- **Wrapping the pre-SetDefault default handler deadlocks the first log call**: after
  `slog.SetDefault(slog.New(tagHandler{slog.Default().Handler()}))`, `slog.Info` never returned (a
  10 s watchdog fired; go1.26.8, go1.27.1); with no other goroutine the runtime aborts `all
  goroutines are asleep - deadlock!`. That handler writes through `log`, which leads back to it, and
  locks the `log.Logger` mutex twice. Wrap a handler you built. Reported by: none — test or review.

## The ReplaceAttr empty-group bug

ReplaceAttr returns `slog.Attr{}` for key `password` (and drops the top-level time); the call is
`Info("login", slog.Group("req", "password", "x"), "user", "ann")`, module `go 1.21`:

| toolchain | JSONHandler | TextHandler |
|---|---|---|
| go1.21.13 | `{"level":"INFO","msg":"login","req":{},"user":"ann"}` | `level=INFO msg=login user=ann` |
| go1.22.12, 1.23.12, 1.24.13, 1.25.14, 1.26.10, 1.27.3 | `{"level":"INFO","msg":"login""user":"ann"}`: **invalid JSON** (no comma) | `level=INFO msg=login req.user=ann`: **moved into the group** |

- ReplaceAttr then sees `user` with `groups=["req"]`, so `len(groups) == 0` checks misfire.
  `slog.Group("g", slog.Attr{})` with nil options breaks the line the same way. A group keeping one
  member, an empty `slog.Group("req")` literal, or the emptied group as the last attribute stayed valid.
- Cause (go1.27.3 `log/slog/handler.go` 504–524): the buffer is rolled back, the separator, key
  prefix and group list set when the group opened are not. golang/go#81970 was fixed on the development
  branch on 2026-10-05 for Go 1.28; go1.27.3 and go1.26.10 still reproduce it, so no 1.27 backport has
  shipped. Gate: `(toolchain 1.22–1.27.3)`.
- **Redact by replacing the value**, as `New` does; dropping top-level built-in keys is safe. A test
  that runs `json.Valid` on every logged line catches it. Reported by: none — test or review.

## Structured-call pitfalls

- **Odd or non-string keys produce `!BADKEY`**: `Info("m", "k")` → `"!BADKEY":"k"`;
  `Info("m", "k", 1, 2)` → `"k":1,"!BADKEY":2`; `Info("m", 42, "v")` → `"!BADKEY":42,"!BADKEY":"v"`
  (duplicate keys). Reported by: `vet+test` (slog: `missing a final value`; `go help test` omits
  slog but runs it); `gopls:slog`; `golangci:govet (standard)`; staticcheck silent.
- **Errors print as `Error()` in both handlers** (`"err":"load config: file missing"`), unless the
  type has other methods: JSON uses `MarshalJSON` (`"err":{"custom":true}`); Text uses `MarshalText`,
  or `%+v` for a `fmt.Formatter`, so a stack-carrying error writes its stack into the Text value
  (`err="short\nstack: main.go:12"`, JSON `"err":"short"`). Use one key (a helper `Err(err) slog.Attr`).
- **JSONHandler renders structs with `encoding/json`, TextHandler with `%+v`.** A struct with only
  unexported fields prints `{}` in JSON and `{v:x}` in Text; a `json:"-"` field is hidden in JSON
  and printed in Text. Reported by: none — test or review.

## Context logging

```go
type ctxKey struct{}

// WithRequestID returns a copy of ctx that carries id.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// Handler wraps a real handler (never the pre-SetDefault default one) and adds request_id.
type Handler struct {
	slog.Handler
}

// Handle adds request_id when the context carries one. Built-in handlers ignore ctx.
func (h Handler) Handle(ctx context.Context, r slog.Record) error {
	if id, ok := ctx.Value(ctxKey{}).(string); ok {
		r.AddAttrs(slog.String("request_id", id))
	}
	return h.Handler.Handle(ctx, r)
}

// WithAttrs keeps the wrapper; the embedded method would return the bare inner handler.
func (h Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return Handler{h.Handler.WithAttrs(attrs)}
}

// WithGroup keeps the wrapper. Attributes added in Handle land inside the open group.
func (h Handler) WithGroup(name string) slog.Handler {
	return Handler{h.Handler.WithGroup(name)}
}
```

- **Built-in handlers ignore ctx**: `InfoContext(ctx, …)` printed no request ID without the
  wrapper; plain `Info` never has one.
- **A wrapper that overrides only `Handle` loses the ID after `.With(…)`**: the embedded
  `WithAttrs` returns the inner handler, so `log.With("component", "db").InfoContext(ctx, …)`
  printed `"component":"db"` and no `request_id`; after `.WithGroup("g")`, `"g":{"k":1}`. With the
  full wrapper above the ID lands inside the group: `"g":{"k":1,"request_id":"req-42"}`. Reported
  by: none — test or review.
- **`slog.NewMultiHandler` `(toolchain ≥1.26)`** fans a record out; each handler keeps its own
  level. In a `go 1.25` module it still builds with go1.27.3 and go1.26.10. Reported by: `vet+test`
  (stdversion: `slog.NewMultiHandler requires go1.26 or later (module is go1.25)`).

## Secrets in logs

The redacting secret type is in [security-auth](security-auth.md). What the handlers do:

| logged | result |
|---|---|
| `slog.Any("headers", r.Header)` | `"headers":{"Authorization":["Bearer s3cr3t-token"]}`; Text `map[Authorization:[…]]` |
| same, ReplaceAttr redacting key `authorization` | still leaks: ReplaceAttr sees the key `headers`, never map keys |
| `slog.Any("r", r)` (`*http.Request`) | JSON `"!ERROR:json: unsupported type: func() (io.ReadCloser, error)"`; Text dumps it, headers included |
| a struct whose `Password` field type has `LogValue` | `"Password":"hunter2"`: LogValue applies only to the value passed to slog (or in `slog.Group`), not to fields |
| a pointer-receiver `LogValue` type passed by value | `hunter2`; passed as a pointer: `[REDACTED]` |

Log chosen headers by name (`slog.String("user_agent", r.UserAgent())`), never the map or the
request. Reported by: none — test or review (vet, staticcheck, gopls, golangci baseline silent).

## Prometheus

```go
// Metrics owns its registry, so building two servers in one test does not panic.
type Metrics struct {
	reg      *prometheus.Registry
	duration *prometheus.HistogramVec
}

// ...

// Wrap must wrap the *http.ServeMux directly: the mux sets r.Pattern on the
// *Request it receives, so a layer in between that passes r.WithContext(...)
// or http.StripPrefix leaves this r.Pattern empty.
func (m *Metrics) Wrap(mux http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		mux.ServeHTTP(w, r)
		route := r.Pattern // set by the mux during ServeHTTP; "" before it
		if route == "" {
			route = "unmatched" // 404, 405: never r.URL.Path (one series per URL)
		}
		m.duration.WithLabelValues(r.Method, route).Observe(time.Since(start).Seconds())
	})
}
```

`New` fills `reg` with `prometheus.NewRegistry()` and registers `duration` on `method` and `route`;
`promhttp.HandlerFor(m.reg, …)` serves it `(client_golang v1.25)`. A status label needs the response-writer wrapper from
[http-server](http-server.md); requests an outer layer rejects never reach `Wrap`.

- **Registering a name twice panics at start-up**, typically a test building the server twice on
  `prometheus.DefaultRegisterer`: `duplicate metrics collector registration attempted`; with other
  help text, `a previously registered descriptor with the same fully-qualified name as Desc{…} has
  different label names or a different help string`. `prometheus.Register` returns the error
  (`errors.AsType[prometheus.AlreadyRegisteredError]` → `ExistingCollector`). A registry per server,
  built twice in one test binary, did not panic. Reported by: none — test or review.
- **A fresh registry exposes nothing** (0 bytes) until you register `collectors.NewGoCollector()`
  and `collectors.NewProcessCollector(…)`; `promhttp.Handler()` has both: 29 `go_` families and, on
  darwin with `CGO_ENABLED=0`, `process_cpu_seconds_total`, `_max_fds`, `_open_fds`,
  `_start_time_seconds`, `_virtual_memory_max_bytes`. Memory sizes need cgo on darwin (source).
- **Label by route, not path**: 1000 requests to `/users/0`…`/users/999` made 1000 series by
  `r.URL.Path`, 1 by `r.Pattern`. Reported by: none — test or review.
- **`r.Pattern` reaches an outer middleware only after `next`, on the same `*Request`** (field
  `(toolchain ≥1.23)`, set by the `(main go ≥1.22)` mux; full matrix in [http-server](http-server.md)).
  Put `Wrap` right around the mux, inside layers that copy the request (auth, request ID, timeouts).
  Reported by: none — test or review.

| chain | `r.Pattern` after `next` (before `next`: always `""`) |
|---|---|
| `Wrap(mux)`, `GET /users/7` | `GET /users/{id}` |
| a layer between them passes `r.WithContext(…)` | `""`: every route became `unmatched` in the test |
| `http.StripPrefix` or `http.TimeoutHandler` between them | `""` (they pass a copy) |

## OpenTelemetry

```go
// Setup must run before the first span (until then every span is a no-op), and the
// caller must call shutdown on exit, or the spans still in the batch are lost.
func Setup(exp sdktrace.SpanExporter) (shutdown func(context.Context) error) {
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{}) // used by otelhttp or your own Extract/Inject
	return tp.Shutdown
}
```

```go
// run shows only the tracing part of the service's run function.
func run(ctx context.Context, exp sdktrace.SpanExporter) error {
	shutdownTracing := tracing.Setup(exp)
	defer func() {
		// Not the canceled signal context: Shutdown would return before exporting.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := shutdownTracing(ctx); err != nil {
			slog.Error("flush traces", "error", err) // spans still buffered are lost
		}
	}()
	// ... build and serve until ctx is canceled
	return nil
}
```

- **Without `otel.SetTracerProvider` every span is a no-op** `(otel v1.47)`: `valid=false
  recording=false`, zero trace ID, nothing logged. A tracer taken earlier delegates once a provider
  is set, so a package-level `otel.Tracer(…)` is fine. Reported by: none — test or review.
- **The default propagator injects nothing** (`Fields()` empty, no `traceparent`) until
  `otel.SetTextMapPropagator`, **and net/http never calls it**. With `TraceContext` set, a plain
  handler saw no span context for an incoming `traceparent` and a plain client sent none. The trace
  continued only through `otelhttp.NewHandler` and `otelhttp.NewTransport` `(otelhttp v0.72)`, or
  an explicit `Extract` from `propagation.HeaderCarrier(r.Header)` and `Inject` into `req.Header`.
  Reported by: none — test or review.
- **Without a resource, traces are named `unknown_service:<executable>`**; the default resource
  honoured `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES=service.name=…`.
- **The batch processor holds spans in memory** (3 spans ended). Reported by: none — test or
  review. In tests, `tp.Shutdown` resets a `tracetest.InMemoryExporter`: count spans before it.

| process ending | spans exported |
|---|---|
| `main` returns, no Shutdown | 0 |
| `tp.Shutdown(ctx)` or `tp.ForceFlush(ctx)` | 3 |
| alive 6 s, no Shutdown (default BatchTimeout 5 s) | 3 |
| exporter takes 2 s, `Shutdown` with a 200 ms deadline, process stays alive | Shutdown returns `context deadline exceeded` at 200 ms; the export completes 2 s later |
| same, process exits right after Shutdown | 0 |
| `Shutdown` with an already canceled context | returns `context canceled` at once; 0 if the process then exits (alive past BatchTimeout: exported at 5 s) |

## Gotchas

- Agent tags a variable `env:"X,required"` - `X=""` passes; use `notEmpty`.
- Agent nests two config structs without `envPrefix` - both read the same unprefixed variables.
- Agent relies on viper `AutomaticEnv` for keys that are only in the struct - `Unmarshal` leaves them zero, no error.
- Agent drops a sensitive attribute in ReplaceAttr with `slog.Attr{}` - on Go 1.22–1.27.3 a group that loses all its members makes JSONHandler write invalid JSON.
- Agent wraps `slog.Default().Handler()` and passes it to `slog.SetDefault` - the first log call deadlocks.
- Agent calls `log.SetOutput` after `slog.SetDefault` - `log.Printf` lines leave the structured stream.
- Agent writes a context handler that overrides only `Handle` - `logger.With(...)` and `WithGroup(...)` drop the request ID.
- Agent logs `r.Header` or a struct with a `Password` field - the secret is printed; ReplaceAttr and nested LogValue do not reach it.
- Agent labels metrics with `r.URL.Path` - one series per URL until the process restarts.
- Agent reads `r.Pattern` before `next`, or above a layer that calls `r.WithContext` - the label is always empty.
- Agent registers metrics on the default registry in a constructor - the second server in a test panics.
- Agent returns from `main` without `TracerProvider.Shutdown` - buffered spans are never exported.
- Agent sets the global propagator and serves or calls with plain net/http - the incoming `traceparent` is ignored and outgoing calls carry none.

## Official sources

- [log/slog](https://pkg.go.dev/log/slog), [A Guide to Writing slog Handlers](https://github.com/golang/example/tree/master/slog-handler-guide), [golang/go#81970](https://github.com/golang/go/issues/81970)
- [os.LookupEnv](https://pkg.go.dev/os#LookupEnv), [caarlos0/env v11](https://pkg.go.dev/github.com/caarlos0/env/v11), [viper v1.21.0](https://pkg.go.dev/github.com/spf13/viper@v1.21.0)
- [client_golang prometheus](https://pkg.go.dev/github.com/prometheus/client_golang/prometheus), [Prometheus instrumentation practices](https://prometheus.io/docs/practices/instrumentation/)
- [OpenTelemetry Go](https://opentelemetry.io/docs/languages/go/), [sdk/trace](https://pkg.go.dev/go.opentelemetry.io/otel/sdk/trace), [propagation](https://pkg.go.dev/go.opentelemetry.io/otel/propagation), [otelhttp](https://pkg.go.dev/go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp), [SDK environment variables](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)
