# Warehouse layout configuration

Laying out a warehouse is the largest single act of configuration in a Karyo deployment. It is
done entirely through data: thirteen entity types in the layout module, created and edited over
`/api/v1/*` with no build step and no code. What the resulting shape *does* - the putaway
finder's filter chain, the sort keys, the FIFO hiding - belongs to
[putaway and location finding](../functional/putaway-and-location-finding.md) and is cited here
rather than re-derived. This document is about what an administrator creates, what the system
will refuse, and where the configuration surface stops.

## The thirteen entities

All live in
`services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/`.

| Entity | What it is | Base class |
|---|---|---|
| `Zone` | A named region, optionally chaining to an overflow zone | `BaseEntity` |
| `Area` | A usage role - STORAGE, PICKING and so on | `BaseEntity` |
| `LocationCluster` | A named, self-nesting grouping of locations | `BaseEntity` |
| `StorageArea` | A named *set* of clusters, used to restrict putaway candidates | `BaseEntity` |
| `WorkingArea` | A named *set* of clusters, used to scope offered work items | `BaseEntity` |
| `LocationType` | Dimensions and three lifting capacities | `BaseEntity` |
| `TypeCapacityConstraint` | The (location type, unit load type) compatibility matrix | `BaseEntity` |
| `StorageStrategy` | Putaway policy - see [strategies and policies](strategies-and-policies.md) | `TenantEntity` |
| `StorageStrategyArea` | The strategy's ordered list of storage areas | `BaseEntity` |
| `StorageLocation` | A physical bin | `TenantEntity` |
| `FixAssignment` | A product pinned to a location, with min/max/desired amounts | `TenantEntity` |
| `ItemDataArea` | A per-product planned-occupancy threshold for a storage area | `TenantEntity` |
| `LocationReservation` | A short-lived soft reserve held by an in-flight putaway | `BaseEntity` |

`StorageArea` and `WorkingArea` are the same shape and easy to confuse; the code says so and
distinguishes them. A storage area "restricts/hides putaway finder candidates"; a working area
"scopes which offered WORK ITEMS an operator sees" (`WorkingArea.kt:6-12`). `StorageArea`
carries the further warning that it is a different concept from `Area` entirely - a named set
of clusters versus a usage role - "do not conflate" (`StorageArea.kt:7-9`). The terms are
near-synonyms, and both notes are worth keeping.

## Layout configuration is instance-wide; the locations in it are not

Nine of the thirteen extend `BaseEntity`, so they carry no `client_id` and are shared across
every goods owner. Four extend `TenantEntity` (`libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt:25-31`).

The split is coherent once stated: the *building* belongs to the operating company, and what
sits in it belongs to a goods owner. Zones, areas, clusters, location types and the capacity
matrix describe racking, so they are instance-wide. Strategies, fix assignments, planned
occupancy and the locations themselves attach to an owner.
`TypeCapacityConstraint`'s KDoc names the rule explicitly: "Pure layout config, `BaseEntity`
(like `LocationType`/`StorageArea`) - not tenant-scoped, same as the rest of the layout
configuration surface" (`TypeCapacityConstraint.kt:14-18`).

`StorageLocation` being tenant-scoped has a consequence worth knowing before promising
anything: a location belongs to exactly one goods owner, or to client 0, and the strategy flag
`onlyClientLocation` decides whether an owner's putaway may land on a shared client-0 location.
That flag defaults to `true`, and the reason is recorded where the field is declared: a shared
location "is counted by no tenant's full inventory ... so silently defaulting stock onto one
leaves it outside every owner's END_OF_PERIOD count" (`StorageStrategy.kt:28-37`). Shared
placement is opt-in because the alternative loses stock from a count, not because sharing is
rare.

`StorageLocation.name` is globally unique (`StorageLocation.kt:11-12`, and
`services/karyo-app/src/main/resources/db/migration/layout/V305__create_storage_locations.sql`),
so two goods owners cannot both hold a bin called `A-01-01` even though each would only ever see
their own. That is a real constraint on a 3PL naming scheme and it is nowhere stated outside
the schema.

