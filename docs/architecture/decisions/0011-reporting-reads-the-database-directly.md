# ADR 0011: Reporting reads the operational database directly

**Status:** Accepted

## Context

Dashboards and KPIs combine data that several modules own: picks from fulfillment, receipts and
orders from orders, stock from inventory, locations from layout. A report is only useful if it
agrees with what the operational screens show.

All of that data lives in one PostgreSQL database and one `karyo` schema
([ADR 0004](0004-one-postgresql-database-and-schema.md)), so every table is reachable from one
connection and nothing prevents a join. There is no message broker to feed a separate read store
([ADR 0008](0008-synchronous-rest-and-cdi-events.md)).

## Decision

- **Reporting reads operational tables directly.** It uses ordinary SQL views - accuracy,
  throughput, cycle-time and utilisation KPIs (`V1001`) and per-location occupancy (`V1002`), revised
  by forward migrations `V1004` to `V1006` - and native queries in its repositories. It keeps no
  separate read model and consumes no events to maintain one.
- **Native SQL names views schema-qualified** (`karyo.kpi_accuracy_daily` and so on), because
  Hibernate's default schema does not rewrite native queries.
- **Day buckets are warehouse-local.** The views bucket by day in the database session time zone,
  which follows the application's JVM zone, and the repositories compute their query bounds in the
  same zone (`WarehouseZone.ZONE`), so the two agree by construction.
- The reporting module also stores saved report definitions, so as a module it is not read-only; its
  KPI and occupancy paths are.
- The same approach is open to any module that needs a cross-domain read. The optional commercial
  analytics engines read the shared stock and pick tables the same way.

## Consequences

- A report is consistent with operational data the moment a transaction commits. There is no lag,
  no consumer to keep running and no initial-population step when a report is added.
- A new KPI is a new view in a forward migration plus a query.
- The coupling is invisible to the build. A view or native query names another module's tables,
  columns and codes directly, with no compile-time link to the owning module, so a rename or a
  changed code breaks it at run time rather than at build time.
- Report queries share the database with operational writes. A heavy report and a pick
  confirmation compete for the same connections and I/O.
- Applied migrations are immutable, comments included ([ADR 0005](0005-flyway-migrations-at-boot.md)).
  Changing a view is a new forward migration, and a decision recorded only in a migration comment
  cannot be corrected, which is why the time-zone decision is recorded in `KpiViewRepository`'s KDoc
  instead.
- Throughput's `units_shipped` counts shipments, not quantities; the module README states the
  interpretation limits of each view.

## Alternatives considered

- **A separate read store fed by events (CQRS).** Rejected. The reason such a store is needed is
  that separate databases cannot be joined; with one schema that constraint does not exist, and
  there is no broker to feed it. It would add eventual consistency, a consumer per read model and an
  initial-population problem for no gain. Whether a separate read store would pay for itself at a
  larger scale has not been assessed.
- **Aggregating through the modules' services or REST endpoints at report time.** Rejected. A
  report over thousands of rows would issue a call per row and per module where one SQL join answers
  it, and it would load the operational paths while doing so.
- **Materialised views refreshed on a schedule.** Not used. Why ordinary views were preferred is not
  recorded.

## Evidence

- `services/karyo-app/src/main/resources/db/migration/reporting/V1001__create_kpi_views.sql:14,26,64,78` - the four KPI views
- `services/reporting-service/karyo-reporting-core/src/main/kotlin/com/karyo/reporting/repository/KpiViewRepository.kt:23-27` - the time-zone decision, recorded in the KDoc
- `services/reporting-service/karyo-reporting-core/src/main/kotlin/com/karyo/reporting/repository/KpiViewRepository.kt:44-67` - schema-qualified native queries over the views
- [`karyo-reporting-core/README.md`](../../../services/reporting-service/karyo-reporting-core/README.md) - routes, the migration chain and each view's interpretation limits

## Related

- [ADR 0004](0004-one-postgresql-database-and-schema.md) - the single schema that makes direct reads possible
- [ADR 0005](0005-flyway-migrations-at-boot.md) - why a view change is a forward migration
- [ADR 0006](0006-api-and-core-modules.md) - the module rule that native cross-module reads step around
- [ADR 0010](0010-crud-with-an-inventory-journal.md) - current state as the thing reports read
- [Data and persistence](../data-and-persistence.md) - the read side and the day-bucketing rule
- [Modules and boundaries](../modules-and-boundaries.md) - the shared schema as a coupling the module graph does not show
