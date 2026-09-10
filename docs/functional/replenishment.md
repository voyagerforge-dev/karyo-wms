# Replenishment

Replenishment moves stock from reserve into a location that is running low. Karyo has two
independent modes with disjoint provenance and disjoint duplicate guards, both driven from one
scan.

## The two modes

**Mode 1 - fix face.** A `FixAssignment` binds one product to one location with `minAmount`,
`maxAmount` and `desiredAmount`. When on-hand falls below `minAmount`, a `REPLENISH` transport
order is raised to top it up.

**Mode 2 - area.** An `ItemDataArea` binds one product to a `StorageArea` with `plannedAmount`
and `plannedStocks` targets across the area's whole cluster set. When either target is missed,
one order is raised to bring stock into the area.

Both mint `TransportType.REPLENISH` with the `RP` order-number prefix. They are told apart by
which provenance column is set: `fixAssignmentId` for Mode 1, `itemDataAreaId` for Mode 2
(`services/task-service/karyo-tasks-core/.../service/TaskService.kt:290-299`). Reusing the
enum value was deliberate - no new `TransportType`, so every existing filter keeps working
unchanged.

## The scan

`ReplenishmentService.scan(clientId)`
(`services/replenishment-service/karyo-replenishment-core/.../service/ReplenishmentService.kt:47-87`)
runs Mode 1 over every fix assignment, then Mode 2 over every item-data area. The ordering
between them is arbitrary and the code says so - the modes are independent, and fix-face first
"simply matches this method's pre-existing shape".

One thing is shared across the whole scan: `claimedUnitLoadIds`, seeded from every open
`REPLENISH` order's source unit load and grown with each newly minted order, so two deficiencies
found in the *same* scan can never claim the same pallet (`:61-66`). Each query snapshots the set
with `.toSet()` rather than passing the live mutable reference, because the set keeps growing for
later assignments (`:127-130`).

## Mode 1: what triggers

`processFixAssignment` (`:100-167`) has four skip conditions, each an early return.

**A null `currentAmount` is skipped, never treated as zero.** The field is nullable precisely to
distinguish "the stock read failed" from "there is genuinely none", and both the scan and the
read-only `needs` view exclude it rather than fabricating a `belowMin`
(`:109-115`, `:210-214`;
`karyo-layout-api/.../spi/FixAssignmentLookup.kt:39-44`).

The trigger itself is a `ReplenishmentStrategy`. The built-in:

```kotlin
override val name: String = "MIN_MAX"
override fun needsReplenishment(currentAmount, minAmount, maxAmount, desiredAmount) =
    minAmount != null && currentAmount < minAmount
```
`.../service/DefaultReplenishmentStrategy.kt:8-16`

**Known defect.** It is named `MIN_MAX` but reads only `minAmount`. `maxAmount` and
`desiredAmount` are passed in and ignored; `maxAmount` is used later, by a different method, to
size the top-up, and `desiredAmount` is read by nothing. A face with no `minAmount` configured is
therefore never replenished at all, whatever its other thresholds say.

An existing open `REPLENISH` order for the same assignment suppresses a second one
(`hasOpenReplenishment`, `ReplenishmentService.kt:117`).

### What counts as on-hand

`FixAssignmentView.currentAmount` is the `ON_STOCK`-only on-hand at the face. The area-mode
equivalent, `StockSummaryLookup.summaryInLocations`, is stricter still - it additionally requires
`lockType = 0` and `reservedAmount = 0`
(`.../inventory/repository/StockUnitRepository.kt:126-140`), and the KDoc records
`reservedAmount = 0` as a deliberate planning-strictness addition.

