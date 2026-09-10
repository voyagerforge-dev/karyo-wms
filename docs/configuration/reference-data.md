# Reference data

Reference data is the material an administrator sets up once and then names from everywhere
else: units of measure, unit load types, products, number ranges, document templates. This
document covers what an installation starts with, who may change it, and the parts of it that
have no administration surface at all.

## What a fresh installation has

Three migrations seed reference data, and all three are idempotent. A fourth, the clients seed,
is not, and is covered in [goods owners and clients](goods-owners-and-clients.md).

**Units of measure** - six rows, created with the table
(`services/karyo-app/src/main/resources/db/migration/product/V201__create_item_units.sql`):
`PCS` (PIECE), `KG` (WEIGHT), `L` (VOLUME), `M` (LENGTH), `BOX` (PIECE), `PAL` (PIECE).

**Unit load types** - four rows, each with a usage list
(`db/migration/inventory/V105__seed_unit_load_types.sql`):

| Name | Usages | Aggregates stocks |
|---|---|---|
| Euro Pallet | FORKLIFT, STORAGE, COMPLETE | no |
| Pick Bin | PICKING | yes |
| Shipping Carton | SHIPPING, PACKING | yes |
| Virtual | PICKING, STORAGE | yes |

**The DEFAULT order strategy** - one row
(`db/migration/orders/V405__seed_default_order_strategy.sql`).

All three use `ON CONFLICT ... DO NOTHING`, so they are idempotent and safe against a database
that already carries the rows. That is the correct shape for seeded reference data, and it is
worth noting because the clients seed in the same Flyway run does neither.

There is no seeded storage strategy, no seeded location type, no seeded zone or area, and no
seeded number range. A commissioning administrator builds all of those.

## Products are configuration as much as data

`ItemData` is where per-product policy lives, and several fields are pure configuration rather
than description
(`services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/domain/model/ItemData.kt`):

- `lotMandatory`, `bestBeforeMandatory`, `shelflife`, `serialNoRecordType` - capture rules
  enforced at receiving (`ItemData.kt:43-53`)
- `defaultUnitLoadTypeId` - the container a receipt defaults to (`ItemData.kt:55-56`)
- `defaultStorageStrategyId` - the putaway policy, described as "Per-product preferred putaway
  StorageStrategy (ID-only cross-module reference)" (`ItemData.kt:58-64`)
- `defaultPackagingUnitId` - with a stated invariant: when non-null it must reference a
  packaging unit belonging to this product, enforced in `updateProduct`, and cleared when that
  unit is removed (`ItemData.kt:66-73`)
- `zoneId` - see below

`defaultPackagingUnitId` is the model for how these should behave: the invariant is written
down, enforced at the service, and maintained on removal.

