# Documents and printing

Every artefact Karyo renders for the world outside it: eleven templates, eleven download routes, one
archive, one per-owner override seam, and one printer.

## 1. One renderer, two output families

`libs/karyo-documents` holds the whole rendering stack: `DocumentRenderer` (Qute + openhtmltopdf),
`DocumentStore` (the archive SPI), `DocumentTemplateProvider` (the override SPI) and `CsvWriter`.
Four domain modules render through it - inventory, orders, layout and fulfillment.

`DocumentRenderer` builds its own Qute `Engine` rather than injecting the application's, "so escaping
behaviour does not depend on the app-wide engine config" (`DocumentRenderer.kt:25-35`). Treatment is
keyed on the template path's suffix alone:

- `.html` is parsed with the `TEXT_HTML` variant, so the registered `HtmlEscaper` escapes every
  interpolated value, then converted to PDF by `htmlToPdf`, which installs a no-op `FSUriResolver`
  that blocks **all** sub-resource fetches - the templates use inline CSS and reference no external
  images or fonts, so refusing every URI neutralises SSRF from injected markup
  (`DocumentRenderer.kt:84-100`).
- `.zpl` is parsed as text and its bindings pre-sanitised: `^` and `~`, ZPL's two control characters,
  are stripped from string values and from one level of nested map values
  (`DocumentRenderer.kt:102-118`). The KDoc is explicit that `List` values are **not** descended
  into, and that a future ZPL template binding a list of strings must sanitise them itself.

Because the treatment is keyed on the path suffix, an override template returned by a provider gets
exactly the same escaping and sanitisation as the bundled one it replaces - the KDoc states the
reasoning: "an uploaded template is trusted-by-role code, not trusted to skip the injection
defenses" (`DocumentRenderer.kt:47-53`).

## 2. Eleven templates, eleven routes

| Template | Route | Media type | Role |
|---|---|---|---|
| `pick-ticket.html` | `GET /api/v1/pick-orders/{id}/pick-ticket.pdf` | `application/pdf` | `fulfillment-read` |
| `bol.html` | `GET /api/v1/shipments/{id}/bol.pdf` | `application/pdf` | `fulfillment-read` |
| `packing-slip.html` | `GET /api/v1/shipments/{id}/packing-slip.pdf` | `application/pdf` | `fulfillment-read` |
| `packet-list.html` | `GET /api/v1/shipments/{id}/packet-list.pdf` | `application/pdf` | `fulfillment-read` |
| `packet-content-list.html` | `GET /api/v1/shipping-units/{id}/content-list.pdf` | `application/pdf` | `fulfillment-read` |
| `label.zpl` | `GET /api/v1/shipping-units/{id}/label.zpl` | `text/plain` | `fulfillment-read` |
| `ul-content-list.html` | `GET /api/v1/unit-loads/{id}/content-list.pdf` | `application/pdf` | `inventory-read` |
| `ul-label.zpl` | `GET /api/v1/unit-loads/{id}/label.zpl` | `text/plain` | `inventory-read` |
| `ul-advice-label.zpl` | `GET /api/v1/asns/{id}/ul-labels.zpl` | `text/plain` | `order-read` |
| `delivery-note.html` | `GET /api/v1/delivery-orders/{id}/delivery-note.pdf` | `application/pdf` | `order-read` |
| `location-label.zpl` | `GET /api/v1/locations/{id}/label.zpl` | `text/plain` | `layout-read` |

Four of the five shipping documents are gated on shipment state through
`DocumentAvailabilityStrategy` and answer 409 `document-not-ready` before it
(`ShipmentDocumentResource.kt:13-19`); the packet content list is the exception and carries no gate.
The delivery note is gated on the order reaching PICKED (`DeliveryOrderResource.kt:140-141`). The
pick ticket carries no gate at all.

Every route takes `?store=true`, an opt-in that archives the rendered bytes through
`Instance<DocumentStore>` and is a no-op when the docstore module is not on the classpath.

## 3. The archive is write-through only

`karyo-docstore-core` implements `DocumentStore` and exposes three routes:
`GET /api/v1/documents` (paginated), `GET /api/v1/documents/{id}/content` and
`DELETE /api/v1/documents/{id}` (`DocumentResource.kt:31-59`). Reading takes any of the five
composite roles and deleting takes `MANAGER` or `ADMIN` (`DocumentResource.kt:33`, `:44`, `:55`).
There is **no upload route** - the only way a document enters the archive is `?store=true` on one of
the eleven render routes. The 10 MB `MAX_CONTENT_BYTES` guard (`DocumentStoreService.kt:139`)
therefore protects an internal caller, not a request body.

Owner scoping is careful and worth recording, because it is the case most likely to be got wrong:
a stored document's owner is the **subject entity's** owner, never the acting principal's, so an OPS
principal storing on another owner's behalf writes a row belonging to that other owner
(`DocumentStoreService.kt:21-31`). `store` refuses an out-of-scope owner outright with
403 (`:52-54`); `findForRead` and `deleteById` answer 404 rather than 403 for an out-of-scope row,
because "a 403 would confirm the row exists to a principal not entitled to know that"
(`:110-112`, `:119`).

