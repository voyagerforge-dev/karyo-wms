# Stocktaking

Counting is a four-level hierarchy: an optional `CountCampaign` groups `CountSession`s, each
session generates one `CountOrder` per location, and each order holds one `CountLine` per stock
unit found there at generation time.

## Two count types, one rule

`CountType` is `CYCLE` or `END_OF_PERIOD`
(`services/stocktaking-service/karyo-stocktaking-api/.../vo/CountType.kt:3-4`). The class KDoc
states the split precisely (`.../service/StocktakingService.kt:51-59`):

- **`CYCLE`** counts a caller-selected scope and **refuses the whole start** if any location in
  it holds reserved stock or is already locked - "the operator is expected to have picked a
  countable set".
- **`END_OF_PERIOD`** counts every location the tenant owns, empty ones included, and **skips**
  an uncountable location, reporting it in `skippedLocations` - "because one reservation must not
  be able to veto an annual inventory".

The rule is the same either way - a location that cannot be counted is not counted - and only the
remedy differs. A shared (`client_id = 0`) location is never in a tenant's scope.

The scope strategy is **always resolved by name**: `EXPLICIT` (or the caller's
`scopeStrategy`) for a cycle count, forced to `FULL_WAREHOUSE` for an end-of-period one. Never
unnamed, because `FullWarehouseScope` outranks `ExplicitLocationScope` on priority and an unnamed
resolve "would silently escalate every plain cycle count into a warehouse-wide freeze"
(`:109-113`). That is a nice example of a priority-ordered SPI being a trap when one
implementation is strictly larger than another.

## What "freeze" means

There is no separate freeze switch. The freeze **is** the per-location `STOCKTAKING` lock plus
the per-stock-unit lock that every generated order takes at start and releases at
`finishOrder`/`cancelOrder` (`:61-66`). A full inventory is frozen for exactly as long as its
orders are open, location by location, and a skipped location is never frozen at all.

That guarantee is enforced rather than asserted, and the mechanism is worth understanding:
`LocationService.lockLocation` overwrites a lock unconditionally, so a second session generated
for an already-frozen location would have released the first session's freeze the moment it
finished - a silent thaw mid-inventory plus a double count. `startCount` therefore snapshots the
pre-existing locks **before** taking any of its own (`:157-172`) and refuses (`CYCLE`) or skips
(`END_OF_PERIOD`) on that snapshot.

The reserved-stock guard lives in `generateOrderForLocation` rather than in the callers
"so it can never be skipped by accident: the `END_OF_PERIOD` path simply never reaches it, having
filtered those locations out first" (`:228-233`, `:243-245`).

`END_OF_PERIOD` is "a real, lockable, closable session" (`:77-79`): it freezes what it counts
and it closes out.

## Walking order

Locations are re-sorted `orderIndex NULLS LAST, name` immediately after the scope resolves, before
any order is generated, so their `created` timestamps land in walking order (`:115-118`).

The ordering guarantee is then entirely a *dispatch-time* property: `CountOrderRepository`'s
claimable query carries no `ORDER BY`, and `StrictPriorityDispatchStrategy`'s `createdAt ASC`
tiebreak re-sorts the merged pool in memory. Since every generated count order carries the same
priority, that tiebreak is the whole ordering for a count-only pool (`:115-128`).

