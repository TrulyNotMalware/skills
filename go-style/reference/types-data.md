# Types, slices, maps, strings, numbers, time and JSON

Applies to Go 1.27.1 with a go.mod `go` line of 1.26 or later unless a rule carries a version tag
([tags and labels](versions-tools.md#reported-by-vocabulary)). These produce a plausible value: a
JSON document missing a field, two slices sharing memory, a time nine hours off.

Contents: [Interfaces and embedding](#interfaces-and-embedding) · [Slices](#slices) · [Maps](#maps) ·
[Strings](#strings) · [Numbers](#numbers) · [Time](#time) · [encoding/json](#encodingjson) ·
[bufio.Scanner](#bufioscanner) · [Gotchas](#gotchas)

## Interfaces and embedding

- **A nil pointer in an interface is not nil**: see [errors-control](errors-control.md#typed-nil).
- **Embedding promotes every method, including `MarshalJSON` and `String`.**

  ```go
  // Wrong: time.Time's MarshalJSON and String are promoted; Event encodes as a bare timestamp.
  type Event struct {
  	time.Time
  	Name string
  }

  // EventRecord is the JSON form of an event.
  type EventRecord struct {
  	At   time.Time `json:"at"`
  	Name string    `json:"name"`
  }
  ```

  `Event` marshals as `"2026-01-02T03:04:05Z"` (Name gone), prints as the time alone, and fails to
  unmarshal `{"name":"x"}`. An embedded `*time.Time` left nil makes `json.Marshal` panic. Reported
  by: none — test or review. Embed only when the outer type should *be* the inner one.
- **Embedding `sync.Mutex` exports `Lock`, `TryLock` and `Unlock`** and makes the type a
  `sync.Locker` (as `*T`), so callers can lock it. Use a named field `mu sync.Mutex`. Reported by:
  `golangci:gocritic exposedSyncMutex (opt-in)`, outside gocritic's default set and only on
  exported types.
- **A method value or a deferred call on a value receiver copies the receiver at that moment.**
  `f := c.Get; c.n = 5; f()` returns the old `n`, and `defer c.Print()` prints it. Reported by:
  none — test or review.
- **`==` on interfaces panics when both hold the same uncomparable type** (`any([]int{1}) ==
  any([]int{1})`, an `error` whose struct contains a slice, a struct with an `any` field holding a
  slice); so does using such a value as a `map[any]` key. Different dynamic types compare false
  without panicking. Reported by: none — test or review.

## Slices

- **Two `append`s to one base with spare capacity overwrite each other.**

  ```go
  // Wrong: shares base's array when cap(base) > len(base).
  func withSuffix(base []string, s string) []string {
  	return append(base, s)
  }

  // The full slice expression caps base at its length, so append must copy.
  func withSuffixCopy(base []string, s string) []string {
  	return append(base[:len(base):len(base)], s)
  }
  ```

  With `base` holding `a` and spare capacity (`make([]string, 1, 4)`), `x := withSuffix(base, "x")`
  and `y := withSuffix(base, "y")` both end up `[a y]`. Reported by: `golangci:gocritic appendAssign (opt-in)` for the direct
  `x := append(b, 1)` form only; through a helper: none — test or review.
- **`append` to a subslice writes into the parent**: `t := append(s[:2], 99)` turns `[1 2 3 4]`
  into `[1 2 99 4]`. `s[:2:2]` or `slices.Clone` keeps the parent. Reported by:
  `golangci:gocritic appendAssign (opt-in)`, which also flags the `s[:2:2]` fix. Copy
  (`slices.Clone`, `maps.Clone`) a slice or map you keep from a caller or hand out from your
  internals; both copies are shallow, so nested slices, maps and pointer targets stay shared.
- **The range value is a copy.**

  ```go
  func resetQty(items []Item) {
  	for i := range items {
  		items[i].Qty = 0 // `for _, it := range items { it.Qty = 0 }` changes a copy
  	}
  }
  ```

  Reported by: `golangci:govet unusedwrite (opt-in)` and `gopls:unusedwrite (hint)` for a plain
  assignment; `it.Qty++` and a write that is read later in the body: none. `range arr` over an
  array value iterates a copy of the array; `range &arr` and slices do not.
- **`slices.Delete`, `Compact` and `Replace` zero the old tail** `(toolchain ≥1.22)`: see
  [versions-tools](versions-tools.md#matrices). Always use the returned slice.
- **nil and empty slices behave the same except in JSON and deep comparison**: `[]string(nil)`
  encodes as `null`, `[]string{}` as `[]` (both dropped by `omitempty`), and `reflect.DeepEqual`
  and `cmp.Diff` report them as different (`slices.Equal` does not; `cmpopts.EquateEmpty` makes
  `cmp.Diff` agree). Declare `var s []T`; check `len(s) == 0`, not `s == nil`.
- **`maps.Keys` and `maps.Values` return an iterator** (`iter.Seq`), not a slice. `len`, `sort` or
  an index variable on it do not compile; `fmt.Println(maps.Keys(m))` prints a function address
  (none — test or review). Write `slices.Sorted(maps.Keys(m))`.

## Maps

- **Iteration order is random** (an 8-key map gave 6 orders in 20 loops). Sort the keys when
  output, hashing or a test depends on order.
- **Writing to a nil map panics**; reading, `len`, `range` and `delete` do not. Concurrent writes
  are fatal ([concurrency](concurrency.md#maps-and-the-race-detector)). A map field is nil until set:

  ```go
  // Registry maps names to handlers; the zero value is ready to use.
  type Registry struct {
  	handlers map[string]func()
  }

  // Register adds or replaces the handler for name.
  func (r *Registry) Register(name string, h func()) {
  	if r.handlers == nil {
  		r.handlers = make(map[string]func())
  	}
  	r.handlers[name] = h
  }
  ```

  Reported by: `staticcheck SA5000`, `gopls:nilness` and `golangci:govet nilness (opt-in)` only
  for a local `var m map[K]V; m[k] = v`; a field, a zero-value struct or a package-level map:
  none — test or review. Either give the type a constructor or initialise lazily as above.

## Strings

- **`len(s)` counts bytes and `range s` yields runes at byte offsets.** `len("héllo")` is 6;
  the range indices are 0, 1, 3, 4, 5; `s[:2]` cuts `é` in half. Count with
  `utf8.RuneCountInString`, slice at indices from `range` or `strings.Index`. Reported by: none — test or review.
- **`string(i)` with an integer yields a rune**: `string(65)` is `"A"`. Use `strconv.Itoa`.
  Reported by: `vet+test` (stringintconv).
- **`strings.Split("", ",")` returns `[""]`** (length 1); `Split("a,,b,", ",")` keeps the empty
  fields. Use `strings.Fields` for whitespace, or skip empty parts. Reported by: none — test or review.
- **`TrimLeft`, `TrimRight` and `Trim` take a set of characters**, not a prefix or suffix:
  `strings.TrimRight("persons.json", ".json")` is `"per"`. Use `TrimSuffix`, `TrimPrefix`,
  `CutSuffix`, `CutPrefix`. `TrimLeft(u, "http:")` happens to work on `"http://host"`, so tests
  with that input pass. Reported by: `staticcheck SA1024` only when the cutset repeats a
  character (`"https://"`); `".json"`: none.

## Numbers

- **Integer arithmetic wraps silently at run time**: `a++` on an `int8` holding 127 gives -128,
  `z--` on a `uint` holding 0 gives the maximum `uint`, and `count-5 > 0` is true for `var count
  uint = 3`. The same arithmetic on constants (`int8(127) + 1`) does not compile; run-time
  overflow is reported by none. Use signed types for quantities that can go below zero.
- **Narrowing and sign-changing conversions truncate**: `int32(n)` for an `int64` n of `1<<40` is
  0, `int32` of `Atoi("3000000000")` is negative, `uint8(len(b))` of 300 bytes is 44.

  ```go
  func toInt32(n int64) (int32, error) {
  	if n < math.MinInt32 || n > math.MaxInt32 {
  		return 0, fmt.Errorf("value %d out of int32 range", n)
  	}
  	return int32(n), nil
  }
  ```

  For text input, `strconv.ParseInt(s, 10, 32)` returns a range error itself. Reported by:
  `golangci:gosec G115 (opt-in)` for most narrowing conversions, silent after a bounds check like
  the one above; not for `int`↔`uint`, not for `float64`→`int`.
- **Integer division truncates, also in untyped constants**: `float64(7/2)` is 3, `1/2*3.0` is 0,
  `-7/2` is -3. Convert before dividing. Reported by: `staticcheck SA4025` only for constant
  expressions that come out zero.

## Time

- **`time.Sleep(5)` sleeps five nanoseconds**; `time.Duration(n)` is nanoseconds. Write
  `5 * time.Second`, or `time.Duration(n) * time.Second` for an `int` (`n * time.Second` does not
  compile). Reported by: `staticcheck SA1004` for small untyped literals only; a named constant or
  `time.Duration(secs)`: none. Do not put the unit in a `time.Duration` name (`TimeoutSecs`:
  `staticcheck ST1011`).
- **`==` on `time.Time` compares the monotonic reading and the location.** For `t := time.Now()`,
  `t == t.Round(0)`, `t == t.In(time.UTC)` and `Parse(Format(t)) == t` are all false; `Equal` is
  true. The same applies to struct `==`, `reflect.DeepEqual` and map keys: normalise keys with
  `t.Round(0).UTC()`. Reported by: `golangci:staticcheck QF1009 (standard)` and gopls (hint) for
  `a == b` only, not `!=`, structs or keys; the staticcheck CLI never runs QF checks.
- **Layouts use the reference time `2006-01-02 15:04:05`.** `"2006-02-01"` swaps month and day;
  `"YYYY-MM-DD"` prints literally; `"15:01:05"` puts the month in the minutes; `"03:04"` without
  `PM` drops the half of the day; a literal `Z` mislabels a non-UTC time. Prefer `time.RFC3339`,
  `time.DateOnly`, `time.DateTime`. Reported by: `vet` timeformat only for a constant layout
  containing `2006-02-01`; `staticcheck SA1002` only for an invalid constant layout.
- The zero `time.Time` is year 1, not the Unix epoch: `time.Unix(0, 0).IsZero()` is false. Test
  `IsZero()`, and convert a Unix 0 meaning "unset" explicitly.
- **`time.Parse` without a zone returns UTC**, and a zone abbreviation is resolved only against
  the machine's local zone: the same `Parse` gave `+0900` on a laptop in that zone and `+0000`
  with `TZ=UTC`. Parse in an explicit location:

  ```go
  func parseLocal(s, zone string) (time.Time, error) {
  	loc, err := time.LoadLocation(zone) // needs tzdata on the host, or import _ "time/tzdata"
  	if err != nil {
  		return time.Time{}, err
  	}
  	return time.ParseInLocation("2006-01-02 15:04", s, loc)
  }
  ```

  Reported by: none — test or review; run the test under two `TZ` values.

## encoding/json

Since Go 1.27 `encoding/json` runs on the v2 implementation and keeps the v1 behaviour: every row
below gave the same result with `GOEXPERIMENT=nojsonv2`, except the escape form of U+FFFD. The
separate `encoding/json/v2` API `(toolchain ≥1.27; stdversion reports it below a go 1.27 line;
gone with GOEXPERIMENT=nojsonv2)` rejects duplicate names and invalid UTF-8 and matches
names case-sensitively. None of these is reported by any tool unless noted.

- Keys match case-insensitively (`"NAME"` fills `Name`) and unknown fields are ignored
  (`Decoder.DisallowUnknownFields` rejects them). A duplicate key keeps the last value in a map or
  `any`; a struct field is decoded twice, so `{"o":{"a":1},"o":{"b":2}}` sets both `o.A` and `o.B`.
- Numbers decoded into `any` become `float64`: `12345678901234567890` turns into
  `1.2345678901234567e+19`. Decode into typed fields, or call `Decoder.UseNumber`.
- **`omitempty` never omits a struct or a `time.Time`**; `omitzero` `(toolchain ≥1.24)` does
  (it calls `IsZero` when the type has one).

  ```go
  // OrderJSON is the wire form of an order.
  type OrderJSON struct {
  	ID        string     `json:"id"`
  	CreatedAt time.Time  `json:"created_at,omitzero"` // omitempty would never omit it
  	Items     []LineItem `json:"items"`               // nil encodes as null, empty as []
  	Note      string     `json:"note,omitempty"`
  }
  ```

  Reported by: `golangci:modernize omitzero (opt-in)` and gopls (hint); `go fix` deletes the
  useless `omitempty` instead of adding `omitzero` ([versions-tools](versions-tools.md#go-fix)).
- **A tag on an unexported field is ignored, and two tagged fields with the same JSON name are
  both dropped**, without an error (a tagged field beats an untagged one of that name). Reported
  by: `vet` structtag (both); `staticcheck SA5008` (the unexported field); a struct without
  exported fields: `staticcheck SA9005`.
- `Unmarshal` into a non-pointer returns an error at run time. Reported by: `vet` unmarshal (not
  in `go test`) and `staticcheck SA1014`; through a `func(v any)` helper: none.
- **`Decoder.Decode` stops after the first value**: `{"name":"a"} garbage` decodes without an
  error, while `Unmarshal` rejects it. `dec.More()` misses a stray `}` or `]`; check for EOF:

  ```go
  func decodeStrict(r io.Reader, v any) error {
  	dec := json.NewDecoder(r)
  	dec.DisallowUnknownFields()
  	if err := dec.Decode(v); err != nil {
  		return err
  	}
  	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
  		return errors.New("unexpected data after the JSON value")
  	}
  	return nil
  }
  ```

- `<`, `>`, `&` are written as `\u003c` etc. (`Encoder.SetEscapeHTML(false)` keeps them); invalid
  UTF-8 becomes U+FFFD on encode and decode, without an error.
- **Decoding into a reused value merges**: absent keys keep their old values, maps gain entries,
  and a slice reuses its array, so `[{"A":3}]` into `[]Item{{A: 1, B: 2}}` gives `[{A:3 B:2}]`
  (struct, pointer and map elements; scalars are replaced). Decode into a fresh value per message.

## bufio.Scanner

`Scanner` stops at a token of 64 KiB or more (with the default buffer) and reports it only through
`Err()`; a loop that skips `Err()` treats the rest of the input as absent.

```go
func countLines(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024) // allow lines up to 1 MiB
	n := 0
	for sc.Scan() {
		n++
	}
	return n, sc.Err() // without this, a longer line ends the loop as if at EOF
}
```

Input "a / 70 000 bytes / b" gave 1 line and `bufio.Scanner: token too long` with the default
buffer, 3 lines with the larger one. For unbounded lines use `bufio.Reader.ReadString('\n')` or
`ReadBytes('\n')`. Reported by: `gopls:scannererr` for scanners over a file, stdin or an `io.Reader`
parameter, but not over `strings.Reader`, `bytes.Reader` or `bytes.Buffer` (which truncate just
the same) and not for a scanner stored in a struct field; `go vet` 1.27 has no such check.

## Gotchas

- Agent embeds `time.Time` in a struct that is marshalled - the other fields vanish from the JSON.
- Agent embeds `sync.Mutex` - callers can lock the type from outside.
- Agent returns `append(base, x)` from a helper - two calls overwrite each other's element.
- Agent modifies the range variable - the slice element is unchanged.
- Agent writes into a map field of a zero-value struct - panic; no tool sees the field shape.
- Agent compares `interface{}`/`any` values holding slices - panic at run time.
- Agent slices a string at a byte index - splits a multi-byte character.
- Agent strips an extension with `TrimRight(name, ".json")` - removes any trailing `.`, `j`, `s`, `o`, `n`.
- Agent converts `int64` to `int32` without a range check - silent truncation.
- Agent calls `time.Sleep(5)` - five nanoseconds.
- Agent compares times with `==` - can be false for the same instant.
- Agent parses a timestamp without a zone - UTC, hours off; a zone abbreviation depends on the host.
- Agent tags a `time.Time` field `omitempty` - the zero time is still written.
- Agent decodes JSON numbers into `any` - large integers lose precision.
- Agent reads with `json.Decoder` and assumes one value - trailing data is accepted.
- Agent scans lines without checking `sc.Err()` - input after a 64 KiB line is silently dropped.

## Official sources

- [The Go spec](https://go.dev/ref/spec) (method sets, comparison operators, appending, conversions, integer overflow)
- [Go Slices: usage and internals](https://go.dev/blog/slices-intro) and [Strings, bytes, runes](https://go.dev/blog/strings)
- Packages [time](https://pkg.go.dev/time), [encoding/json](https://pkg.go.dev/encoding/json), [bufio](https://pkg.go.dev/bufio#Scanner), [slices](https://pkg.go.dev/slices), [maps](https://pkg.go.dev/maps)
