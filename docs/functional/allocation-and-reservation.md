# Allocation and reservation

Allocation is where a promise to a customer becomes a claim on a specific pallet. It is one
algorithm, `StockSelectionService`, wrapped by one bookkeeping layer, `DefaultStockReserver`,
and reached from four places: delivery-order release, the PENDING retry, short-pick recovery,
and wave release by the optional wave engine.

## The order side

`OrderService.release` (`services/order-service/karyo-orders-core/.../service/OrderService.kt:259-278`)
is the entry point. It requires state `CREATED`, runs every `OrderReleaseValidator` extension,
transitions the order to `RELEASED`, then reserves per line.

Each line ends `PROCESSABLE` if `shortage` is zero, `PENDING` otherwise
(`:273-274`). The order is promoted to `PROCESSABLE` only when **every** line is
(`promoteIfFullyReserved:486-490`). A shortfall is therefore an ordinary, first-class outcome:
the order sits at `RELEASED` with a shortage report in the response, not an error.

`retryReservation` (`:295-310`) is the sanctioned backward hop. `OrderState.canAdvanceTo` has one
non-forward rule, `PENDING → PROCESSABLE`/`RESERVED`
(`karyo-orders-api/.../vo/OrderState.kt:51`), and this is the method that uses it: re-reserve
only the `PENDING` lines, promote if that clears the last one.

