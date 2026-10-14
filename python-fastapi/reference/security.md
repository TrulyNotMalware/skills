# Authentication, tokens, passwords, CORS

Applies to FastAPI 0.142, Starlette 1.7, PyJWT 2.15, bcrypt 5.0. Security code fails in two
ways: loudly at a version boundary (every login breaks after an upgrade), or silently by accepting
what it should reject. Both kinds are listed.

Contents: [Bearer tokens](#bearer-tokens) · [Passwords](#passwords) · [CORS](#cors) ·
[Other headers and hosts](#other-headers-and-hosts) · [Webhooks](#webhooks) ·
[Server-side request forgery](#server-side-request-forgery) · [Gotchas](#gotchas)

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
- `docs_url=None` alone leaves `/redoc` and `/openapi.json` public; use `openapi_url=None`
  ([fastapi-basics](fastapi-basics.md#routing)). The default `422` body echoes request input,
  including sibling secret fields ([web-errors](web-errors.md#validation-errors)).
- Client addresses and scheme behind a proxy come from `X-Forwarded-*`; uvicorn trusts them only
  from `--forwarded-allow-ips` (default `127.0.0.1,::1`). With the wrong setting
  `request.client.host` is the proxy and `request.url.scheme` is `http`: `url_for` builds
  `http://` links and `HTTPSRedirectMiddleware` redirects forever. With `'*'` the leftmost
  `X-Forwarded-For` entry is trusted, so any client can spoof its address.
- Rate limiting keyed on `request.client.host` puts every client in one bucket when the proxy's
  forwarded headers are not trusted or not sent; with a correct `--forwarded-allow-ips` the
  clients are distinguished.
- List every proxy hop in `--forwarded-allow-ips`; CIDR ranges work (uvicorn 0.54). uvicorn then
  takes the right-most `X-Forwarded-For` entry that is not trusted. With a CDN in front of a listed
  load balancer but not listed itself, `request.client.host` is the CDN's address for every client.
- When the proxies' addresses cannot be listed (a managed load balancer), derive the client from
  the header: count from the **right** as many entries as there are proxies that append to it.
  `chain[-(hops + 1)]` (as popular guides suggest) is one too far: with one load balancer it is the
  value the client sent, so every rotated value gets a fresh rate-limit bucket. With the helper
  below behind uvicorn `--forwarded-allow-ips '*'`, rotated left-most values shared one bucket. It
  is safe only when the app is reachable through those proxies alone: a direct caller writes the
  whole header. Read `getlist`: `headers.get` returns only the first line when the client sent its
  own header and the proxy added a second one (Starlette 1.7).

```python
from ipaddress import ip_address

from fastapi import Request

TRUSTED_HOPS = 1  # proxies in front of the app that append to X-Forwarded-For


def client_ip(request: Request) -> str | None:
    chain = [
        part.strip()
        for line in request.headers.getlist("x-forwarded-for")
        for part in line.split(",")
    ]
    if len(chain) < TRUSTED_HOPS:
        return None  # not via the proxies: reject, or use a separate bucket
    try:
        return str(ip_address(chain[-TRUSTED_HOPS]))
    except ValueError:
        return None
```

## Webhooks

Applies to signed callbacks from a provider that retries until it gets a `2xx` (FastAPI 0.142,
SQLAlchemy 2.1; measured with uvicorn 0.54 on SQLite and PostgreSQL 17).

```python
import hashlib
import hmac
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DATABASE_URL = "postgresql+asyncpg://app:secret@localhost:5432/app"
WEBHOOK_SECRET = b"replace-from-settings"
MAX_BODY = 256 * 1024


class Base(DeclarativeBase):
    pass


class ProcessedEvent(Base):
    __tablename__ = "processed_event"
    id: Mapped[str] = mapped_column(primary_key=True)


class Payment(Base):  # the effect of an event
    __tablename__ = "payment"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[str]
    status: Mapped[str]


class Event(BaseModel):
    id: str
    type: str


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[dict[str, object]]:
    engine = create_async_engine(DATABASE_URL)  # tables come from migrations
    try:
        yield {"sessionmaker": async_sessionmaker(engine, expire_on_commit=False)}
    finally:
        await engine.dispose()


app = FastAPI(lifespan=lifespan)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.state.sessionmaker() as session:
        yield session


async def read_body(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():  # chunked bodies have no Content-Length
        body += chunk
        if len(body) > MAX_BODY:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE)
    return bytes(body)


@app.post("/webhooks/provider")
async def provider_webhook(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
    signature: Annotated[str, Header(alias="X-Signature")] = "",
) -> dict[str, str]:
    raw = await read_body(request)
    expected = hmac.new(WEBHOOK_SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode(), signature.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED)
    event = Event.model_validate_json(raw)  # parse only after the signature holds
    session.add(ProcessedEvent(id=event.id))
    try:
        await session.flush()  # a redelivery fails here, before the effect
    except IntegrityError:
        await session.rollback()
        return {"status": "duplicate"}
    session.add(Payment(event_id=event.id, status=event.type))  # same transaction
    await session.commit()  # before the 2xx: the sender stops retrying on success
    return {"status": "processed"}
```

- Verify over the raw bytes (`await request.body()`, or the capped `request.stream()` read above).
  They are the bytes the sender signed, also on a route that declares a body model;
  `model_dump_json()` of the parsed model differs (key order, spaces), so a signature over it never
  matches.
- Cap the body before verifying it: nothing else limits it (uvicorn 0.54 read a 32 MiB unsigned
  body in full before the `401`). A `Content-Length` check alone misses chunked requests: a 1 MiB
  chunked body passed it and was read whole. The `request.stream()` loop above answered `413` for
  1 MiB with and without `Content-Length`.
- Declare no body model on the route. With one, FastAPI validates before the handler runs: an
  unsigned malformed request gets `422` with its input echoed, and the signature is never checked.
  Parse with `model_validate_json` after verifying.
- `hmac.compare_digest` on two `str` raises `TypeError` for a non-ASCII header value, a `500`;
  compare bytes as above.
- Insert the event id in the transaction that applies the effect, and commit before returning.
  When the effect fails, the id rolls back with it and the redelivery is processed. On PostgreSQL
  a concurrent redelivery blocks on the uncommitted id until the first transaction commits, then
  answers `duplicate` (10 simultaneous deliveries: 1 processed, 9 duplicate, no `500`, on asyncio
  and uvloop). Committing the id first and the effect afterwards loses the event: the effect
  failed with `500`, the redelivery answered `duplicate`. A commit after a dependency's `yield`
  runs after the `200` is sent ([fastapi-basics](fastapi-basics.md#dependencies-with-yield)): a
  failing commit there (PostgreSQL, a `DEFERRABLE INITIALLY DEFERRED` unique violation at
  `COMMIT`) returned `200` and stored nothing, and the sender does not retry; with
  `Depends(get_session, scope="function")` the same failure is a `500`.

## Server-side request forgery

Applies when the service fetches a URL a user supplied (link previews, imports, callbacks it
calls). Python 3.14.0, httpx 0.28.

- Check the addresses the name resolves to, not the host string: `ip_address("2130706433")`
  raises `ValueError`, while `getaddrinfo` resolves it (also `0x7f000001` and `127.1`) to
  `127.0.0.1` (macOS resolver).
- `is_private` is `False` for carrier-grade NAT `100.64.0.0/10`. `not is_global` catches that and
  IPv4-mapped addresses (`::ffff:127.0.0.1`), but `is_global` is `True` for NAT64
  `64:ff9b::7f00:1` and IPv4-compatible `::127.0.0.1`, which embed `127.0.0.1`. A deny list of
  `IPv4Network`s never matches an `IPv6Address`; unwrap `ipv4_mapped` first.
- Connect to the address you checked. Validating the name and then calling `client.get(url)`
  resolves it again: with a resolver whose second answer differed (simulated), the request reached
  the internal server. Pin the IP in the URL, send the original `Host`, and pass
  `extensions={"sni_hostname": host}`; without it TLS checks the certificate against the IP and
  fails.
- httpx pools connections by the URL's host, here the pinned IP. On a shared client a second
  hostname reused the TLS connection verified for the first name, and its own certificate was never
  checked. With `http2=True` that happened even with `max_keepalive_connections=0`, when the second
  request was sent while the first was in flight (3 of 3 runs, hypercorn over HTTP/2). The snippet
  therefore opens a client per call.
- `client.get()` follows the client's redirect setting: a caller's client with
  `follow_redirects=True` went from the checked host to `http://[::1]/`. The snippet's own client
  sets `follow_redirects=False`; check each hop yourself if redirects are needed.

```python
import ipaddress
import socket

import anyio
import httpx

NAT64 = ipaddress.ip_network("64:ff9b::/96")
IPV4_COMPATIBLE = ipaddress.ip_network("::/96")


def is_public(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        elif addr in NAT64 or addr in IPV4_COMPATIBLE:
            addr = ipaddress.IPv4Address(int(addr) & 0xFFFF_FFFF)
    return addr.is_global


async def fetch_public(url: str) -> httpx.Response:
    target = httpx.URL(url)
    if target.scheme not in {"http", "https"} or not target.host:
        raise ValueError(url)
    port = target.port or (443 if target.scheme == "https" else 80)
    infos = await anyio.getaddrinfo(target.host, port, type=socket.SOCK_STREAM)
    addrs = [ipaddress.ip_address(info[4][0]) for info in infos]
    if not addrs or not all(is_public(addr) for addr in addrs):
        raise ValueError(url)
    pinned = target.copy_with(host=str(addrs[0]))  # connect to what was checked
    # A client per call: a pooled connection to this IP never serves another hostname.
    async with httpx.AsyncClient(follow_redirects=False) as client:
        return await client.get(
            pinned,
            headers={"Host": target.netloc.decode("ascii")},
            extensions={"sni_hostname": target.host},
        )
```

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
- Agent starts uvicorn with `--forwarded-allow-ips '*'` behind a load balancer - every client chooses its own `request.client.host`.
- Agent takes the client from `X-Forwarded-For` at `chain[-(hops + 1)]` - the client-sent value; a fresh rate-limit bucket per request.
- Agent lists the load balancer but not the CDN in front of it in `--forwarded-allow-ips` - every client gets the CDN's address.
- Agent verifies a webhook signature over the re-serialized body model - it never matches; sign-check `await request.body()`.
- Agent commits the webhook event id before applying the effect - a failed effect is never retried; the redelivery answers duplicate.
- Agent commits webhook writes after a dependency's `yield` - the `200` is sent first; a failed commit is lost.
- Agent passes two `str` to `hmac.compare_digest` - a non-ASCII header value is a `500`.
- Agent blocks user-supplied URLs with `is_private`, `not is_global` or an IPv4 deny list - each lets CGNAT, IPv4-mapped or NAT64 addresses through.
- Agent validates a URL's host and then lets httpx resolve it again - a rebinding resolver reaches internal hosts.
- Agent pins the IP for HTTPS fetches on a shared client - a second hostname on that IP rides the first name's TLS connection unchecked (with `http2=True` even without keep-alive); use a client per call.
- Agent fetches user-supplied URLs with a client that follows redirects - a redirect leads to an internal address unchecked.
- Agent reads a webhook body without a size limit before verifying it - unsigned bodies of any size are buffered; a `Content-Length` check alone misses chunked requests.

## Official sources

- [FastAPI: Security](https://fastapi.tiangolo.com/tutorial/security/)
- [PyJWT: Usage](https://pyjwt.readthedocs.io/en/stable/usage.html)
- [bcrypt on PyPI](https://pypi.org/project/bcrypt/)
- [Starlette: CORSMiddleware](https://www.starlette.io/middleware/#corsmiddleware)
- [uvicorn: Settings (proxy headers)](https://uvicorn.dev/settings/)
