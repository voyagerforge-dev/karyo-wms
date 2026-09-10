# Stock model and states

What Karyo believes is physically in the warehouse, and the rules that govern it. Everything
downstream - allocation, picking, counting, replenishment - is a read or a write against this
model, so its edges are the edges of the whole product.

## The two entities

There are exactly two, and the distinction is load-bearing.

A **`UnitLoad`** is a physical carrier: a pallet, a tote, a pick bin, a carton. It has a
globally unique `labelId`
(`services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/domain/model/UnitLoad.kt:11-12`,
`unique = true`), a location, a type, and a `lockType` of its own. It may nest inside another
unit load through `carrierUnitLoad` (`:38`), and `isCarrier` (`:34`) marks one that holds
others.

A **`StockUnit`** is a quantity of one product on one unit load
(`.../domain/model/StockUnit.kt`). It carries `amount`, `reservedAmount`, an optional
`lotNumber`, `serialNumber` and `bestBefore`, a `state`, a `lockType`, and a `strategyDate` -
the FIFO key. A unit load may hold several stock units; the count is what makes it "mixed".

The single derived value everything else depends on:

```kotlin
val availableAmount: BigDecimal get() = amount.subtract(reservedAmount)
```
`StockUnit.kt:54-55`

`amount` is what is physically there. `reservedAmount` is what someone else has already promised
away. Only the difference is offerable. There is no third quantity - no "allocated but not
reserved", no "in transit" - so every planning question in the system reduces to this
subtraction.

## The six stock states

`karyo-inventory-api/.../vo/StockState.kt:3-10`:

| State | Code | Meaning |
|---|---|---|
| `UNDEFINED` | 0 | Entity default, never written by a business path |
| `INCOMING` | 100 | Received but not yet accepted onto stock |
| `ON_STOCK` | 300 | The only pickable state |
| `PICKED` | 600 | On a pick container |
| `PACKED` | 650 | In a shipping unit |
| `SHIPPED` | 680 | Handed to the carrier |
| `DELETABLE` | 1000 | Soft-deleted; awaiting the reaper |

Transitions go through one chokepoint, `StockService.changeState`
(`.../service/StockService.kt:392-406`), which enforces **forward-only** movement with one
exception: `DELETABLE` is reachable from anywhere.

```kotlin
if (newState <= su.state && newState != StockState.DELETABLE.code) {
    throw InventoryException.InvalidStateTransition(id, su.state, newState)
}
```
`StockService.kt:402-404`

