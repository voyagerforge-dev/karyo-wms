# ADR 0009: State changes leave the process through a transactional outbox

**Status:** Accepted

## Context

Integrating systems subscribe to Karyo's state changes as webhooks
([Webhooks and the event catalogue](../../integration/webhooks-and-the-event-catalogue.md)). A
notification must go out for every change that committed and for none that rolled back. Sending
from inside the business transaction cannot promise both: the commit can succeed and the send
fail, or the send succeed and the commit roll back.

The copilot ([ADR 0027](0027-ai-copilot-over-tool-calls.md)) also needs a feed of each goods
owner's recent activity.

## Decision

- A state change that matters outside its module is written to `karyo.outbox_events` inside the
  same transaction as the change, through `OutboxService.publish` (`OutboxService.kt:12-22`). Where
  in-process observers also need the change, the same payload is fired as a CDI event in the same
  transaction ([ADR 0008](0008-synchronous-rest-and-cdi-events.md)), for example
  `GoodsReceiptService.kt:647-648`.
- A row carries the aggregate type and id, the event type, the payload serialised to JSON exactly as
  fired - not wrapped in an envelope - and `tenant_id`, which is the goods owner
  (`V1__create_outbox.sql:1-14`).
- The outbox has two readers:
  - **The webhook relay.** `WebhookFanoutScheduler` reads rows past a stored cursor, matches each
    against the active subscriptions of the same goods owner by event type, and records one
    delivery per subscription and event (`WebhookFanoutScheduler.kt:28-63`).
    `WebhookDeliveryScheduler` hands each due delivery to its own transaction, with retries and a
    capped backoff (`WebhookDeliveryScheduler.kt:9-38`). Both run every
    `karyo.webhooks.poll-interval`; the interval, batch size, timeout, attempt limit and backoff
    are in `application.yaml:252-258`.
  - **The copilot's recent-activity tool**, which reads the caller's goods owner's rows for the last
    N minutes (`WarehouseInsightTools.kt:167-178`, `OutboxEventRepository.kt:16-20`).
- The system owner, client 0, owns no goods and never receives a webhook
  (`WebhookFanoutScheduler.kt:42-47`).
- Fan-out progress is the cursor, not the row's `published` flag (`WebhookFanoutScheduler.kt:66-72`).

## Consequences

- A committed change is delivered at least once; a rolled-back change is never delivered. Each
  delivery carries a stable id, so a receiver can discard a retry it has already processed.
- There is no broker to operate. The relay is two scheduled beans inside the application.
- Delivery latency is bounded below by the poll interval, five seconds by default.
- Each delivery runs in its own transaction, so a slow or failing endpoint cannot roll back
  deliveries that already succeeded.
- **The relay requires a single application instance.** Neither scheduler locks rows, and
  `ConcurrentExecution.SKIP` only stops a tick overlapping the previous tick in the same JVM. A
  second instance against the same database would deliver everything twice. The supported
  deployment runs one instance ([ADR 0022](0022-compose-four-container-deployment.md)).
- `published` is written `false` and never set. The partial index on unpublished rows and
  `OutboxEventRepository.findUnpublished` serve nothing (`V1__create_outbox.sql:14`,
  `OutboxEventRepository.kt:11-14`).
- Nothing deletes outbox rows in a running installation; only the demo-data reset truncates the
  table (`DemoDataService.kt:154`). The table grows with every state change.
- Code comments in ten places still call the log dormant, for example `DomainEvent.kt:11`,
  `UserCreatedEvent.kt:5` and its four sibling account events, `CrossDockEvents.kt:8`,
  `DeliveryOrderStateChangedEvent.kt:7`, `TransportOrderStateChangedEvent.kt:7` and
  `ProductService.kt:231`. They are wrong: the log has the two readers above.
- `DomainEvent<T>` in `libs/karyo-events` defines an envelope that nothing constructs; the relay
  builds its own envelope when it delivers (`DomainEvent.kt:6-14`).
- Event types use two naming forms, PascalCase and dotted lowercase. The reason is not recorded.
  The delivered envelope's id is derived from the delivery, so the id of the source outbox row is
  not on the wire and two subscriptions cannot correlate the same event; whether that was weighed
  is not recorded.

## Alternatives considered

- **Publishing to a message broker, or calling subscribers, from inside the business transaction.**
  Rejected: a dual write cannot be atomic, which is the problem the outbox exists to solve.
- **Change data capture from the database log.** Not taken: a polling relay is simpler to build and
  needs no further component, at the price of latency bounded by the poll interval.
- **Delivering a whole batch in one transaction.** Rejected: one slow or failing endpoint could time
  the transaction out and roll back deliveries already made (`WebhookDeliveryScheduler.kt:9-23`).

## Evidence

- `libs/karyo-events/src/main/kotlin/com/karyo/events/outbox/OutboxService.kt:6-22` - the single write path
- `services/karyo-app/src/main/resources/db/migration/common/V1__create_outbox.sql:1-14` - the table
- `services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/GoodsReceiptService.kt:647-648` -
  a dual publish: outbox row and CDI event in one transaction
- `services/integration-hub-service/karyo-webhooks-core/src/main/kotlin/com/karyo/webhooks/relay/WebhookFanoutScheduler.kt:28-77` - fan-out
- `services/integration-hub-service/karyo-webhooks-core/src/main/kotlin/com/karyo/webhooks/relay/WebhookDeliveryScheduler.kt:9-38` - delivery
- `services/karyo-app/src/main/resources/application.yaml:252-258` - relay settings
- `services/ai-service/karyo-ai-core/src/main/kotlin/com/karyo/ai/tools/WarehouseInsightTools.kt:167-178` - the copilot reader
- [Events and the outbox](../events-and-outbox.md)

## Related

- [ADR 0008](0008-synchronous-rest-and-cdi-events.md) - the in-process half of the same notification
- [ADR 0010](0010-crud-with-an-inventory-journal.md) - why the outbox is a delivery log, not the source of state
- [ADR 0022](0022-compose-four-container-deployment.md) - the single-instance deployment the relay depends on
- [ADR 0027](0027-ai-copilot-over-tool-calls.md) - the copilot that reads recent activity
