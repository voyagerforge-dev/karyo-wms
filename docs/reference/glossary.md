# Glossary

Warehouse vocabulary as Karyo uses it. Where a term means something narrower here than in
general warehouse use, that is said explicitly.

[Stock model and states](../functional/stock-model-and-states.md) explains how the stock terms
fit together; this page just tells you what each word means.

## Stock and quantities

**On hand** - what is physically present, regardless of who it is promised to.

**Available** - on hand, not promised to an order, not held. The only quantity you can promise
to a customer.

**Allocated** (also **reserved**) - on hand but already promised to an order. Still on the
shelf; not yours to give away.

**Held** (a **lock**) - stock deliberately taken out of use, typically for damage or a quality
question. It stays counted and stays where it is, but nothing will allocate it. In Karyo, a
hold beats every other status: a group containing any held stock reads as **Hold**.

**Out** - nothing usable left.

**Stock unit** - one quantity of one product, with its lot, expiry and location. The atom
Karyo actually tracks.

**Lot** (or batch) - a production or receipt grouping, tracked where the product requires it,
so a recall or an expiry can be traced.

**Shortage** - the part of an order line Karyo could not reserve because the stock does not
exist.

## Physical things

**Location** - a place stock can be. A rack position, a floor space, a dock. It has a name,
which is what gets scanned.

**Unit load** - a physical carrier holding stock: a pallet, a cage, a tote. It has a label,
and it moves as one thing.

**LPN** (licence plate number) - the label identifying a unit load. Stock tracked on labelled
unit loads is **LPN-tracked**; stock held loose at a location is **loose**.

**Pick face** - a location goods are picked from, kept stocked from bulk storage.

**Reserve** (also bulk) - storage that feeds pick faces rather than being picked from directly.

**Zone** and **area** - groupings of locations, used to constrain where goods may go and to
scope work.

**Fix assignment** - the binding of a product to a location with a minimum and a target
quantity. Without one, [replenishment](../user-guide/replenish.md) cannot know that a pick face
is running down.

**Handling class** - a classification that matches goods to places able to take them.

## Documents and orders

**ASN** (advance shipping notice) - what somebody said is arriving. Optional. It buys you the
ability to compare what arrived against what was promised.

**Goods receipt** - what actually arrived and what was done about it. A receipt with no ASN is
a **blind receipt**.

**Retour** - a receipt of returned goods.

**Delivery order** - a customer order to be fulfilled: what is to leave the building and for
whom.

**Pick order** - the work created from a delivery order once it is released to picking. One
delivery order can become several pick orders.

**Shipment** - the packed goods leaving together, with a carrier and tracking against them.

**Shipping unit** - one packed carton or pallet within a shipment.

**Manifest** - committing a shipment to a carrier, recording carrier, service and tracking. It
does not mean the goods have left.

**Dispatch** - the goods physically leaving. This is what tells the rest of the record the
stock is gone.

## Work

**Task** (a **transport order**) - a unit of work for an operator: a putaway, a move, a
replenishment, a transfer.

**Putaway** - moving received goods from the dock into storage. Karyo creates this work
automatically when a receipt line is received.

**Move** - relocating a unit load.

**Replenishment** - topping a pick face back up from bulk storage.

**Transfer** - a follow-on hop of a putaway, move or replenishment, created automatically when
the journey needs more than one leg.

**Cross-dock** - routing received goods straight to outbound staging instead of into storage.
A [commercial engine](../commercial/README.md).

**Claim** and **release** - taking a task so nobody else works it, and giving it back.

**Pause** - suspending a task or a receipt. Paused work is deliberately invisible in ordinary
lists and is resumed from the desktop, not the floor.

## Counting

**Cycle count** - counting selected locations, as everyday practice.

**Full inventory** - counting every location a goods owner has, empty ones included.

**Blind count** - counting without being shown what the system expects. The default, because
showing the expectation produces agreement rather than accuracy.

**Campaign** - a group of related counts, reported on together.

**In review** - a submitted count that disagrees with the record and needs a human decision.

## People, ownership and access

**Client** (a **goods owner**) - whose stock this is. In a third-party warehouse, one per
customer. Being a goods owner is not a permission.

**Silo tenancy** - one Karyo installation per operating company. Goods owners live inside an
installation; separate companies mean separate installations. There is no shared instance and
no tenant switcher.

**Tenant authority** (`principal_kind`) - whether a person is operating-company staff, who see
across goods owners, or a goods owner, who see only their own. Independent of role. Anything
unrecognised is treated as the restrictive option.

**Role** - a bundle of permissions. Five are for people: `VIEWER`, `RECEIVER`, `OPERATOR`,
`MANAGER` and `ADMIN`. Two are for other systems: `INTEGRATOR` for an integrating application
and `AI_SERVICE` for Karyo's AI service account. What you see is decided by the permissions in
the bundle, not the name.

## Software terms you will meet

**Desktop console** - the browser interface for planners and administrators, at the site root.

**Floor app** - the progressive web app for operators, at `/m/`.

**PWA** (progressive web app) - a web application installable to a device's home screen, which
keeps working through a patchy connection.

**Strategy** - a configured rule deciding which stock is chosen, or where stock is put away.
Set per installation rather than fixed.

**SPI** (service provider interface) - a published extension point an implementer can plug
their own behaviour into without changing Karyo's source.

**Webhook** - an outbound HTTP notification Karyo sends when something happens, so another
system can react.

**Inventory journal** - the record of stock movements, which is what makes a correction
explainable afterwards.

**Outbox** - the internal queue that makes webhook delivery reliable across restarts.

**Commercial engine** - one of nine optional modules not included in the free application. See
[commercial engines](../commercial/README.md).

## Related

- [Data model](data-model.md) - the tables behind these words
- [Requirements](requirements.md) - what Karyo is required to do
- [User guide](../user-guide/README.md) - the same words, used on the screens
