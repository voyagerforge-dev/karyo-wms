# Data and persistence

One database, one schema, one Flyway instance: how Karyo stores its state, how the schema is
versioned, and where the module boundary does and does not hold in the data.

Derived from `services/karyo-app/src/main/resources/application.yaml`, the 116 migration files
under `services/karyo-app/src/main/resources/db/migration/`, and
`libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt`.

## One schema, one Flyway instance

All persistence is one PostgreSQL database, schema `karyo`
([ADR 0004](decisions/0004-one-postgresql-database-and-schema.md)). Flyway runs at startup
(`migrate-at-start: true`), creates the schema if absent, and applies 17 registered locations out
of order (`services/karyo-app/src/main/resources/application.yaml:30-40`,
[ADR 0005](decisions/0005-flyway-migrations-at-boot.md)).

Out-of-order is on deliberately, and the config file says why (`:36-39`): modules ship
independently, so `layout V308` can land after `orders V4xx` are already applied to a long-lived
database. Each module's own range stays internally ordered.

**Every migration lives in the aggregator**, not in the module that owns the table. There is one
datasource, one Flyway instance, and `quarkus.flyway.locations` is a single app-owned list. A
directory that is not on that list silently never runs.

## Version bands

Each module owns a numeric band:

| Band | Module | Band | Module |
|---|---|---|---|
| V1-V2 | common | V901 | webhooks |
| V101-V111 | inventory | V1001-V1006 | reporting |
| V201-V207 | product | V1101-V1104 | monitors |
| V301-V318 | layout | V1201-V1203 | auth |
| V401-V431 | orders | V1300 | crossdock |
| V501-V508 | tasks | V1301-V1302 | docstore |
| V601-V613 | fulfillment | V1400-V1402 | wave |
| V701-V704 | stocktaking | V1500 | streaming |
| V801 | work | | |

The table was reconstructed by listing the directories; nothing in the build enforces it.

**crossdock and docstore share the 1300 band.** crossdock holds `V1300`, docstore holds `V1301`
and `V1302`. The next crossdock migration numbered by the obvious convention is `V1301`, which
collides with an applied docstore migration and fails startup on a duplicate version. This is
latent, not live.

## The commercial engines' schema lives here

Four of those directories - `monitors`, `crossdock`, `wave` and `streaming` - hold the schema of
commercial engines whose code is not in this repository. They are on the Flyway locations list
(`application.yaml:40`) like every other directory, so **a free installation creates the
engines' tables and never writes a row into them**:

| Band | Directory | Tables |
|---|---|---|
| V1101-V1104 | `db/migration/monitors` | `monitor_config`, `alerts`, `alert_deliveries` |
| V1300 | `db/migration/crossdock` | `cross_dock_orders` |
| V1302 | `db/migration/docstore` | `document_templates`, used only by the document-templates engine |
| V1400-V1402 | `db/migration/wave` | `waves`, `wave_selection_rules`, `consolidation_groups`, `consolidation_lines`, `sort_scans` |
| V1500 | `db/migration/streaming` | `stream_batches` |

The engines also stamp free tables. `V430__delivery_order_wave.sql` adds wave membership to
`delivery_orders` and `V431__delivery_order_streaming.sql` adds a release-mode override and three
streaming timestamps; `V610__pick_order_wave.sql`, `V611__pick_order_bulk.sql` and
`V612__group_shipments.sql` add wave, bulk and group-shipment columns to the picking and shipping
tables. Those columns and their indexes exist in every free installation too.

Cartonization, forecasting, slotting and simulation add no schema at all; they read the free
tables.

The schema is public and the algorithms are not. One consequence is that the Flyway history is the
same in a free and a full build, so adding the commercial engines to an installation needs no
schema change of its own.

## Entity base classes

```kotlin
BaseEntity    // id (GenerationType.IDENTITY), version (@Version), created, modified
  TenantEntity  // + clientId, plus a declared-but-never-enabled Hibernate @Filter
```

