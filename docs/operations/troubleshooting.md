# Troubleshooting

Failure modes Karyo actually produces, and what each one means. Deployment-time failures - ports in
use, health-check timeouts, placeholder secrets, migration checksums, container builds - are
covered in [deploying](deploying.md#troubleshooting-a-deploy); this page covers what goes wrong
afterwards.

## Signing in and seeing things

### I can reach Karyo but sign-in loops or is rejected

Karyo does not hold passwords; sign-in goes to Keycloak and comes back. The usual cause is that the
origin your browser is using is not the one the deployment was configured with.

`KARYO_PUBLIC_ORIGIN` must be **one exact browser-canonical origin**, and the realm's callback URLs
must match it exactly. A near-match, a different port, or the address with and without a trailing
component are all different origins. Do not relax the realm's callback URLs into wildcards to make a
mismatch go away; that removes the check that makes the callback safe.

### A colleague sees a menu entry that I do not

That is a permission, not a fault. Both the desktop sidebar and the floor menu are filtered by what
your token actually carries, and an empty group disappears entirely. Ask an administrator which role
you hold.

Note that `MANAGER` is not an administrator: as shipped, only `ADMIN` reaches the `/admin` section.

### The floor menu says "No transactions available for your role"

Your token carries none of the permissions the eight numbered transactions require. This is the same
permission question as above.

### Stock I expect to see is not there

Before assuming data loss, check two things that are independent of each other:

1. **Which goods owner** the stock belongs to. Every list is filtered to the owners your session is
   entitled to.
2. **Your tenant authority.** Operating-company staff see across goods owners; a goods owner sees
   only their own. Anything unrecognised is treated as the restrictive option, so a misconfigured
   user sees too little rather than too much.

## Screens that look broken but are not

### A page shows a padlock and "is a paid add-on"

That capability is one of the optional [commercial engines](../commercial/README.md) and this
installation does not have it. Nothing is misconfigured, and no setting turns it on. The free
workflow around it is complete.

The screens that do this without an engine are Waves, Streaming, Monitors, Forecasting, Slotting,
Simulation, Document templates, and the Exceptions card on the dashboard.

### The Copilot strip appears on an order I have not released

The strip is driven by the lines alone: it shows for any line whose reserved amount is below the
amount ordered, with no check on the order's state. Nothing is reserved before you press
**Release**, so a brand-new order shows the strip with every line "short". It clears as
reservations cover the amounts.

### The numbers at the top of Inventory do not match my warehouse total

They are page-scoped and labelled *"this page"*. Several list screens load one page of records and
then filter, sort and total within it. Use **Export** for a full extract.

## Orders that will not move

### Releasing an order leaves it on "Exception"

Karyo reserved what it could and could not reserve the rest, so the order stays **Released** with
short lines. That means the stock does not exist, not that the order is queued. Receive more or
[replenish](../user-guide/replenish.md) the pick face and press **Retry reservation**, or cancel.
See [pick an order](../user-guide/pick-an-order.md).

Check as well that the stock you expected is not **held** or already **allocated** to another
order. Held stock is never selected.

### "no reserved stock to pick"

The order was never released, or its reservations were released afterwards. Release the order
first; that is the step that allocates.

### "no PACK_STAGING location configured"

Your warehouse has no pack-staging location. This is a setup gap rather than an order problem, and
every release to picking will fail until it exists.

### "already released to picking"

Somebody released it before you. Look at the Tasks board for the pick work.

### An order cannot be cancelled

Cancellation is allowed only while the order is below **Picked**. Once goods have been picked they
have left their home location, so the order must run forward through packing rather than disappear.

## Receiving

### "Received more than the ASN allows for this line"

You are booking in more than was announced. Either the count is wrong or the delivery is genuinely
over. An over-delivery is a decision for a supervisor, not a number to force.

### "This receipt is closed"

Somebody finished the receipt while you were working it.

### The receipt will not accept lines and shows a pause banner

A paused receipt refuses further receiving and cannot be finished. Resume it from the receipt
screen; the floor cannot resume a paused item by design.

### Received stock produced no putaway task

Two legitimate reasons before you suspect a fault:

- **The line was received on hold.** Held stock is deliberately not put away.
- **No destination could be found.** The task is still created, without a suggested location and
  carrying a note that says why, but it is left unreleased: it is deliberately not offered to the
  floor, and it does not appear on the Tasks board under any chip. It is visible through
  `GET /api/v1/transport-orders`. Move the pallet with a **New move** from **Fulfillment > Tasks**,
  then give that product an eligible destination so the next receipt finds one.

## The floor app

### Menu transactions are dimmed and say "Offline"

Every numbered menu transaction needs a live connection, because each one asserts something about
the physical world that Karyo must check against current data. Tasks already claimed continue to
work offline.

### I cannot sign in on the floor device

Sign-in needs a connection. Work you have already completed stays queued and is not lost.

### A red banner says actions failed to sync

Open **Sync issues** from the banner. Each rejected action is listed with Karyo's reason.

A rejection usually means the warehouse moved on while the device was offline: the order was
cancelled, the receipt was closed, or someone else counted that location. The only action is
**Discard**, which is correct: the queued action is stale. Discard it, look at the current state,
and redo the work if it still needs doing. If a rejection is not obviously stale, show it to a
supervisor before discarding.

### A task screen says it is paused

Pausing and resuming are desktop decisions. The floor can only release the task back to the pool.

### A count will not release

A count order that was cancelled while you held it cannot be released, and the app says so rather
than failing silently. Return to the inbox.

### A count offers only "LOCATION EMPTY"

Nothing was on record at that location, so there are no lines to submit. If the location really is
empty, that button is the correct and only way to close the order.

## Counting and stock corrections

### Locations are locked and other work is refused

A full inventory locks every location it counts until that location's count is finished. Plan counts
accordingly.

### A full inventory skipped locations

Locations with reserved stock, or an existing lock, are skipped rather than forced. Starting the
session reports which ones, once, and that list is not stored: the session list shows progress only,
so note the names at the time. If you did not, look for the locations in scope that got no count
order. Count them afterwards with a targeted cycle count in the same campaign once their
reservations clear.

### The shelf and the record disagree

Count it. Do not adjust the number. A count writes a correction with an audit trail and feeds the
inventory accuracy measure; an adjustment does neither.

## Settings that appear not to apply

### A configuration change had no effect

Runtime settings resolve in a fixed order: a value set for a specific goods owner wins, then a
system-wide value, then the deployment's configuration, then the built-in default.

**A value stored in Karyo can override what the deployment's environment says.** Check
**Admin > System properties** before investigating the server. The resolution rules are in
[the runtime configuration store](../configuration/runtime-configuration-store.md).

### Automatic replenishment scanning is not happening

It is off by default and has to be enabled per goods owner. Until then, replenishment is on-demand
and somebody has to press **Scan now**.

### Realm changes did not take effect after a restart

A realm import skips a realm that already exists, so re-running an import does not update a realm
already in the database. The supported route for changing an existing realm is
[changing an existing Keycloak realm](deploying.md#changing-an-existing-keycloak-realm).

## Getting help

- [Open an issue](https://github.com/voyagerforge-dev/karyo-wms/issues/new/choose) and answer the
  fields the bug report form asks for. It collects the version, the deployment shape, the
  reproduction and the log lines, and it is the one place that list is maintained.
- **Never report a suspected vulnerability in a public issue.** Follow the
  [security policy](../../SECURITY.md).
