# Putaway and location finding

Putaway is two mechanisms bolted together: a task lifecycle in the task module, and a placement
algorithm in the layout module. They meet at one SPI call.

## The trigger

`TaskService.onGoodsReceiptLineReceived` observes `GoodsReceiptLineReceivedEvent`
(`services/task-service/karyo-tasks-core/.../service/TaskService.kt:119-144`) and creates one
`PUTAWAY` transport order per received line. It runs at
`TransactionPhase.AFTER_SUCCESS` in its own `REQUIRES_NEW` transaction, because the unit load
and stock must be visible to the inventory lookup - which they are not until the receiving
transaction commits (`:110-112`).

Four conditions make it return early, in order:

1. **`event.qaHold`** - held stock is not ready to put away (`:123-126`).
2. **A cross-dock order already exists for the line.** When the cross-docking engine is
   installed, its interceptor runs *synchronously inside* the receiving transaction, so by the
   time this observer runs the lookup is authoritative. An unresolvable
   `Instance<CrossDockLookup>` means the engine is not installed, which means nothing was ever
   intercepted (`:127-133`).
3. **A task already exists for the line** - idempotency, keyed on `goodsReceiptLineId`
   (`:134-137`).
4. **The unit load cannot be found** - logged at WARN and skipped (`:138-142`).

The phase split between the two consumers of the same event is the interesting part, and it is
the one architectural decision that shows up as functional behaviour: cross-dock must claim the
line *inside* the receipt transaction so that putaway, running strictly after commit, can see
the claim and stand down. [Events and the outbox](../architecture/events-and-outbox.md)
describes the mechanism; this is what it buys.

Auto-putaway is **always on** for non-held lines. It is hardcoded, not configurable, and the
KDoc says so explicitly and names a future `ReceivingStrategy` as the place tunability would go
(`:113-117`).

## Task creation, and what happens when there is nowhere to go

`createPutawayTask` (`TaskService.kt:170-198`) persists the order, transitions it to `CREATED`,
then asks the finder:

- **`Found`** - the suggestion is stamped and the order goes to `RELEASED`, i.e. into the work
  queue.
- **`NoLocation`** - the order **stays `CREATED`** with the reason in `note`. The comment states
  the intent: "Keep the work: surface it in the queue (CREATED, unreleased) with a reason"
  (`:192-196`).

That is a real behavioural distinction, and following it through shows the intent does not hold.
A `CREATED` transport order is not claimable: `TaskService.assign` requires `RELEASED`
(`:433-435`), and the work provider's claimable query filters on the same. The re-resolve that
was written for exactly this case runs on `start`:

```kotlin
if (order.transportType == TransportType.PUTAWAY && order.suggestedLocationId == null) {
    reResolveSuggestion(order)
}
```
`TaskService.kt:535-537`

but `start` needs `RESERVED`, which needs `assign`, which needs `RELEASED`. `TransportOrderResource`
exposes list, get, create-manual-move, assign, start, complete, cancel, pause and resume
(`.../api/v1/TransportOrderResource.kt:43-117`) - **no endpoint releases a `CREATED` order and none
sets a destination on an existing one**. And `suggestedLocationId` is never written back to
`null` anywhere in the codebase, so the guard's other half - "or a since-gone one", per its own
KDoc (`TaskService.kt:755-757`) - cannot fire either.

**Known defect.** An unplaceable pallet leaves a task that can only be cancelled, and the
operator's real recovery is to cancel it and raise a manual `MOVE` with an explicit destination.
The work is not lost, but it is not resolvable in place the way `createPutawayTask`'s comment says
it is, and `reResolveSuggestion` is unreachable in the shipped call graph. A comment in
`OccupancyMixReader.kt:45-50` reasons about the same call site from a different angle -
self-exclusion - and concludes it is "currently unreachable" for that narrower reason, without
noticing this one.

## The finder

`LocationFinderService` plays two roles at once (`.../layout/service/LocationFinderService.kt:32-42`):
it is the public `LocationFinder` facade, and it is the lowest-priority `PutawayLocationStrategy`,
the built-in algorithm that runs last and always has an opinion.

