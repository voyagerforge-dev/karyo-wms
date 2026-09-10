# ADR 0010: Stock is stored as current state with an immutable journal, not event-sourced

**Status:** Accepted

## Context

Almost everything a warehouse does reads current stock. Stock selection, location finding,
reservation and replenishment all query the rows as they are now, with joins, ordering and
filters, and an operator scanning a location needs the amount that is there at that moment, not a
value that will be correct once a projection catches up.

Every stock change also has to be traceable afterwards: who moved what, when, from where to where,
and what the amount was after the change. Disputes, counts and investigations depend on it.

Karyo is one process over one database ([ADR 0001](0001-modular-monolith.md),
[ADR 0004](0004-one-postgresql-database-and-schema.md)), so a stock change and the record of it can
commit together in one local transaction.

## Decision

- **PostgreSQL rows are the source of truth.** Stock units, unit loads and every other domain object
  are ordinary JPA entities updated in place.
- **Every stock change writes an `InventoryJournal` row** in the transaction of the operation that
  made the change, through `JournalService`. A journal row is a denormalised snapshot: product
  number and name, lot, serial number, the from and to unit load and location names, the amount
  moved, the stock unit's amount afterwards, the operator and a correlation string. Record types
  are `CREATED`, `CHANGED`, `PICKED`, `TRANSFERRED`, `COUNTED` and `DELETED`.
- **Journal rows are immutable.** Every column is mapped `updatable = false`.
- **A journal row belongs to the goods, not to the actor.** Its `client_id` is the stock's goods
  owner, and the acting principal supplies only the operator name, so an owner's audit log shows a
  movement made by the operating company's staff.
- **The journal is an audit trail, not an event store.** Nothing rebuilds entity state by replaying
  it. Notifications that leave the process go through the outbox
  ([ADR 0009](0009-transactional-outbox.md)), which is not a source of truth either.

## Consequences

- Operational queries read current state directly, with ordinary SQL, and see every committed
  change immediately.
- A journal row is self-contained. Names are copied at write time, so renaming a product or a
  location later does not rewrite history, and an audit query needs no join to current state.
- The stock row and its journal row commit or roll back together; there is no window in which one
  exists without the other.
- There are no temporal queries for free. "What was on this location at 15:00?" means working back
  from current state through journal deltas; no snapshot store exists.
- Immutability is enforced by the entity mapping, not by the database: the migration declares no
  trigger or grant that would stop an `UPDATE` issued outside JPA.
- The table is declared `PARTITION BY RANGE (created)` with a single `DEFAULT` partition. No monthly
  partitions and no archival or retention job exist, so every row lands in the default partition.
  The shape allows partitions to be added later without a rewrite; it is not a retention mechanism.
- The journal also holds sign-in events. `LOGIN`, `LOGOUT` and `LOGIN_FAILED` rows are written by the
  Keycloak audit poller ([ADR 0013](0013-keycloak-oidc.md)), so one table is the audit log for both
  stock movements and authentication.
- **Known defect.** The `correlation_id` column holds a domain string chosen by whichever service
  wrote the row. The `X-Correlation-Id` request header reaches the log context only and never a
  journal row, so querying `GET /api/v1/journals?correlationId=` with the value a client sent
  returns nothing.

## Alternatives considered

- **Full event sourcing**, with events as the source of truth and current state as a projection.
  Rejected. Stock selection and location finding need immediately consistent current state and
  complex SQL over it; maintaining those as eventually consistent projections adds projection
  management, snapshotting and event versioning for state reconstruction, and the eventual
  consistency is unacceptable on the paths where an operator is waiting at a location.
- **Event sourcing for inventory only, CRUD elsewhere.** Rejected. Inventory has the most complex
  queries, the highest write rate and the strictest consistency requirement in the product, so it is
  the module where event sourcing would cost most. The journal already provides the audit trail that
  motivates event sourcing there, and two data patterns across modules would raise the cost of every
  cross-module change.

## Evidence

- `services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/domain/model/InventoryJournal.kt:8-62` - the entity, every column `updatable = false`
- `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/vo/JournalRecordType.kt:3-16` - the record types, including the three sign-in types
- `services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/service/JournalService.kt:37` - `record`, the general write method; the class also has dedicated methods for purges and for trashing and reviving unit loads
- `services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/service/StockService.kt:251-285` - a `@Transactional` stock change writing its journal row; every stock-changing method in the class follows the same shape
- `services/karyo-app/src/main/resources/db/migration/inventory/V104__create_inventory_journals.sql:1-24` - the partitioned table and its one default partition
- `services/karyo-app/src/main/kotlin/com/karyo/app/auth/KeycloakEventPoller.kt:14-19` - sign-in events appended to the journal
- `libs/karyo-security/src/main/kotlin/com/karyo/security/TenantFilter.kt:51` - the correlation header, put into the log context and nowhere else

## Related

- [ADR 0004](0004-one-postgresql-database-and-schema.md) - the one database the journal lives in
- [ADR 0009](0009-transactional-outbox.md) - the outbox, which carries notifications rather than state
- [ADR 0011](0011-reporting-reads-the-database-directly.md) - reporting reads the same current state
- [Stock model and states](../../functional/stock-model-and-states.md) - what the journalled operations do
- [Data and persistence](../data-and-persistence.md) - the schema the journal sits in
