# Picking

A `PickOrder` is a container plus a list of `Pick` rows, each of which names one source stock
unit and a planned quantity. Everything in this document is about how those rows come into
existence, what a confirmation does, and what happens when the quantity is not there.

## Generating pick orders

`PickOrderService.releaseToPicking`
(`services/fulfillment-service/karyo-fulfillment-core/.../service/PickOrderService.kt:123-181`)
turns one delivery order's reservations into pick work.

1. Refuse if the order is at or past `STARTED` - "fail fast with a domain-correct 409 ... rather
   than doing work and leaning on `markStarted`'s forward-only guard to roll it all back"
   (`:131-135`).
2. Flatten every line's `OrderLineReservation` slices into `PlannedPick`s
   (`flattenReservations:756-768`). One slice, one planned pick.
3. Refuse if there are none: "no reserved stock to pick" (`:138-140`).
4. Require a `PACK_STAGING` location; without one, release is refused (`:147-148`).
5. Group, fire the extension event, persist.

**Partial reservations are pickable.** The state gate is `< STARTED`, so a `RELEASED` order whose
lines are still `PENDING` releases whatever *was* reserved. That follows from the shortfall
model in [allocation](allocation-and-reservation.md#the-order-side) - the order is not blocked on
being fully covered - but it means "released to picking" does not imply "fully allocated".

### Grouping and the extension seam

`PickOrderGroupingStrategy` decides how planned picks split into orders; the built-in is
`DiscreteGroupingStrategy` (one batch). For each resulting batch,
`PickingOrderPrepareEvent` fires **after grouping and before any persistence** - no container, no
`PickOrder`, no `Pick` row exists yet - and an observer may claim planned picks by index
(`firePrepareEventAndFilter:802-814`). If an extension consumes every index, the whole batch is
refused with `AllPicksConsumedByExtension` and no pick order is created, "so the caller learns an
extension took the whole batch rather than silently getting an empty order" (`:798-801`). Karyo
ships no built-in observer; it is a pure seam.

`createTypeOrders` on the strategy then splits each batch by picking type, producing separate
`COMPLETE` and `PICK` orders (`:167-171`). Off - the default - one batch is one pick order even
when the batch is type-mixed.

### `COMPLETE` versus `PICK`

```kotlin
val full = sourceAmounts[pp.sourceStockUnitId]?.compareTo(pp.amount) == 0
return if (full) PickingType.COMPLETE else PickingType.PICK
```
`pickingTypeOf:189-192`

A pick is `COMPLETE` when the planned quantity equals the source stock unit's whole `amount`.
Note this is the *fulfillment* `PickingType` (`karyo-fulfillment-api/.../vo/PickingType.kt`),
stored as a string on the `Pick`; the inventory module has a separate `PickingType(PICK, COMPLETE)`
enum with integer codes used by the selector's `PickStockResult`. They mean roughly the same
thing and are computed by different rules - the inventory one additionally requires the unit load
to be unopened, single-stock and `COMPLETE`-capable
(`.../inventory/service/StockSelectionService.kt:234-245`).

`sourceAmountsFor` builds the amount map like this:

```kotlin
picks.map { it.itemDataId }.distinct()
    .flatMap { stockUnitLookup.findByItemDataId(it, clientId) }
    .associate { it.id to it.amount }
```
`PickOrderService.kt:787-790`

That loads **every stock unit of every ordered product across the warehouse** to read the amounts
of a handful of source units. `StockUnitLookup.findByIds(ids, clientId)` exists on the same SPI
and is used a few methods away by `captureActuals` (`PickOrderService.kt:506-510`,
`karyo-inventory-api/.../spi/StockUnitLookup.kt:53`). `WavePickService` calls the same method
twice per wave release, and `PickTopUpService` keeps a private copy of the identical three lines.

### The container

Each pick order gets its own unit load as a pick container, created at the pack-staging location
with the pick-order number as its label (`PickOrderService.persistPickOrder:226-235`). Its type
defaults to the `karyo.fulfillment.pick-bin-unit-load-type-id` config value (seeded "Pick Bin",
id 2), overridable per request (`:85-94`).

There is a documented collision caveat: the generated pick-order number is checked for
uniqueness against `PickOrderRepository`, but the *same string* becomes the container's
`labelId`, and `unit_loads.label_id` is globally unique across all label sites. The uniqueness
check covers only the pick-order side, because `fulfillment-core` depends on
`karyo-inventory-api`, not `-core`, and `UnitLoadLookup` exposes no `findByLabel`. The label's
own collision risk is left to the database constraint, "same as every other generated label site
in the codebase that can't reach a same-module repository" (`:216-225`).

## Confirming a pick

`confirmPick(pickId, pickedAmount, targetUnitLoadId)` (`:284-329`) accepts any amount in
`(0, plannedAmount]`. Over-picking is refused; short-picking is normal.

The terminal guard is `state >= PICKED`, which covers `CANCELED(800)` as well as `PICKED(600)`,
and the comment names the failure it prevents: with a `PICKED`-only check, a stray or retried
confirm on a cancelled pick "would sail through, moving stock via `pickStock` with NO backing
reservation (potentially consuming a DIFFERENT order's reservation that re-claimed the freed
stock), driving the completion predicate below to reassign a CANCELED order back to PICKED, and
firing markPicked/outbox for an order the business believes canceled" (`:288-297`).

Then, in order:

1. **Capture actuals.** `pickedLotNumber` and `pickedBestBefore` are read from the source stock
   unit *before* `pickStock` mutates or consumes it - "the durable record of what was picked,
   independent of whatever the source stock unit becomes afterwards" (`:308-311`). A missing
   content ref leaves both `null`; the KDoc is explicit that this is an honest gap, "never
   fabricated" (`:494-501`).
2. **Move the stock.** `StockPicker.pickStock` releases the source's reservation for the picked
   quantity first, so the transfer - which validates `availableAmount` - can draw goods reserved
   for this order, then transfers and flips the freshly created target stock to `PICKED`
   (`.../inventory/service/DefaultStockPicker.kt:48-67`). Fulfillment never touches reservations
   directly.
3. **Recover any shortfall** (below).
4. **Complete the pick order** if every pick is now terminal, and advance the delivery order if
   every sibling pick order is too.

### Order completion is sibling-aware

Because `createTypeOrders` can mint more than one pick order per delivery order,
`finishPickOrderIfDone` (`PickOrderService.kt:377-422`) only calls `markPicked` when **every**
non-cancelled sibling has independently reached its own terminal state
(`allSiblingsComplete:490-492`).

The reason is recorded and is a good example of how a small strategy flag creates a real
failure mode: `markPicked` is deliberately strict, not idempotent, so the second sibling to
finish would call it a second time, `canAdvanceTo` would refuse the same-state transition, and
"the WHOLE confirmation (incl. the stock move that already happened) rolls back, forever - the
first sibling's PICKED write is durable, so a retry fails identically" (`:386-399`).

Wave-linked orders take a different route entirely: completion is decided per confirmed pick,
through the pick's own owning order resolved from its line, because a batch pick order carries
no `deliveryOrderId` and a `PICK_ONLY` member order may own no per-order pick order at all
(`advanceWaveMemberOrderIfDone:449-458`).

## Short picks

A confirm below the planned amount runs `recoverShortfall` (`:345-357`), which forks on whether
the pick order is order-bound:

- **Not order-bound** (an `EXTINGUISH` order, or a cross-order wave batch order) - release the
  uncommitted reservation and stop. There is no follow-up, no substitution and no shortfall
  report. For batch picks this is deliberate: a wave's shortage recovery happens when the wave is
  allocated, where its own shortage handling reports the dropped lines, not on the floor
  (`:331-343`).
- **Order-bound** - run `handleShortfall`.

`handleShortfall` (`:541-586`) does four things:

1. Release the unpicked reservation.
2. Ask the `PickDifferenceStrategy` what to do with the short source's residual. The built-in is
   `LEAVE`: leave it on the bin, but exclude it from the re-selection so the follow-up sources
   from elsewhere.
3. Apply the order's `ShortPickMode` - `FOLLOW_UP`, `FOLLOW_UP_THEN_SUBSTITUTE` (the default),
   `SUBSTITUTE_ONLY` or `NONE` (`karyo-orders-api/.../vo/ShortPickMode.kt:8-16`) - creating
   follow-up `Pick` rows for whatever can be re-reserved.
4. Hand any still-uncovered remainder to the `ShortfallStrategy`. The built-in is
   `PARTIAL_SHIP`: report the shortage and accept it.

Exclusion is **per confirm**, not per chain: a follow-up pick that itself confirms short excludes
only its own source, not the original short source earlier in the chain. That is bounded because
the chain still terminates at the shortfall strategy, and the KDoc says so
(`PickOrderService.kt:536-539`).

Two things about follow-ups deserve attention.

**The exclusion can be silently ignored.** `coverWithFollowUps` passes `excludeStockUnitIds`
alongside the strategy's `preferMatching` and `completeHandling` (`:597-609`), and the selector
applies exclusions only in its baseline passes - not in either pre-pass. Under a strategy with
either flag on, the follow-up can re-select the source that just came up short. This is a known
defect; see
[allocation](allocation-and-reservation.md#excludestockunitids-does-not-reach-the-pre-passes).

**A substitution follow-up carries the wrong article number.**

```kotlin
this.itemDataId = itemDataId               // the SUBSTITUTE's id
this.itemDataNumber = parent.itemDataNumber // the ORIGINAL's number
```
`:615-616`

**Known defect.** `SubstitutionLookup.findSubstitutes` returns only
`(substituteItemDataId, priority)` - there is no number on the value object
(`karyo-product-api/.../spi/SubstitutionLookup.kt:8-12`) - and the code takes the parent's rather
than looking one up. `PickResponse.itemDataNumber` is served straight from that field
(`.../api/v1/dto/PickDtos.kt:51`, `:65`), so an operator or an integrator reading the pick sees
the *original* article number against the *substitute's* product id. `substitutedItemDataId` is
also on the response, so the mismatch is detectable, but only by a client that knows to look.

Lot handling on a follow-up is correct and deliberate: a same-item follow-up re-selects within
the parent's lot and stamps it; a substitute is a different product with its own lots, so neither
the lot restriction nor the stamp is applied (`PickOrderService.kt:593-596`).

## Cancelling

Two granularities, both in `PickLifecycleService`.

**Per line** - `cancelPick` marks one pick `CANCELED` and releases its reservation.

**Order level** - `forceFinish` (`PickLifecycleService.kt:114-127`) cancels every open pick,
releasing each outstanding reservation through the same path a short-pick release uses, then
lands the order on:

- `CANCELED` if **no pick was ever genuinely `PICKED`**, or
- `PICKED` if at least one was.

The `PICKED` outcome is intentional - "you pack what was picked" - and the short signal lives on
the delivery order's derived line rollup rather than on the pick order's state machine
(`:68-79`). The count is of picks in state `PICKED` exactly, not "not open", so an order whose
picks were all cancelled per line still lands on `CANCELED` (`:118-122`).

Force-finish deliberately does **not** drive the delivery order anywhere. The rollup reads
`PICKED` picks only, so a cancelled pick simply never contributes and the derived figure
self-corrects (`:36-45`).

### Force-finish can skip `PICKED`

The delivery order therefore stays at `STARTED(500)` after a force-finish. If the pick order
landed on `PICKED`, packing is openable, and `PackingService.pack` ends by calling
`markPacked`, which is `progressIfBehind` and so performs `STARTED(500) → PACKED(650)` in one hop
(`.../orders/service/DefaultOrderProgressionPort.kt:58-60`, `:74-79`).

`OrderState.canAdvanceTo` is forward-only, not step-by-step, so this is legal by construction and
nothing flags it. A delivery order can therefore reach `SHIPPED` having never been `PICKED`.
Anyone filtering or reporting on `state == PICKED` to mean "picking is done" will miss these.
The mechanism is deliberate; whether this particular outcome is intended is not recorded.

The one pairing that *is* guarded is a cancelled delivery order with a `PICKED` pick order -
which the cancel cascade produces in a single call. `PackingService.openPacking` closes it with a
guard keyed on the **delivery order's** state rather than the pick order's
(`.../service/PackingService.kt:70-78`, `:90-94`).

## Extinguish picks

`ExtinguishService` (`.../service/ExtinguishService.kt:25-46`) generates stock-clearance picks:
one `Pick` per stock unit for its full `availableAmount`, or every stock unit on a unit load,
reserved *before* the row exists.

There is no `OrderStrategy` and no `DeliveryOrder`. `PickOrder.deliveryOrderId == null` is the
marker, the order number is prefixed `EXT-`, and every pick is stamped
`pickingType = "EXTINGUISH"`. An open extinguish order for the same client is topped up rather
than duplicated.

The null `deliveryOrderId` is what routes an extinguish short-confirm down the release-only
branch, and wave batch pick orders use the same marker. That is worth knowing because it means
`deliveryOrderId == null` on a pick order has two different meanings depending on whether
`waveId` is set.

One consequence of `pickingType = "EXTINGUISH"` being a string on the row: the commercial
demand-forecasting engine reads `karyo.picks` directly and filters `picking_type <> 'EXTINGUISH'`
in native SQL, so renaming the literal would break a reader the build cannot see. See
[the couplings the module graph does not show](../architecture/modules-and-boundaries.md#three-couplings-the-module-graph-does-not-show).

## Waves, briefly

The commercial wave engine adds wave-based bulk fulfilment. The engine is not in this
repository, but the pick-order side of it is (`WavePickService`), and its interaction with this
document is limited to three things:

- a wave-linked pick order carries `waveId`, and may or may not carry `deliveryOrderId`;
- `HYBRID` mode routes `COMPLETE` lines to ordinary per-order pick orders and `PICK` remainders
  to cross-order batch orders, which ride the same tasks board as normal `PICK` work - no new
  `WorkType`;
- every confirm on a wave-linked pick fires `WavePickActivityEvent`, not only completions,
  because a wave progress UI wants live activity (`PickOrderService.kt:460-479`).

Wave internals - selection rules, allocation shortage actions, consolidation, sort stations -
belong to the wave engine and are not described here.

## Related

- [Allocation and reservation](allocation-and-reservation.md) - where planned picks come from
- [Packing and shipping](packing-and-shipping.md) - what a completed pick order becomes
- [Work allocation](work-allocation.md) - how a pick order reaches an operator
- [Commercial engines](../commercial/README.md) - what the wave engine adds