The limit is stated honestly at the same site (`:130-135`): `created ASC` preserves walking order
only **within one `startCount` batch**. The pool an operator pulls from merges every open order
across every session for the tenant, so two overlapping sessions interleave by `created` in a way
that no longer walks the floor. `TravelPathDispatchStrategy` is the opt-in seam that re-derives
it at dispatch time - see [work allocation](work-allocation.md#dispatch-strategies).

## The scale ceiling

`startCount` is one `@Transactional` call: N location reads, N order inserts, one line insert per
stock unit, in a single transaction that also holds the write locks. The KDoc states the bound
rather than hiding it (`:81-86`):

> At the scale this targets (a demo warehouse is ~40 locations; a real single-site WMS is
> hundreds) that is fine. It is NOT batched or chunked, so a warehouse in the tens of thousands
> of locations would need that work - deliberately not built ahead of a caller (YAGNI), not
> overlooked.

## Counting

`submitCount(orderId, inputs)` (`:408-463`) requires the order in `GENERATED`, then:

- **A zero-line order is refused.** Without the refusal it would fall through as a silent no-op
  auto-finish: an empty line list trivially satisfies every loop, `allMatched` stays true, and
  the order finishes with no operator intent recorded anywhere. The refusal points at the
  sanctioned confirm-empty operation instead (`:416-427`).
- **An input for a line that is already off `PLANNED` is refused, not discarded.** The floor PWA
  submits an amount for every entry line with no notion of "already counted", so without this a
  real count would vanish underneath a web-triggered zero and `accept` would delete stock that
  was actually there (`:430-442`).
- Each `PLANNED` line takes its input and becomes `COUNTED`. A line whose counted amount equals
  its planned amount is journalled `COUNTED` and moves straight to `FINISHED`; anything else stays
  `COUNTED`, flagged for review.
- The order advances to `COUNTED`, and if every line matched, `finishOrder` runs immediately -
  releasing every lock and possibly closing the session.

Two operator escapes exist, both zeroing lines without finishing the order:

- **`unitLoadMissing`** (`:482-495`) - every still-`PLANNED` line for that unit load is counted at
  zero and moved to `COUNTED`, and **the order state is deliberately left unchanged** so the
  operator can keep counting the rest of the location. Idempotent on lines already off `PLANNED`,
  but a 404 if the unit load never had a line on this order - "that's the 'not on this order' case
  the caller actually needs surfaced, as opposed to 'already handled'".
- **`locationEmpty`** (`:522-536`) - a zero-line order finishes directly; an order with lines
  zeroes them all and goes to `COUNTED` for review, "a discrepancy this large still needs
  `accept`". On the zero-line branch there is deliberately no journal call, because every journal
  row is written against a stock unit and there is none - the finished order plus the stamped
  `lastCountedAt` "*are* the audit trail for this confirmation, honestly, not a gap being papered
  over" (`:505-513`).

## Review

`accept` (`:549-562`) requires `COUNTED`, applies `StockCountingPort.applyCount` for every
still-`COUNTED` (i.e. discrepant) line, marks them `FINISHED`, and finishes the order. Lines that
matched exactly during submit are untouched.

`applyCount` (`.../inventory/service/DefaultStockCountingPort.kt:101-109`) adjusts the amount,
journals `COUNTED`, and - when the counted amount is zero - soft-deletes the stock and trashes the
unit load if it is now empty. That trash is what releases the location's allocation, via
`UnitLoadTrashedEvent` and layout's observer (`:86-93`).

`recount` (`StocktakingService.kt:573-593`) cancels the current order, releasing every lock, and
regenerates a fresh `GENERATED` order for the same location under the same session. No inventory
adjustment is made. The session is deliberately not close-checked, "since a fresh non-terminal
order is generated in the same breath".

`cancelOrder` (`:609-615`) is the same thing without the replacement - and deliberately does
**not** call `markCounted`, because nothing was counted there.

## What a count cannot record

`CountLine` rows exist only for stock the snapshot found:
`DefaultStockCountingPort.findStockAtLocation` walks the unit loads at the location and emits one
`CountableStock` per non-`DELETABLE` stock unit (`DefaultStockCountingPort.kt:37-59`). Every
downstream operation - submit, unit-load-missing, location-empty, accept - works over those rows.

`StockCountingPort` has five methods - `findStockAtLocation`, `lockForCount`, `releaseCount`,
`applyCount`, `recordMatchCounted`
(`karyo-inventory-api/.../spi/StockCountingPort.kt:7-11`). **None of them creates stock.** And the
REST surface is
`count`, `unit-loads/missing`, `accept`, `recount`, `cancel`, `location-empty`
(`.../api/v1/StocktakingResource.kt:82-139`) - nothing that adds a line.

**Known defect.** An operator who finds a pallet the system does not know about, or finds more of
a product than any line covers, has no way to record it through stocktaking. The count can
reduce, zero or adjust known stock; it cannot book a surplus. The remedy is outside the count
entirely - `POST /api/v1/stock-units` or a blind goods receipt - which leaves the discrepancy
unlinked to the count that found it. Whether the omission is deliberate is not recorded.

## Related

- [Stock model and states](stock-model-and-states.md) - the `STOCKTAKING` lock and soft deletion
- [Work allocation](work-allocation.md) - how count orders reach an operator