`DocumentStoreService.list` is the only endpoint in the application that clamps page size, to 200,
and its companion KDoc explains why it does so locally rather than in the shared `PaginationParams`
(`:141-149`).

Filenames are always generated as `{documentType}-{numericId}.{ext}` at the call sites
(`UnitLoadDocumentService.kt:75`, `AsnDocumentService.kt:54`, `OrderDocumentService.kt:47`,
`LocationDocumentService.kt:37`, `PickDocumentService.kt:50`, `ShipmentDocumentService.kt:394`), so
the `Content-Disposition` header `DocumentResource.kt:49` builds carries no caller-supplied text.

## 4. The override seam belongs to a commercial engine

`DocumentTemplateProvider` is a first-non-null seam consulted by `DocumentRenderer.render` before the
bundled classpath template, resolved through `Instance<>` so `libs/karyo-documents` has no
compile-time dependency on whoever implements it (`DocumentTemplateProvider.kt:3-13`). Its contract
is precise about the null case: `ownerClientId == null` means "no owner context" and **must** resolve
to no override, never to some other client's template.

No implementation of it is in this repository. Per-owner template overrides are one of the
commercial engines, licensed under the `documents` entitlement key. The console's template
administration page checks that entitlement before it queries anything and shows a locked panel
without it (`frontend/web/src/pages/admin/admin-templates-page.tsx:271-276`), and
`tests/e2e/tests/admin-document-templates-locked.spec.ts` exercises that locked state. In a free
installation every document renders from its bundled template. Whatever a provider returns, the
renderer applies the escaping and ZPL sanitisation of §1 to it. See
[Gating and degradation](../commercial/gating-and-degradation.md) for how the gate behaves.

## 5. The shipper address on every bill of lading is a demo placeholder

`bol.html:5` renders a "Ship From" block from `shipFrom.name`, `.street`, `.city`, `.zipCode`,
`.country`, bound at `ShipmentDocumentService.kt:313-318` from `ShipFromConfig`. That
`@ConfigMapping(prefix = "karyo.shipping.ship-from")` interface declares its own `@WithDefault`s -
`Karyo Demo Warehouse`, `1 Logistics Way`, `Distribution City`, `00000`, `US`
(`ShipFromConfig.kt:8-12`) - and `application.yaml:259-265` restates the same five literals.

**Known defect.** Unlike almost every other `karyo.*` leaf, these five carry no `${ENV:default}`
indirection, appear in no environment template, and are not `system_properties` catalogue keys. A
real installation prints that address on every bill of lading until an operator discovers the five
variable names by reading the source. See
[Strategies and runtime configuration §5](strategies-and-runtime-configuration.md#5-about-forty-environment-knobs-one-of-them-in-the-operators-template).

## 6. One printer, one printable document

`LabelPrintService` pushes raw ZPL to a TCP socket, port 9100 by default, with a 3-second connect
timeout and no spool (`LabelPrintService.kt:36-54`). Its KDoc gives the reason for failing fast
rather than queueing: "a floor operator standing at the printer needs the error now; a spooler
printing queued labels later creates mislabeling risk" (`:9-15`). Its two failure modes map to RFC
7807 through dedicated mappers - 503 `no-printer-configured` and 502 `printer-unreachable`
(`LabelPrintExceptionMapper.kt:18`, `:35`).

The target is `karyo.print.url`, a single instance-wide value with the `"none"` sentinel. The KDoc
states one printer per instance and names `printTo` as the seam a future per-request printer
registry would call into (`LabelPrintService.kt:30-35`). In a silo serving several goods owners from
several pack stations, every printed label goes to that one device.

`printTo` accepts an arbitrary `host:port` and is deliberately not reachable from REST - the only
caller is `UnitLoadResource.kt:82`, which passes the configured URL. It is public for tests and for
that future registry.

That single caller is also the only print endpoint in the API:
`POST /api/v1/unit-loads/{id}/label/print` (`UnitLoadResource.kt:77-84`,
`@RolesAllowed("inventory-write")`). The other three ZPL documents - the shipping-unit carton label,
the ASN advice labels and the location label - can only be **downloaded**. An integrator or a floor
station wanting those on a printer has to fetch the ZPL and push it themselves, and a downloaded
label is no proof that a printer received it. The
[implementer guide](../guides/implementer-guide.md#operate-and-integrate) covers printers as part of
operating an installation.

## Related

- [The HTTP API surface §6](http-api-surface.md#6-media-types-and-downloads) - media types and extension-in-path
- [Strategies and runtime configuration](strategies-and-runtime-configuration.md) - where `karyo.print.url` and the ship-from block sit
- [The commercial boundary](../architecture/commercial-boundary.md) - the `documents` entitlement and where it is checked
