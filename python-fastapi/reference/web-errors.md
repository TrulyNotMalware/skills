# Error responses and exception handlers

Applies to FastAPI 0.142 on Starlette 1.7. FastAPI has no built-in RFC 9457 problem details; the
default error body is `{"detail": ...}` for `HTTPException` and `{"detail": [...]}` for validation
errors. Whatever shape the project uses, the rules below decide whether an error reaches the
client in that shape at all.

Contents: [Which exceptions reach which handler](#which-exceptions-reach-which-handler) ·
[Validation errors](#validation-errors) · [Status codes and bodies](#status-codes-and-bodies) ·
[Gotchas](#gotchas)

## Which exceptions reach which handler

```python
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.utils import is_body_allowed_for_status_code
from starlette.exceptions import HTTPException as StarletteHTTPException


class DomainError(Exception):
    code = "domain_error"
    status_code = 400


class NotFoundError(DomainError):
    code = "not_found"
    status_code = 404


def create_app() -> FastAPI:
    app = FastAPI()

    @app.exception_handler(DomainError)
    async def domain_error(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "message": str(exc)}, status_code=exc.status_code)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        if not is_body_allowed_for_status_code(exc.status_code):
            return Response(status_code=exc.status_code, headers=exc.headers)
        return JSONResponse(
            {"code": "http_error", "message": exc.detail}, status_code=exc.status_code, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        return JSONResponse({"code": "validation_error", "errors": errors}, status_code=422)

    return app
```

- Lookup order: for an `HTTPException`, a handler registered by **status code**
  (`@app.exception_handler(404)`) is checked first, then the class hierarchy (a handler for
  `DomainError` also handles `NotFoundError`; the most specific registered class wins).
  Registering `500` is an alias of `Exception`, for unhandled errors only: it does not see
  `HTTPException(500)`. Status-code handlers never see `RequestValidationError`, and they must
  forward `exc.headers` like class handlers.
- **Register the HTTP handler on `starlette.exceptions.HTTPException`**, not on
  `fastapi.HTTPException`. FastAPI's class is a subclass; the router's own `404` and `405` are
  raised as the Starlette class, so a handler keyed on the FastAPI class does not see them and
  those responses keep the default `{"detail": "Not Found"}` shape.
- A handler for `Exception` is a last resort, not a catch-all: `HTTPException` and
  `RequestValidationError` keep their own handlers, and the response it returns is still sent
  as an unhandled error (re-raised in test clients, no user middleware applied, see
  [fastapi-basics](fastapi-basics.md#application-and-lifespan)). With `FastAPI(debug=True)` the
  handler is **ignored** and the client receives the traceback as text or HTML.
- Do not put `str(exc)` into the body of an `Exception` handler: for a `ResponseValidationError`
  it contains the offending value and the source path and line of the endpoint.
- An exception raised inside `BaseHTTPMiddleware` or a pure ASGI middleware is **not** routed
  through the specific handlers, `HTTPException` included: the client gets a bare `500` (or the
  `Exception` handler's response when one is registered). Middleware that rejects requests must
  return a response itself. A pure ASGI middleware that raises **after** the inner app returned
  cannot change the response: the client already has its `200`, and the server logs the error and
  closes the connection.
- An exception raised inside a handler is looked up once more by the outer
  `ExceptionMiddleware` (handlers run at route level and again at app level): a raised
  `HTTPException`, or another class that has a handler, gets that handler's response; anything
  else is a `500` with no trace of the original error in the response. For errors raised outside
  a route (router `404`/`405`) there is no second pass: a handler that raises there is a `500`.

## Validation errors

- The default `422` body echoes each error's **input**. For a wrong-type field it is that field's
  value only. For a **missing** field, `loc` names the missing field (`["body", "otp"]`) but
  `input` is the enclosing object, so a request with a valid `password` and no `otp` returns the
  password in the error response. A wrong body shape and a model-level validator echo the whole
  object at `loc: ["body"]`. A body sent without a JSON content type is echoed as raw text. `SecretStr` does not help; the
  echo happens before the model exists. Strip `input` in a custom `RequestValidationError`
  handler, as above.
- `exc.errors()` in a custom handler still contains `input` and `ctx`; a `ctx` can hold the
  `ValueError` raised by a validator, which `JSONResponse` cannot encode (`500`). The default
  handler survives because it runs `jsonable_encoder`, which turns the exception in `ctx` into
  `{}` (the text remains in `msg`). Copy the fields you return, as above.
- `exc.body` is whatever the route's body parser produced, independent of which parameter
  failed: the parsed JSON whenever the route declares a body parameter and the body parsed (also
  for a query, header or path error), the raw request text for `json_invalid`, raw `bytes` (not JSON-serializable) when the
  request has no JSON content type, and `None` when no
  body was sent or the route has no body parameter. An empty body is `422 missing` at
  `loc: ["body"]` when the body parameter is required; an optional body is `None`.
- Malformed JSON is also a `422` (`json_invalid`), not a `400`.
- Path parameter type mismatches (`/items/abc` for `item_id: int`) are `422`, not `404`.
- Returning data that does not fit the response model is a `500` (`ResponseValidationError`). A
  handler registered for `ResponseValidationError` can turn it into a shaped response.

## Status codes and bodies

- A route declared with `status_code=204` or `304` sends an empty body; a returned value is
  silently discarded. `status_code=205` is broken unless the route returns an explicit
  `Response(status_code=205)`: the body is blanked but `Content-Length` is not, and uvicorn aborts
  the response (`Response content shorter than Content-Length` on httptools,
  `Too little data for declared Content-Length` on h11). A real client sees
  `RemoteProtocolError`; `TestClient` returns `205` and passes.
- Returning `None` from a route with no response model sends `200` with body `null`.
- `HTTPException(detail={...})` sends the dict as `detail`; `headers=` are added to the
  response, which is how `WWW-Authenticate` and `Retry-After` belong on `401`/`429`. A custom
  handler must forward `exc.headers` itself (the snippet above does).
- A custom `HTTPException` handler that always builds a `JSONResponse` breaks
  `HTTPException(204)` and `304`: the client still sees the status, but uvicorn logs
  `Exception in ASGI application` (`Too much data for declared Content-Length` on h11,
  `Response content longer than Content-Length` on httptools) and **drops the
  keep-alive connection**, while `TestClient` and `ASGITransport` deliver the body and pass.
  Return an empty `Response` when `fastapi.utils.is_body_allowed_for_status_code` is false, as
  the default handler and the snippet do. The same applies to a route that returns its own
  `Response(..., status_code=204)` with content.
- `405` responses carry an `Allow` header listing the methods of the route. A `HEAD` request to a
  `GET`-only route is `405` as well; FastAPI does not add `HEAD` automatically.
- The `Accept` header is ignored: a client asking for `text/html` still receives JSON.

## Gotchas

- Agent registers the handler on `fastapi.HTTPException` - router `404`/`405` responses keep the default shape.
- Agent relies on a handler for `Exception` to shape every error - `HTTPException` and validation errors bypass it, and its response has no CORS headers.
- Agent raises `HTTPException` from inside middleware - the client gets a bare `500`.
- Agent keeps the default `422` body on an endpoint that receives credentials - a missing sibling field echoes the secret.
- Agent returns `exc.errors()` unchanged from a custom handler - `ctx` may contain non-serializable objects, and `input` still leaks.
- Agent returns a body from a `204` route - discarded without error.
- Agent writes an `HTTPException` handler that always returns JSON and raises `HTTPException(204)` - server error and dropped connection, invisible in tests.
- Agent expects `/items/abc` to be `404` - it is `422`.
- Agent expects malformed JSON to be `400` - it is `422`, and it hides every other parameter error until the JSON parses.
- Agent registers `@app.exception_handler(422)` for validation errors - it sees only `HTTPException(422)`.
- Agent returns `JSONResponse({...})` from a `status_code=204` route - sent as `200` with a body.
- Agent sets `Retry-After` or `WWW-Authenticate` on `HTTPException` and writes a custom handler without `exc.headers` - the headers disappear.
- Agent tests the body of an `Exception` handler, or of an exception raised in middleware, with the default test client - the exception is re-raised instead; see [testing](testing.md#choosing-a-client).
- Agent leaves `debug=True` on in an environment - the `Exception` handler is skipped and tracebacks go to the client.
- Agent declares `status_code=205` on a route returning data - the server aborts the response.
- Agent expects `HEAD` to work on `GET` routes (health checks, load balancers) - `405`; add `methods=["GET", "HEAD"]`.

## Official sources

- [FastAPI: Handling errors](https://fastapi.tiangolo.com/tutorial/handling-errors/)
- [Starlette: Exceptions](https://www.starlette.io/exceptions/)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
