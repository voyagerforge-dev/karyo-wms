# Receiving and quality holds

How goods enter Karyo, what is checked on the way in, and what a hold actually holds.

## The two shapes of inbound

There is one receiving path with two entry shapes, distinguished per **line**, not per receipt:

- **Against expectation.** The line names an `asnLineId`. The ASN line supplies the product,
  the over-receipt guard runs against its `expectedAmount`, and the receipt is auto-bound to
  that line's parent ASN if it was not already.
- **Blind.** The line names an `itemDataId` and no ASN line. Nothing is compared against an
  expectation.

`GoodsReceiptService.resolveLineContext`
(`services/order-service/karyo-orders-core/.../service/GoodsReceiptService.kt:526-541`) is the
fork. A line with neither field is a 422 (`:572-575`).

A goods receipt may span any number of ASNs (`goods_receipt_asns`, a join table). A scalar
`asnId` request field is still accepted, as an alias folded into the set
(`GoodsReceiptService.kt:462-464`).

## The ASN

An `Asn` runs `CREATED → RELEASED → STARTED → FINISHED`, plus `CANCELED`, over the shared 18-value
`OrderState` (`karyo-orders-api/.../vo/OrderState.kt:23-41`). Only `RELEASED` or `STARTED` ASNs
can be attached to a receipt; anything else is a 409
(`GoodsReceiptService.kt:471-478`).

Cancellation is **stricter than the shared state machine**: `AsnService.cancel` refuses at or
past `STARTED` (`AsnService.kt:139`), where `OrderState.canAdvanceTo` would allow it up to
`PICKED`. The narrower gate is deliberate - once a line has been received against, the ASN is
history, not a plan.

`recordReceipt` (`AsnService.kt:240-250`) advances a line `CREATED → STARTED` on first receipt
and `→ FINISHED` when `remaining` hits zero, and pulls the ASN `RELEASED → STARTED` alongside.

Reversal takes the quantity back but **never walks state backwards**:

> Deliberately does NOT walk line/ASN state backward - `OrderState` is forward-only, so a
> FINISHED line may end with `receivedAmount < expectedAmount` after a reversal; the quantity is
> the truth, the state is the history.

`AsnService.kt:255-260`. This is the clearest statement of the model's general posture: state
records what happened, quantities record what is. A consultant reading an ASN line's state to
decide whether more is expected will be wrong after a reversal; read `remaining`.

### Unit-load pre-advice

An ASN may carry `AsnUlAdvice` rows - expected unit-load labels. On receipt, if the receipt has
**any** ASN attached, the resolved label is checked against every attached ASN's open advices
and silently matched (`GoodsReceiptService.matchUlAdvice:591-596`). A blind receipt with no ASN
attached never matches, and an unmatched label is a no-op by design: un-advised arrivals are
first-class and are never warned about. Reversing a line reopens the advice it matched
(`GoodsReceiptService.kt:425`), so re-receiving the same physical pallet re-matches.

## Receipt types

`GoodsReceiptType` is `NORMAL(0)` or `RETOUR(1)`, fixed at create and immutable afterwards -
there is no update path and the update DTO has no such field
(`karyo-orders-api/.../vo/GoodsReceiptType.kt:16-22`, `GoodsReceiptService.kt:103-105`).

RETOUR carries two rules, both enforced in the service rather than in the enum:

1. **No ASN binding.** Customer returns do not arrive on supplier ASNs, so RETOUR plus any
   requested ASN is a 422 (`GoodsReceiptService.kt:453-459`).
2. **Inspected by default.** A RETOUR line received without an explicit `lockType` defaults to
   `QUALITY_FAULT(103)` (`GoodsReceiptService.resolveLineLockType:507-509`).

That default lives at the service, not in the `StockReceiver` SPI, and the reason is recorded:
the SPI stays a policy-free mechanism ("create stock, optionally locked") that inventory honours
without knowing receiving rules (`GoodsReceiptService.kt:498-505`).

## What is checked before anything is written

`ReceiveLineValidator` runs every check before the first write
(`.../service/ReceiveLineValidator.kt:20-21`):

| Check | Refusal | Where |
|---|---|---|
| Lock type is one of `{1, 103, 202, 203}` | 422 | `ReceiveLineValidator.kt:50-54`, `:94-101` |
| `storageStrategyId` names a strategy owned by this client | 422 | `:88-92` |
| The product still exists | 422 on an ASN line, "invalid reference" blind | `:34-43` |
| `lotMandatory` satisfied | 422 | `:67-68` |
| `bestBeforeMandatory` satisfied | 422 | `:69-70` |
| `bestBefore` is not in the past | 422 | `:71-72` |

Three of these are worth calling out.

An explicit `UNLOCKED(0)` is **refused**, not accepted as a no-op, "so 'no lock' has exactly one
spelling (omission)" (`:46-49`). `STOCKTAKING(7)` is refused too - it is nonsensical at
receipt.

A product deleted after the ASN was created **fails the receive** rather than skipping
validation, because "a vanished product must never become a constraint bypass"
(`:29-33`). The ASN-bound path loads the product for the same reason: trusting the ASN line's
denormalised item fields instead would make `lotMandatory` and `bestBeforeMandatory`
unenforceable exactly where most receiving happens (`GoodsReceiptService.kt:532-536`).

There is deliberately **no minimum-remaining-shelf-life threshold**. The reason is recorded
rather than invented: `shelflife` on the product is a duration, not an acceptance threshold, and
the acceptance datum does not exist (`ReceiveLineValidator.kt:60-63`).

## Over-receipt

Receiving more than an ASN line expects is governed by two levels, and the instance level is the
stricter one.