In this repository 29 entity classes extend `TenantEntity` and 25 extend `BaseEntity` directly.
Optimistic locking via `@Version` is universal.

The `tenantFilter` on `TenantEntity` is not an enforcement layer. It is covered in
[Identity and tenancy](identity-and-tenancy.md#what-actually-enforces-isolation), where the
rationale belongs.

## Column naming is not uniform

156 migration occurrences of `client_id` against 3 of `tenant_id`. The three are `outbox_events`
(`V1__create_outbox.sql`), the webhook subscription and delivery tables
(`V901__create_webhooks.sql`) and `alert_deliveries` (`V1103__create_alert_deliveries.sql`) - the
cross-cutting relay and log tables, written by `OutboxService(tenantId = ...)` and the delivery
machinery rather than by a domain service. The split is consistent with that reading and nothing
contradicts it, but no document states the convention, so anyone writing a join between a domain
table and a relay table has to notice it themselves.

Identity generation is likewise mixed: `V1300__create_cross_dock_orders.sql` uses `BIGSERIAL`,
`V1301__create_documents.sql` uses `GENERATED BY DEFAULT AS IDENTITY`. Both satisfy
`GenerationType.IDENTITY`, so this is cosmetic, but the schema has two idioms for the same thing.

## No foreign keys across module boundaries

Cross-module references are plain IDs. `V1500__create_stream_batches.sql:2` states the house rule
inline: "ID-only references, no FK (house rule)." Validation happens through the owning module's
lookup SPI, which keeps each module extractable
([ADR 0007](decisions/0007-cross-module-references-by-id.md)).

## No row-level security

There are no `CREATE POLICY` statements, no `ENABLE ROW LEVEL SECURITY`, and no
`current_setting` calls anywhere in the migration chain.

Isolation between goods owners is enforced in application code and nowhere else
([Identity and tenancy](identity-and-tenancy.md#what-actually-enforces-isolation)). Why no
database-level layer backs it is not recorded.

## The read side bypasses the module boundary

Reporting reads foreign tables through native SQL, and so do three commercial engines. See
[Modules and boundaries](modules-and-boundaries.md#three-couplings-the-module-graph-does-not-show)
for the full table. Two properties of those queries matter here:

- They hardcode another module's private encodings. The slotting advisor filters stock on state
  `300`, which is `StockState.ON_STOCK` in the Apache-2.0 `karyo-inventory-api`; the forecasting
  engine filters `picking_type <> 'EXTINGUISH'`. Neither has a compile-time link to the owning
  module, so renaming or renumbering either breaks them at runtime, and nothing in this repository
  will notice. Treat both encodings as a published contract.
- Day bucketing is warehouse-local, not UTC, and this is load-bearing. `date_trunc('day', ...)`
  buckets in the Postgres session timezone, which pgjdbc takes from the JVM default zone, so a
  deployment picks its warehouse timezone through the container `TZ`. `WarehouseZone.ZONE`
  (`libs/karyo-common/src/main/kotlin/com/karyo/common/time/WarehouseZone.kt`) exists so the
  query bounds and the view bucketing agree by construction. The KDoc on `KpiViewRepository` is
  explicit that `WarehouseZone` is the record of that decision, "since the applied migration's SQL
  comments are forward-only and cannot be edited to reflect it"
  (`.../reporting/repository/KpiViewRepository.kt:23-26`).

That last sentence is worth keeping. Applied migrations are immutable including their comments, so
a decision that lives in a migration comment cannot be corrected later. Anything that needs to stay
true has to live somewhere editable.

## Related

- [Modules and boundaries](modules-and-boundaries.md) - the module graph the schema cuts across
- [Identity and tenancy](identity-and-tenancy.md) - what enforces owner isolation
- [The commercial boundary](commercial-boundary.md) - what else a free installation carries
- [Reference: data model](../reference/data-model.md) - the entity model