The facade runs the strategy chain in ascending priority and takes the first non-null result
(`:142-152`). A custom strategy at any lower priority pre-empts the built-in entirely, and owns
its own reservation semantics.

### The fourteen filters

The full list is in the class KDoc (`LocationFinderService.kt:43-59`).

Six run as SQL predicates in one query
(`StorageLocationRepository.findPutawayCandidates:250-289`):

```
l.lockType = 0
and l.allocation < 100
and l.allocationState = 0
and not exists (select 1 from FixAssignment f where f.location = l)
and a.usages like :usage
and (t.liftingCapacity is null or t.liftingCapacity = 0 or t.liftingCapacity >= :weight)
```

plus the zone predicate and the ownership predicate, ordered `allocation asc, name asc`.

The remaining eight run in-service over the SQL survivors, each batched: active-reservation fold,
`TypeCapacityConstraint` compatibility and capacity, static client mixing, `StorageArea`
restriction and FIFO/full-area hiding, field/section group lifting capacity, and the two
occupancy-plus-in-flight-transport mixing passes (client and item).

Two of these deserve emphasis because they change results silently.

**No configured areas means no restriction at all.** If the resolved strategy has no
`StorageStrategyArea` rows, filter 9 imposes nothing. That is deliberate: requiring
`locationCluster IS NOT NULL` instead "would silently exclude every cluster-less location in an
existing deployment" (`LocationFinderService.kt:72-81`).

**The lifting-capacity predicate does not count what is already there.** Filter 5 compares the
type's cap against the incoming weight alone. Only the field/section *group* rollups (filter 10)
add already-occupied weight, and only where the location type defines those columns. This is a
known gap.

### Ordering, and who gets the last word

Default order is effective allocation ascending (emptiest first), then location name ascending
as a stable tie-break. `strategy.sorts` and `nearPickingLocation` layer a typed comparator chain
on top, and `useAreaStrategyDate` prepends the strategy's area order
(`LocationFinderService.kt:91-104`, `CandidateOrdering`).

Then the SPI `LocationFilter` chain runs, and **its order is honoured verbatim**: the finder
takes `first()` and does not re-sort (`:106-107`, `resolveViaSpiFilters:315-323`). Stock
selection honours its own filter chain's order the same way, so both seams behave alike.

### Strategy resolution

Three rungs, in order (`LocationFinderService.resolveStrategy:343-373`):

1. the request's `storageStrategyId` - for auto-putaway, the receipt line's validated per-line
   override, persisted on the transport order so a later re-resolve replays it;
2. the incoming product's `defaultStorageStrategyId`;
3. `null`.

The third rung is a deliberate absence: Karyo does not auto-create a fallback strategy, because
what such a strategy's fields should be, and whether one is seeded per client, is a product
decision that has not been taken (`:353-356`).

Whichever rung produces the id, ownership is checked. A foreign or missing strategy resolves to
`null` and the finder falls back to `mixClient = false` and no zone - fail-closed. The reasoning
is spelled out: without the check, naming or *inheriting* another client's strategy with
`mixClient = true` disables the segregation guard outright and returns that client's dedicated
locations (`:357-368`).

Defaults when no strategy resolves: `mixClient = false`, `mixItem = true`,
`onlyClientLocation = true` (`:631-639`). The last keeps a strategy-less putaway owner-scoped, so
reaching a shared `client_id = 0` location is an explicit opt-in rather than a silent fallback.

### `manualSearch`

A strategy with `manualSearch = true` short-circuits the entire search **before any candidate
query is built**, returning `NoLocation` with a reason (`:213-226`). The task module's
"keep the work" fallback is then the manual placement flow. The same flag also bypasses
`findAddToLocation` (`:169-179`).

## Soft reservations

A `Found` result writes a `LocationReservation` row so two concurrent putaways are never handed
the same nearly-full location (`reserve:329-339`):

- **key** - the transport order id, so the caller can release by the same key;
- **load** - `percent = 100`;
- **TTL** - 10 minutes.

