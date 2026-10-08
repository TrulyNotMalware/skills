# Naming, API shape, doc comments and packages

Applies to Go 1.27.1 with a go.mod `go` line of 1.26 or later unless a rule carries a version tag
([tags and labels](versions-tools.md#reported-by-vocabulary)). Naming and API rules rarely break a
build; they decide whether callers can use a package without reading its source, and whether a
later change breaks them. Where the main style guides disagree, [SKILL.md](../SKILL.md#house-defaults)
gives the default; the codebase's own convention wins over both.

Contents: [Names](#names) · [API shape](#api-shape) · [Constructors and options](#constructors-and-options) ·
[Doc comments](#doc-comments) · [Packages, init and globals](#packages-init-and-globals) ·
[Enums and exhaustive switches](#enums-and-exhaustive-switches) · [Generics](#generics) ·
[What the linters check](#what-the-linters-check) · [Gotchas](#gotchas)

## Names

```go
// Package orderstore keeps orders in memory.
package orderstore

import "sync"

// Order is one customer order.
type Order struct {
	ID         string
	CustomerID string
	TotalCents int64 // never negative
}

// Store keeps orders by ID. The zero value is an empty store ready to use.
type Store struct {
	mu     sync.Mutex
	orders map[string]Order
}

// Lookup returns the order with the given ID and whether it exists.
func (s *Store) Lookup(id string) (Order, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.orders[id]
	return o, ok
}
```

- **MixedCaps, no underscores**, except in test function names (`TestLookup_missing`) and
  generated code. **Initialisms keep one case**: `CustomerID`, `userID`, `URL`, `HTTPClient`,
  `xmlAPI`; never `CustomerId` or `Url`.
- **Receivers** are one or two letters from the type name (`s *Store`), the same in every method,
  never `this` or `self`. A type's methods are all pointer receivers or all value receivers: use
  pointers when a method mutates, the type holds a mutex or other no-copy field, or it is large.
- **Package names** are short, lower case, one word, and say what the package provides:
  `orderstore`, not `util`, `common`, `helpers` or `models`. Exported names do not repeat the
  package: `orderstore.Store`, not `orderstore.OrderStore`.
- **No `Get` prefix** on getters: `Owner()`, with `SetOwner()` for the setter; a lookup by key can
  be named for what it does (e.g. `Lookup`). Reported by: none — test or review (no linter checks it).
- Name length follows scope: `i`, `s`, `r` in a few lines; descriptive names for package-level
  identifiers and long functions. Do not put the type in the name (`usersMap`).
- Errors: `ErrNotFound` / `errNotFound` for sentinels, `NotFoundError` for types
  ([errors-control](errors-control.md#sentinels-types-and-messages)). A `time.Duration` name has no
  unit suffix (`Timeout`, not `TimeoutSecs`).

## API shape

- **Accept the smallest interface you need; return concrete types.** The interface belongs to the
  package that uses it:

  ```go
  // orderLookup is the one method billing needs; *orderstore.Store satisfies it,
  // and a test can pass a small fake.
  type orderLookup interface {
  	Lookup(id string) (orderstore.Order, bool)
  }

  // Invoice formats the invoice line for one order.
  func Invoice(orders orderLookup, id string) (string, error) {
  	o, ok := orders.Lookup(id)
  	if !ok {
  		return "", fmt.Errorf("invoice for order %q: order not found", id)
  	}
  	return fmt.Sprintf("%s: %d.%02d", o.ID, o.TotalCents/100, o.TotalCents%100), nil
  }
  ```

  Do not export an interface next to its only implementation "for mocking", and do not return an
  interface from a constructor unless several implementations really are returned. Never take a
  pointer to an interface.
- **Make the zero value useful.** `orderstore.Store{}` works without a constructor (a `Put` method
  creates the map on first use, as `Registry.Register` does in [types-data](types-data.md#maps)); a
  `sync.Mutex` field needs no initialisation and no pointer. If a zero value cannot work, provide
  `NewX`.
- **Synchronous by default**: return results instead of starting goroutines and taking callbacks;
  callers add concurrency. `ctx context.Context` comes first when the call can block.
- Return `(T, error)` or `(T, bool)`; keep `error` last. Name results only when two of them share a
  type or a deferred closure must set them; use bare `return` only in very short functions.
- Do not retain or expose a caller's slice or map without copying it
  ([types-data](types-data.md#slices)).
- **Key the fields of struct literals from other packages**: `pkg.Point{X: 1, Y: 2}`. Reported by:
  `vet` composites for imported struct types only (not in `go test`); a package's own types: none.

## Constructors and options

Several parameters go into a config struct whose zero fields mean "default":

```go
// ClientConfig configures NewClient. A zero field means "use the default".
type ClientConfig struct {
	BaseURL string
	Timeout time.Duration // default 10s
	Retries int           // default 0: no retries
}

// NewClient returns a client for cfg.BaseURL.
func NewClient(cfg ClientConfig) *Client {
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Second
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}}
}
```

Functional options suit a public constructor that most callers call without options and that keeps
gaining them:

```go
// Server serves the API on one address.
type Server struct {
	addr   string
	logger *slog.Logger
}

// Option configures a Server.
type Option func(*Server)

// WithLogger sets the server's logger; the default is slog.Default().
func WithLogger(l *slog.Logger) Option {
	return func(s *Server) { s.logger = l }
}

// NewServer returns a server for addr with the given options applied.
func NewServer(addr string, opts ...Option) *Server {
	s := &Server{addr: addr, logger: slog.Default()}
	for _, opt := range opts {
		opt(s)
	}
	return s
}
```

Options take an argument (`WithRetries(3)`, `WithTLS(false)`) rather than signalling by presence.

## Doc comments

- Every exported name has a doc comment: a full sentence that starts with the name
  (`// Lookup returns …`). One file per package carries `// Package orderstore …`. Explain what
  and why, not how. Reported by: `golangci:revive exported (opt-in)` for a missing comment;
  staticcheck checks only the form (ST1020–ST1022) and the package comment (ST1000), all non-default.
- **gofmt rewrites doc comments `(toolchain ≥1.19)`**: an indented code block gets a tab, an
  indented `* item` becomes `  - item`, and an indented `1) first` line after a bullet item is
  merged into that bullet, even across a blank line. List items must be indented; unindented
  `1. one` lines are joined into the paragraph. Write lists as gofmt prints them and check `go doc`:

  ```go
  // Backoff returns the delay before retry number n (counting from 0).
  //
  // The delay:
  //   - starts at base,
  //   - doubles with each retry,
  //   - never exceeds limit.
  func Backoff(n int, base, limit time.Duration) time.Duration {
  	d := base
  	for range n {
  		d = min(2*d, limit)
  	}
  	return d
  }
  ```

  Reported by: `gofmt`; vet and staticcheck say nothing.

## Packages, init and globals

- One module per repository unless parts are versioned separately. In a repository with importable
  packages or several binaries, binaries live in `cmd/<name>/main.go` (a single command can keep
  `main.go` at the root); `main` stays small (parse flags, build dependencies, call `run`); code
  other modules must not import goes under `internal/` (docs: go.dev/doc/modules/layout).
- **`init` functions** ([house default](../SKILL.md#house-defaults)): register, or compute values
  that cannot fail, with no I/O; configuration errors return to `main`. Reported by:
  `golangci:gochecknoinits (opt-in)`.
- **No mutable package-level state in libraries**; pass dependencies in. Reported by:
  `golangci:gochecknoglobals (opt-in)`, which exempts `err`-prefixed error variables.

## Enums and exhaustive switches

```go
// Status is the lifecycle state of an order.
type Status int

// Order states. The zero value means "not set".
const (
	StatusUnknown Status = iota // the zero value: not set
	StatusPending
	StatusPaid
	StatusCancelled
)

// String returns the lower-case name of s.
func (s Status) String() string {
	switch s {
	case StatusUnknown:
		return "unknown"
	case StatusPending:
		return "pending"
	case StatusPaid:
		return "paid"
	case StatusCancelled:
		return "cancelled"
	}
	return fmt.Sprintf("Status(%d)", int(s))
}
```

The zero value is a named "unknown" state, so a forgotten field is visible. Go has no exhaustive
`switch`: a constant added later falls through silently. Reported by: `golangci:exhaustive
(opt-in)` ("missing cases in switch of type …"). Parse external input with a function such as
`ParseStatus(s string) (Status, error)` that returns an error for an unknown name.

## Generics

- Write the concrete function first; add a type parameter when the same code is about to be
  written for a second type. Prefer the standard library (`slices`, `maps`, `cmp`) to new generic
  helpers: `slices.Sorted(maps.Keys(m))` needs no helper.
- Prefer an ordinary interface parameter when the code calls methods; type parameters fit
  containers and algorithms over element types.
- `any` replaces `interface{}` (`go fix:any`).
- **Generic methods `(go ≥1.27)`**:

  ```go
  // Bag holds values of any type.
  type Bag struct{ items []any }

  // Add appends v and returns it. A method with its own type parameter (go >= 1.27)
  // cannot implement an interface method.
  func (b *Bag) Add[T any](v T) T {
  	b.items = append(b.items, v)
  	return v
  }
  ```

  Below a `go 1.27` line this is a `compiler` error ("generic method requires go1.27"). A type
  whose `Add[T]` should satisfy `interface{ Add(int) int }` does not compile ("wrong type for
  method Add").

## What the linters check

| Rule | staticcheck CLI | golangci standard | Opt-in |
|---|---|---|---|
| Initialisms, underscores | ST1003 non-default | excluded | revive var-naming |
| Error strings | ST1005 | ST1005 | revive error-strings |
| Receiver named `self`/`this` | ST1006 | ST1006 | revive receiver-naming |
| Inconsistent receiver names | ST1016 non-default | excluded | revive receiver-naming |
| Sentinel not `ErrX` | ST1012 | ST1012 | errname (types too), revive error-naming |
| Duration with a unit suffix | ST1011 | ST1011 | none |
| Doc comment form | ST1020–ST1022 non-default | excluded | revive exported |
| Missing doc on an exported name, stutter | none | none | revive exported |
| Package comment | ST1000 non-default | excluded | revive package-comments |
| `Get` prefix on getters | none | none | none |
| Mixed pointer and value receivers | none | none | recvcheck |

## Gotchas

- Agent names a package `util` or `common` - the name says nothing at the call site.
- Agent writes `CustomerId` or `GetName()` - only a non-default or opt-in check reports the first, nothing the second.
- Agent declares an interface beside its only implementation for mocking - the consumer cannot shrink it.
- Agent mixes value and pointer receivers on a type with a mutex - value-receiver calls lock a copy.
- Agent writes a type whose zero value panics (a nil map written in a method) - `var s Store` compiles and crashes on first use.
- Agent puts a numbered list after a bullet item in a doc comment (even after a blank line) - gofmt makes it part of that bullet.
- Agent puts I/O or flag parsing in `init` - errors cannot be returned and tests inherit the side effect.
- Agent adds an enum constant - every `switch` without a case for it falls through silently.
- Agent uses unkeyed literals of a struct from another package - a new field breaks or shifts them.

## Official sources

- [Effective Go](https://go.dev/doc/effective_go) (names, getters, embedding; not updated for generics or modules) and [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)
- [Go Doc Comments](https://go.dev/doc/comment), [Package names](https://go.dev/blog/package-names), [Organizing a Go module](https://go.dev/doc/modules/layout)
- [When To Use Generics](https://go.dev/blog/when-generics) and [Generic methods](https://go.dev/blog/generic-methods)
- [Google Go Style Guide](https://google.github.io/styleguide/go/) and [Uber Go Style Guide](https://github.com/uber-go/guide/blob/master/style.md)
