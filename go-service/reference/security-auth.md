# Security and authentication

Applies to the Go 1.27.1 toolchain (this file's claims were not re-run on 1.27.3) with a go.mod `go`
line of 1.26.0 or later, github.com/golang-jwt/jwt/v5 v5.3.1 and golang.org/x/crypto v0.58.0 unless
a rule carries a version tag. Each mistake here accepts what it should reject: a token without an
expiry, a password with a different tail, a cross-site POST, a forged client address. gosec flags
most weak random sources and cookie attributes; nothing reported the JWT (bar errcheck on a
single-value `MapClaims` assertion), password, comparison, CORS or client-IP pitfalls.

Contents: [Verifying JWTs](#verifying-jwts) · [Passwords](#passwords) · [Comparing secrets](#comparing-secrets) ·
[Random tokens](#random-tokens) · [Cookies](#cookies) · [CORS and cross-origin protection](#cors-and-cross-origin-protection) ·
[Client IP behind proxies](#client-ip-behind-proxies) · [Host header](#host-header) · [Secrets in logs](#secrets-in-logs) ·
[Gotchas](#gotchas)

## Verifying JWTs

```go
// Claims are the token claims the service reads.
type Claims struct {
	Scope string `json:"scope,omitempty"`
	// By value: a nil *jwt.RegisteredClaims panics on a token without registered claims.
	jwt.RegisteredClaims
}

// ... (*Claims).Validate returns ErrNoSubject for an empty sub.

// ErrUnknownKey means the token names a kid the verifier does not hold.
var ErrUnknownKey = errors.New("unknown signing key")

// Verifier checks RS256 tokens from one issuer for one audience. It is safe for
// concurrent use; replace it (not its map) to rotate keys.
type Verifier struct {
	parser *jwt.Parser
	keys   map[string]*rsa.PublicKey // by kid
}

// NewVerifier pins the algorithm and requires exp, iss and aud. An empty issuer
// would switch the iss check off (golang-jwt skips it), so it is an error.
func NewVerifier(issuer, audience string, keys map[string]*rsa.PublicKey) (*Verifier, error) {
	if issuer == "" || audience == "" {
		return nil, errors.New("jwt verifier: issuer and audience must not be empty")
	}
	return &Verifier{
		parser: jwt.NewParser(
			jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
			jwt.WithExpirationRequired(),
			jwt.WithIssuer(issuer),
			jwt.WithAudience(audience),
			jwt.WithLeeway(30*time.Second),
		),
		keys: keys,
	}, nil
}

// Verify returns the claims of a valid token, or an error and no claims.
func (v *Verifier) Verify(raw string) (*Claims, error) {
	claims := &Claims{}
	if _, err := v.parser.ParseWithClaims(raw, claims, v.key); err != nil {
		return nil, err
	}
	return claims, nil
}

func (v *Verifier) key(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	k, ok := v.keys[kid]
	if !ok {
		return nil, fmt.Errorf("%w: kid %q", ErrUnknownKey, kid)
	}
	return k, nil
}
```

Its 19-row table test passes under `-race` with parallel subtests sharing one `Verifier`. Removing
an option fails only specific rows: RS512 and PS256 (`WithValidMethods`), no `exp` (`WithExpirationRequired`),
a wrong or missing `iss` or `aud`, `exp` 10 s ago (leeway), no `sub` (`Validate`); so does removing the
empty-value guard.

What `jwt.Parse` did (golang-jwt v5.3.1); code relying on any **bold** default is reported by
nothing (none — test or review). Every claim error also matches `jwt.ErrTokenInvalidClaims`, and
its text starts with `token has invalid claims: `.

| Token | Parser options | Result (claim errors without the prefix) | `errors.Is` |
|---|---|---|---|
| no `exp` | defaults | **accepted — never expires** | — |
| no `exp` | `WithExpirationRequired()` | `token is missing required claim: exp claim is required` | `ErrTokenRequiredClaimMissing` |
| `exp` 30 s ago | defaults / `WithLeeway(time.Minute)` | `token is expired` / accepted | `ErrTokenExpired` |
| `nbf` 30 s ahead | defaults / `WithLeeway(time.Minute)` | `token is not valid yet` / accepted | `ErrTokenNotValidYet` |
| `iat` 1 h ahead | defaults / `WithIssuedAt()` | **accepted** / `token used before issued` | `ErrTokenUsedBeforeIssued` |
| any `iss`, any `aud` | no `WithIssuer`, no `WithAudience` | **accepted — not checked** | — |
| no `iss`, or any `iss` | **`WithIssuer("")`** (an unset config value) | **accepted — the check is off** | — |
| `iss` other / `aud` `"x"` | `WithIssuer("auth")` / `WithAudience("api")` | `token has invalid issuer` / `… audience` | `ErrTokenInvalidIssuer` / `ErrTokenInvalidAudience` |
| `aud` `"api"` or `["x","api"]` | `WithAudience("api")` | accepted: string or array, any one match | — |
| no `aud` | `WithAudience("api")` | `token is missing required claim: aud claim is required` | `ErrTokenRequiredClaimMissing`, **not** `…InvalidAudience` |
| `aud` `["x"]` | `WithAllAudiences("api", "x")` | `token has invalid audience` | `ErrTokenInvalidAudience` |
| `aud` `"orders"` (no `aud`) | `WithAudience("")` | `token has invalid audience` (no `aud`, `""` or `[""]`: `aud claim is required`); only an array holding `""` next to another value (`["x",""]`) passes | `ErrTokenInvalidAudience` (`…RequiredClaimMissing`) |
| expired, signed by another key | defaults | `token signature is invalid: ` + `crypto/rsa: verification error` (RS256, PS256) or `signature is invalid` (HS256) | `ErrTokenSignatureInvalid`, not `ErrTokenExpired` |

- **Pin the method even with a typed RSA key.** With the keyfunc returning `*rsa.PublicKey` and no
  `WithValidMethods`, RS512 and PS256 tokens from that key passed (HS256 signed with its PEM and
  `alg: none` failed on the key type). A keyfunc returning `[]byte(pem)` accepted that HS256 forgery,
  and an HMAC keyfunc ignoring `token.Method` accepted HS512. A `string` HMAC key fails at run time:
  `HMAC sign expects []byte`, or `HMAC verify expects []byte` from a keyfunc. Reported by: none — test or review.
- **On error, `Parse` still returns a token with the claims it decoded**: a badly signed token
  gives `token != nil` with the sender's `sub`, and so does a three-part token whose signature does
  not decode (`ErrTokenMalformed`); only a wrong number of segments gives a nil token. Read claims
  only when `err == nil`. Reported by: none — test or review.
- **Custom checks go in `Validate() error`** `(golang-jwt v5)`, either receiver; a v4 `Valid() error`
  compiles and is never called, so a migration drops the check. Reported by: none — test or review.
- **Embed `jwt.RegisteredClaims` by value.** With the pointer embedded, tokens carrying `exp` or
  `sub` work (encoding/json allocates it), but a token with only custom claims panics with a nil
  dereference inside `Parse` — and the sender chooses the token. Reported by: none — test or review.
- **`jwt.MapClaims` numbers are `float64`**: an `int64` above 2^53 loses digits and
  `mc["n"].(int)` fails; `jwt.WithJSONNumber()` keeps `json.Number` (go-style skill, types-data).
  Reported by: `golangci:errcheck (standard)` with `check-type-assertions`, single-value form only.
- **Times are whole seconds** (`jwt.TimePrecision`): a 500 ms token issued at :00.200 is expired
  on issue, and a token is expired at its `exp` instant. Reported by: none — test or review.

## Passwords

```go
// Hasher bounds how many bcrypt operations run at once.
type Hasher struct {
	slots chan struct{}
}

// ... NewHasher sizes slots to runtime.GOMAXPROCS(0); Hash wraps GenerateFromPassword the same way.

// Check reports whether password matches hash. A mismatch is (false, nil).
func (h *Hasher) Check(ctx context.Context, hash []byte, password string) (bool, error) {
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()
	err := bcrypt.CompareHashAndPassword(hash, []byte(password))
	if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		return false, nil
	}
	return err == nil, err
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Hasher) release() { <-h.slots }
```

- **The 72-byte limit is enforced on one side only** `(x/crypto v0.58)`. `GenerateFromPassword` rejects
  73 bytes (25 Hangul characters are 75) with `bcrypt.ErrPasswordTooLong`, but `CompareHashAndPassword`
  matches a 72-byte password's hash against those bytes plus 22 more, so hashes from a truncating
  library accept any password sharing the first 72 bytes. Reported by: none — test or review.
- **Cost below 4 silently becomes 10**; 32 or more is an error. One hash on one arm64 core: cost
  10 ≈ 70 ms, 12 ≈ 260 ms, 14 ≈ 1.1 s. Reported by: none — test or review.
- **Unbounded bcrypt slows every request during a login burst.** Cost-12 compares started at once,
  GOMAXPROCS=8: 1 → 265 ms, 8 → 396 ms, 32 → 1.53 s, 128 → 6.68 s wall: about 30/s fill 8 cores.
  With the `Hasher` (8 slots), 32 checks under a 500 ms deadline completed 8–16 across runs; the rest
  returned `context.DeadlineExceeded` at the deadline (500–541 ms) without running bcrypt. An admitted
  compare cannot be cancelled (wall 0.7–1.0 s), so bound admission. Reported by: none — test or review.

## Comparing secrets

- **Empty equals empty** (static API keys, shared secrets): `subtle.ConstantTimeCompare(nil,
  []byte{})` is 1 and `hmac.Equal(nil, nil)` is true, so an unset environment variable matches an
  absent header. Refuse an empty key at startup. Reported by: none — test or review.
- **`ConstantTimeCompare` returns 0 at once when lengths differ** (source), revealing the expected
  length. Store `sha256.Sum256(key)` and compare it with the presented key's digest; a checker
  built this way rejected the empty, one-byte-off and prefix keys. Reported by: none — test or review.

## Random tokens

- **`crypto/rand.Text()`** `(toolchain ≥1.24)`: 26 base32 characters (`A–Z2–7`), 130 bits; the doc
  allows longer texts later, so do not validate exactly 26. `crypto/rand.Read` never returns an error (docs).
- **`math/rand` and `math/rand/v2` are not for secrets**, a fixed-seed ChaCha8 included. Reported
  by: `golangci:gosec (opt-in)` G404 for `math/rand`, `math/rand/v2` and `rand.New(rand.NewChaCha8(…))`,
  but not for a `*rand.ChaCha8` used directly (`c.Read`, `c.Uint64`: none — test or review);
  `staticcheck SA1019` and `gopls` (deprecated) only for `math/rand.Read`; vet silent.

## Cookies

`http.SetCookie` never calls `Cookie.Valid()`; it repairs or drops what it cannot send. What a
real server sent:

| Cookie | `Valid()` | `Set-Cookie` on the wire |
|---|---|---|
| Value `{"id":7,"role":"admin"}` | `invalid byte '"'` | `json="{id:7,role:admin}"` + one standard `log` line |
| Value `a;b=c`, `a\b`, `café` | invalid byte | `ab=c`, `ab`, `caf` + one `log` line each |
| Name `bad name` | invalid name | **no header, no log line** |
| `Partitioned` without `Secure` `(toolchain ≥1.23)` | `partitioned cookies must be set with Secure` | sent with `Partitioned` |

- **Call `c.Valid()` and return its error before `SetCookie`.** A session helper doing so returned
  `session cookie: http: invalid byte '"' in Cookie.Value` for a JSON value; without the check the
  cookie went out as `session={id:7}`. Reported by: none — test or review.
- **Set `Secure`, `HttpOnly` and `SameSite` yourself**: unset `SameSite` sends no attribute, and
  `SameSite=None` went out without `Secure`. Store an ID or a signed value. Reported by:
  `golangci:gosec (opt-in)` G124 on each literal lacking one of the three (`MaxAge: -1` included).

## CORS and cross-origin protection

```go
// CORS lets the listed origins make credentialed calls. It must wrap the whole mux:
// a method pattern such as "POST /orders" answers the preflight OPTIONS with 405.
func CORS(origins ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		allowed[o] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			h.Add("Vary", "Origin") // caches must key on Origin
			origin := r.Header.Get("Origin")
			ok := origin != "" && allowed[origin]
			if ok {
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Credentials", "true")
			}
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				// ... Allow-Methods and Allow-Headers when ok
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// BrowserAPI guards a cookie-authenticated API called from one frontend origin.
func BrowserAPI(mux http.Handler, frontend string) (http.Handler, error) {
	cop := http.NewCrossOriginProtection()
	if err := cop.AddTrustedOrigin(frontend); err != nil { // needed for a sibling subdomain too
		return nil, err
	}
	return cop.Handler(CORS(frontend)(mux)), nil
}
```

- **Reflecting `Origin` with `Allow-Credentials: true` allows every origin.** A hand-written middleware
  answered `Origin: https://evil.example` with that origin and credentials on the preflight and the
  POST; a browser then lets that site read the responses (Fetch spec). Reported by: none — test or review.
- **Route-level CORS never sees the preflight.** With `mux.Handle("POST /x", cors(h))`, `OPTIONS /x`
  got `405 Allow: POST` and no CORS headers; with a `/` catch-all, 200 from `/` and none either
  ([http-server](http-server.md) has the pattern rules). Reported by: none — test or review.
- **`http.CrossOriginProtection`** `(toolchain ≥1.25)`, identical on go1.25.0 to go1.27.1 except the last row:

  | Request | Result |
  |---|---|
  | POST with no `Sec-Fetch-Site` and no `Origin` (curl), or `same-origin` / `none` | 200 |
  | POST, `Sec-Fetch-Site: same-site` (sibling subdomain), or POST/PUT/DELETE `cross-site` | **403** |
  | GET, HEAD or OPTIONS cross-site | 200 — safe methods are never checked |
  | No `Sec-Fetch-Site`, `Origin` `https://<Host>` on an `http` server | 200 — only the host is compared |
  | No `Sec-Fetch-Site`, `Origin` another host or `null` | 403 |
  | Bypass `POST /hook/`: `POST /hook/x` / `POST /hook/../admin` | 200 / 403 |
  | Same bypass, `POST /hook` with its own protected handler | 403; **200 on go1.25.0** (handler reached) |

  It is CSRF protection for browsers, not authentication; a GET that changes state is not covered. A
  frontend on another subdomain needs `AddTrustedOrigin` (then 200, without it 403), which errors on
  a path, a trailing slash or a missing scheme. go1.25.1 fixed the bypass bug: a request ServeMux would
  redirect to the pattern (`/hook` → `/hook/`) was exempt. Reported by: none — test or review.

## Client IP behind proxies

```go
// ClientIP returns the client address behind trustedHops reverse proxies that each append
// their peer's address to X-Forwarded-For (0: no proxy). Entries further left come from the
// client. The service port must be reachable only through the proxies.
func ClientIP(r *http.Request, trustedHops int) (netip.Addr, error) {
	if trustedHops == 0 {
		ap, err := netip.ParseAddrPort(r.RemoteAddr)
		return ap.Addr(), err
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(v, ",")...)
	}
	if len(hops) < trustedHops {
		return netip.Addr{}, errors.New("X-Forwarded-For has fewer entries than trusted proxies")
	}
	return netip.ParseAddr(strings.TrimSpace(hops[len(hops)-trustedHops]))
}
```

A per-key limiter (`x/time/rate`, 3 per minute) and 10 requests on new connections, each with a
different forged `X-Forwarded-For` (3/7 is 3 × 200, then 7 × 429):

| Limiter key | Direct | `NewSingleHostReverseProxy` | `ReverseProxy{Rewrite: SetURL + SetXForwarded}` |
|---|---|---|---|
| leftmost `X-Forwarded-For` | **10 × 200** | **10 × 200** (app saw `10.0.0.1, 127.0.0.1`) | 3 × 200, 7 × 429 (inbound header dropped) |
| `r.RemoteAddr` (`ip:port`) | **10 × 200** (new port each time) | 3/7 only because the proxy reuses one upstream connection | same |
| host of `r.RemoteAddr` | 3/7, correct | 3/7, but every client shares the proxy's bucket | same |
| rightmost entry (1 trusted hop) | **10 × 200** — the app is reachable directly | 3/7, correct | 3/7, correct |

- **The leftmost entry is whatever the client sent** (a Director-style proxy appends to it), and
  `r.RemoteAddr` is `ip:port` whose host behind a proxy is the proxy. Count trusted hops from the
  right; with no proxy use the parsed peer address. Reported by: none — test or review.
- **Trusting `X-Forwarded-For` assumes the port is reachable only through your proxies.** Behind a real
  `httputil.ReverseProxy`, `ClientIP(r, 1)` returned the proxy-seen address despite a forged entry.

## Host header

`r.Host` is whatever the client named. A raw `Host: evil.example` reached the handler as `r.Host`,
an absolute request line (`GET http://evil.example/ HTTP/1.1`) overrides the Host header, and
net/http rejects only a missing (HTTP/1.1), malformed or repeated one; an empty `Host:` passes as
`r.Host == ""`. Behind `NewSingleHostReverseProxy` the app saw the client's Host; behind `Rewrite`
with `SetURL` and `SetXForwarded`, the upstream's host and the client's value in `X-Forwarded-Host`.

- **Build absolute URLs from configuration, not from the request.** A reset link built from `r.Host`
  pointed at `https://evil.example/…` with the user's token. Use a configured base URL for e-mail
  links, OAuth redirect URIs and `Location` headers on your site. Reported by: `golangci:gosec (opt-in)`
  G710 only on an `http.Redirect` whose URL comes from `r.Host`; a link in a mail body or a hand-set
  `Location` header: none — test or review.
- **Choose a tenant or virtual host from an allow list.** A host pattern does that in the mux:
  `mux.Handle("api.example.com/", h)` served `api.example.com` and `api.example.com:8080` and
  answered 404 to `evil.example` and to `API.EXAMPLE.COM` (the match is case-sensitive).

## Secrets in logs

`slog.Any("headers", r.Header)` prints `Authorization`, and a `slog.LogValuer` does not redact a
secret nested in a struct: see [config-observability](config-observability.md) for the redacting type.

## Gotchas

- Agent calls `jwt.Parse(raw, keyfunc)` with no options - a token without `exp` never expires and any `iss` or `aud` passes.
- Agent passes the issuer from config straight to `jwt.WithIssuer` - an unset value turns the iss check off and every issuer passes.
- Agent relies on the keyfunc's key type instead of `WithValidMethods` - RS512 and PS256 tokens from the same RSA key pass, and with a `[]byte(pem)` key so does HS256 signed with the public key.
- Agent reads `token.Claims` before checking the `Parse` error - it trusts the claims of a badly signed or undecodable-signature token.
- Agent keeps a jwt v4 `Valid()` method on custom claims - v5 never calls it.
- Agent embeds `*jwt.RegisteredClaims` - a token with only custom claims panics inside `Parse`.
- Agent calls bcrypt in handlers without a bound - about 30 logins/s fill 8 cores and every request slows.
- Agent trusts bcrypt to reject long passwords - `CompareHashAndPassword` ignores bytes past 72.
- Agent compares an API key from an unset env var with a missing header - empty equals empty.
- Agent makes tokens with `math/rand/v2` - predictable, and only gosec G404 says so (not for a `ChaCha8` used directly).
- Agent puts JSON in a cookie value - the quotes are dropped and the corrupted cookie is still sent.
- Agent reflects `Origin` with `Allow-Credentials: true` - every site can read the responses.
- Agent wraps one method-pattern route with CORS - the preflight gets 405 and the browser blocks the call.
- Agent puts `CrossOriginProtection` in front of a frontend on a sibling subdomain - its POSTs get 403.
- Agent keys a rate limiter on the leftmost `X-Forwarded-For` or on `RemoteAddr` with its port - each request gets a new bucket.
- Agent builds a reset or callback link from `r.Host` - a forged Host header sends the user's token to another site.

## Official sources

- [golang-jwt/jwt v5.3.1](https://pkg.go.dev/github.com/golang-jwt/jwt/v5@v5.3.1), its [migration guide](https://github.com/golang-jwt/jwt/blob/v5.3.1/MIGRATION_GUIDE.md) and [RFC 8725, JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [x/crypto/bcrypt v0.58.0](https://pkg.go.dev/golang.org/x/crypto@v0.58.0/bcrypt), [crypto/subtle](https://pkg.go.dev/crypto/subtle), [hmac.Equal](https://pkg.go.dev/crypto/hmac#Equal), [rand.Text](https://pkg.go.dev/crypto/rand#Text)
- [http.Cookie](https://pkg.go.dev/net/http#Cookie), [http.SetCookie](https://pkg.go.dev/net/http#SetCookie), [http.CrossOriginProtection](https://pkg.go.dev/net/http#CrossOriginProtection), [Go 1.25 release notes](https://go.dev/doc/go1.25) and [httputil.ReverseProxy](https://pkg.go.dev/net/http/httputil#ReverseProxy) (Director versus Rewrite and `SetXForwarded`)
- [Fetch standard: the CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol) and [CORS and HTTP caches](https://fetch.spec.whatwg.org/#cors-protocol-and-http-caches)