**Known defect.** That summary filters `su.lockType = 0` but **not** `su.unitLoad.lockType = 0`.
Selection treats the pallet lock as a read-time invariant
([stock model](stock-model-and-states.md#the-pallet-lock-is-a-read-time-invariant)), so stock on
a locked pallet sitting in an area counts towards that area's on-hand while being unpickable -
the area looks stocked and the pick fails.

## Source selection

`DefaultReplenishmentSourceSelector.selectSource`
(`.../inventory/service/DefaultReplenishmentSourceSelector.kt:37-50`) starts from the same
`findForSelection` query allocation uses - `ON_STOCK`, unlocked stock *and* unlocked pallet,
`amount > reservedAmount`, FIFO-ordered - then applies five filters and a two-tier preference. It
is read-only: no reservation, no state change.

The filters exclude: the target location itself; any excluded location set (Mode 2 passes the
whole destination area); any unit load already claimed in this scan; picking-usage locations
unless `fromPicking` is on; and anything failing the strictness rule.

**Strictness depends on the destination, not on the candidate** (`meetsStrictness:64-67`):

- replenishing a *picking* face - a candidate that is itself on a picking location may use the
  base query's loose `amount > reservedAmount`; everything else must be strict;
- replenishing a *storage* face - every candidate must be strict, whatever its own location.

"Strict" means `reservedAmount = 0` and a non-mixed unit load, where non-mixed is "exactly one
live stock row". That definition is deliberately shared with
`ConfirmVariantService.singleLiveStockOrThrow` "so the codebase has one 'is this unit-load safe
to move as a single thing' definition, not two" (`:69-74`).

**Lot is a preference, not a filter.** If the face already holds lots, matching candidates are
preferred; if none match, the full pool is used (`preferredPool:78-83`). Same posture as
allocation.

**Two tiers.** Phase A is a fix-assigned location that is *not* itself a picking location; Phase
B is everything else. The pool is already FIFO-ordered, so `firstOrNull` on each partition is
FIFO-first of that phase (`firstOfTier:111-113`).

The exclusion of picking locations from Phase A is not cosmetic. A normal pick face *is* a fix
assignment, so `fixFaceLocationIds` contains other pick faces. Without the exclusion, once
`fromPicking` is on, a candidate on another pick face would rank top-priority "and this selector
would rob one pick face to feed another" (`:91-103`). Phase A is reserved for fixed reserve or
bulk slots.

Mode 2 deliberately reuses the same reserve-first tiering, treating fix-assigned reserve slots as
the designated refill source, rather than ordering its sources by the storage strategy's cluster
set (`:105-109`).

No source is a `NO_SOURCE` shortfall on the scan result - not an error, not a retry.

## How much moves

`topUpAmount` (`ReplenishmentService.kt:201-207`) sizes the move:

```
maxAmount == null            -> null   (whole-UL move)
deficit = maxAmount - current
deficit <= 0                 -> null
requested = min(deficit, source.availableAmount)
requested < source.amount    -> requested   (a genuine partial)
otherwise                    -> null        (whole-UL move)
```

Two details matter. The cap is the source's **available** amount, not its gross - "a source
partially reserved elsewhere must never be asked to give up more than what is actually free to
move". And the partial/whole comparison is against the **gross** amount, so a fully available
source whose deficit reaches its whole amount stays a whole-UL move rather than becoming a
"partial" that leaves nothing behind.

That quantity is stamped on the transport order at mint time, and `TaskService.complete` defaults
to it when the operator supplies neither an amount nor an explicit destination
(`TaskService.kt:612-620`). The default is deliberately the mint-time snapshot rather than a live
re-read, and the reasoning is long but sound: `TransportOrder` carries no "was this capped"
flag, so a genuine cap and a stale whole-UL denormalisation are indistinguishable at that call
site, and preferring live would discard the cap and move the whole source (`:598-611`).

## Mode 2: area replenishment

`AreaReplenishmentService.processArea`
(`.../service/AreaReplenishmentService.kt:114-171`).

Deficiency is **either** threshold missing its target, not both:
`amountDeficient || stocksDeficient` (`deficientSummaryOrNull:177-186`). An area with neither
threshold configured is skipped before the stock query even runs.

**One order per area per scan.** A deficiency a single whole-UL move cannot close is left for the
next scan to re-evaluate against then-current on-hand; the method never loops within an area
(`:69-72`).

Destination choice is `chooseDestination` (`:213-221`), and its honesty is worth quoting:

> `LocationFinder` has no area or arbitrary-location-set constraint ... Rather than fabricate a
> capacity-ranked search this codebase's SPI surface does not support, `chooseDestination` picks
> the lowest-id unlocked, non-fix-face location whose base allocation plus active soft
> reservations is below 100 ... arbitrary but deterministic, with no capacity ranking.

`:78-91`. Fix faces are excluded from candidacy *before* the lock and occupancy queries run,
because a fix-assigned location inside the area's cluster is Mode 1's face; without that, a
single-location cluster that is entirely fix-assigned would let the same location receive both a
Mode 1 and a Mode 2 order in one scan (`:199-206`).

An area with no valid destination reports `NO_DESTINATION` rather than guessing.

`TaskService.createAreaReplenishment` then soft-reserves the chosen location through
`LocationFinder.reserve`, keyed by the new order's id, so a concurrent putaway avoids it
(`TaskService.kt:337`). That reservation carries the ordinary 10-minute TTL, and the KDoc says so
(`:310-314`).

### A stale claim in that KDoc

The same KDoc states:

> the area scan's own destination choice (`chooseDestination`) is occupancy- and
> reservation-blind in v1 (defect filed), so successive area scans can still re-pick the same
> location

`TaskService.kt:305-311`. It is not true. `chooseDestination` excludes both `lockedLocationIds`
and `occupiedLocationIds`, and `DefaultLocationLockPort.occupiedLocationIds` folds base
allocation together with active reservation load using the same "effective allocation" split the
finder itself uses (`.../layout/service/DefaultLocationLockPort.kt:55-70`). The code and the
stale comment sit in different modules.

Cross-dock staging is the case the comment does describe. When the cross-docking engine creates
a `CROSS_DOCK` order, its destination is never reserved: `TaskService.createCrossDock`
(`TaskService.kt:358-382`) calls no `reserve`, where `createAreaReplenishment` does. **Known
defect** - a concurrent putaway can be handed the same staging location.

## Running the scan

Two ways.

**On demand** - `POST /api/v1/replenishment/scan`, which is what a tenant that never opts in
uses.

**Scheduled** - `ReplenishmentScheduler` (`.../service/ReplenishmentScheduler.kt:50-72`),
`karyo.replenishment.auto-scan-enabled`, **default false**, interval
`karyo.replenishment.scan-interval` default `10m`, `ConcurrentExecution.SKIP`. Off by default
because the schedule is "an opt-in wrapper around the existing on-demand
`ReplenishmentService.scan`, not a behavior change for tenants that never asked for a background
sweep" (`.../service/ReplenishmentScanConfig.kt:6-11`).

The tenant set comes from `FixAssignmentLookup.clientIdsWithAssignments`, which is
`SELECT DISTINCT client_id FROM karyo.fix_assignments`
(`.../layout/repository/FixAssignmentRepository.kt:40-44`). Mode 2 runs inside `scan`, and the
scheduler only calls `scan` for clients on that list.

**Known defect.** A tenant configured for area replenishment only, with no fix assignments, is
never scanned on the schedule at all. Its on-demand endpoint still works, which is what makes the
gap quiet. `StockPurgeScheduler`, one module over, avoids the same trap by unioning *two* tenant
queries, precisely because "a client whose only remaining purge work is an empty terminal unit
load ... would otherwise never be visited at all"
(`.../inventory/service/StockPurgeScheduler.kt:32-37`).

A failure for one tenant is caught, logged at WARN and the loop continues
(`ReplenishmentScheduler.kt:64-70`).

The scheduler's KDoc records a hazard worth knowing if you write another scheduler (`:29-44`):
request scope *is* active on a `@Scheduled` thread, merely never primed with a tenant, so an
ambient `TenantContext` read silently sees `clientId = 0` rather than throwing; and `scan`'s call
graph reaches two transitive ambient reads. Both use explicit-`clientId` overloads, and an
integration test with real beans guards it, because "mocking `ReplenishmentService` hides
everything downstream of `scan`, which is exactly where this bug lived".

## Related

- [Putaway and location finding](putaway-and-location-finding.md) - the transport-order lifecycle
  a replenishment order rides
- [Stock model and states](stock-model-and-states.md) - locks and availability
