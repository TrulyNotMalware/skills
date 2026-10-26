# Daemons: following files and shipping lines

Applies to the Go 1.27.1 toolchain (this file's claims were not re-run on 1.27.3) with a go.mod `go`
line of 1.26.0 or later, golang.org/x/sync v0.24.0 (errgroup) and fsnotify v1.10.1 unless a rule
carries a version tag. fsnotify ran on darwin (kqueue); Linux (inotify) statements come from its
source and the man pages (docs). A log collector that loses or duplicates lines still exits 0 and
passes a test that writes a file once and reads it once: test rotation, truncation, a stalled sink
and a signal during the last flush. The code is one log collector: `Follow` → `Batch` →
`HTTPSink.Send` → checkpoint, under an errgroup.

Contents: [Process structure](#process-structure) · [Following a file](#following-a-file) · [Rotation](#rotation) ·
[fsnotify](#fsnotify) · [Checkpoints](#checkpoints) · [Batching and backpressure](#batching-and-backpressure) ·
[The HTTP sink](#the-http-sink) · [Kafka as the sink](#kafka-as-the-sink) ·
[Signals and supervision](#signals-and-supervision) · [Gotchas](#gotchas)

## Process structure

A sketch, not a complete program: `logship` is the collector's own package, elided here. The code
below assumes these signatures, taken from the prose around it (the `Batch` numbers are max
lines, flush interval and final-flush timeout). Declarations only, so this block does not compile
on its own:

```text
func RemoveStaleTemps(path string) error
func LoadCheckpoint(path string) (Pos, error)
func SaveCheckpoint(path string, p Pos) error
func Follow(ctx context.Context, path string, from Pos, poll time.Duration, wake <-chan struct{}, out chan<- Line) error
func Batch(ctx context.Context, in <-chan Line, maxLines int, every, final time.Duration,
	flush func(context.Context, []Line) error) error
func (s *HTTPSink) Send(ctx context.Context, key string, body []byte) error
type Pos struct {
	File   string
	Offset int64
}
type Line struct {
	Text string
	Pos  Pos
}
type HTTPSink struct {
	Client             *http.Client
	URL                string
	Attempts           int
	BaseDelay, MaxDelay time.Duration
}
```

```go
func run(ctx context.Context, path, ckpt, url string, poll time.Duration) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	// ... the SIGHUP channel (Signals and supervision)

	if err := logship.RemoveStaleTemps(ckpt); err != nil {
		return err
	}
	from, err := logship.LoadCheckpoint(ckpt)
	if err != nil {
		return err
	}
	sink := &logship.HTTPSink{Client: &http.Client{Timeout: 10 * time.Second}, URL: url,
		Attempts: 5, BaseDelay: 200 * time.Millisecond, MaxDelay: 5 * time.Second}
	lines := make(chan logship.Line, 1000) // bounded: a stalled sink stops the reading, not the memory
	wake := make(chan struct{}, 1)

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		err := logship.Follow(gctx, path, from, poll, wake, lines) // closes lines when it returns
		if ctx.Err() != nil && errors.Is(err, context.Canceled) {
			return nil // a signal stopped it: not an error, and it must not mask the final flush's error
		}
		return err
	})
	g.Go(func() error {
		return logship.Batch(gctx, lines, 500, time.Second, 5*time.Second,
			func(ctx context.Context, b []logship.Line) error {
				var body bytes.Buffer
				for _, l := range b {
					body.WriteString(l.Text)
					body.WriteByte('\n')
				}
				// The same batch gets the same key on every try and in the final flush.
				first, last, sum := b[0].Pos, b[len(b)-1].Pos, sha256.Sum256(body.Bytes())
				key := fmt.Sprintf("%s:%d-%d:%x", first.File, first.Offset, last.Offset, sum[:8])
				if err := sink.Send(ctx, key, body.Bytes()); err != nil {
					return err
				}
				return logship.SaveCheckpoint(ckpt, last) // only what the sink acknowledged
			})
	})
	// ... the SIGHUP goroutine (Signals and supervision)
	return g.Wait()
}
```

`main` calls `run(context.Background(), …)` and exits 1 on any error. `SaveCheckpoint` writes
`device:inode offset` with `WriteFileAtomic`; `LoadCheckpoint` returns the zero `Pos` if there is
none. Delivery is at-least-once, SIGTERM included. As a process against a real HTTP sink (25 000
lines, SIGTERM, restart, 1 000 more), 70 runs: exit 0 both times and no line lost in all 70; the
batch in flight at the signal arrived twice (500 lines) in 4, because the sink had taken the POST
the signal canceled and the final flush resent it; a receiver that drops repeated keys saw every
line once in 70 of 70.

- **A component stopped by the signal returns nil, not `ctx.Err()`.** `Wait` keeps the first error:
  with the sink hung at SIGTERM the follower's `context.Canceled` won, the final flush's `context
  deadline exceeded` 5 s later was dropped, and a `main` treating `Canceled` as success exited 0
  with an empty stderr. With the nil return: exit 1, error logged. Test the parent `ctx`, not
  `gctx`, which a sibling's failure also cancels. Reported by: none — test or review.
- **A nil return cancels nothing.** One goroutine returned nil, another waited on `ctx.Done()`:
  `Wait` blocked. A component that can finish on its own returns a sentinel error if the rest
  should stop. Reported by: none — test or review. errgroup basics: go-style skill, concurrency.
- **Every send selects on `ctx.Done()`; the producer closes its output on every return.** A tailer
  blocked on `lines <- l` after the batcher failed, or a batcher ranging over a `lines` the failed
  tailer never closed, kept `Wait` from returning. Reported by: none — test or review.

## Following a file

```go
// MaxLine bounds the memory per line. A longer line is passed on in pieces of MaxLine bytes when
// the reader's buffer size divides MaxLine (Follow's is 64 KiB), else of up to MaxLine plus a buffer.
const MaxLine = 1 << 20

// readLines calls emit with every complete line r holds now, '\n' included, and returns the bytes
// after the last '\n', to be passed back in when more data has arrived. emit must copy the line:
// the buffer is reused.
func readLines(r *bufio.Reader, partial []byte, emit func(line []byte) error) ([]byte, error) {
	for {
		chunk, err := r.ReadSlice('\n')
		partial = append(partial, chunk...)
		if err == nil || len(partial) >= MaxLine {
			if err := emit(partial); err != nil {
				return partial, err
			}
			partial = partial[:0]
			continue
		}
		if errors.Is(err, io.EOF) {
			return partial, nil // not sticky: the next call reads what was appended
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return partial, err
		}
	}
}
```

`Follow(ctx, path, from, interval, wake, out)` opens the file (waiting while it is absent), resumes
at `from.Offset` only if its device:inode is `from.File`, else at 0, and loops: `readLines`, whose
`emit` sends `Line{Text, Pos}` in a `select` on `ctx.Done()`; `atEOF` (Rotation); then a wait for
`ctx.Done()`, the `interval` ticker or `wake` (fsnotify, SIGHUP; nil is fine). It closes `out` on
return. `Line.Pos` (device:inode, offset after the line) is what the checkpoint stores.

- **`bufio.Scanner` cannot follow a growing file.** On `"line1\npart"` it returned `"part"` as a
  line; after `"ial\nline3\n"` was appended, `Scan` returned false with `Err()` nil on every call
  (its `io.EOF` is never cleared). Reported by: none — test or review.
- **`bufio.Reader` returns the partial line with `io.EOF`; EOF is not sticky.** Sending the partial
  at EOF split a line in two (`part`, `ial`), dropping it lost bytes, keeping it (`readLines`) gave
  `partial`. `ReadString` returned a 70 000-byte line whole: without `MaxLine` a writer that never
  writes `'\n'` grows the follower without limit. Scanner's 64 KiB limit: go-style skill,
  types-data. Reported by: none — test or review.

## Rotation

Rename + create: the app writes with `O_APPEND`, the log is renamed to `app.log.1`, the app writes
`late1` to its old descriptor, then reopens `app.log` (as after a SIGHUP):

| follower at the end of the file | lines delivered |
|---|---|
| never compares the file | `pre1` `late1`: stuck on the old inode, never sees `new1` `new2` |
| `!os.SameFile(f.Stat(), os.Stat(path))` → reopen | `pre1` `new1` `new2`: `late1` lost |
| same check → read the old file to EOF, then reopen (`Follow`) | all four |

```go
// atEOF compares the open file f, consumed up to read bytes, with the file now at path.
func atEOF(f *os.File, path string, read int64) (truncated, rotated bool, err error) {
	cur, err := f.Stat()
	if err != nil {
		return false, false, err
	}
	if cur.Size() < read {
		return true, false, nil // copytruncate: start again at 0
	}
	fi, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, false, nil // between rename and create: keep reading the old file
	}
	if err != nil {
		return false, false, err
	}
	return false, !os.SameFile(cur, fi), nil // rotated: the open file has been read to its end
}
```

On `truncated` `Follow` seeks to 0; on `rotated` it sends the unfinished last line and opens `path`
at offset 0 with its device:inode (`"%d:%d"` of `syscall.Stat_t` `Dev` and `Ino`, Unix only: a string, as
gosec G115 reports `uint64(st.Dev)`, an `int32` on darwin).

- **Between rename and create `os.Stat(path)` fails with `fs.ErrNotExist`**: keep reading the old
  file. Bytes written to the old inode after the switch are still lost unless the old descriptor
  stays open for a grace period (design, not run). Reported by: none — test or review.
- **copytruncate: `size < offset` fires only if the follower looks before the file regrows past
  its offset.** Follower at offset 36, `os.Truncate(path, 0)`, then the app writes:

  | writer | follower | written before the next look | lines after the truncation |
  |---|---|---|---|
  | `O_APPEND` | no size check | 3 B, then 45 B | none until size > 36, then a mid-line fragment |
  | `O_APPEND` | `size < offset` → `Seek(0)` | 3 B | all |
  | `O_APPEND` | `size < offset` → `Seek(0)` | 48 B | the mid-line fragment: the check never fired |
  | no `O_APPEND` | either | any | the writer continues at 36: the file starts with 36 NUL bytes |

  Only a follower that looked while the file was empty restarts at 0 and reads the NULs (`Follow`
  prefixed them to the next line). Lines written between logrotate's copy and its truncate are in
  neither file (docs). Prefer rename + create. Reported by: none — test or review.
- **A deleted file keeps working.** After `os.Remove(path)` the follower read new lines with no
  error and `Nlink` 0; the space stays allocated until close, and `Follow` keeps a file that is
  never recreated open. Reported by: none — test or review.
- **A stored offset alone applies to whatever file is at `path`.** Rotated while the daemon was
  down (100 lines shipped, a new 150-line file at `path`): with only the offset stored, the restart
  skipped the new file's first 100 lines and exited 0; with device:inode stored, 250 of 250. The
  lines the old file got after the checkpoint stay unread in `app.log.1`; copytruncate keeps the
  inode, and a deleted file's inode can be reused (not run). Reported by: none — test or review.

## fsnotify

fsnotify v1.10.1 only wakes the polling follower. `Wake(ctx, path)` watches the parent directory
(`filepath.Dir(filepath.Clean(path))`), keeps events whose `Name == path` except Chmod, sends
without blocking on a 1-buffered channel (a burst becomes one wake-up), and treats each `Errors`
value as a wake-up in the same `select`. With a 1 h poll, lines arrived <1 ms after an append and
after rename, create and append.

- **Watch the directory.** `Add(file)` across rename + create (darwin): WRITE, RENAME, then
  nothing, and `WatchList()` was empty: the watch was dropped without an error. On Linux the kernel
  drops it on deletion (inotify(7)) and fsnotify on IN_MOVE_SELF (source). kqueue sent `CREATE
  app.log.1` before `RENAME app.log`; inotify does not guarantee rename order (docs): re-stat, do
  not pair events. Reported by: none — test or review.
- **`Event.Name` is `filepath.Join(dir, name)`, so it is clean.** `./app.log` and `dir/./app.log`
  never matched: no wake-ups, no error. Reported by: none — test or review.
- **Events coalesce, by a count that varies widely.** 10, 1 000 and 10 000 appends gave 1–9,
  317–908 and 5 688–7 772 WRITE events to a draining reader over 12 runs, and 1–2 to one stalled for
  500 ms (darwin); inotify merges identical unread events (docs). An event means "read to EOF". The writer was never slowed.
  Reported by: none — test or review.
- **An unread `Errors` channel stops `Events`.** After one backend error (EMFILE, darwin) a reader
  of `Events` alone got nothing more, 3 of 3 runs. On Linux a full queue arrives as
  `fsnotify.ErrEventOverflow` on `Errors` (docs): re-stat every followed file. Reported by: none —
  test or review.
- **Limits (docs):** no recursion; no NFS, SMB, FUSE, /proc or /sys; inotify's `max_user_watches`
  and `max_user_instances` fail `Add` or `NewWatcher` ("no space left on device", "too many open
  files"); kqueue holds one descriptor per file in a watched directory, rotated files included.
  Run (darwin, 3 of 3): at that limit a file renamed into the directory got no CREATE, no error and
  none of its later WRITEs (kqueue drops the error, source); only the poll finds it. Reported by:
  none — test or review.

## Checkpoints

`WriteFileAtomic(path, data, perm)`: `os.CreateTemp` in the same directory (a rename cannot cross
filesystems), write, `Chmod(perm)` (`CreateTemp` makes 0600), `Sync`, close, `os.Rename`, `Sync` the
directory; any error removes the temp file. `RemoveStaleTemps(path)` deletes leftover temp files.

- **`os.WriteFile` truncates, then writes.** A reader looping `os.ReadFile` while a writer replaced
  256 KiB for 1 s saw 187 empty and 67 partial files out of 4 554; a 15-byte checkpoint overwritten
  by a process killed with SIGKILL after 400 ms held 445 857 792 bytes of the new value. With
  `WriteFileAtomic`: 0 empty, 0 partial, the old 15 bytes after SIGKILL, plus a stray temp file.
  Reported by: none — test or review.
- **Power loss (docs):** rename(2) replaces atomically, but fsync(2) on the file does not make the
  directory entry durable: sync the directory (Linux). On darwin `Sync` uses F_FULLFSYNC (source).
- **Checkpoint after the sink acknowledged.** Crash between the two steps of a batch: send then
  checkpoint → that batch delivered twice, nothing lost (at-least-once); checkpoint then send → the
  batch lost. The daemon killed with SIGKILL and restarted: 50 000 of 50 000 lines, 500 duplicates
  (one batch) in 12 of 17 runs over two test programs; none by key, as the re-read batch was cut
  at the same lines (not guaranteed: a batch cut by the timer can differ). Reported by: none — test
  or review.

## Batching and backpressure

`Batch(ctx, in, maxSize, interval, finalTimeout, flush)` cuts a batch at `maxSize` lines or every
`interval` and never changes it. It returns when `in` is closed, not on `ctx.Done()`, so every line
handed over is flushed, the last time under `finalTimeout`. A batch whose flush the cancellation
interrupted is sent again unchanged, so its key is the same: the sink may already have stored it.

- **The final flush needs a context that is not canceled yet.** After the signal: the root context
  failed the POST with `context canceled` at once; so did `context.WithTimeout(root, 5*time.Second)`
  (a child of a canceled context is born canceled); `context.WithTimeout(context.WithoutCancel(root),
  5*time.Second)` delivered in 52 ms `(toolchain ≥1.21)`. Reported by: none — test or review.
- **A new slice per batch.** With `batch = batch[:0]` and a flush that kept its slice (a retry
  queue), the kept batches read `[4 5 6] [4 5 6]`. Reported by: none — test or review.
- **A bounded channel, not a goroutine per line.** 200 000 lines into a stalled sink: `go
  send(line)` → 200 000 goroutines, +144.5 MiB heap, +390.8 MiB stacks; a 1 000-line channel → one
  goroutine, +0.2 MiB; the follower stops reading (the file is the buffer). Reported by: none —
  test or review.

## The HTTP sink

Client and Transport: [http-client](http-client.md). `HTTPSink.Send(ctx, key, body)` waits between
tries with `time.NewTimer` + `select` on `ctx.Done()`, honours `Retry-After`, else full jitter
(`rand.N`, math/rand/v2; gosec G404 needs a `//nolint`); retries network errors, 429 and 5xx but
501; stops on any other status; builds a new request and `bytes.Reader` per try. Against a real
listener: 503, 503, 200 → 3 tries, each with the full body and one key; `Retry-After: 1` → 1.003 s
gap; 400, 401, 413, 501 → 1 try; cancel during a `Retry-After: 5` wait → returned in 102 ms.

- **`time.Sleep` between tries** returned 5 s after the cancel; under systemd's stop timeout a
  long backoff ends in SIGKILL. Reported by: none — test or review.
- **A new request and reader per try.** Reusing one `*http.Request` worked only on a reused
  connection; on a new one it failed, and a body without `GetBody` arrived empty with a 200. With
  an `Idempotency-Key` header the Transport itself resends a POST on a reused connection, so the
  receiver must deduplicate on the key. Both measured in [http-client](http-client.md). Reported
  by: none — test or review.
- **Derive the key from the batch.** A random key per `flush` call let the batch canceled at
  SIGTERM arrive under two keys. Positions alone repeat: copytruncate keeps the inode and restarts
  the offsets, and with `dev:ino:first-last` a deduplicating receiver dropped 100 of 100 new lines
  (3 of 3 runs); with the content hash added, 0. The key repeats only for the same bytes at the
  same place: identical lines rewritten at the same offsets after a copytruncate share it, and a
  deduplicating receiver dropped them (100 of 100, 2 of 2 runs). Reported by: none — test or review.

## Kafka as the sink

franz-go v1.22.1, run only against an unreachable broker; the client: [kafka](kafka.md).
Stop tailing, then `Flush` with `context.WithTimeout(context.WithoutCancel(ctx), d)`, then `Close`.
A timed-out `Flush` returned `context deadline exceeded`, the record still buffered. `Close` fails
buffered records with `kgo.ErrClientClosed` through promises it does not wait for: wait on a
`sync.WaitGroup` before `main` exits. A nil promise lost the record silently. With defaults a
record for a dead broker waited forever: set `RecordDeliveryTimeout`. Checkpoint only from
promises that returned nil. Reported by: none — test or review.

## Signals and supervision

`signal.NotifyContext`, the second signal and `stop()`: [lifecycle-deploy](lifecycle-deploy.md).
`run` also passes `make(chan os.Signal, 1)` to `signal.Notify(…, syscall.SIGHUP)`; a group goroutine
turns each SIGHUP into a non-blocking send on `wake` (logrotate postrotate, `systemctl reload`).

- **SIGHUP without `Notify` kills the daemon**: `kill -HUP` → exit status 129. With the handler and
  a 1 h poll, SIGHUP delivered waiting lines in 516 ms (1 s batches) and the process kept running. A
  receiver busy for 500 ms missed a SIGHUP on an unbuffered channel and got it on a 1-buffered one:

  | `signal.Notify` channel | vet sigchanyzer | staticcheck SA1017 | gopls |
  |---|---|---|---|
  | `c := make(chan os.Signal)` | yes | yes | yes |
  | `signal.Notify(make(chan os.Signal), …)` | no | yes | no |
  | `var c chan os.Signal; c = make(chan os.Signal)` | no | yes | no |
  | struct field `d.ch = make(chan os.Signal)` | no | no | no |

  Reported by: `vet`, `gopls:sigchanyzer`, `golangci:govet (standard)` (first shape); `staticcheck
  SA1017`, `golangci:staticcheck (standard)` (three); the struct field: none — test or review.
- **A broken stdout or stderr kills a Go program with SIGPIPE even when the parent ignores
  SIGPIPE** (writing to a pipe whose reader exited):

  | SIGPIPE disposition | C `yes` | Go |
  |---|---|---|
  | default | exit 141 | exit 141 |
  | SIG_IGN inherited from the parent (systemd's default `IgnoreSIGPIPE=yes`) | EPIPE, exit 1 | **exit 141** |
  | `signal.Ignore(syscall.SIGPIPE)` or `signal.Notify(c, syscall.SIGPIPE)` in `main` | — | EPIPE, exit 0 |

  The runtime keeps an inherited SIG_IGN only for SIGHUP and SIGINT (source; run on darwin).
  Reported by: none — test or review.
- **systemd (docs, systemd 262 man pages):** stop is SIGTERM, then SIGKILL after `TimeoutStopSec`
  (90 s unless the distribution changed it): end the final flush and backoff before it.
  `KillMode=control-group` (default) signals the whole unit; `Type=notify` waits for `READY=1`
  (go-systemd/v22 `daemon.SdNotify`). `Restart=on-failure` (default `no`) restarts after a
  non-zero exit or a signal **except SIGHUP, SIGINT, SIGTERM and SIGPIPE, which count as clean**:
  a daemon killed by an unhandled SIGHUP or by SIGPIPE stays down.

## Gotchas

- Agent returns `ctx.Err()` from the tailer and treats `context.Canceled` as success - a final flush that failed on SIGTERM exits 0 with nothing logged.
- Agent lets a group goroutine return nil when its work ends - nothing is canceled and `Wait` blocks.
- Agent follows a file with `bufio.Scanner` - it stops at the first EOF and splits the last partial line.
- Agent reopens the path as soon as `os.SameFile` says it changed - the old file's last lines are lost.
- Agent detects copytruncate only by `size < offset` - a file that regrew past the offset is read from mid-line.
- Agent stores only the offset in the checkpoint - after a rotation while the daemon was down, the new file's first lines are skipped.
- Agent watches the log file itself, or compares `Event.Name` with an unclean path - no more wake-ups, no error.
- Agent reads only fsnotify `Events` - the first backend error stops every later event.
- Agent writes the checkpoint with `os.WriteFile`, or before the sink acknowledged - a crash corrupts it or loses the batch.
- Agent derives the final flush's timeout from the signal context - the flush fails at once.
- Agent retries with the same `*http.Request` - a fresh connection fails; a plain `io.Reader` sends an empty body and gets 200.
- Agent builds the idempotency key from positions alone - after copytruncate new lines reuse old keys and a deduplicating receiver drops them (with the content hash, only identical lines rewritten at the same offsets are dropped).
- Agent draws a new random key per send - the batch canceled at SIGTERM and resent arrives twice under two keys.
- Agent waits between retries with `time.Sleep` - SIGTERM waits for the whole backoff.
- Agent relies on systemd's `IgnoreSIGPIPE=yes` and `Restart=on-failure` - a Go daemon still dies of SIGPIPE when its stdout reader goes away, and systemd counts that as clean and does not restart it.
- Agent passes a nil promise to franz-go `Produce` - records failed at `Close` vanish without an error.

## Official sources

- [bufio](https://pkg.go.dev/bufio), [os](https://pkg.go.dev/os), [os/signal](https://pkg.go.dev/os/signal), [context](https://pkg.go.dev/context), [errgroup v0.24.0](https://pkg.go.dev/golang.org/x/sync@v0.24.0/errgroup)
- [fsnotify v1.10.1](https://pkg.go.dev/github.com/fsnotify/fsnotify@v1.10.1) and its [README](https://github.com/fsnotify/fsnotify/blob/v1.10.1/README.md)
- [inotify(7)](https://man7.org/linux/man-pages/man7/inotify.7.html), [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html), [fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)
- systemd [service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [sd_notify](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html); [go-systemd daemon](https://pkg.go.dev/github.com/coreos/go-systemd/v22/daemon)
- [franz-go kgo v1.22.1](https://pkg.go.dev/github.com/twmb/franz-go/pkg/kgo@v1.22.1); [RFC 9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110#name-retry-after)
