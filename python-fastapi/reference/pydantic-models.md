# Pydantic models, request bodies, settings

Applies to Pydantic 2.13, pydantic-settings 2.15, FastAPI 0.142. A `BaseModel` validates
**input on construction** and nothing else unless configured: defaults, later assignments, and
objects built with `model_construct()` are not checked. `BaseSettings` sets `validate_default=True`,
so its defaults are validated and its field validators run on them; assignments are still
unchecked.

Contents: [What is and is not validated](#what-is-and-is-not-validated) ·
[Type coercion](#type-coercion) · [Partial updates (PATCH)](#partial-updates-patch) ·
[Aliases and naming](#aliases-and-naming) · [Serialization](#serialization) ·
[Request bodies in FastAPI](#request-bodies-in-fastapi) · [Settings](#settings) ·
[Gotchas](#gotchas)

## What is and is not validated

| Situation | Default behavior |
|---|---|
| Field default (`n: int = "x"`) on a `BaseModel` | not validated; the instance holds `"x"` (`BaseSettings` validates defaults) |
| Assignment after creation (`m.n = "x"`) | not validated |
| Unknown input field (`nmae=` instead of `name=`) | silently dropped (`extra="ignore"`) |
| `field_validator` on a field that uses its default (`BaseModel`) | does not run |
| `field_validator` without `return` (`after`, `plain`, `wrap` mode) | the field becomes `None`; in `before` mode the `None` is rejected by the field type unless it is optional |

- Turn these on per model where they matter: `ConfigDict(validate_default=True,
  validate_assignment=True, extra="forbid")`. Use `extra="forbid"` on request models when a
  misspelled optional field must not be ignored.
- Mutable defaults of built-in collections and model instances are safe: `tags: list[str] = []`
  is copied per instance. Pydantic copies **unhashable** defaults only; a default instance of a
  custom class that is hashable (no `__eq__`), or a lock, is shared by all instances. A **call** in
  a default is evaluated once at class definition: `created: datetime = datetime.now(UTC)` gives
  every instance the same timestamp. Use `Field(default_factory=...)` for both cases.
- Field validators run in field definition order, and `info.data` contains only the fields that
  were defined earlier **and** validated successfully. When an earlier field is invalid it is
  simply missing from `info.data`, and `model_validator(mode="after")` does not run at all. Use
  `info.data.get(...)`, or put cross-field rules in an after-validator.
- Only `ValueError`, `AssertionError` and `PydanticCustomError` raised in a validator become a
  `ValidationError`. A `KeyError` from `info.data["x"]` or a `TypeError` from comparing a naive
  with an aware `datetime` escapes as is; in a FastAPI handler that is a `500`, not a `422`.
  Use `AwareDatetime`/`NaiveDatetime` when comparing datetimes (a plain `datetime` field accepts
  both kinds).
- With `validate_assignment=True`, an assignment that fails in a `model_validator(mode="after")`
  raises but leaves the new value on the instance; a failing field validator or a type error
  keeps the old value.

```python
from datetime import UTC, datetime

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator


class Booking(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    created_at: AwareDatetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def check_range(self) -> "Booking":
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        return self
```

## Type coercion

Default (lax) mode converts compatible input. Observed conversions:

| Input | Field | Result |
|---|---|---|
| `"1"` | `int` | `1` |
| `1.0` | `int` | `1` |
| `1.5` | `int` | error |
| `5` | `str` | error |
| `"yes"`, `"off"`, `1` | `bool` | `True`, `False`, `True` |
| `True` | `int` | `1` |
| `0.1` (float) | `Decimal` | `Decimal("0.1")` |

- Where this is not acceptable, use `Field(strict=True)` on the `int`, `float`, `bool` and `str`
  fields concerned. Strict mode also rejects a JSON string for an `int` field.
- FastAPI validates a JSON body in **Python** mode (`json.loads`, then `validate_python`), not
  with `model_validate_json`. A strict `Decimal`, `UUID`, `datetime` or `Enum` field in a request
  model therefore rejects every input (`422`, `is_instance_of`, or `datetime_type` for `datetime`), although the same model accepts the
  same JSON through `model_validate_json`. Do not put `ConfigDict(strict=True)` on request models.
- Path and query parameters always arrive as strings. A strict `int`/`bool` field or model used in
  `Path()`/`Query()` can never be satisfied (`422 int_type` for `?n=1`).

## Partial updates (PATCH)

A model with `None` defaults cannot tell "field omitted" from "field set to null" through
`model_dump()`. Use the set of fields that were sent:

```python
from pydantic import BaseModel


class ItemUpdate(BaseModel):
    name: str | None = None
    price: float | None = None


def changes(update: ItemUpdate) -> dict[str, object]:
    return update.model_dump(exclude_unset=True)


assert changes(ItemUpdate.model_validate({"price": None})) == {"price": None}
assert changes(ItemUpdate.model_validate({})) == {}
```

- `exclude_none=True` is the wrong tool: it drops an explicit `null`, so a client can never clear
  a field.
- `model_copy(update=...)` adds the updated names to `model_fields_set` and does **not** validate
  the new values; unknown keys are accepted too, also with `extra="forbid"`.
- If `null` is not a valid value for a column, reject it in the update model instead of writing it.

## Aliases and naming

- With an alias (or `alias_generator=to_camel`) input is accepted **only** under the alias.
  `Model(first_name="a")` fails with `missing: firstName`. Add `validate_by_name=True` (Pydantic
  2.11+; `populate_by_name=True` still works but is slated for deprecation) to accept both.
- `model_dump()` and `model_dump_json()` use field names unless `by_alias=True` is passed or the
  model sets `serialize_by_alias=True`. FastAPI responses use aliases by default
  (`response_model_by_alias=True`). Code that dumps a model by hand (cache, message, log)
  therefore produces different keys than the API does.
- Validation errors from FastAPI report the **alias** in `loc` (`["body", "firstName"]`) for
  missing and wrong-typed fields; with `validate_by_name=True`/`populate_by_name=True` a
  wrong-typed field is reported under whichever key the client sent, and a missing field still
  under the alias. Tests that assert on `loc` with field names break when an alias generator is
  added.

## Serialization

- `model_dump()` returns Python objects (`datetime`, `Decimal`, `UUID`, `Enum`); `json.dumps` on it
  fails. Use `model_dump(mode="json")` or `model_dump_json()`.
- JSON output: `Decimal` becomes a string (`"1.10"`), enums their value, UTC datetimes ISO 8601
  with `Z` and other offsets as `+09:00`, naive datetimes ISO 8601 **without offset** (clients
  guess the zone). `NaN` and infinity become `null` in `model_dump_json()` and in a FastAPI
  response with a declared response model; `model_dump(mode="json")` keeps the `nan` float, and a
  `JSONResponse` or plain dict fails with `500`. To refuse non-finite values use
  `Field(allow_inf_nan=False)`; it acts on validation, so a returned instance built without
  validation still sends `null`.
- A handler that returns a plain `dict` without a response model goes through
  `jsonable_encoder`: a `Decimal` is silently converted to a **float** (`1.10` becomes `1.1`),
  UTC datetimes get `+00:00` instead of `Z`, `NaN`/infinity fail with `500`, and an arbitrary
  object is **not** rejected: the encoder falls back to `dict(obj)` and then `vars(obj)`, so an
  object with a `__dict__` is sent as all of its attributes, private ones included. Only objects
  without `__dict__` (`__slots__`, `object()`) or with an unencodable attribute fail with `500`.
  Declare a response model so the encoding is the same everywhere.
- `SecretStr` is masked in `repr`, `str`, `model_dump(mode="json")` and `model_dump_json()`
  (`"**********"`); `model_dump()` in Python mode returns the `SecretStr` object itself, which
  `json.dumps` cannot encode. An empty secret dumps as `""`, not as the mask. Reading the value
  takes `.get_secret_value()`. A response model with a `SecretStr` field sends the mask.

## Request bodies in FastAPI

| Signature | Expected JSON body |
|---|---|
| `item: Item` | `{"name": "a"}` |
| `item: Item, user: User` | `{"item": {...}, "user": {...}}` |
| `item: Annotated[Item, Body(embed=True)]` | `{"item": {"name": "a"}}` |
| `item: Item, note: str` | body `{"name": "a"}`, `note` is a **query** parameter |

- Adding a second body model to a handler changes the contract of the first one: the flat body
  that worked before now fails with `422`.
- A scalar parameter next to a body model is a query parameter. `Annotated[str, Body()]` puts it
  into the body, and then the body is keyed: `{"item": {...}, "note": "n"}`. As the **only** body
  parameter, `Annotated[str, Body()]` expects a bare JSON string (`"n"`), not `{"note": "n"}`.
- `Annotated[Item, Query()]` reads a model from the query string.
- A JSON body is parsed only when the request has a JSON content type (`application/json`, any
  `application/*+json`). With no `Content-Type`, `text/plain` or `text/json`, the request fails
  with `422` (`model_attributes_type`, "Input should be a valid dictionary or object to extract
  fields from"), which looks like a validation problem of the payload (FastAPI 0.142).
- JSON literals `NaN`, `Infinity` or `1e999` sent by a client for a field that rejects them (an
  `int`, a `str`) crash the `422` handler itself (the error's `input` is not JSON-serializable): the client gets `500`.

## Settings

```python
from functools import lru_cache

from pydantic import BaseModel, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Pool(BaseModel):
    size: int = 5


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="APP_", env_nested_delimiter="__", env_file=".env", extra="ignore"
    )

    database_url: SecretStr
    allowed_hosts: list[str] = []
    pool: Pool = Pool()
    debug: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- Priority, highest first: constructor arguments, environment variables, `env_file`, defaults.
- Environment variable names are matched case-insensitively and need the prefix, except fields
  with an explicit `alias`/`validation_alias`: those are read under the bare alias (`MODE`),
  and `APP_MODE` is silently ignored. A misspelled variable (`APP_DATABSE_URL`) is ignored and
  the default is used; only required fields without a default fail at startup. Give settings
  that must be configured **no default**.
- Complex fields are parsed as JSON: `APP_ALLOWED_HOSTS=a,b` raises `SettingsError`;
  `APP_ALLOWED_HOSTS=["a","b"]` works.
- Nested models are filled through the delimiter: `APP_POOL__SIZE=9`. A nested variable replaces
  the **whole** default object, not one field: with `pool: Pool = Pool(enabled=True)`,
  `APP_POOL__SIZE=9` yields `Pool(size=9, enabled=False)`. Set
  `nested_model_default_partial_update=True` to merge into the default instance.
- Nested models are `BaseModel`s, not `BaseSettings`: a `BaseSettings` default
  (`pool: PoolSettings = PoolSettings()`) is instantiated at class definition, so it reads the
  environment at import time with its own `env_prefix`, fails at import when it has a required
  field the environment does not supply, and never sees variables set later. The parent's
  delimiter form (`APP_POOL__SIZE`) still overrides it at `Settings()` time.
- A missing `env_file` is ignored without a message.
- `BaseSettings` defaults to `extra="forbid"`, which applies to constructor arguments and to
  `env_file` keys: any other key in the file, also one without the prefix, raises
  `extra_forbidden`. Environment variables that match no field (`APP_NOT_A_FIELD`) are ignored in
  every mode. Shared `.env` files need `extra="ignore"`.
- "No default" catches a missing variable, not an empty one: `APP_DATABASE_URL=` satisfies a
  required `SecretStr`/`str` field with an empty string. Add `min_length=1` where empty is wrong.
- A shipped `.env.example` with blank values (`CORS_ALLOW_ORIGINS=`, `MONGO_URL=`) is read as empty strings
  once copied to `.env`: a complex field (`list[str]`) raises `SettingsError` at startup, a
  `SecretStr | None` becomes `SecretStr('')` and the code builds a client from `""`, and a required
  password counts as set. `SettingsConfigDict(env_ignore_empty=True)` makes blank values count as unset
  (pydantic-settings 2.15).
- `Settings()` reads the environment at the moment it is called. A module-level
  `settings = Settings()` runs at import time, before test fixtures can set anything. Expose a
  function and inject it as a dependency ([testing](testing.md#dependency-overrides)).

## Gotchas

- Agent gives a `BaseModel` field an invalid default or assigns after creation - neither is validated (`BaseSettings` validates defaults, not assignments).
- Agent writes a `field_validator` that forgets `return` - the field silently becomes `None` (a `before` validator fails with `int_type` instead).
- Agent gives a settings field an `alias` and sets the prefixed variable - ignored; the alias is read without the prefix.
- Agent returns a model instance built with `model_construct()` - response-model constraints such as `allow_inf_nan=False` are not applied.
- Agent reads `info.data["other"]` in a field validator - `KeyError` when `other` was invalid or is defined later.
- Agent uses `datetime.now()` as a default - one timestamp for all instances; use `default_factory`.
- Agent applies a PATCH with `model_dump()` or `exclude_none=True` - omitted fields overwrite data, or explicit nulls are lost; use `exclude_unset=True`.
- Agent updates with `model_copy(update=...)` - the new values are not validated.
- Agent relies on a typo in a request field being rejected - unknown fields are ignored unless `extra="forbid"`.
- Agent ships a `.env.example` with blank values and no `env_ignore_empty=True` - copying it crashes startup on the first complex field, or silently satisfies a required secret.
- Agent accepts money or flags in lax mode - `"1"`, `1.0`, `"yes"` and floats are converted.
- Agent sets `ConfigDict(strict=True)` on a request model with `Decimal`/`UUID`/`datetime` fields, or uses a strict field in `Query()` - every request fails with `422`.
- Agent asserts `loc == ["body", "first_name"]` in tests of an aliased model - `loc` carries the alias.
- Agent returns a plain dict with a `Decimal` - it arrives as a float with the scale lost.
- Agent writes `json.dumps(model.model_dump())` for a model with `SecretStr` or `datetime` - `TypeError`; use `model_dump_json()`.
- Agent adds an alias generator and constructs the model by field name - fails without `validate_by_name=True`.
- Agent compares two `datetime` fields in a validator - `TypeError` (naive vs aware) escapes as `500`; use `AwareDatetime`.
- Agent exports a required setting as an empty string - accepted; add `min_length=1`.
- Agent writes `model_dump()` output to a cache or message - field names, not aliases, and not JSON-safe types.
- Agent returns naive datetimes - serialized without offset.
- Agent adds a second body model or a scalar parameter to a handler - the body contract changes, or the scalar becomes a query parameter.
- Agent debugs a `422` "valid dictionary" error in the payload - the request lacks a JSON content type.
- Agent sets `APP_ALLOWED_HOSTS=a,b` - lists are parsed as JSON.
- Agent gives a required setting a placeholder default - a misspelled variable goes unnoticed.
- Agent adds `env_file` to settings that share a `.env` with other tools - `extra_forbidden` at startup.
- Agent customises a nested model's default and sets one nested variable - the other customised values revert to the nested model's defaults.
- Agent puts a `SecretStr` field in a response model - the client receives the mask.

## Official sources

- [Pydantic: Models](https://docs.pydantic.dev/latest/concepts/models/)
- [Pydantic: Validators](https://docs.pydantic.dev/latest/concepts/validators/)
- [Pydantic: Conversion table](https://docs.pydantic.dev/latest/concepts/conversion_table/)
- [Pydantic: Serialization](https://docs.pydantic.dev/latest/concepts/serialization/)
- [Pydantic Settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)
- [FastAPI: Body - multiple parameters](https://fastapi.tiangolo.com/tutorial/body-multiple-params/)
