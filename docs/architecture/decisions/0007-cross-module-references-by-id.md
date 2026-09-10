# ADR 0007: Modules refer to each other's rows by id, never by foreign key

**Status:** Accepted

## Context

Every module's tables share one schema ([ADR 0004](0004-one-postgresql-database-and-schema.md)),
so the database would accept a foreign key from any table to any other. A foreign key between two
modules' tables ties their schemas together: neither module could change, rebuild or drop its own
table without the other, deletes would cascade or fail across the boundary, and extracting either
module would become a data migration.

## Decision

- A column that refers to another module's row is a plain `BIGINT` id with no foreign key. Foreign
  keys exist only between tables of the same module. `goods_receipt_lines` references its own
  `goods_receipts` with a foreign key, and stock units, unit loads and locations by bare id
  (`V409__create_goods_receipt_lines.sql:1-2,8`); `unit_loads` references its own
  `unit_load_types` with a foreign key and holds `storage_location_id` bare
  (`V102__create_unit_loads.sql:9-10`).
- Migrations say so where they add such a column, for example
  `V418__add_gr_line_serial_and_packaging.sql:4-5`, `V425__gr_line_storage_strategy.sql:1-3`,
  `V427__delivery_order_destination_operator_sender.sql:5`, `V609__pick_order_destination.sql:6-8`
  and `V1500__create_stream_batches.sql:2`. A scan of every migration finds no foreign key from one
  module's table to another's.
- The owning module answers questions about its rows through a lookup SPI in its `-api`:
  `ProductLookup` (`ProductLookup.kt:10`), `StockUnitLookup` (`StockUnitLookup.kt:12`) and the other
  lookup interfaces ([ADR 0006](0006-api-and-core-modules.md)).
- A module that must not remove rows other modules still use asks them through an SPI it declares.
  Before stock units and unit loads are purged, `PurgeBlockerLookup` is answered by fulfillment,
  orders, stocktaking and tasks for their own live references (`PurgeBlockerLookup.kt:3-27`).

## Consequences

- A module's schema changes stay inside the module, and the id-only references are the seams an
  extraction would need.
- References to rows that are removed on purpose become tombstones by design: journal rows,
  finished picks, receipt lines and closed count lines keep the ids of rows that no longer exist
  (`PurgeBlockerLookup.kt:16-18`).
- **The database does not protect integrity across modules; the application has to, and does not
  everywhere.** Known defects:
  - Deleting a storage location asks nothing about what refers to it (`LocationService.kt:364-370`).
    With stock on it the delete succeeds and leaves unit loads pointing at a location that no longer
    exists, because `storage_location_id` has no foreign key (`V102__create_unit_loads.sql:10`).
    With a fix assignment on it, the same-module foreign key fails the delete with an unmapped
    constraint violation, an HTTP 500 (`V307__create_fix_assignments.sql:7`). A live putaway
    reservation on it is removed silently by a cascade (`V308__create_location_reservations.sql:6`).
  - The referential guards that do exist see only their own module. Deleting a unit-load type checks
    unit loads, which inventory owns, and cannot see the products and layout rules that name the type
    (`UnitLoadTypeService.kt:26-36`).
  - Some writes accept another module's id without asking its owner. A product's default unit-load
    type, default storage strategy and zone are stored unvalidated (`ProductService.kt:107-109,183`).

## Alternatives considered

- **Foreign keys across module tables.** Rejected: they would bind the modules' schemas to each
  other and turn any later extraction into a data migration. Keeping references as ids is what
  keeps a module extractable.

## Evidence

- `services/karyo-app/src/main/resources/db/migration/orders/V409__create_goods_receipt_lines.sql:1-8` -
  a same-module foreign key beside cross-module ids
- `services/karyo-app/src/main/resources/db/migration/inventory/V102__create_unit_loads.sql:9-10` -
  the same split on `unit_loads`
- `services/product-service/karyo-product-api/src/main/kotlin/com/karyo/product/spi/ProductLookup.kt:10`,
  `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/spi/StockUnitLookup.kt:12` -
  lookup SPIs
- `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/spi/PurgeBlockerLookup.kt:3-29` -
  asking other modules before a delete
- `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/service/LocationService.kt:364-370` -
  the unguarded delete
- [Data and persistence](../data-and-persistence.md),
  [Warehouse layout configuration](../../configuration/warehouse-layout-configuration.md)

## Related

- [ADR 0004](0004-one-postgresql-database-and-schema.md) - the shared schema that makes this a rule rather than a necessity
- [ADR 0006](0006-api-and-core-modules.md) - the lookup SPIs live in `-api` modules
- [ADR 0011](0011-reporting-reads-the-database-directly.md) - the one place that reads another module's tables directly
