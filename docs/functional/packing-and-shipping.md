# Packing and shipping

The outbound tail: a fully picked order becomes a `Shipment` holding `ShippingUnit`s, which get a
carrier and a tracking number, and then leave.

## The shipment state machine

`ShipmentState` (`karyo-fulfillment-api/.../vo/ShipmentState.kt:10-21`) is
`PACKING(640) → PACKED(650) → SHIPPING(670) → SHIPPED(680)`, plus `CANCELED(800)`.

Forward-only, with `CANCELED` gated to `code < SHIPPING` - so a shipment can be cancelled while
it is being packed or after it is packed, but **never once it has been manifested**. The codes
are deliberately the same numbers as the corresponding `OrderState` values, which is what lets
the order and the shipment track each other without a mapping table.

## Opening packing

`PackingService.openPacking(deliveryOrderId)`
(`services/fulfillment-service/karyo-fulfillment-core/.../service/PackingService.kt:82-130`)
creates exactly **one `Shipment` per delivery order**, never one per pick order. Its guards, in
order:

1. There is at least one non-cancelled pick order for the delivery order.
2. The delivery order itself is not `CANCELED`.
3. Every non-cancelled pick order is `PICKED`.
4. No non-cancelled shipment already exists.

Guard 2 is not redundant with guard 3, and the reason is recorded (`:70-78`): a partially picked
order force-finished by the cancel cascade lands on `PICKED` while the delivery order goes
`CANCELED`, so a single `POST /delivery-orders/{id}/cancel` produces exactly that pair. Without
the delivery-order-keyed check, that pair opens packing and ships a cancelled order.

Guard 4 ignores `CANCELED` shipments - cancelling a shipment frees the order to be packed again
(`:98-102`).

Guard 3 is sibling-aware for the same reason picking's completion check is: `createTypeOrders`
can split one release into several pick orders, so this reads every one of them rather than an
arbitrary single row (`:63-68`).

### Auto-open

The `createShippingOrder` strategy flag makes pick-order completion open packing automatically.
The mechanism is a `PickOrderAutoPackEvent` fired synchronously by `confirmPick` but observed at
`AFTER_SUCCESS` (`:162-169`), and the KDoc explains why the obvious thing does not work
(`:140-147`): `openPacking` re-reads the pick order in its own query, and even under
`REQUIRES_NEW` that query starts before `confirmPick`'s `PICKED` write commits, so it refuses
with "pick order is not fully picked" every single time.

The observer catches `Exception`, not just `FulfillmentException`, because the sequence service
can throw a `SequenceException` that extends a different base - "a misconfigured strategy must
never be able to fail a legitimate pick confirmation" (`:154-160`). A failed auto-open is
therefore silent; `PickOrderService.isAutoOpenPending` (`.../service/PickOrderService.kt:674-682`)
is the derived, self-healing signal that surfaces it, computed rather than stored so a manual
open clears it on the next read.

## Packing

`pack(shipmentId, weight, type)` (`PackingService.kt:193-235`) resolves the order's
`packoutStrategy` and packs **every sibling container**, one strategy call per container.

`PackoutStrategyResolver` (`.../service/PackoutStrategyResolver.kt:27-33`) prefers a strategy
whose `name` matches the knob, then walks ascending priority taking the first non-null result -
and skips the already-tried named instance on the fallback scan, because re-invoking a strategy
whose `pack()` is not a pure decision is "a correctness hazard" (`:15-21`). That null-returning
path is how a licence-gated strategy defers cheaply.

The built-in is `ONE_TO_ONE` (`.../service/OneToOnePackout.kt:18-34`): the pick container becomes
one shipping unit, one line per confirmed pick, `complete = true`. The commercial cartonization
engine adds a `CARTONIZATION` strategy that splits one container across boxes.

Three properties of `pack` are easy to get wrong and are each documented at the site.

**Weight is this call's scale reading, not a running total.** The operator enters one scalar, and
it is prorated across only the containers this call is actually packing:
`weight * containerPickedAmount / totalPickedAmount`, half-up to three decimals
(`PackingService.packSiblingContainers:247-267`). Without the proration every sibling would carry
the full entered weight and the shipment total would be wrong by a factor of N - and both the
carrier manifest and the bill of lading fold unit weights into a total. On a repack the caller
weighs the freed quantity, not the shipment's original total.

**Selection is ledger-based, not state-based.** `Pick.state` tops out at `PICKED` - packing never
advances it - so the same picks come back on every call forever.
`ShippingUnitLine.sourcePickId` is a per-pick ledger, read once per call as a grouped query, and
the strategy is handed only `pickedAmount - consumed` (`:277-301`, `:312-330`). Removal
self-heals it: deleting a unit or a line frees the amount for the next `pack()` with no extra
bookkeeping.

**A container's stock flips as soon as its own packout completes**, independent of its siblings.
The shipment- and order-level transition waits for all of them; the physical state does not
(`:242-245`).

When every container is complete: shipment → `PACKED`, order → `PACKED`, and if `sendToShipping`
is set, the order is additionally parked at `SHIPPING(670)` - state parking only, never gating
the shipment's own machine (`:226-231`).