## There is no warehouse

Karyo has no `Warehouse` entity, no `warehouses` table and no site dimension. One installation
is one warehouse. Karyo is silo-tenanted - one instance per company
([ADR 0014](../architecture/decisions/0014-silo-tenancy-and-goods-owners.md)) - and the admin
navigation states the corollary in its own comment, distinguishing a future SaaS "Tenants"
concept from a Client (`frontend/web/src/config/admin-navigation.ts:19-28`).

A `warehouse_id` nevertheless exists as a Keycloak user attribute, is offered on the user form,
is minted into the JWT by a realm protocol mapper, and is read into `TenantContext.warehouseId`.
Nothing consumes it. That is covered in
[users, roles and permissions](users-roles-and-permissions.md#warehouse_id-is-collected-and-read-by-nothing).

## What the system refuses

The layout services carry real referential guards, and they are the most consistent thing in
this area - up to a point.

Four entities refuse deletion while dependents exist, answering 409 `has-dependents`
(`exception/LayoutException.kt:33`, mapped at `exception/LayoutExceptionMapper.kt:25`):

- `Zone` while any location references it (`service/ZoneService.kt:95`)
- `LocationType` while any location references it (`service/LocationTypeService.kt:93`)
- `Area` while any location references it (`service/AreaService.kt:99`)
- `StorageArea` while any strategy area or item-data area references it (`service/StorageAreaService.kt:84,88`)

**Known defect.** `StorageLocation` - the only one of the five that physically holds inventory -
has no guard at all. `LocationService.delete` loads the row, invalidates two caches and deletes
(`service/LocationService.kt:365-371`). Because `unit_loads.storage_location_id` carries no
foreign key (it is a cross-module reference; the column and its index are declared without one
at `db/migration/inventory/V102__create_unit_loads.sql:10,22`), deleting an occupied location
succeeds and leaves unit loads pointing at a row that no longer exists.

The same call behaves three different ways depending on what happens to reference the location:

| Referenced by | Foreign key | Outcome |
|---|---|---|
| Unit loads holding stock | none - cross-module | Deletion succeeds; the stock is orphaned |
| A fix assignment | `fix_assignments.location_id` (`db/migration/layout/V307__create_fix_assignments.sql:7`) | Constraint violation, unmapped - no `ExceptionMapper` covers a persistence exception, so HTTP 500 |
| A live reservation | `location_reservations.location_id ... ON DELETE CASCADE` (`db/migration/layout/V308__create_location_reservations.sql:6`) | The reservation is silently cascaded away |

The route is `@RolesAllowed("layout-write")`
(`api/v1/LocationResource.kt:78-81`), a role the shipped `MANAGER` composite carries.

The contradiction is internal. Karyo already articulates the exact principle this violates, in
the goods-owner model: clients are never deleted because "26 entity types may reference one and
there are no foreign keys to tell us whether removal is safe"
(`services/auth-service/karyo-auth-api/src/main/kotlin/com/karyo/auth/vo/ClientState.kt:7-9`).
A storage location is in the same position and gets the opposite treatment.

A second, milder version of the same shape: every guard that does exist stops at the module
boundary. `UnitLoadTypeService.delete` refuses while unit loads reference the type
(`services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/service/UnitLoadTypeService.kt:28-36`)
but cannot see `TypeCapacityConstraint.unitLoadTypeId` in the layout module or
`ItemData.defaultUnitLoadTypeId` in the product module, neither of which has a foreign key. The
guards are as good as the no-cross-module-foreign-key convention allows
([ADR 0007](../architecture/decisions/0007-cross-module-references-by-id.md)), and no better.

## What cannot be deleted at all

`LocationCluster` and `StorageStrategy` have no delete method and no `@DELETE` route
(`service/LocationClusterService.kt`, `service/StorageStrategyService.kt`,
`api/v1/StorageStrategyResource.kt:24-60`). Neither does `OrderStrategy`
(`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/api/v1/OrderStrategyResource.kt:30-49`).
Strategy and cluster lists only ever grow; a mistake made during commissioning is permanent and
must be worked around by renaming or by leaving the row unreferenced. See
[strategies and policies](strategies-and-policies.md#neither-strategy-can-be-deleted) for the
code that defends against a deletion the API cannot perform.

## What an update will not check

`LocationService.updateLocation` accepts a new `locationTypeId` and a new `areaId` and applies
both without asking whether the location currently holds anything
(`service/LocationService.kt:163-185`). Changing the location type changes the dimensions,
lifting capacity and the capacity-matrix rows that govern what may sit there; changing the area
changes its usage role. Both can be done under a loaded pallet. There is no evidence either way
about whether this was considered - the method has extensive comments about the clearing-location
unique index and none about occupancy - so whether it is deliberate is not recorded.

The one thing `updateLocation` does guard carefully is `isClearing`. A partial unique index
allows at most one clearing location per instance, and because that index fires at flush rather
than at the statement, the method forces the flush inside its own try-catch so the violation
becomes a clean 409 instead of a raw 500 (`service/LocationService.kt:196-213`). The comment
also records the two alternatives it rejected: the clearing location is "NOT the free-text
`kind` taxonomy, NOT a magic id" (`StorageLocation.kt:77-79`).

## Fields an administrator can set that steer nothing

Four columns on `StorageLocation` are honest about being descriptive: `capacity`,
`temperatureZone`, `handlingClass` and `kind` are labelled "honest, seeder-derived metadata"
and left nullable so an unset row renders as a gap rather than a fabricated value
(`StorageLocation.kt:60-72`). `plcCode` is likewise declared "Search/display only, zero finder
semantics. An EquipmentAdapter address bridge is not implemented"
(`StorageLocation.kt:83-85`). Those are fine: the code says what they are.

`allocationState` is the opposite kind of field - it does steer behaviour, excluding a location
from the putaway finder when non-zero, and the comment notes that "no business writer flips it
automatically" (`StorageLocation.kt:89-92`). It is an operator's manual "mark full" and works
as described.

The layout module's genuinely inert configuration lives one module away, on the product: see
[`ItemData.zoneId` in reference data](reference-data.md#itemdatazoneid-steers-nothing).

## Capacity, and one disagreement the code admits to

`TypeCapacityConstraint` is the (location type, unit load type) matrix. Its `allocation`
percentage expresses how much of a location one unit load occupies - 100 means one fits, 50
means two - and the KDoc states plainly that the oversize case above 100 is "NOT enforced by
placement logic here" (`TypeCapacityConstraint.kt:27-29`). It also records that
`unitLoadTypeId` is deliberately unvalidated, because inventory exposes no `UnitLoadTypeLookup`
SPI and the recorded constraint was against inventing a new cross-module SPI for one
validation: "advisory integrity only" (`TypeCapacityConstraint.kt:19-25`). That is a decision
with its cost written next to it.

`LocationService.checkCapacity` carries the most valuable comment in the module. It documents
that current weight is computed on demand from the same read the group-capacity check uses, so
the two agree; that the check is deliberately unscoped by tenant because "a pallet presses on
the rack whoever owns the goods", closing with "Do not 'fix' this into a scoped read"; and that
an unweighed unit load contributes zero, degrading honestly rather than refusing on invisible
occupancy (`service/LocationService.kt:253-294`). It also names a live inconsistency: only a
null lifting capacity is unlimited here, while filter 5 of the putaway candidate query reads a
zero cap as unlimited, "so the two disagree on that one value; the disagreement is recorded,
not resolved here" (`service/LocationService.kt:289-294`). **Known defect:** an administrator
who sets a location type's lifting capacity to `0` meaning "nothing may go here" gets a refusal
from the capacity endpoint and no filtering from the finder.

## Related

- [Putaway and location finding](../functional/putaway-and-location-finding.md) - what the finder does with this layout
- [Strategies and policies](strategies-and-policies.md) - storage strategies and their flags
- [Reference data](reference-data.md) - unit load types and product fields the layout depends on
- [Data and persistence](../architecture/data-and-persistence.md) - why cross-module references carry no foreign key
