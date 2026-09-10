# Events and the outbox

How a state change in one module reaches another module in the same process, and how it reaches
anything outside the process.

Derived from `libs/karyo-events/`, every `@Observes` site, and the two webhook schedulers.

## Two mechanisms, and where they overlap

Internal state-change notification is **synchronous CDI events**
([ADR 0008](decisions/0008-synchronous-rest-and-cdi-events.md)). There is no broker. A module fires
a typed payload; observers on the aggregated classpath receive it. The free code fires events from
18 call sites.

Anything outside the process learns of a change from the **outbox**: a row written to
`outbox_events` in the same transaction as the change
([ADR 0009](decisions/0009-transactional-outbox.md)). The free code writes outbox rows from 57 call
sites, and [the event catalogue](../integration/webhooks-and-the-event-catalogue.md) lists every
type they produce.

The two mechanisms are independent. A change reaches in-process observers only if its module fires
an event, and reaches the outside only if it writes an outbox row. Some changes do both - fired for
an observer and written for the webhook relay - but most outbox rows have no in-process event beside
them. `.../crossdock/event/CrossDockEvents.kt:6-11` describes dual publishing as "the same
dual-publish convention every other module uses", which overstates it.

## Transaction phases are load-bearing

The default (`IN_PROGRESS`) joins the firing transaction. `AFTER_SUCCESS` runs after commit. The
choice is deliberate at every site, and the clearest example is goods receipt:

| Observer | Phase | Effect |
|---|---|---|
| The cross-docking engine's receiving observer | default, in-transaction | Claims the received line for cross-docking, inside the receipt transaction |
| `TaskService.onGoodsReceiptLineReceived` (`.../tasks/service/TaskService.kt:120-121`) | `AFTER_SUCCESS` | Creates the putaway task, after the receipt commits |

That ordering is what makes the design work. `CrossDockLookup` states it
(`.../tasks/spi/CrossDockLookup.kt:3-14`): the engine's interceptor runs synchronously inside the
receiving transaction, before the putaway observer's `AFTER_SUCCESS` phase, so by the time that
observer runs, an existing cross-dock order for the line is authoritative. When no engine answers,
the lookup is treated as "never intercepted" and the warehouse falls back to its ordinary
always-putaway behaviour. Cross-docking is a commercial engine; receiving must not depend on it.
(That same contract is wrong about one case; see
[Gating and degradation](../commercial/gating-and-degradation.md#one-lookup-contract-is-wrong-about-the-unlicensed-case).)

`PackingService.kt:140` is blunter: "`@Observes(during = TransactionPhase.AFTER_SUCCESS)` is
load-bearing, not decoration". The auto-putaway observer carries the same constraint.

## The outbox is active

`OutboxService.publish` writes `aggregate_type`, `aggregate_id`, `event_type`, a JSONB payload,
`tenant_id` and `published = false` (`libs/karyo-events/src/main/kotlin/com/karyo/events/outbox/OutboxService.kt:12-19`).
`V1__create_outbox.sql` indexes unpublished rows partially.

It has two live readers:

- **The webhook relay.** `WebhookFanoutScheduler` and `WebhookDeliveryScheduler` both run on
  `{karyo.webhooks.poll-interval}` with `ConcurrentExecution.SKIP`
  (`.../relay/WebhookFanoutScheduler.kt:28`, `.../relay/WebhookDeliveryScheduler.kt:30`). Fan-out
  matches subscriptions to outbox rows by `s.clientId == e.tenantId`, skipping `clientId == 0`
  (`.../relay/WebhookFanoutScheduler.kt:42-47`).
- **The copilot.** `WarehouseInsightTools.kt:172` calls `outbox.recentForTenant(...)` for the
  recent-activity tool.

**The word "dormant" is stale and it is still in the tree.** Ten main-source comments call the
outbox a dormant log, and several contradict themselves within one sentence, for example
`.../auth/event/UserCreatedEvent.kt:5-6`:

> Serialized as-is into the dormant `outbox_events` log by OutboxService; the live readers are the
> webhook relay and the copilot's recent-activity tool.

A log with two live readers is not dormant. The same adjective survives in the other four auth
event payloads, `DomainEvent.kt`, `CrossDockEvents.kt`, `DeliveryOrderStateChangedEvent.kt`,
`TransportOrderStateChangedEvent.kt` and `ProductService.kt`.

## `DomainEvent<T>` is unused

`libs/karyo-events/src/main/kotlin/com/karyo/events/DomainEvent.kt` defines an envelope
(`eventId`, `eventType`, `source`, `correlationId`, `tenantId`, `schemaVersion`, `payload`). Its
own KDoc (`:7-14`) says no production code constructs one, that internal notifications are
synchronous CDI events, that `OutboxService` writes the bare payload rather than wrapping it, and
that the `karyo.{service}.{entity}.{event-type}` topic naming is likewise reserved. The webhook
relay's `WebhookEnvelope` mirrors the shape when it builds a delivery.

The KDoc also cites a system-architecture document as the source of the envelope; no such document
is in this repository. What actually leaves the process, and in what shape, is the
[webhook event catalogue](../integration/webhooks-and-the-event-catalogue.md).

## A dangling cross-reference

`CrossDockEvents.kt:11` sends the reader to a "Cross-Module Communication Map" in a repository-root
agent-instructions file. This repository contains no such file, and several other comments in the
tree point at the same missing file. For the communication channels themselves, read
[Modules and boundaries](modules-and-boundaries.md#three-couplings-the-module-graph-does-not-show)
and this document.

## Related

- [Webhooks and the event catalogue](../integration/webhooks-and-the-event-catalogue.md) - the
  external contract the outbox feeds
- [Modules and boundaries](modules-and-boundaries.md) - the event bus as a coupling channel
- [Runtime and configuration](runtime-and-configuration.md#schedulers) - the relay's schedulers