A group (cross-order consolidation) shipment carries no `deliveryOrderId` and this per-order pack
flow refuses it outright, pointing at the wave engine's pack-out routes (`:204-209`).

## Manifest

`ShippingService.manifest` (`.../service/ShippingService.kt:55-88`) requires state `PACKED`, at
least one shipping unit, and an unpaused shipment. It sums every unit's weight, resolves a
`CarrierAdapter`, and stamps the returned carrier, service and tracking number onto the shipment
**and onto every unit**, then advances to `SHIPPING`.

The built-in adapter is `ManualCarrierAdapter` (`.../service/ManualCarrierAdapter.kt:14-23`):
lowest priority, `handles()` returns true for any carrier, and it uses the operator-supplied
tracking number or generates `MAN-{shipmentNumber}`. Real carrier integrations register at a
lower priority and claim their carrier by name. So out of the box Karyo *has* a carrier flow, and
it is an entirely manual one - there is no rate shopping, no label buy and no carrier API call
anywhere in this repository.

## Dispatch

`dispatch(shipmentId)` (`ShippingService.kt:109-144`) requires `SHIPPING`, an unpaused shipment,
and a configured `SHIP_STAGING` dock. For each distinct container unit load, in this order:

1. move it to the dock,
2. optionally rename its label (the `karyo.shipping.rename-unit-load` runtime property, per
   client, default off),
3. ship its stock.

The order is load-bearing: a container whose last live stock just shipped can go terminal, and a
`DELETABLE` unit load refuses to move (`:120-124`). Moving first also matches the physical
sequence. There is one observable consequence, recorded rather than hidden: the resulting SHIP
journal row and outbox event record the dock's location, not the container's pre-dispatch origin
(`:94-99`).

`shipContainer` flips `PACKED → SHIPPED` and then promotes the same units straight to `DELETABLE`
in the same transaction (`.../inventory/service/DefaultStockPicker.kt:192-214`); see
[stock model](stock-model-and-states.md#deletion-and-the-reaper).

Finally the shipment goes `SHIPPED` and every member order is driven `markShipped` then
`markFinished` (`ShippingService.kt:138-141`). A per-order shipment has its one bound order; a
group shipment reads `shipment_orders` (`:146-149`).

**Dispatch is one shot.** It is gated to `SHIPPING` exactly, and `ShipmentState.canAdvanceTo`
refuses `CANCELED` from `SHIPPING` onwards, so there is no re-dispatch and no un-ship. The order
progression port makes `markShipped`/`markFinished` idempotent anyway, on symmetry grounds,
"to remove the trap before it can resurface if that gate ever loosens, at zero behavioral cost
today" (`.../orders/service/DefaultOrderProgressionPort.kt:23-28`).

## Unwinding a shipment

`ShippingLifecycleService` owns claim, release, pause, resume, cancel, `removeUnit` and
`removeLine`. Claim, release and pause mirror the goods-receipt shapes exactly, including the
fail-loud non-idempotence: a second pause is a 409, and so is claiming a shipment you already
hold (`.../service/ShippingLifecycleService.kt:58-136`).

**`cancel`** (`:138-166`) restores every shipping unit's stock per its `origin` and advances the
shipment to `CANCELED`, firing one event under the shipment's own `clientId` rather than the
ambient one. Refused once past `PACKED`. Member orders of a group shipment stay at `PACKED`; a
fresh pack-out re-marks them through `progressIfBehind`.

**`removeUnit`** (`:206-221`) restores one unit's stock and hard-deletes the unit and its lines.
Removing the last unit does *not* delete the shipment: it stays `PACKING`, ready to be repacked,
and a shipment that had already reached `PACKED` is written **back** to `PACKING` by a direct
field write, an entity-internal regression scoped to this one path (`:167-175`).

Two guards on that method are worth knowing because they encode real failure modes:

- **Sole-referent guard** (`:176-185`). Every box a cartonization packout produces can share the
  same pick-container `unitLoadId`. Restoration is keyed by `unitLoadId`, so removing one such
  unit would flip the whole shared container's stock while its siblings stay live on the
  shipment. The removal is refused unless the unit being removed is the only live referent, and
  the message points at `cancel` instead.
- **Pause guard** (`:197-199`). Removing a unit mutates the shipment, so it joins
  pack/manifest/dispatch. `cancel` deliberately stays pause-exempt - it is an abort, like
  `release`.

**`removeLine`** (`:235-252`) is a plain delete with no stock effect for a packout or ad-hoc unit,
whose lines merely describe what already sits on the container. It is **refused** for a
consolidation container, where the lines are the only record of which cart each slice of quantity
came off and restoration replays exactly those lines - deleting one strands that quantity.

## Related

- [Picking](picking.md) - where a shipment's contents come from, and how a force-finish reaches
  here
- [Stock model and states](stock-model-and-states.md) - `PACKED`, `SHIPPED` and the ship-time
  promotion to `DELETABLE`
- [Documents and printing](../integration/documents-and-printing.md) - the bill of lading and
  the labels a shipment produces
