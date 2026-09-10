# The error contract

What a failed call returns, how much of it an integrator can key on, and where the contract stops
holding. Derived from every `ExceptionMapper` in the free build and from the resources that throw
past them.

## 1. RFC 7807, implemented once and reused

`libs/karyo-common/src/main/kotlin/com/karyo/common/exception/ProblemDetail.kt` is the single body
shape:

```kotlin
data class ProblemDetail(
    val type: String, val title: String, val status: Int, val detail: String,
    val instance: String? = null, val traceId: String? = null,
    val timestamp: Instant = Instant.now(),
)
```

Sixteen `@Provider` exception-mapper classes, spread over fourteen files, build it. Ten follow one
identical shape: a `when` over a sealed exception hierarchy yielding `(status, slug)`, a `type` of
`"https://karyo.com/errors/$slug"`, a `title` derived by title-casing the slug, `detail` from the
exception message, and `instance` from the injected `UriInfo`. There is one such mapper per
hierarchy: auth, docstore, fulfillment, inventory, layout, orders, product, sequence, stocktaking
and tasks. The other six are single-exception mappers built the same way by hand:
`ConstraintViolationExceptionMapper`, the licence gate (`LicenseRequiredExceptionMapper.kt:12`),
the two label-printer failures (`LabelPrintExceptionMapper.kt:18`, `:35`) and work's two
out-of-hierarchy refusals (`WorkExceptionMapper.kt:11`, `:29`).

Two limits matter most. There is no extensible property bag and no `violations` array. And
`ConstraintViolationExceptionMapper` flattens bean-validation failures into a prose `detail` of
`propertyPath: message` pairs joined by `"; "` (`ConstraintViolationExceptionMapper.kt:11-13`),
which must not be parsed as a field-error contract.

## 2. Two fields are always empty

`traceId` is never set. No mapper in the tree assigns it, and it could not be populated usefully
anyway: `application.yaml:333-335` sets `quarkus.otel.sdk.disabled: true` under `%prod` and
`:312-313` sets `quarkus.otel.enabled: false` under `%dev`, so no span id exists in either
environment Karyo runs in ([ADR 0025](../architecture/decisions/0025-metrics-exposed-tracing-off-by-default.md)).
The field is on the wire as `null` in every response.

`instance` is set by fifteen of the sixteen mappers. `ConstraintViolationExceptionMapper` is the
exception - it constructs `ProblemDetail` with no `instance`
(`ConstraintViolationExceptionMapper.kt:14-19`), so a bean-validation 400 is the one error body that
does not say which path produced it. It is also the error class most likely to arrive in bulk while
an integration is being built.

## 3. The `type` URI is a slug namespace with collisions

The `type` field is what RFC 7807 intends a client to key on. In Karyo it is
`https://karyo.com/errors/` plus a per-module slug, and the slugs are not module-qualified, so the
same URI is produced by unrelated hierarchies:

| Slug | Produced by |
|---|---|
| `validation-failed` | `ConstraintViolationExceptionMapper.kt:15` (400), `InventoryExceptionMapper.kt:22` (400), `OrderExceptionMapper.kt:25` (400), `TaskExceptionMapper.kt:20` (400), `ProductExceptionMapper.kt:25` (400) |
| `not-found` | `InventoryExceptionMapper.kt:17`, `OrderExceptionMapper.kt:19`, `TaskExceptionMapper.kt:17` - all 404 |
| `duplicate-name` | `InventoryExceptionMapper.kt:24`, `OrderExceptionMapper.kt:21`, `LayoutExceptionMapper.kt:18` - all 409 |
| `has-dependents` | `InventoryExceptionMapper.kt:23`, `LayoutExceptionMapper.kt:25` - both 409 |
| `not-cancelable` | `OrderExceptionMapper.kt:29`, `TaskExceptionMapper.kt:22` - both 409 |
| `document-not-ready` | `OrderExceptionMapper.kt:38`, `FulfillmentExceptionMapper.kt:24` - both 409 |
| `invalid-state-transition` | `InventoryExceptionMapper.kt:20` (409), `OrderExceptionMapper.kt:22` (409), `TaskExceptionMapper.kt:19` (409), **`ProductExceptionMapper.kt:21` (422)** |
| `invalid-reference` | `OrderExceptionMapper.kt:20` (404), `TaskExceptionMapper.kt:18` (404), **`LayoutExceptionMapper.kt:21` (422)** |

The last two rows are the ones that break. `https://karyo.com/errors/invalid-state-transition`
carries HTTP 409 from three modules and HTTP 422 from the fourth, and
`https://karyo.com/errors/invalid-reference` carries 404 from two and 422 from the third. A client
that maps the problem type to a retry or user-facing decision, which is the whole purpose of the
field, cannot also assume a status from it.