The other three are not. `ProductService.createProduct` validates `itemUnitId` and refuses an
unknown one (`service/ProductService.kt:76-77`), then assigns `defaultUnitLoadTypeId`,
`defaultStorageStrategyId` and `zoneId` with no lookup at all
(`ProductService.kt:107-109`; the update path is the same at `ProductService.kt:183`). Four
cross-module id fields on one entity, one validated. The consequence for
`defaultStorageStrategyId` is traced in
[strategies and policies](strategies-and-policies.md#a-mistyped-strategy-id-is-silent): a typo
produces a silently strategy-less putaway.

### `ItemData.zoneId` steers nothing

**Known defect.** `zoneId` is accepted on create and update, echoed on `ProductResponse`
(`ProductService.kt:441`), and read by nothing. The putaway finder's zone comes from
`request.preferredZoneId ?: strategy?.zone?.id`
(`services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/service/LocationFinderService.kt:230`),
and `preferredZoneId` is only ever supplied by a caller of the find-location API - no internal
putaway path derives it from the product.

An administrator setting a product's zone is doing the most natural thing in the world -
"this SKU lives in the chilled zone" - and getting nothing. The mechanism that would deliver
it, a strategy with a zone, exists one table away.

## Unit load types: instance-wide reference data behind an operational role

`UnitLoadTypeResource` gates reads on `inventory-read` and every write, including delete, on
`inventory-write`
(`services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/api/v1/UnitLoadTypeResource.kt:20,25,29,37,43`).

`inventory-write` is carried by the shipped `OPERATOR` and `RECEIVER` composites. So any
picker or goods-in clerk can create, rename and delete the unit load types that the
`TypeCapacityConstraint` matrix, product defaults and packing behaviour are all built on -
instance-wide reference data, behind the role that lets someone move a pallet.

The delete does guard: it refuses while any unit load references the type
(`service/UnitLoadTypeService.kt:28-36`). That guard is inventory-internal only, and cannot see
`TypeCapacityConstraint.unitLoadTypeId` in the layout module or `ItemData.defaultUnitLoadTypeId`
in the product module, neither of which has a foreign key. Deleting an unreferenced type
therefore silently strands whatever capacity-matrix rows point at it.

The admin surface disagrees with the backend about who this is for. **Admin -> Unit load types**
is listed with `permission: 'user-admin'`
(`frontend/web/src/config/admin-navigation.ts:76`) and sits behind the `user-admin` route guard,
while the page's own write controls check `inventory-write`
(`frontend/web/src/pages/admin/admin-unit-load-types-page.tsx:39-40`) and the backend enforces
`inventory-write`. A pure `user-admin` administrator sees the page and cannot write; an operator
holds the authority and never sees the entry.

## Number ranges have no administration surface at all

`sequence_numbers` is a real configuration table: per named sequence it holds `counter`,
`end_counter` (default 9999), `format` (default `%1$04d`) and `check_digit_type`
(`db/migration/common/V2__create_sequence_numbers.sql`). Those four columns are exactly the
knobs a warehouse asks about on day one - how long is a label, what does it look like, does it
carry a check digit.

**Known defect.** There is no REST resource, no admin page and no seed. Rows are created on first
use with the migration defaults, inside the generator
(`libs/karyo-sequence/src/main/kotlin/com/karyo/sequence/generator/FormattedCounterGenerator.kt:12-19,56-60`).
Changing a format or widening a range means an `UPDATE` against the database by hand.

Which generator runs is itself an environment knob, `karyo.sequence.generator`, defaulting to
`TIMESTAMP_RANDOM`
(`libs/karyo-sequence/src/main/kotlin/com/karyo/sequence/SequenceConfig.kt:14-17`). The
`FORMATTED_COUNTER` generator - the only generator the table configures - is therefore off
unless an operator sets the variable and restarts. Selection is strict: an unknown name fails
application boot rather than falling back to another registered generator, and duplicate
generator names fail boot too, "so selection is deterministic"
(`libs/karyo-sequence/src/main/kotlin/com/karyo/sequence/SequenceNumberService.kt:25-48`). That
is the right call and it is documented at the refusal.

Generation is bounded and honest: up to five attempts against a caller-supplied uniqueness
check, `SequenceException.TooLong` immediately if a candidate exceeds the column, and
`SequenceException.Exhausted` if every attempt collides
(`SequenceNumberService.kt:50-67`). The counter wraps to zero at `end_counter`
(`FormattedCounterGenerator.kt:46`).

Put those together for a deployment running `FORMATTED_COUNTER`: `unit_loads.label_id` is
UNIQUE (`db/migration/inventory/V102__create_unit_loads.sql:7`), the default range is 0..9999,
and on wrap the regenerated labels collide with existing rows until the retry budget is spent,
at which point the operation fails cleanly with `Exhausted`. The failure mode is a refusal
rather than corruption, which is the correct behaviour. The problem is the remedy: widening
`end_counter` requires direct database access, because the product ships no way to do it.

## Document templates

Per-client document template overrides are a commercial engine, gated by the `documents`
entitlement; the engine and its REST routes are not in this repository
([commercial engines](../commercial/README.md)). The document archive, by contrast, is free.

The admin sidebar lists both **Documents** (the free archive) and **Document templates**
unconditionally (`frontend/web/src/config/admin-navigation.ts:81-82`). The templates page
checks the licence before anything else and, without the `documents` entitlement, renders only
"the locked/upsell panel, with no client/template queries firing"
(`frontend/web/src/pages/admin/admin-templates-page.tsx:42-48,276-277`). A free installation
therefore shows a configuration entry that leads to a locked panel rather than a setting. That is
at least declared on the page, which the system properties screen does not manage - see
[the configuration boundary](the-configuration-boundary.md#the-entitlement-gate-cuts-across-every-tier).

One piece of reference data has no configuration story at all: the ZPL location-label template
ships as a resource inside the layout module
(`services/warehouse-layout-service/karyo-layout-core/src/main/resources/templates/location-label.zpl`),
not as a document template, so changing a location label's layout is a build-time change while
changing a shipping document's is not. The split is stated here as a fact, not a judgement.

## Related

- [Goods owners and clients](goods-owners-and-clients.md) - the clients seed
- [Warehouse layout configuration](warehouse-layout-configuration.md) - the capacity matrix unit load types feed
- [Strategies and policies](strategies-and-policies.md) - how a product's storage strategy is bound
- [Documents and printing](../integration/documents-and-printing.md) - rendering and the document archive