The 100 is `ALLOCATION_PER_UL` (`LocationFinderService.kt:629`): one unit load fully reserves a
location, mirroring the fixed 100%-per-unit-load allocation model. The whole capacity model is
one unit load per location; `TypeCapacityConstraint` is the only thing that varies that, and it
varies it per (location type, unit-load type) pair rather than per location.

Effective allocation is `location.allocation + Σ(active reservation percent)`, and filter 3 drops
anything at or above 100. So one in-flight putaway makes a location invisible to the next one,
regardless of how much room is physically left.

Reservations are released three ways: explicitly on task complete and on cancel
(`TaskService.kt:646`, `:705`), and by a 60-second sweeper that reaps anything past `expiresAt`
so a crashed putaway never permanently blocks a location
(`LocationFinderService.sweepExpiredReservations:186-193`).

The TTL is a real operational edge and both places that could hide it say so instead. Pausing a
task keeps its operator and its suggestion, but "kept" is bounded by the TTL, not indefinite: a
pause that outlasts ten minutes loses the slot to the next putaway, and resume finds a stale
suggestion (`TaskService.kt:452-459`). The same caveat is repeated for area replenishment
(`:310-314`).

### The candidate cliff

`CANDIDATE_FETCH_LIMIT = 200` (`LocationFinderService.kt:627`). The SQL fetches at most 200
rows, ordered by *base* allocation, and every in-service filter then runs on those 200 only.

**Known defect.** If all 200 are excluded by the in-service passes - a strategy's area
restriction, a type-capacity constraint, group lifting capacity, client or item mixing, or an SPI
filter - the finder returns `NoLocation` even though location 201 would have qualified. The
over-fetch is described in a code comment as existing so "reservation load (filter 3 tail) can
drop some without starving the result" (`:232-233`), which covers one of the eight in-service
passes. Why the cap is 200 is not recorded.

## The rest of the transport-order lifecycle

Putaway shares its entity, `TransportOrder`, with four other transport types
(`karyo-tasks-api/.../vo/TransportType.kt:25-31`): `MOVE` (ad-hoc operator move), `REPLENISH`,
`TRANSFER` (a multi-hop chain successor) and `CROSS_DOCK`. They share one state machine, one
work provider and one order-number sequence - the prefixes `TO`/`MV`/`RP`/`XD` vary, the
sequence name does not (`TaskService.kt:775-784`).

`CREATED → RELEASED → RESERVED → STARTED → FINISHED`, plus `CANCELED` pre-`STARTED`.
`RESERVED → RELEASED` (giving the task back) is the one backward move, and it is done by writing
the field directly and re-emitting the event, because `TransportOrderEmitter.transition` is
forward-only and would refuse it. The bypass is deliberate and documented at the site
(`TaskService.kt:492-504`).

`pause` is orthogonal to state: it stamps `pausedAt` and `state` never moves
(`:444-479`). The window is every pre-terminal state, wider than the goods receipt's, because
the queue-and-claim lifecycle has two parking points - `RELEASED` (queued) and `RESERVED`
(claimed, not started). The KDoc also records a deliberate observability gap: **no event and no
outbox row is written on pause or resume**, even though every state transition streams to the
outbox, "because pause is orthogonal to state by design and was never meant to appear in that
stream" (`:459-462`).

Cancel is deliberately *not* pause-guarded, unlike assign/start/complete: "pause is an
operator's 'step away', not a lock against the task being pulled from the queue entirely"
(`:653-658`).

`complete` has four shapes (`:587-651`): whole unit load to the suggested or an overridden
location; confirm-merge onto an existing unit load; a partial confirm; and, mid-complete, a
possible `TRANSFER` chain successor if the destination is a transfer-staging area and the order
still carries a different real target. The two destination shapes are mutually exclusive - both
supplied is a 400.

## Related

- [Receiving and quality holds](receiving-and-quality-holds.md) - where the trigger comes from
- [Replenishment](replenishment.md) - the other producer of transport orders
- [Work allocation](work-allocation.md) - how a released task reaches an operator