Elsewhere the same idea is spelled with a module prefix - `pick-not-found`, `product-not-found`,
`layout-not-found`, `count-not-found`, `document-not-found`, `user-not-found` and
`client-not-found` all exist alongside the bare `not-found` - so the namespace is inconsistent about
qualification as well as colliding.

## 4. The response is `application/json`, not `application/problem+json`

Every mapper returns `Response.status(...).entity(problem).build()` with no `.type(...)` call, so
the media type comes from the resource's class-level `@Produces(MediaType.APPLICATION_JSON)`.
RFC 7807 defines `application/problem+json` for exactly this body, and the string `problem+json`
occurs nowhere in the backend. A client that content-negotiates or dispatches on the problem media
type will not see it.

The front end's own unit tests assume the opposite: they stub error responses with
`Content-Type: application/problem+json`
(`frontend/web/src/lib/__tests__/api-client.test.ts:65`, `:137`, `:157`), a content type the
backend never sends.

## 5. Twenty refusals bypass the contract entirely

There is no `ExceptionMapper<Exception>` or `ExceptionMapper<Throwable>` anywhere. Anything not
matching one of the registered hierarchies is handled by RESTEasy's defaults.

Twenty main-source sites throw a bare JAX-RS exception with a message and no entity:

| Module | Sites |
|---|---|
| `karyo-webhooks-core` | 9 - `WebhookSubscriptionService.kt:29,30,58,71,81,88`, `WebhookDeliveryService.kt:18,26`, `WebhookUrlValidator.kt:20` |
| `karyo-work-core` | 5 - `WorkInboxResource.kt:30,35,49,58,96` |
| `karyo-reporting-core` | 3 - `KpiResource.kt:28`, `VolumeResource.kt:29`, `ReportDefinitionService.kt:32` |
| `karyo-fulfillment-core` | 2 - `PickOrderResource.kt:228`, `ExtinguishService.kt:150` |
| `karyo-demo` | 1 - `DemoResource.kt:37` |

(`SystemPropertyResource.kt:107,123` also throw `WebApplicationException`, but each wraps a
`Response` already carrying a `ProblemDetail`, so those two stay on the contract.)

What such a throw produces is recorded inside the codebase itself, in the comment that motivated the
one place it was fixed. `WebhookSubscriptionResource.kt:49-55` explains that the client-0 refusal is
returned as an explicit `ProblemDetail` rather than a `BadRequestException` because "a bare
`BadRequestException` falls through to RESTEasy's default (non-JSON) error body, which the
frontend's `ApiError` parsing can't read, surfacing only a generic 'Server returned 400' toast
instead of this message."

That fix covers one refusal in `WebhookSubscriptionResource`. The nine other refusals in the same
module - including `WebhookUrlValidator.kt:20`, which is the SSRF rejection an integrator
registering a receiver is most likely to hit, and every `subscription $id`/`delivery $id` not-found -
still take the raw path the comment describes as unreadable.

A second class of bypass comes from the other direction: an unmapped `OptimisticLockException` on a
concurrent reservation reaches the client as a 500 where the API otherwise models a shortage as an
ordinary outcome (see [Allocation and reservation](../functional/allocation-and-reservation.md)).

Refusals produced before any resource runs carry their own bodies too - an authentication failure
from the OIDC layer, or nginx's own 404 for `/api/internal/`
(`infrastructure/docker/nginx/nginx.conf:100-102`). Those are outside the application's mappers by
construction. The twenty sites above are not: they are the application's own refusals, on the
application's own routes.

## 6. What a client can actually rely on

| Rely on | Do not rely on |
|---|---|
| HTTP status | `type` implying a status, or being module-unique |
| `type`, `title`, `detail`, `timestamp` present on any mapped error | `traceId` (always null), `instance` (absent on validation 400s) |
| The status families the mappers use, with the exceptions in §3: 400 malformed input, 403 a scope, principal-kind or licence refusal, 404 a missing row, 409 a state or concurrency conflict, 413 an oversized document, 422 a well-formed request the domain refuses, 502 or 503 a failing dependency (the Keycloak admin API, a label printer) | A structured field-error list; `detail` is prose |
| A JSON body on any mapped error | A JSON body on the twenty sites in §5 |
| | `application/problem+json` as the media type |

## Related

- [The HTTP API surface](http-api-surface.md)
- [Identity for an integrating system](identity-for-an-integrating-system.md) - what a 401 or 403 means
- [ADR 0017](../architecture/decisions/0017-versioned-rest-api-and-error-contract.md) - the decision to version the API and state an error contract