Each reserved slice is recorded as an `OrderLineReservation` row keyed `(lineId, stockUnitId)`
(`OrderService.reserveLine:473-481`). That ledger is what makes cancellation safe - see
[Cancelling an order](#cancelling-an-order).

## The strategy

Every knob the selector honours comes from an `OrderStrategy`
(`.../domain/model/OrderStrategy.kt`): `useLockedStock`, `preferComplete` (default `true`),
`preferMatching`, `completeHandling`, `enforceLot`, plus the downstream picking and packing
flags. Resolution is a chain of `OrderStrategyResolver` beans by ascending priority, first
non-null name wins, falling back to the seeded `DEFAULT` (`OrderStrategyService.resolve:78-85`).

**`OrderStrategy` is instance-wide, not per goods owner.** It extends `BaseEntity`, not
`TenantEntity`, its `name` is globally unique, and `OrderStrategyRepository.findByName` takes no
`clientId` (`OrderStrategy.kt:10-22`, `OrderStrategyRepository.kt:10-11`). The entity KDoc gives
the reason: "no clientId - silo tenancy makes the company implicit".

That reason is true and incomplete. In a silo the *company* is implicit, but the *goods owner*
is not - `clientId` is the goods owner, and the same instance keeps `StorageStrategy`,
`FixAssignment` and `ItemDataArea` per goods owner and fails closed on a foreign one
([putaway](putaway-and-location-finding.md#strategy-resolution)). So one silo hosting several
goods owners gives them all one set of allocation, short-pick and packout rules, editable by
anyone holding `order-write` (`.../api/v1/OrderStrategyResource.kt:39-49`) - a normal write role,
not an admin one. Why `OrderStrategy` is scoped differently from `StorageStrategy` is not
recorded beyond that KDoc line.

## The selector

`StockSelectionService.selectStock`
(`services/inventory-service/karyo-inventory-core/.../service/StockSelectionService.kt:41-123`)
is the algorithm. What follows is its shape and its edges.

### Hard exclusions

Before anything else, an inactive product returns an empty result outright
(`:43-49`) - the projection is maintained by a product-event observer rather than a
cross-module call at selection time.

Every candidate query then filters `state = 300 and amount > reservedAmount`, plus
`lockType = 0 and unitLoad.lockType = 0` unless locked stock was explicitly requested
(`StockUnitRepository.findForSelection:52-63`). There is no area or location predicate; see
[stock model](stock-model-and-states.md#on_stock-is-the-whole-gate).

### FIFO

Within every pass: `strategyDate asc, amount asc, created asc, id asc`
(`StockUnitRepository.kt:69`). `strategyDate` is set from `bestBefore` at receipt, so FIFO is
really FEFO where a best-before exists and creation order where it does not.

### Two pre-passes, then thirteen

1. **`preferMatching`** - the first eligible unlocked unit whose available amount *exactly*
   equals the demand wins. Skipped when `completeHandling` is active, because the complete-only
   contract is the stronger constraint (`StockSelectionService.selectStock:59-68`). Locked stock
   is never admitted here, "preferMatching is a preference, never an override of the lock safety
   fence" (`:270-275`).
2. **`completeHandling`** - any non-`NONE` mode searches strict complete unit loads and then
   **returns**, never falling through to the partial passes (`:70-81`). Complete-or-nothing.
3. Otherwise, up to thirteen baseline passes accumulating `min(available, remaining)` from each
   survivor until the demand is covered.

`CompleteHandling` has six modes (`karyo-inventory-api/.../vo/CompleteHandling.kt:12-32`):
`NONE`, first-exact, first-at-or-above, and three combinatorial modes solved by a bounded DFS
`Optimizer` capped at a candidate count and a node count, with both truncations logged so a
suboptimal answer is observable rather than silent (`.../service/Optimizer.kt:19-21`, `:41-47`).

"Strict complete" means unopened, wholly unreserved, single-stock, and a unit-load type that
permits `COMPLETE` usage (`StockSelectionService.isStrictComplete:304-308`). It does not check
that the unit load sits in a storage area or off a fixed location: selection does not consider
location at all (`:299-303`).

### The thirteen passes are six queries

`getCandidatesForPass` (`StockSelectionService.kt:143-177`) varies exactly two things: whether
locked stock is included (passes 10-11) and whether the lot filter applies (passes 1, 3, 6, 8, 10,
12). Passes 3-5 repeat 1-2, passes 8-9 repeat 6-7, and passes 12-13 repeat 6-7. Six distinct
repository scopes are executed thirteen times. Why the loop runs thirteen passes over six scopes
is not recorded.

The code's own KDoc says otherwise: `getCandidatesForPass`'s pass map labels passes 3, 4 and 8
"relaxed" and passes 5, 12 and 13 "fallback" (`StockSelectionService.kt:128-142`), distinctions
the method does not implement. Duplicated results are harmless - `selectedIds` skips them - but
the cost is seven redundant database round trips per selection, and a reader who trusts the KDoc
will look for behaviour that is not there.

### Lot is a preference, not a rule

Lot-filtered and any-lot passes alternate, so if the requested lot cannot satisfy the demand,
selection crosses into other lots. `enforceLot = true` with a supplied lot skips every any-lot
pass and returns short instead (`getCandidatesForPass:150-151`).

The order of the passes produces a result that surprises people. Ask for 50 of lot `LOT-7` with the
defaults (`preferComplete` on) against three units, oldest first: S4, `LOT-7`, 30 available; S5,
`LOT-9`, 100 available; S6, `LOT-7`, 10 available. Pass 1 looks for a complete-coverage candidate
in `LOT-7` and finds none; pass 2 looks for complete coverage in any lot and takes all 50 from
S5. The requested lot is bypassed entirely even though 40 units of `LOT-7` sit on the shelf,
because complete-coverage preference outranks lot preference in pass order. With
`preferComplete` off, the partial `LOT-7` pass takes S4 and S6 first and S5 covers only the
remaining 10; with `enforceLot` on, the response stays short at 40.

Note also that `completeHandling` applies the supplied lot to its single strict query and never
falls back to another lot regardless of `enforceLot` - so the two flags interact differently
depending on which path runs (`:82`).

### The fixed-slot ceiling

A `FixAssignment` may carry a `maxPickAmount`. When one exists for this product at a candidate's
location and it is **less than what is still needed for the whole request**, the slot is skipped
for that pass (`exceedsFixCeiling:224-227`). It is not permanently excluded: a later pass may
re-offer it once other picks have shrunk the remainder to or below the ceiling.

The comparison is deliberately against the outstanding request, not against the per-unit take,
and the reasoning is recorded at the site (`:216-223`). The ceiling applies at all three entry
points - the baseline loop, `preferMatching` and `completeHandling` (`:202-208`, `:276-282`,
`:310-318`).

### `excludeStockUnitIds` does not reach the pre-passes

`excludeStockUnitIds` is filtered inside `getCandidatesForPass` (`:166-169`) and **nowhere else**.
`exactMatchCandidate` and `selectCompleteHandling` each call `findForSelection` directly and
never apply it (`:284-297`, `:320-336`).

**Known defect.** The consequence is concrete, because the one production caller that sets the
parameter is short-pick recovery. `PickOrderService.coverWithFollowUps` passes the just-short
source in `excludeStockUnitIds` **and** passes the strategy's `preferMatching` and
`completeHandling` straight through (`.../fulfillment/service/PickOrderService.kt:597-609`).
Under a strategy with either flag on, the exclusion is silently ignored and the follow-up can
re-select the very unit that just came up short - which is exactly what the parameter exists to
prevent.

## Holding a reservation

`DefaultStockReserver.doReserve`
(`.../inventory/service/DefaultStockReserver.kt:44-87`) runs selection, then walks the result
calling `StockService.reserveStock` per unit, accumulating `ReservedStock` slices and returning
whatever it could not cover as `shortfall`.

`reserveStock` (`StockService.kt:605-640`) refuses a locked unit and refuses when
`availableAmount < amount`, journals a `CHANGED` row with the delta, and publishes a
`RESERVE` amount event. A unit that has become unreservable between selection and reservation is
caught, logged and skipped, "and let the remainder surface as shortfall"
(`DefaultStockReserver.kt:74-83`).

Release refuses to release more than is actually reserved, rather than clamping to zero, and the
reason is recorded at the site (`StockService.kt:642-649`): a silent clamp would let a caller's
over-release walk `reservedAmount` past zero and consume another party's live reservation on the
same stock unit without any signal - a delivery-order cancel silently stealing another order's
reservation, for example. Refusing also keeps the journal truthful: the amount it records is
always the amount applied.

The explicit-`clientId` overloads exist for scheduler-driven callers, and they distinguish a
*foreign* stock unit from a *missing* one: a unit that exists but belongs to another client
throws `Forbidden` rather than being folded into "not found", "so a caller bug (unprimed ambient
context, wrong clientId) fails loudly instead of leaking as a permanent `reservedAmount` drift"
(`DefaultStockReserver.kt:189-202`).

### What happens when two orders race

There is no pessimistic lock on `StockUnit`. Two transactions can both read the same unit with
`availableAmount = 10`, both pass the sufficiency check, and both write. `@Version` on
`BaseEntity` means only one commits; the other fails the version check at flush.

Nothing catches that. `doReserve` catches `InventoryException` only, and each of the sixteen
`ExceptionMapper` implementations in this repository is typed to one specific exception - none
covers `Throwable`, `Exception`, `RuntimeException` or optimistic locking - so the failure reaches
the JAX-RS default and becomes a 500. There is also no retry: nothing in this repository retries
an optimistic-lock failure.

**Known defect.** The correctness is right - stock is never double-booked - but the outcome the
API models for "you cannot have all of it" is `ReservationOutcome.shortfall`, and a lost race
produces something else entirely.

## Cancelling an order

`OrderService.cancel` (`OrderService.kt:331-373`) is the most carefully ordered method in the
module, and the ordering is load-bearing:

1. **Cascade first.** Cancel is legal up to `PENDING(550)`, which includes a `STARTED(500)` order
   already released to picking, so `PickCancelPort` force-finishes the still-open pick work -
   otherwise the pick order stays claimable and its picks stay confirmable against a reservation
   this method is about to give away.
2. **Then release only the unhandled remainders**: each recorded `OrderLineReservation` slice
   minus what terminal picks on that same (line, stock unit) already consumed or released,
   floored at zero (`unhandledRemainders:405-421`).

JPA auto-flushes before the terminal-slice query, so the picks cancelled in step 1 are already
terminal - and thus already netted out - in step 2 (`:328-329`). Releasing the full recorded
slice instead would double-release, which is the defect the refusal in `releaseReservation` also
guards against independently.

## Related

- [Picking](picking.md) - what a reservation becomes
- [Stock model and states](stock-model-and-states.md) - `availableAmount`, locks, versioning
- [Strategies and policies](../configuration/strategies-and-policies.md) - who configures an
  `OrderStrategy`