`OverReceiptGuard.check` (`.../service/OverReceiptGuard.kt:41-52`) only fires when
`receivedAmount + amount > expectedAmount`. It then resolves
`karyo.receiving.allow-over-receipt` for the receiving client - a stored runtime property first,
the environment-driven default (`true`) last - and refuses unless **both** the per-request
`allowOverReceipt` flag and the instance knob allow it.

The composition is one-directional by design: a per-request override can never widen the
instance knob (`ReceivingConfig.kt:16-20`). The lookup only runs on an actual over-receipt, so
the normal path gains no database read.

## Finishing a receipt

`finish` (`GoodsReceiptService.kt:389-401`) promotes stock `INCOMING → ON_STOCK` through
`StockReceiver.markOnStock`, filtered to lines that are neither `qaHold` nor `reversed`.

`qaHold` is **derived, not stored**, and means *any* receive-time lock, not only a quality fault:

```kotlin
val qaHold: Boolean get() = lockType != null && lockType != LockType.UNLOCKED.code
```
`.../domain/model/GoodsReceiptLine.kt:118-120`

`markOnStock` independently skips locked and already-promoted units and logs a warning, so the
filter is belt-and-braces (`.../service/DefaultStockReceiver.kt:84-111`).

Cancellation is only possible while **no line has been received at all**
(`GoodsReceiptService.kt:433-437`), because stock cannot be un-received in bulk. Note that a
reversed line still counts: once every line on a receipt has been received and then reversed,
the receipt can no longer be cancelled and must be finished instead.

## Reversing a line

`reverseLine` (`GoodsReceiptService.kt:416-429`) is a total undo that refuses unless it can
fully reverse. It:

1. soft-deletes the stock via `StockReceiver.unreceive`, guarded by an amount-equality check -
   any pick, partial consumption or manual adjustment since receipt makes the amount mismatch
   and refuses the whole reversal (`DefaultStockReceiver.kt:113-120`);
2. decrements the bound ASN line without walking its state backwards;
3. cancels the putaway transport order **in the same transaction**, through a default-phase CDI
   observer - if that task is already `STARTED` the observer throws and the whole reversal rolls
   back (`.../tasks/service/TaskService.kt:156-168`);
4. reopens any unit-load pre-advice the line matched.

`unreceive` deliberately does **not** trash the emptied unit load, and the reason is worth
keeping: a reversal is a receiving correction, not a retirement, and the workflow re-receives
onto the same physical label immediately afterwards. Labels are globally unique and a
`DELETABLE` unit load refuses reuse, so auto-trashing would permanently burn the label
(`DefaultStockReceiver.kt:122-131`).

Terminal putaway tasks (`FINISHED`/`CANCELED`) do not block a reversal - "no live work can
conflict" - only an in-flight `STARTED` one does (`TaskService.kt:158-166`).

## Quality holds

A hold is a lock on the stock unit, applied at receipt. There is no separate hold entity, no
hold reason table, and no inspection workflow. `GoodsReceiptService`'s own class KDoc records
this as a known limitation (`GoodsReceiptService.kt:47-50`): stock received with a lock type -
`QUALITY_FAULT` for a QA hold, say - stays `INCOMING` and locked after finish. Releasing it takes
a manual inventory unlock and a manual stock state change to `ON_STOCK`; there is no release
workflow.

Held stock is also skipped by auto-putaway: the observer returns early on `event.qaHold`
(`TaskService.kt:123-126`), so no transport order is ever created for it.

### Releasing a hold

The release is two REST calls per stock unit, against endpoints that exist for general inventory
maintenance rather than for this purpose:

1. `POST /api/v1/stock-units/{id}/lock` with `UNLOCKED`
   (`.../api/v1/StockUnitResource.kt:144-148`)
2. `POST /api/v1/stock-units/{id}/change-state` with 300
   (`StockUnitResource.kt:178-182`)

What happens next is the part that matters operationally. **Nothing observes a stock state
change.** This repository contains twelve `@Observes` methods in all - two of them on Quarkus's
`StartupEvent` - and not one takes a stock state-change or lock event; `changeState` writes an
outbox row and nothing else. So after the manual release:

- no putaway task is created, and
- the stock is now `ON_STOCK` **at whatever location it was received onto**, and
- `findForSelection` has no area predicate
  ([stock model](stock-model-and-states.md#on_stock-is-the-whole-gate)),

which means released stock is immediately allocatable from the goods-in dock, and stays there
until somebody notices and raises a manual move.

**Known defect.** The KDoc records that there is no release workflow; what it does not record is
that the workaround silently makes dock stock pickable.

## Configuration seams that do not exist yet

Two things a client will ask for on day one are per-request inputs rather than policy, and both
are recorded as deferred rather than missing:

- **Auto-putaway on receipt is always on** for non-held lines - hardcoded, not a knob. Making it
  tunable (disable / immediate versus deferred / per item category) is left to a future
  `ReceivingStrategy` (`TaskService.kt:113-117`).
- **`lockType` and `allowOverReceipt` are per-request**, decided by the operator per line. If a
  strategic pattern emerges - vendor X always allows over-receipt, SKU Y always QA-holds - the
  recorded direction is to elevate them onto a `ReceivingStrategy` with a resolver seam, and that
  is deferred (`GoodsReceiptService.kt:296-305`).

Both are honest deferrals with a named shape. Neither exists, so per-vendor or per-SKU receiving
policy is a caller responsibility.

## Related

- [Putaway and location finding](putaway-and-location-finding.md) - what happens to a received
  line next
- [Stock model and states](stock-model-and-states.md) - the lock enums and the `INCOMING` state
