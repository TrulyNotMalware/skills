# Redis with go-redis

Applies to the Go 1.27.1 toolchain (this file's claims were not re-run on 1.27.3) with a go.mod `go`
line of 1.26.0 or later (go-redis declares it) and go-redis v9.23.0 unless a rule carries a version
tag. Measured against Redis Cluster 8.10 (6 nodes) through `redis.ClusterClient`. These mistakes
surface as a miss that is really an error, a deadline that is not enforced, a key that never expires
and a command that fails only on the cluster, none of which shows in a test against one healthy
node: test a deadline shorter than the command, an exhausted pool and keys in different slots.

Contents: [Redis client and redis.Nil](#redis-client-and-redisnil) · [Deadlines and the pool](#deadlines-and-the-pool) ·
[TTLs and locks](#ttls-and-locks) · [Cluster slots](#cluster-slots) · [Gotchas](#gotchas)

## Redis client and redis.Nil

```go
// ...
func NewClusterClient(addrs []string, user, password string) *redis.ClusterClient {
	return redis.NewClusterClient(&redis.ClusterOptions{
		Addrs:                 addrs,
		Username:              user,
		Password:              password,
		ContextTimeoutEnabled: true,
		DialTimeout:           2 * time.Second,
		ReadTimeout:           time.Second, // blocking commands add their own timeout + 10 s
		WriteTimeout:          time.Second,
		PoolSize:              20, // per node; default 5 * GOMAXPROCS
		PoolTimeout:           time.Second,
	})
}

var ErrMiss = errors.New("cache miss")

// GetString maps redis.Nil (missing key) to ErrMiss; any other error is a failure.
func GetString(ctx context.Context, rdb redis.Cmdable, key string) (string, error) {
	v, err := rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", ErrMiss
	}
	if err != nil {
		return "", fmt.Errorf("redis get %s: %w", key, err)
	}
	return v, nil
}
```

Defaults with only `Addrs` and credentials, at GOMAXPROCS 8: dial, read and write timeouts 5 s;
`PoolSize` 5 × GOMAXPROCS (40) **per node**; `PoolTimeout` read timeout + 1 s (6 s) on each node
(`ClusterOptions.PoolTimeout` reads 0); `MaxRedirects` 3; RESP3; `ContextTimeoutEnabled` false.

- **A missing key is the error `redis.Nil`, and `Val()` hides it**: `Get(…).Result()` → `("",
  redis: nil)`, `Get(…).Int()` → `(0, redis: nil)`, `Val()` → `""` for a missing key and for an
  empty string. Wrapped with `%w`, `err == redis.Nil` is false and `errors.Is` true. Reported by:
  `golangci:errorlint (opt-in)` for `==`; `Val()`: none — test or review.
- **Not every miss is `redis.Nil`**: `MGet` gives a nil element and a nil error; `SetNX` reports
  "already set" as `false, nil`, `SetArgs` with `Mode: "NX"` as `redis.Nil`; `Expire` on a missing
  key is `false, nil`. Reported by: none — test or review.

## Deadlines and the pool

`BLPOP` with a 5 s timeout on an empty list:

| `ContextTimeoutEnabled` | ctx | Returned after | Error | `errors.Is(err, context.DeadlineExceeded)` | Connection |
|---|---|---|---|---|---|
| false (default) | 300 ms timeout | 5.1 s | `redis: nil` | false | reused |
| false | canceled at 300 ms | 5.04 s | `redis: nil` | false | reused |
| true | 300 ms timeout | **300 ms** | `read tcp …: i/o timeout` (`net.Error`, `Timeout()` true) | **false** | discarded |
| true | canceled at 300 ms | **5.06 s** | `redis: nil` | false | reused |
| either | canceled before the call | at once | `context canceled` | — | — |

- **A ctx deadline becomes a socket deadline, and only with `ContextTimeoutEnabled`** (go-redis
  v9.23.0): the earlier of the deadline and now + read timeout; nothing watches `ctx.Done()` during
  a read (source). A cancel at shutdown does not interrupt a blocked command, and a deadline
  surfaces as a network timeout: test `errors.AsType[net.Error]` and `Timeout()`. A blocking
  command's socket deadline is its own timeout + 10 s (source); with the client above, `BLPOP` 3 s
  under a 200 ms ctx returned `i/o timeout` after 200 ms. Reported by: none — test or review.
- **`ClusterClient` repeats a pool timeout `MaxRedirects` + 1 times.** `PoolSize` 2, two 4 s `BLPOP`s
  holding both connections of a node, then a `GET` on the same slot:

  | `PoolTimeout` | `MaxRedirects` | `GET` ctx | Result | After | `PoolStats().Timeouts` |
  |---|---|---|---|---|---|
  | default (6 s per node) | default 3 | none | waited for a `BLPOP` to end, `redis: nil` | 3.86 s | 0 |
  | 500 ms | -1 (no retries) | none | `redis: connection pool timeout` | 500 ms | 1 |
  | 500 ms | 1 | none | `redis: connection pool timeout` | 1.02 s | 2 |
  | 500 ms | 0 (= 3) | none | `redis: connection pool timeout` | **2.09 s** | 4 |
  | default | default | 1 s timeout, `ContextTimeoutEnabled` false or true | `context deadline exceeded` | 1 s | 0 |

  The pool wait honours the ctx in both settings, and there the error is `context deadline
  exceeded`. A blocking command such as `BLPOP` holds its connection for its whole timeout: size
  the pool for them or give them a client of their own. Reported by: none — test or review.

## TTLs and locks

- **`Set(ctx, k, v, 0)` on a key with a TTL removes the TTL**: TTL 1 min, then `Set(ctx, k, v2, 0)`
  → `TTL` -1 ns; `redis.KeepTTL` instead of 0 kept it. `INCR` on a new key creates it without a TTL.
  Reported by: none — test or review.
- **`TTL` returns the sentinels as nanoseconds**: -1 ns no expiry, -2 ns missing key; compare with
  `-1` and `-2`, not `-time.Second`. Reported by: none — test or review.
- **`Expire` rounds a sub-second duration up to 1 s** with a log line (`… truncating to 1s`; PTTL
  996 ms) and drops the fraction of longer ones (`dur / time.Second`, source). `Set` with 500 ms
  sends `PX` (PTTL 495 ms); use `PExpire`. Reported by: none — test or review.
- **A lock released with `DEL` can release someone else's**: A's `SetNX` (A's token, 1 s TTL)
  expired while A worked 1.2 s, B's `SetNX` succeeded, A's `Del` removed B's lock. Reported by: none — test
  or review. Release by token:

```go
// unlock deletes the key only while it still holds the caller's token: after the TTL
// expired and another owner took the lock, a plain DEL would release theirs.
var unlock = redis.NewScript(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`)

// Unlock returns 1 when it deleted the lock and 0 when another owner holds it.
func Unlock(ctx context.Context, rdb redis.Scripter, lock, token string) (int, error) {
	return unlock.Run(ctx, rdb, []string{lock}, token).Int()
}
```

A's token → 0, the lock stayed B's; B's → 1. For an ACL user limited to a key pattern, a key
outside it fails inside the script too (`NOPERM No permissions to access a key`). On Redis ≥8.4, `DelExArgs(ctx, lock, redis.DelExArgs{Mode: "IFEQ",
MatchValue: token})` does it in one command (experimental in go-redis). Tokens come from
`crypto/rand` ([security-auth](security-auth.md)). Past its TTL the lock excludes nobody, and the token check protects only the lock: A's write at
1.2 s overwrote B's although A's unlock returned 0. Where a late write is wrong, the protected
store must refuse it: a fencing token (`INCR` at acquire) checked by the write (a Lua script
refused A's), or a conditional write such as a version column.

## Cluster slots

`app:a` (slot 16169) and `app:b` (3914) differ; `app:{u1}:a` and `app:{u1}:b` share slot 4574:

| Command on keys in different slots | Result |
|---|---|
| `MSET`, `MGET`, multi-key `DEL`, `RENAME`, `SUNION`; `EVAL` with `KEYS` in two slots | `CROSSSLOT Keys in request don't hash to the same slot` |
| `Pipelined` (`GET a`, `GET b`, `GET {u1}:a`, `INCR`) | all 4 succeed (the client groups commands per node) |
| `TxPipelined` (`MULTI`/`EXEC`) `SET a`, `SET b` | `CROSSSLOT …`; neither key changed |
| `Watch(fn, a, b)` | client-side `redis: Watch requires all keys to be in the same slot` |
| the same commands on the `{u1}` keys | all succeed |

- **go-redis does not split multi-key commands across slots**, and a non-cluster Redis has no slots
  (docs), so a test against one passes. Reported by: none — test or review.
- **A hash tag hashes only the text between the first `{` and the next `}`**: the prefix stays
  outside (`app:{user:42}:cart`). Every key with one tag lives on one node: tag per entity.

## Gotchas

- Agent compares `err == redis.Nil` or reads `.Val()` - a wrapped miss becomes a failure, an error an empty string.
- Agent sets a ctx deadline on go-redis without `ContextTimeoutEnabled` - the command runs to the read timeout; with it, a cancel still does not interrupt and the error is not `context.DeadlineExceeded`.
- Agent expects `PoolTimeout` to bound a `ClusterClient` call - it repeats `MaxRedirects` + 1 times.
- Agent overwrites a key with `Set(ctx, k, v, 0)` or passes 500 ms to `Expire` - the TTL is gone, or is 1 s.
- Agent releases a Redis lock with `DEL` - after the TTL it deletes the next owner's lock.
- Agent treats a TTL lock as mutual exclusion for the protected data - an owner that outlives the TTL still writes after the next owner.
- Agent tests multi-key commands or `TxPipelined` on one Redis node - calls whose keys hash to different slots fail with `CROSSSLOT` on the cluster.

## Official sources

- [go-redis v9.23.0](https://pkg.go.dev/github.com/redis/go-redis/v9@v9.23.0) and its [timeouts guide](https://redis.uptrace.dev/guide/go-redis-debugging.html#timeouts)
- Redis [cluster specification: hash tags](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#hash-tags), [SET](https://redis.io/docs/latest/commands/set/), [TTL](https://redis.io/docs/latest/commands/ttl/), [EXPIRE](https://redis.io/docs/latest/commands/expire/)
