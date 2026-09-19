# The HTTP API surface

What an integrating system actually calls, and what shape it can rely on. Derived from the 47
JAX-RS resource classes in the free build - the `api/v1` packages of every module, plus
`libs/karyo-license/.../LicenseResource.kt` and
`services/karyo-app/.../admin/AdminExtensionsResource.kt`. The commercial engines add resources of
their own under the same prefix when they are installed; the counts below are for the free build.

## 1. One version, one prefix, one process

Every resource in the tree declares a path under `/api/v1`. There are 42 distinct class-level
`@Path` values and no other prefix anywhere: no `/api/v2`, no `/api/mobile`, no `/api/internal`
resource. nginx additionally answers 404 for anything under `/api/internal/`
(`infrastructure/docker/nginx/nginx.conf:123-125`), so no such route is reachable through the proxy
even if one were added.

Across those resources there are 252 annotated methods: 97 `@GET`, 106 `@POST`, 26 `@DELETE`,
22 `@PUT` and 1 `@PATCH`.

Both front ends and any integrating system call the same surface. There is no separate mobile API
and no backend-for-frontend layer.

Paths are kebab-case plural nouns (`/stock-units`, `/delivery-orders`, `/webhook-subscriptions`);
JSON fields are camelCase. Domain actions are POST subpaths (`/delivery-orders/{id}/release`,
`/webhook-deliveries/{id}/redeliver`). Six resources declare only `@Path("/api/v1")` at class level
and carry the full path on each method - `PickOrderResource`, `ShipmentResource`,
`PickDocumentResource`, `ShipmentDocumentResource`, `StocktakingResource`, `HealthResource` - so a
reader cannot infer a resource's routes from its class annotation alone.

## 2. There is no machine-readable description of any of it

No module declares the SmallRye OpenAPI extension. `gradle/libs.versions.toml` has no OpenAPI
coordinate, `services/karyo-app/build.gradle.kts:80-108` lists the assembled Quarkus extension union
and OpenAPI is not in it, and the whole source tree contains **zero** imports of
`org.eclipse.microprofile.openapi`. `/q/openapi` and `/q/swagger-ui` do not exist, and nginx would
not proxy them if they did: only `/q/health` is exposed (`nginx.conf:134-137`).

This is the single most consequential property of this surface for an integrator: the contract is
the Kotlin source, and nothing else. It also sits uneasily with the rest of the product, which ships
an `INTEGRATOR` role and a webhook hub addressed to exactly the caller that would need a published
description.

