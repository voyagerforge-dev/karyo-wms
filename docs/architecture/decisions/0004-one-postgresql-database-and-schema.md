# ADR 0004: One PostgreSQL database and one `karyo` schema serve every module

**Status:** Accepted

## Context

Warehouse operations need ACID transactions. A reservation, a transfer or an adjustment that
half-happens leaves double picks or stock that exists only on paper, and several of those
operations touch more than one module at once.

The domain is relational, and its hottest queries are join-heavy and ordered: stock selection joins
stock units, unit loads, locations and goods owners and orders them first-in-first-out; location
finding filters and ranks locations by capacity and strategy. Some columns hold JSON, such as the
outbox payload. The inventory journal is an append-only record that grows with every stock change.

The backend is one process ([ADR 0001](0001-modular-monolith.md)) with one Hibernate persistence
unit.

## Decision

- PostgreSQL is Karyo's only database. The Compose stack runs PostgreSQL 16
  (`infrastructure/docker/docker-compose.prod.yml:7-8`).
- There is one datasource and one persistence unit, whose default schema is `karyo`
  (`services/karyo-app/src/main/resources/application.yaml:11-26`). Flyway creates and owns that
  schema ([ADR 0005](0005-flyway-migrations-at-boot.md)).
- Every module's tables live in `karyo`. Modules are separated by table ownership and by id-only
  references ([ADR 0007](0007-cross-module-references-by-id.md)), not by schema or database.
- The schema uses standard PostgreSQL features directly - JSONB where a column holds JSON, partial
  indexes (`V1__create_outbox.sql:9,14`) - and installs no extension.
- The inventory journal is declared range-partitioned on `created`, with one default partition and
  no other (`V104__create_inventory_journals.sql:21-24`).

## Consequences

- One backup and one restore cover the whole installation, and a change that spans modules is one
  ACID transaction.
- Reporting can join other modules' tables directly instead of maintaining copies
  ([ADR 0011](0011-reporting-reads-the-database-directly.md)).
- Coupling through the schema is invisible to the build. Code that reads another module's tables
  with native SQL - reporting's KPI views, and the commercial insight engines - fails at runtime,
  not at compile time, when those tables change.
- Separation between goods owners is enforced in application code, not in the database: the schema
  carries no row-level security policies ([ADR 0014](0014-silo-tenancy-and-goods-owners.md)).
- One connection pool of at most twenty connections serves every module and every scheduler
  (`application.yaml:15`).
- The tables of four commercial engines exist in every installation, empty where the engines are
  absent ([ADR 0005](0005-flyway-migrations-at-boot.md)).
- The journal is partitioned so that it can be split by month, with recent months cheap to query and
  old months dropped rather than deleted. No monthly partitions exist and nothing creates them, so
  every journal row lands in `inventory_journals_default`. Adding a range partition later means first
  moving the rows the default partition already holds for that range, because PostgreSQL will not
  attach a partition while the default partition holds rows that belong to it.
- Karyo can move only to another PostgreSQL: native SQL, JSONB and partial indexes are used
  directly.

## Alternatives considered

- **A database or schema per module.** Rejected. There would be no joins across modules;
  cross-module operations would become distributed transactions needing sagas; reference data would
  be copied and kept in step; and there would be more databases to run, back up and restore. Its
  benefits - schema evolution and scaling per module - have no use for one application released as
  a whole. The discipline it demanded, no foreign keys between modules, is kept
  ([ADR 0007](0007-cross-module-references-by-id.md)).
- **MySQL.** Rejected: weaker window functions and common table expressions for the selection and
  location-finding queries, and a JSON type less capable than JSONB.
- **MongoDB.** Rejected: the domain is relational - stock selection joins stock units, unit loads,
  locations and owners - its multi-document transactions are limited, and Flyway does not support
  it.
- **CockroachDB.** Rejected: distributed SQL that a single installation does not need, with a
  minimum of around 2 GB of memory per node.

## Evidence

- `infrastructure/docker/docker-compose.prod.yml:7-8` - the database container
- `services/karyo-app/src/main/resources/application.yaml:11-35` - one datasource, one persistence
  unit, one schema, Flyway owning it
- `services/karyo-app/src/main/resources/db/migration/common/V1__create_outbox.sql:9,14` - JSONB and
  a partial index
- `services/karyo-app/src/main/resources/db/migration/inventory/V104__create_inventory_journals.sql:21-24` -
  the partitioned journal and its only partition
- [Data and persistence](../data-and-persistence.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - one process, one datasource
- [ADR 0005](0005-flyway-migrations-at-boot.md) - how the schema is created and changed
- [ADR 0007](0007-cross-module-references-by-id.md) - how modules share a schema without sharing keys
- [ADR 0010](0010-crud-with-an-inventory-journal.md) - the journal the partitioning is for
- [ADR 0011](0011-reporting-reads-the-database-directly.md) - reads across module tables
- [ADR 0014](0014-silo-tenancy-and-goods-owners.md) - where owner separation is enforced instead