Forward-only means *not* step-by-step. `changeState` will happily jump 300 → 650 if a caller
asks, and the equivalent jump does happen at the order level (see
[picking](picking.md#force-finish-can-skip-picked)). There is exactly one sanctioned backward
write in the whole model, `StockPicker.unpackContainer`, which writes the state field directly
rather than going through the chokepoint, precisely because the guard would refuse it
(`.../service/DefaultStockPicker.kt:216-219`).

`changeState` also stamps `modified` by hand (`StockService.kt:417`) because nothing else does -
no `@PreUpdate`, no `@UpdateTimestamp`, and the column default only fires on insert. That single
line is what makes the purge retention window mean anything.

### `ON_STOCK` is the whole gate

`StockUnitRepository.findForSelection` - the query behind every allocation decision - filters
`state = 300` and nothing else about where the stock is:

```
itemDataId = ?1 and clientId = ?2 and state = 300 and amount > reservedAmount
```
`.../repository/StockUnitRepository.kt:52`

There is no area, zone or usage predicate. Stock that is `ON_STOCK` and unlocked is allocatable
wherever it physically sits - including a goods-in dock, a pack-staging location or a
cross-dock staging slot. It matters most on the quality-hold release path, where nothing moves
the stock out of receiving first - see
[receiving and quality holds](receiving-and-quality-holds.md#releasing-a-hold).

## Two lock enums that disagree

There are two `LockType` enums and they are not compatible. Both KDocs warn about it in almost
identical language.

**Stock locks** (`karyo-inventory-api/.../vo/LockType.kt:16-23`): `UNLOCKED(0)`, `GENERAL(1)`,
`STOCKTAKING(7)`, `QUALITY_FAULT(103)`, `LOT_EXPIRED(202)`, `LOT_TOO_YOUNG(203)`,
`SHIPPED(405)`.

**Location locks** (`karyo-layout-api/.../vo/LockType.kt:13-18`): `UNLOCKED(0)`, `GENERAL(1)`,
`QUARANTINE(2)`, `STOCKTAKING(7)`, `DAMAGE(8)`.

They share only 0, 1 and 7. Codes 2 and 8 exist only for locations; 103, 202, 203 and 405 only
for stock. Passing a code across the boundary makes the receiving enum's `fromCode` throw.
Reconciling the two is deliberately not done; the warnings in both KDocs
(`karyo-inventory-api/.../vo/LockType.kt:7-11`, `karyo-layout-api/.../vo/LockType.kt:7-11`) are
the guard.

`SHIPPED(405)` has no writer anywhere in Karyo, and its own KDoc says so
(`karyo-inventory-api/.../vo/LockType.kt:12-14`). Dispatch flips state to `SHIPPED(680)` and then
straight on to `DELETABLE`; it never sets a lock.

### The pallet lock is a read-time invariant

A unit load's `lockType` is not cascaded once and forgotten. `findForSelection` joins it
directly:

```
and lockType = 0 and unitLoad.lockType = 0
```
`StockUnitRepository.kt:62`

The consequence is stated in the field's own KDoc (`UnitLoad.kt:84-88`): stock that lands on an
already-locked pallet *after* the lock was applied - a late receive, a transfer, carrier
nesting - is unpickable even though its own `lockType` is still 0. The per-stock cascade in
`UnitLoadService.lock`/`unlock` (`.../service/UnitLoadService.kt:569-591`) still runs, but it
drives journalling and per-stock visibility rather than being the enforcement.

`unlock` only clears a stock unit whose lock equals the code the unit load itself carried, so a
stock unit that was individually locked under a different code survives a pallet unlock
(`UnitLoadService.kt:581-588`).

One asymmetry worth knowing: the summary read replenishment uses to decide whether a pick face
is deficient filters `su.lockType = 0` but **not** `su.unitLoad.lockType = 0`
(`StockUnitRepository.kt:131`). A locked pallet sitting in a pick face therefore still counts
towards that face's on-hand, while being unpickable. See
[replenishment](replenishment.md#what-counts-as-on-hand).

## The journal

Every mutation writes an `InventoryJournal` row through `JournalService.record`. The record
types are `CREATED(1)`, `CHANGED(2)`, `PICKED(3)`, `TRANSFERRED(5)`, `COUNTED(7)`, `DELETED(8)`,
plus three authentication codes `LOGIN(10)`/`LOGOUT(11)`/`LOGIN_FAILED(12)` that the auth event
poller writes into the same table
(`karyo-inventory-api/.../vo/JournalRecordType.kt:3-16`).

That last group carries a live constraint, spelled out in the enum's own comment: the codes must
exist in the same release as any row carrying them, because `JournalResource.list` calls
`fromCode` per row and `fromCode` throws on an unknown code (`JournalRecordType.kt:11-13`,
`:19`). Removing or renumbering a value breaks reading the history that already exists.

Reservation changes are journalled as `CHANGED` with the delta amount, not as a distinct type
(`StockService.kt:623-631`), so a reservation and an adjustment are the same record type in the
history and are told apart only by the correlation and activity codes.

## Weight

`UnitLoad.weight` is the effective weight: the operator's measured value when one is set,
otherwise the calculated one (`UnitLoad.kt:40-53`). The calculation is the type's tare plus
every non-gone stock unit on the load, and it is **always a full recompute, never incremental**.
The reasoning is recorded in the field's KDoc (`UnitLoad.kt:55-63`): an incremental total with a
full-recalculation fallback for when the increment goes wrong is a cache with a repair hatch; a
full recompute at each of the few mutation points costs one batched read and cannot drift.

The manual override beating the calculation is a deliberate design decision
(`UnitLoad.kt:65-71`).

## Deletion and the reaper

`StockService.deleteStock` is a soft delete: it flips state to `DELETABLE(1000)` and journals.
The row survives, and `findByUnitLoadId` still returns it - which is why
`DefaultStockCountingPort.findStockAtLocation` filters `state != DELETABLE` explicitly before
planning a count (`.../service/DefaultStockCountingPort.kt:37-44`).

Hard deletion is a separate, opt-in scheduled reaper. `StockPurgeScheduler` defaults **off**
(`karyo.inventory.purge.enabled`, `defaultValue = "false"`,
`.../service/StockPurgeScheduler.kt:47-48`) with the reason stated at `:17-18`: "this is the one
irreversible operation in this codebase, so an existing deployment must opt in explicitly".

The retention window is a per-client runtime property defaulting to 30 days, floored at 1 day at
the point of use (`.../service/StockPurgeService.kt:21-22`, `:35`, `:121`). The floor exists
because the property catalogue validates INTEGER without domain knowledge and would otherwise
accept 0, collapsing the grace period on the next tick (`StockPurgeService.kt:24-34`).

Each candidate purges in its own transaction, so one poison row blocks only itself
(`StockPurgeService.kt:182-192`). Live references are excluded through the `PurgeBlockerLookup`
SPI, which four modules implement - orders, tasks, fulfillment and stocktaking each answer for
their own open work.

Dispatch pre-empts the reaper for shipped stock: `shipContainer` flips `PACKED → SHIPPED`, then
promotes the same units straight to `DELETABLE` in the same transaction
(`DefaultStockPicker.kt:192-214`). The KDoc explains why (`:164-177`): occupancy reads filter
`state < DELETABLE`, so the promotion removes shipped stock from every occupancy answer
immediately, regardless of whether the reaper is even switched on. `SHIPPED` remains the
recorded ship state in the journal and outbox; `DELETABLE` is the database end state.

## Concurrency

`BaseEntity` carries `@Version` (`libs/karyo-common/.../domain/BaseEntity.kt:15-16`), so stock
mutations are guarded by optimistic locking. There is no pessimistic lock on `StockUnit`; the
only `PESSIMISTIC_WRITE` reads in this repository are on `UnitLoad`
(`UnitLoadRepository.kt:20`) and on the sequence-number table
(`SequenceNumberStateRepository.kt:13`).

That choice is correct for correctness - two concurrent reserves of the same unit cannot both
commit - but the losing transaction's failure is not modelled anywhere. See
[allocation and reservation](allocation-and-reservation.md#what-happens-when-two-orders-race).

## Related

- [Receiving and quality holds](receiving-and-quality-holds.md) - how stock enters the model
- [Allocation and reservation](allocation-and-reservation.md) - how `reservedAmount` is set
- [Data and persistence](../architecture/data-and-persistence.md) - the schema, the migration
  bands and the tenancy columns
- [Data model](../reference/data-model.md) - every table and entity