The one machine-checked contract that does exist is Pact, and it covers only what the desktop
console uses: four consumer suites under `frontend/web/src/test/pact/` (inventory, location,
product, user) against four provider tests under `services/karyo-app/src/test/kotlin/**/pact/`
(auth, inventory, layout, product), verified on every change by CI's `pact-verify` job
([contract testing](../architecture/testing.md#contract-testing)). Nothing else on the surface has a
contract artefact.

## 3. Pagination is opt-in per resource

`libs/karyo-common/.../pagination/PaginationParams.kt` is a `@BeanParam` carrying `page`
(default 0), `size` (default 20) and a repeatable `sort`. `PaginatedResponse` wraps results as
`{ content: [...], page: { number, size, totalElements, totalPages } }`.

Fourteen resource classes return it. Twenty-seven list methods, across twenty-three resource
classes, return a bare `List<T>` with no envelope, no total and no page: among them
`/api/v1/journals`, `/api/v1/unit-loads`, `/api/v1/webhook-subscriptions`,
`/api/v1/replenishment` (needs), `/api/v1/report-definitions`, `/api/v1/work/mine` and
`/api/v1/order-strategies`. A client cannot tell from the URL shape which kind it will get.

`PaginationParams` enforces no maximum `size`. Exactly one endpoint clamps it:
`DocumentStoreService.list` coerces to 200 and its companion KDoc explains why it clamps locally
rather than in the shared class (`DocumentStoreService.kt:99`, `:141-149`). The three CSV exports
substitute their own bound for a different purpose - see §5.

`SortParser.parse` (`libs/karyo-common/.../pagination/SortParser.kt:12-32`) validates each
`field,direction` pair against a per-resource allowlist and **silently drops** anything not on it,
falling back to the resource's default sort when nothing survives. A caller who misspells a sort
field gets a successful 200 in a different order than it asked for, with no signal.

## 4. Filters are declared per resource; there is no query language

Each resource declares its own `@QueryParam` set. There is no generic operator suffix, no
`field.gt`/`field.like`/`field.in`, and no cursor pagination anywhere in the tree. An unrecognised
query parameter is simply ignored by JAX-RS, so a wrong filter name silently widens the result set
rather than failing.

## 5. CSV export is a separate, capped surface

Three endpoints emit `text/csv` rather than JSON: GET /api/v1/stock-units/export.csv
(`StockUnitResource.kt:86-111`), GET /api/v1/delivery-orders/export.csv
(`DeliveryOrderResource.kt:54-69`) and GET /api/v1/pick-orders/export.csv
(`PickOrderResource.kt:107-121`). All three route through
`libs/karyo-documents/.../CsvWriter.kt`, which is RFC 4180 with a UTF-8 BOM, CRLF line endings and
OWASP formula-injection escaping on every field (`CsvWriter.kt:105-109`) - a leading `=`, `+`, `-`,
`@`, tab or CR is apostrophe-prefixed unless the whole field is a plain decimal.

All three share one row cap, `CsvWriter.EXPORT_MAX_ROWS = 10_000` (`CsvWriter.kt:58`).

**Known defect.** When the true total exceeds the cap, `write` appends a literal line
`# truncated at 10000 rows` to the body (`CsvWriter.kt:89-91`). That comment line is the **only**
signal of truncation: the status is 200, there is no header, and the endpoints accept no page or
offset parameter, so there is no way to retrieve rows beyond the first ten thousand. It is honest
to a person reading the file and invisible to a program consuming it.

## 6. Media types and downloads

Ordinary resources declare `@Produces(MediaType.APPLICATION_JSON)`. Document downloads declare their
own: `application/pdf` for the PDF routes, `text/plain` for the ZPL routes, `text/csv` for the three
exports. Format is carried by a **file extension in the path**
(`/shipments/{id}/bol.pdf`, `/shipping-units/{id}/label.zpl`, the CSV exports above), not by
content negotiation; there is no `Accept`-driven variant anywhere.

`StockUnitResource.kt:80-85` records the practical consequence of that choice: a literal segment
such as the CSV export's must be declared before the `/{id}` template, or JAX-RS captures it as an
id and the `Long` conversion fails.

## 7. PATCH exists; the partial-update type is used somewhere else

`libs/karyo-common/.../patch/Patchable.kt` is the tri-state wrapper (absent / null / value) that
makes a partial update expressible, registered as a Jackson module by
`services/karyo-app/.../config/JacksonConfig.kt`. Three DTOs use it:
`UpdateProductRequest`, `UpdateDeliveryOrderRequest` and `UpdateOrderStrategyRequest`.

All three are consumed by `@PUT` methods (`ProductResource.kt:46-49`,
`DeliveryOrderResource.kt:85-88`, `OrderStrategyResource.kt:46-49`). The only `@PATCH` method in the
free build - `WebhookSubscriptionResource.kt:90` - takes a plain nullable-field DTO instead. So the
verb that means "partial" and the type that expresses "partial" do not meet anywhere in the API, and
nothing records why.

## 8. What the surface does not have

None of the following exists anywhere in the application or its proxy, and an integrator should not
plan around any of them:

| Absent | Evidence |
|---|---|
| OpenAPI / Swagger UI | §2 |
| CORS headers | `nginx.conf` sets none; `application.yaml` configures no `quarkus.http.cors`. A browser client on another origin cannot call the API |
| Rate limiting or quota | No `limit_req`/`limit_conn` in `nginx.conf`; no fault-tolerance rate limiter on any resource |
| Idempotency keys, ETag / `If-Match` | No `@HeaderParam` exists anywhere in the main source tree - the single request header read is `X-Correlation-Id`, in `TenantFilter.kt:51` |
| Deprecation / `Sunset` headers | No resource or filter emits either |
| HATEOAS links | No `_links` in any DTO |
| Bulk import, file upload, EDI | The free build has no upload route at all (the only body-bearing upload belongs to a commercial engine, see [Documents and printing](documents-and-printing.md)); the integration hub's build-file comment lists import/export and ERP adapters as not yet built (`settings.gradle.kts:81`) |
| TLS at the application edge | `nginx.conf:112` is `listen 80`. TLS in front of the stack is the operator's; see [Deploying](../operations/deploying.md) |

The single body-size limit that does apply to every request is nginx's `client_max_body_size 10m`
(`nginx.conf:19`).

## Related

- [The error contract](api-error-contract.md) - what a failure looks like on the wire
- [Identity for an integrating system](identity-for-an-integrating-system.md) - how a caller authenticates at all
- [Webhooks and the event catalogue](webhooks-and-the-event-catalogue.md) - the push half of the surface
- [ADR 0017](../architecture/decisions/0017-versioned-rest-api-and-error-contract.md) - why the surface is versioned at `/api/v1`
