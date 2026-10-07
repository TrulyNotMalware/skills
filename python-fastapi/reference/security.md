# Authentication, tokens, passwords, CORS

Applies to FastAPI 0.142, Starlette 1.7, PyJWT 2.15, bcrypt 5.0. Security code fails in two
ways: loudly at a version boundary (every login breaks after an upgrade), or silently by accepting
what it should reject. Both kinds are listed.

Contents: [Bearer tokens](#bearer-tokens) · [Passwords](#passwords) · [CORS](#cors) ·
[Other headers and hosts](#other-headers-and-hosts) · [Gotchas](#gotchas)

## Bearer tokens

```python
from datetime import UTC, datetime, timedelta
from typing import Annotated

import jwt
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

SECRET = "replace-with-at-least-32-random-bytes-from-settings"  # a SecretStr in real code
ALGORITHM = "HS256"
AUDIENCE = "api"

bearer = HTTPBearer()
app = FastAPI()


class Principal(BaseModel):
    user_id: str
    scopes: list[str] = []


def issue_token(user_id: str, scopes: list[str], ttl: timedelta = timedelta(minutes=15)) -> str:
    now = datetime.now(UTC)
    claims = {"sub": user_id, "scope": " ".join(scopes), "aud": AUDIENCE, "iat": now, "exp": now + ttl}
    return jwt.encode(claims, SECRET, algorithm=ALGORITHM)


async def current_principal(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
) -> Principal:
    try:
        claims = jwt.decode(
            credentials.credentials,
            SECRET,
            algorithms=[ALGORITHM],
            audience=AUDIENCE,
            options={"require": ["exp", "sub", "aud"]},
            leeway=10,
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    scope = claims.get("scope", "")
    if not isinstance(scope, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return Principal(user_id=claims["sub"], scopes=scope.split())


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


@app.get("/me")
async def me(principal: CurrentPrincipal) -> Principal:
    return principal
```

- A token **without `exp` is valid forever** by default. Pass `options={"require": ["exp"]}`;
  issuing code that forgets `exp` is then rejected instead of trusted.
- `sub` must be a string (PyJWT 2.10+). A token issued with `{"sub": 1}` is rejected with
  `jwt.exceptions.InvalidSubjectError` (an `InvalidTokenError`, not re-exported at the top level),
  while `encode()` still accepts an integer `sub` without complaint, so an upgrade invalidates
  every token issued with an integer subject.
- A token carrying `aud` is rejected with `InvalidAudienceError` unless `audience=` is passed.
  Pin the audience on both sides.
- `algorithms=[...]` is mandatory in `decode()` (`DecodeError` without it), and `"none"` cannot be
  abused when a key is given. Still list only the algorithm you issue with.
- Every token-caused `jwt.decode` error derives from `jwt.InvalidTokenError`; catch that, not
  `Exception`. An uncaught `ExpiredSignatureError` is a `500`, not a `401`. Key-configuration
  errors (`InvalidKeyError` for a PEM of the wrong key type or an unparsable PEM; a plain
  `TypeError` for a key object of the wrong type or `None`) are **not** `InvalidTokenError` and
  surface as `500`, which is right for a server-side misconfiguration. `options={"verify_signature": False}` also skips the `exp` check.
- A valid signature says nothing about the **shape** of the other claims. A token whose `scope` is
  `null` or a list (another issuer's convention, an issuing bug) makes `claims["scope"].split()`
  raise, which is a `500` for a request that should be a `401`. Check claim types before use.
- Clock skew between issuer and verifier makes fresh tokens "expired"; `leeway=` covers seconds,
  not misconfigured clocks.
- An HMAC key shorter than the hash size (32 bytes for HS256, 48 for HS384, 64 for HS512) works,
  but PyJWT 2.11+ raises `InsecureKeyLengthWarning` on every encode and decode. Python's default
  filter prints it once per process for `encode` and once for `decode` (the warning is attributed
  to PyJWT's own line, not the caller's), so it is easy to miss; under `filterwarnings = error`
  it is a failing test, and under `-W always` a line per encode and per decode. Generate the
  secret with `secrets.token_urlsafe(64)`.

### FastAPI security schemes

- `HTTPBearer()` answers `401` with `WWW-Authenticate: Bearer` when the header is missing,
  malformed, or of another scheme. `HTTPBearer(auto_error=False)` returns `None` instead; the
  route must then handle the anonymous case, or it is open.
- The scheme name is matched case-insensitively (`bearer x` is accepted), and `Bearer tok extra`
  yields the credentials `tok extra`. `OAuth2PasswordBearer` accepts `Authorization: Bearer` with
  no token and passes `""` as the token, where `HTTPBearer` answers `401`.
- The scheme only extracts the credentials. Everything else (signature, expiry, audience,
  authorization) happens in the dependency that uses it.
- Authentication proves who calls; **authorization is a separate check** on the resource
  (`doc.owner_id == principal.user_id`, or scopes). `Security(dep, scopes=[...])` only passes
  the requested scopes to the dependency through `SecurityScopes`; the dependency must compare
  them itself.
- Router-level `dependencies=[Depends(bearer)]` cover the routes of that router only (also routes
  added to it after `include_router`). A route registered on the app or on another router is
  open. App-level `FastAPI(dependencies=[...])` covers FastAPI HTTP routes only: `/docs`,
  `/openapi.json`, mounted sub-applications and raw Starlette routes stay open, and an
  `HTTPBearer` dependency on the app or on a router breaks every WebSocket route under it with a
  `500` (no `Request` to inject). Test an unauthenticated request per route
  ([testing](testing.md#what-to-test-through-the-client)).

## Passwords

```python
import bcrypt


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())
```

- **bcrypt 5.0 raises `ValueError` for passwords longer than 72 bytes**, in `checkpw` as well as
  `hashpw`; bcrypt 4.x silently truncated (a 73-byte password verified against the hash of its
  first 72 bytes). After the upgrade, users whose passwords were hashed from over-long input can
  no longer log in unless `verify_password` truncates the same way. Bytes count, not characters.
- **passlib 1.7.4 is broken with bcrypt 5.0**: `CryptContext(schemes=["bcrypt"]).hash("pw")`
  raises the 72-byte `ValueError` for any password, because passlib's backend self-test
  (`detect_wrap_bug`) hashes an over-long secret at load. Every hash and verify call fails.
  passlib is unmaintained; call `bcrypt` (or `argon2-cffi`) directly.
- Hashing is CPU-bound: `bcrypt` at the default cost took about 170 ms here. In an `async def`
  handler that stalls every other request for that long; run it through `run_in_threadpool` or
  in a `def` handler ([fastapi-basics](fastapi-basics.md#def-and-async-def-handlers)).
- Compare API keys and signatures with `secrets.compare_digest`, not `==`; it takes two `str`
  (ASCII only) or two `bytes`, and raises `TypeError` for a mix.

## CORS

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
```

- **`allow_origins=["*"]` together with `allow_credentials=True` is not rejected by anything.**
  Starlette reflects the request's `Origin` and adds `Access-Control-Allow-Credentials: true`, so
  any site can make credentialed requests. List the origins.
- `allow_methods` defaults to `["GET"]`: with only `allow_origins` set, a preflight for `POST`
  answers `400 Disallowed CORS method` and the browser reports a CORS error for every write that
  needs a preflight (JSON bodies, custom headers).
- CORS does not stop "simple" requests from running: a `POST` with `text/plain` or a form body
  from a disallowed origin reaches the handler and changes state; only the response is withheld
  from the page. With cookie authentication that is a CSRF hole; require a custom header or a
  JSON content type, or add CSRF tokens.
- `allow_headers` defaults to none beyond the CORS-safelisted ones; `Authorization` must be listed
  for bearer tokens from a browser.
- A `500` from an unhandled exception carries no CORS headers
  ([fastapi-basics](fastapi-basics.md#application-and-lifespan)); the browser shows a CORS error
  instead of the failure.
- CORS is a browser mechanism. It does not protect the API from non-browser clients and is not
  authentication.

## Other headers and hosts

- `TrustedHostMiddleware(allowed_hosts=[...])` rejects other `Host` headers with `400`; the match
  is case-sensitive, ignores `X-Forwarded-Host`, and `*.example.com` does not match
  `example.com`. Test clients send `testserver` by default
  ([testing](testing.md#choosing-a-client)).
- Client addresses and scheme behind a proxy come from `X-Forwarded-*`; uvicorn trusts them only
  from `--forwarded-allow-ips` (default `127.0.0.1,::1`). With the wrong setting
  `request.client.host` is the proxy and `request.url.scheme` is `http`: `url_for` builds
  `http://` links and `HTTPSRedirectMiddleware` redirects forever. With `'*'` the leftmost
  `X-Forwarded-For` entry is trusted, so any client can spoof its address.
- Rate limiting keyed on `request.client.host` puts every client in one bucket when the proxy's
  forwarded headers are not trusted or not sent; with a correct `--forwarded-allow-ips` the
  clients are distinguished.
- `docs_url=None` alone leaves `/redoc` and `/openapi.json` public; use `openapi_url=None`
  ([fastapi-basics](fastapi-basics.md#routing)). The default `422` body echoes request input,
  including sibling secret fields ([web-errors](web-errors.md#validation-errors)).

## Gotchas

- Agent issues tokens without `exp` and verifies without `require: ["exp"]` - such tokens are accepted forever (a token that has `exp` is still checked).
- Agent puts an integer user id in `sub` - rejected by PyJWT 2.10+.
- Agent adds `aud` to tokens and verifies without `audience=` - every token is rejected after the change.
- Agent catches `jwt.ExpiredSignatureError` only - other invalid tokens are `500`.
- Agent upgrades to bcrypt 5 with passlib in place - every hash and verify call raises.
- Agent accepts long passwords and hashes with bcrypt 5 - `ValueError` at 73 bytes.
- Agent hashes passwords inside an `async def` handler - the process stalls per login.
- Agent uses `HTTPBearer(auto_error=False)` and forgets the `None` case - anonymous access.
- Agent puts auth in `APIRouter(dependencies=...)` and later adds a route on the app or another router - that route is open.
- Agent puts `HTTPBearer` in `FastAPI(dependencies=...)` - docs and mounts stay open; WebSocket routes under it (also under a router with that dependency) break with `500`.
- Agent upgrades to bcrypt 5 - users with passwords over 72 bytes can no longer log in.
- Agent treats `Security(dep, scopes=[...])` as enforcement - the dependency must compare scopes itself.
- Agent sets `allow_origins=["*"]` with credentials - any origin gets credentialed access.
- Agent sets `allow_origins` only - `POST` preflights fail with `400`.
- Agent keys rate limits on `request.client.host` behind a proxy whose forwarded headers are not trusted - one bucket for everyone.
- Agent calls `.split()` on a `scope` claim without checking its type - `500` for a token with a list or null scope.
- Agent relies on CORS to protect cookie-authenticated writes - simple cross-site `POST`s still execute.
- Agent compares API keys with `==` - timing side channel.
- Agent uses a short JWT secret - a weak key, and a warning that fails tests under `filterwarnings = error`.

## Official sources

- [FastAPI: Security](https://fastapi.tiangolo.com/tutorial/security/)
- [PyJWT: Usage](https://pyjwt.readthedocs.io/en/stable/usage.html)
- [bcrypt on PyPI](https://pypi.org/project/bcrypt/)
- [Starlette: CORSMiddleware](https://www.starlette.io/middleware/#corsmiddleware)
- [uvicorn: Settings (proxy headers)](https://uvicorn.dev/settings/)
