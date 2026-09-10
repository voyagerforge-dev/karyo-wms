# ADR 0017: The external API is versioned REST under `/api/v1`, with an RFC 7807 error body

**Status:** Accepted

## Context

Karyo's HTTP API is called by its two front ends and by integrating systems. Internal calls between
modules never use it: they are in-process injections and events
([ADR 0008](0008-synchronous-rest-and-cdi-events.md)), so the REST surface is purely the external
contract.

The warehouse domain has well-defined views - a stock list, an order and its lines, a pick list, a
receipt - rather than ad-hoc client-driven queries. Clients need to know what a successful response
looks like, how a failure is reported, and what may change without warning.

## Decision

- **One version, one prefix.** Every resource is under `/api/v1`, JSON over HTTP. Resource paths are
  kebab-case plural nouns (`/stock-units`, `/delivery-orders`); JSON fields are camelCase; domain
  actions are POST subpaths (`/delivery-orders/{id}/release`).
- **Versioning is URL-major and additive within a version.** New fields are optional or defaulted,
  consumers tolerate unknown fields and enum values, and removing or changing a required field needs
  an explicit compatibility decision. There is no deprecation-header mechanism.
- **Errors are RFC 7807 problem details.** Mapped failures return a `ProblemDetail` body - `type`,
  `title`, `status`, `detail`, `instance`, `traceId`, `timestamp` - built by one exception mapper per
  module hierarchy, with `type` of the form `https://karyo.com/errors/<slug>`. The HTTP status is the
  signal a client can always rely on.
- **Pagination, where a resource offers it,** uses `PaginationParams` (`page` from 0, `size`
  defaulting to 20, repeatable `sort`) and returns a `PaginatedResponse` envelope. Sort fields are
  checked against a per-resource allowlist.
- **Downloads carry their format in the path** (`.csv`, `.pdf`, `.zpl`), not through content
  negotiation.
- **No hypermedia.** Clients know their routes; there are no `_links`.
- **The contract is the source.** The JAX-RS resources and the `-api` DTOs are the definition; no
  OpenAPI document is generated.
- `/api/internal/` is refused at the proxy.

## Consequences

The contract as implemented has gaps a client must know about. Each is current behaviour:

- **Some refusals bypass the error body.** A set of refusals in the webhook, work, reporting,
  fulfillment and demo modules throw bare JAX-RS exceptions, which produce the framework's default
  non-JSON body. The front end cannot read those and shows a generic "Server returned 400".
- **There is no catch-all mapper.** An exception no mapper covers - for example an optimistic-lock
  failure when two reservations race for the last units - reaches the client as a 500, where the API
  models a shortage as an ordinary outcome.
- **`type` slugs are not module-qualified and collide.** `not-found`, `validation-failed` and
  `duplicate-name` come from several modules; `invalid-state-transition` is 409 from three modules
  and 422 from product. A client cannot infer the status from the type.
- **The media type is `application/json`,** not `application/problem+json`.
- **`traceId` is always null** because tracing is disabled ([ADR 0025](0025-metrics-exposed-tracing-off-by-default.md)),
  and bean-validation 400s omit `instance`. Their `detail` is prose joined from property paths and
  messages, not a structured field list.
- **Pagination is opt-in per resource.** Many collections return a bare array with no total, and no
  maximum `size` is enforced. A misspelled sort field is dropped silently and the default order
  applies. Why some resources paginate and others do not is not recorded.
- **CSV exports stop at 10,000 rows** and say so only in a trailing `# truncated at 10000 rows` line,
  with status 200 and no way to fetch the rest.
- **Unknown query parameters are ignored,** so a misspelled filter widens the result instead of
  failing.
- **The `X-Correlation-Id` header is accepted into the log context only** and never reaches a journal
  row ([ADR 0010](0010-crud-with-an-inventory-journal.md)).
- **There is no machine-readable contract, no rate limiting, no CORS, and no idempotency keys or
  entity tags.** Why there is no OpenAPI document, why there is no rate limiting, and why downloads
  select their format by path extension rather than by `Accept` are not recorded.

## Alternatives considered

- **GraphQL.** Rejected. The domain's views are well defined, and a resolver layer, the N+1 loading
  problem and field-level authorisation are costs a set of targeted REST resources does not have.
- **gRPC.** Rejected. A binary protocol needs a proxy for browser clients and is harder to inspect,
  and at Karyo's call volumes the latency advantage over JSON is negligible.
- **Hypermedia (HATEOAS).** Rejected. The two front ends know their routes, and integrators use REST
  plus webhooks, not discovered links.
- **Header or media-type versioning.** Not recorded as considered.

## Evidence

- `libs/karyo-common/src/main/kotlin/com/karyo/common/exception/ProblemDetail.kt:5-18` - the one error body
- `libs/karyo-common/src/main/kotlin/com/karyo/common/exception/ConstraintViolationExceptionMapper.kt:8-20` - validation failures flattened to prose, with no `instance`
- `services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/exception/InventoryExceptionMapper.kt:20,32` and `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/exception/ProductExceptionMapper.kt:21,28` - the same slug with two statuses
- `services/integration-hub-service/karyo-webhooks-core/src/main/kotlin/com/karyo/webhooks/api/v1/WebhookSubscriptionResource.kt:49-55` - why a bare exception breaks the front end, recorded where one refusal was fixed
- `libs/karyo-common/src/main/kotlin/com/karyo/common/pagination/PaginationParams.kt:14-23` and `libs/karyo-common/src/main/kotlin/com/karyo/common/pagination/SortParser.kt:12` - pagination parameters and sort parsing
- `libs/karyo-documents/src/main/kotlin/com/karyo/documents/CsvWriter.kt:58,90` - the export cap and its truncation line
- `services/karyo-app/src/main/resources/application.yaml:312-313,333-335` - tracing disabled in development and production
- `infrastructure/docker/nginx/nginx.conf:100-102` - `/api/internal/` refused

## Related

- [ADR 0008](0008-synchronous-rest-and-cdi-events.md) - REST outside the process, events inside it
- [ADR 0016](0016-two-frontends-same-origin.md) - the same-origin clients of this API
- [HTTP API surface](../../integration/http-api-surface.md) - the surface in full
- [API error contract](../../integration/api-error-contract.md) - what a failure looks like on the wire
- [Webhooks and the event catalogue](../../integration/webhooks-and-the-event-catalogue.md) - the push half of the contract
