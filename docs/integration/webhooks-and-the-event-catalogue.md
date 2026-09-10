# Webhooks and the event catalogue

The only push surface Karyo has: how the relay works, what a receiver gets, what it can rely on, and
every event type it can receive. [Events and the outbox](../architecture/events-and-outbox.md) owns
the outbox's internals and the synchronous CDI events beside it; this document is the contract as a
subscriber sees it.

## 1. The shape of the relay

`services/integration-hub-service/` holds two modules: `karyo-webhooks-api` (the envelope and two
SPIs) and `karyo-webhooks-core` (everything else). It is free - no licence gate anywhere in it.
Its build-file comment names it "Integration hub modules (webhooks; future: import/export, ERP
adapters)" (`settings.gradle.kts:81`), so webhooks are the whole hub.

The relay reads the transactional outbox
([ADR 0009](../architecture/decisions/0009-transactional-outbox.md)) with two schedulers, both
`@Scheduled(every = "{karyo.webhooks.poll-interval}")` with `ConcurrentExecution.SKIP`:

**Fan-out** (`WebhookFanoutScheduler.kt:19-63`) reads outbox rows by id after a persistent cursor,
takes every `active = true` subscription across all tenants, and for each `(event, subscription)`
pair inserts a `webhook_delivery` row when three tests pass: the subscription's `clientId` is
non-zero **and** equal to the event's `tenantId`; the subscription's patterns match the event type;
and no delivery already exists for that pair. It then advances the cursor to the highest id it saw,
whether or not anything matched.

The cursor is a dedicated single-row table, `webhook_fanout_cursor`
(`V901__create_webhooks.sql:40-45`), with a `CHECK (id = 1)` singleton constraint. `OutboxReader`'s
KDoc states the reason explicitly: `OutboxEvent.published` is not a delivery checkpoint, so fan-out
progress belongs to its own cursor (`WebhookFanoutScheduler.kt:66-72`).

**Delivery** (`WebhookDeliveryScheduler.kt:24-37`) fetches the ids of due deliveries
(`PENDING`/`FAILED` with `nextAttemptAt <= now`, oldest id first, `batchSize` at a time) and hands
each to `WebhookDeliveryProcessor.deliverOne`, which runs `@Transactional(REQUIRES_NEW)`. The class
KDocs record why each delivery gets its own transaction: in a single shared transaction, one slow
partner could trigger a JTA timeout that rolled back deliveries that had already succeeded in the
same tick, producing a cross-tenant re-fire storm (`WebhookDeliveryScheduler.kt:9-23`,
`WebhookDeliveryProcessor.kt:17-27`).

## 2. What arrives at the receiver

A JSON POST with five headers (`WebhookDeliveryProcessor.kt:60-66`):

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Karyo-Event` | the event type |
| `X-Karyo-Delivery` | the numeric delivery-row id, as a string, stable across retries |
| `X-Karyo-Timestamp` | Unix epoch seconds, regenerated per attempt |
| `X-Karyo-Signature` | `sha256=` + lowercase hex HMAC-SHA256 over `"{timestamp}.{body}"` |

The body is a `WebhookEnvelope` (`WebhookEnvelope.kt:6-14`, built at
`WebhookEnvelopeBuilder.kt:10-19`):

```json
{
  "eventId":       "string - deterministic UUID for this delivery row, stable across retries",
  "eventType":     "string - e.g. 'ItemDataCreated'",
  "occurredAt":    "string - ISO-8601 UTC, the outbox row's creation time",
  "tenantId":      "number - the goods owner (client_id) the event belongs to",
  "aggregateType": "string - the aggregate, e.g. 'ItemData'",
  "aggregateId":   "number - database id of the aggregate (0 for User events)",
  "data":          "object - the event's payload, see the catalogue in section 8"
}
```

`data` is the outbox row's stored JSON payload, re-parsed.

`eventId` is **not** the source event's identity. It is
`UUID.nameUUIDFromBytes("delivery-${d.id}")` - a deterministic UUID derived from the delivery-row id
(`WebhookDeliveryProcessor.kt:95`). That makes it stable across retries of one delivery, which is
what a receiver needs for idempotency. The consequence is that the outbox event id is never on the
wire in any form: two subscriptions receiving the same domain event see two different `eventId`
values and two different `X-Karyo-Delivery` values, with nothing in common to correlate them by. Why
the source event's identity is left out of the envelope is not recorded.

## 3. Signing and its limits

`HmacSha256Signer.kt:10-15` computes `"sha256=" + hex(HMAC-SHA256(secret, "$timestamp.$body"))`.
The signing input is the timestamp header, a literal period, and the raw request body:

```
signingInput = "{X-Karyo-Timestamp}.{rawBody}"
expected     = "sha256=" + hex(HMAC-SHA256(subscriptionSecret, signingInput))
```

A receiver verifies it like this, and must compare in constant time:

```python
import hmac, hashlib

def verify(secret: str, timestamp: str, raw_body: bytes, header_sig: str) -> bool:
    signing_input = f"{timestamp}.".encode() + raw_body
    mac = hmac.new(secret.encode(), signing_input, hashlib.sha256)
    computed = "sha256=" + mac.hexdigest()
    return hmac.compare_digest(computed, header_sig)
```

The secret is 32 random bytes from `SecureRandom`, hex-encoded to 64 characters
(`WebhookSubscriptionService.kt:23-26`), and the HMAC key is that 64-character string. It is
returned **once**, in the `CreatedSubscriptionResponse` from `POST /api/v1/webhook-subscriptions`
(`WebhookSubscriptionResource.kt:67-78`). `SubscriptionResponse`, used by list and get, has no
`secret` field, and `update` cannot rotate one. Recovering from a lost secret therefore means
deleting the subscription and creating a new one - which, because `webhook_delivery.subscription_id`
is `ON DELETE CASCADE` (`V901__create_webhooks.sql:20`), also destroys that subscription's delivery
history, including anything `DEAD` and awaiting redelivery.

Nothing enforces a timestamp freshness window on the receiver's behalf and nothing versions the
signature scheme; a receiver must impose its own replay window.

`http` targets are accepted as readily as `https` - `OutboundUrlPolicy.check` allows both schemes
(`OutboundUrlPolicy.kt:62-65`). The relay's own README opens by describing delivery as "via HTTPS
POST" (`services/integration-hub-service/karyo-webhooks-core/README.md:3-5`), which overstates what
the validator requires.

## 4. Delivery guarantees, stated plainly

- **At-least-once, while the subscription is active.** The unique index
  `uq_webhook_delivery_event (subscription_id, outbox_event_id) WHERE outbox_event_id IS NOT NULL`
  (`V901__create_webhooks.sql:35-37`) plus the `existsForEvent` pre-check make fan-out idempotent, so
  a re-scan cannot double-enqueue. Delivery itself retries, so a receiver must deduplicate on
  `eventId` or `X-Karyo-Delivery`.
- **Events published while a subscription is inactive are lost permanently.** Fan-out reads
  `subs.findActive()` (`WebhookSubscriptionRepository.kt:10`) and the cursor advances regardless,
  so deactivating a subscription is not a pause - it is a drop. `active` is an ordinary editable
  boolean with no warning, and reads naturally as a pause. The same applies to a subscription
  created later: it starts at the current cursor, never at the beginning.
- **No ordering guarantee.** Within one fan-out batch, delivery ids follow outbox ids, and
  `findDue` orders by id ascending (`WebhookDeliveryRepository.kt:13-19`). But a delivery that fails
  is rescheduled by `nextAttemptAt` and rejoins the queue behind newer ones, so a receiver can see
  `PickOrderPicked` before the `PickOrderCreated` it retried past - up to an hour later on the last
  attempts.
- **Single-instance by assumption.** Neither scheduler locks rows (`findDue` is a plain query, no
  `SELECT ... FOR UPDATE`). `ConcurrentExecution.SKIP` guards a tick against its own predecessor
  within one JVM and nothing else, so a second application instance would double-deliver. Karyo
  runs one instance by design
  ([ADR 0022](../architecture/decisions/0022-compose-four-container-deployment.md)).
- **Retry budget.** Eight attempts by default; back-off `base x 2^(attempts-1)` seconds with a
  10-second base, capped at one hour, with the shift clamped to 30
  (`ExponentialBackoffRetryPolicy.kt:22-25`, defaults at `application.yaml:252-258`). After the
  last attempt the row becomes `DEAD`, and the console's Integrations page lists it
  (`frontend/web/src/pages/admin/admin-integrations-page.tsx:384`).
  `POST /api/v1/webhook-deliveries/{id}/redeliver` resets `attempts` to 0, granting a full fresh
  budget (`WebhookDeliveryService.kt:24-33`).
- **Fan-out never delivers SYS events.** A subscription for client 0 is refused at registration
  (`WebhookSubscriptionResource.kt:56-65`) and skipped again in the loop
  (`WebhookFanoutScheduler.kt:47`), and a non-zero subscription cannot match a `tenantId = 0` row.
  There is no way to subscribe to instance-level events, and an event written with `tenantId = 0` is
  never delivered to anyone.

## 5. Malformed bodies are delivered, signed, and counted as success

**Known defect.** `WebhookDeliveryProcessor.buildBody` handles a missing source row by returning
`{"error":"source event gone"}` (`WebhookDeliveryProcessor.kt:104-105`). That string is then signed
and POSTed with `X-Karyo-Event` still set to the real event type, and if the receiver answers 2xx
the delivery is marked `DELIVERED`. A subscriber therefore has to defend against a body that is not
a `WebhookEnvelope` at all, which the envelope's own contract does not allow for.

In practice the row can only vanish through direct database action - nothing in the application
deletes from `outbox_events` - so the branch is defensive. It is still a body shape on the wire.

## 6. Subscription management

Five routes, all `@RolesAllowed("integration-admin")` (`WebhookSubscriptionResource.kt:30`):
`POST /api/v1/webhook-subscriptions`, `GET`, `GET /{id}`, `PATCH /{id}`, `DELETE /{id}`, plus
`POST /api/v1/webhook-subscriptions/{id}/test`, which enqueues a synthetic `webhook.ping` delivery
(`WebhookSubscriptionResource.kt:111-118`). Deliveries are read and requeued through
`/api/v1/webhook-deliveries` (`WebhookDeliveryResource.kt:23`), same role.

A ping is not backed by an outbox row (`outboxEventId` is null) and follows the same signing and
retry path as a real delivery. Its envelope is built at delivery time
(`WebhookDeliveryProcessor.kt:96-102`):

```json
{ "eventType": "webhook.ping", "aggregateType": "Webhook", "aggregateId": 0,
  "data": { "message": "ping" } }
```

with `occurredAt` set to the moment of the attempt rather than a fixed creation time.

Pattern matching is three rules, in `EventMatcher.kt:4-13`, and any one pattern in a subscription's
list is enough:

| Pattern | Matches |
|---|---|
| `*` | every event type |
| `PickOrder*` | any event type starting with `PickOrder` (a trailing `*` is a prefix match) |
| `ItemDataCreated` | exactly that event type |

There is no allowlist of subscribable types - whatever string an outbox row carries is matchable, so
a new event type reaches existing `*` and prefix subscriptions the moment it first publishes.

## 7. SSRF

`WebhookUrlValidator` is a thin wrapper over the shared `OutboundUrlPolicy` in `libs/karyo-security`,
which rejects non-http(s) schemes, loopback, link-local (including the EC2 metadata address),
private IPv4 ranges, IPv6 unique-local, any-local, multicast, and the literal hostnames `localhost`
and `metadata.google.internal` (`OutboundUrlPolicy.kt:9-51`). `WebhookHttpClient` sets
`followRedirects(NEVER)` (`WebhookHttpClient.kt:20`).

Validation runs at **create and update only** (`WebhookSubscriptionService.kt:42`, `:70`); nothing
re-checks at delivery time. The relay's README says so in as many words
(`services/integration-hub-service/karyo-webhooks-core/README.md:68-69`) and names DNS rebinding and
non-dotted-decimal IP encodings (integer, hex-octet, octal-octet) as residual risks.
`OutboundUrlPolicy`'s own KDoc names the same two risks but justifies accepting them partly on the
grounds that the URLs are "gated to trusted roles (the `user-admin` platform role for webhook
subscriptions)" (`OutboundUrlPolicy.kt:46-50`). The gate is `integration-admin`, not `user-admin`;
the README corrects this in its own text
(`services/integration-hub-service/karyo-webhooks-core/README.md:74-76`) and the shared library's
KDoc still carries the wrong role. The KDoc also describes its check as "create-time/delivery-time"
(`OutboundUrlPolicy.kt:34`); in this repository its only caller is `WebhookUrlValidator`, which
checks at create and update only.

## 8. The event catalogue

In the free build, **48 distinct event types** are published to `outbox_events`, from 57 calls to
`OutboxService.publish` in main source, plus `webhook.ping`, which the relay synthesises. A
subscription on `*` receives all 49. The list below was produced from those calls, not from a
document: each row names the call site that publishes the type and the payload class its `data`
serialises.

**`tenantId`** is the goods owner the aggregate belongs to, with three exceptions that matter to a
subscriber: `Client*` events carry the client's own id, so a goods owner's subscription receives the
events about itself; `User*` and `Role*` events carry the goods owner of the user concerned; and
`UnitLoadClientChanged` is published **twice**, once under the old owner and once under the new, so
both see it (`UnitLoadService.kt:231-241`).

**`aggregateId`** is the aggregate's database id, except for `User*` and `Role*` events, where the
aggregate lives in Keycloak rather than Karyo's database and `aggregateId` is always `0`; use
`data.userId` (the Keycloak user id) instead.

### Clients and users (`karyo-auth-core`; payloads in `karyo-auth-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `ClientCreated` | `Client` | a goods owner is created | `clientId`, `name`, `number`, `code`, `tenantId` | `ClientService.kt:94` |
| `ClientUpdated` | `Client` | a goods owner's details change | `clientId`, `name`, `number`, `tenantId` | `ClientService.kt:122` |
| `ClientDeactivated` | `Client` | a goods owner is set inactive | `clientId`, `number`, `tenantId` | `ClientService.kt:171-190` |
| `ClientReactivated` | `Client` | a goods owner is set active again | `clientId`, `number`, `tenantId` | `ClientService.kt:171-190` |
| `UserCreated` | `User` | a user is provisioned | `userId`, `username`, `email`, `tenantId`, `roles` | `UserManagementService.kt:80` |
| `UserDeactivated` | `User` | a user is disabled | `userId`, `username`, `tenantId`, `reason` | `UserManagementService.kt:264` |
| `UserReactivated` | `User` | a user is re-enabled | `userId`, `username`, `tenantId` | `UserManagementService.kt:291` |
| `RoleAssigned` | `User` | a realm role is granted to a user | `userId`, `username`, `roleName`, `tenantId` | `RoleService.kt:41` |
| `RoleRevoked` | `User` | a realm role is removed from a user | `userId`, `username`, `roleName`, `tenantId` | `RoleService.kt:70` |

### Products (`karyo-product-core`; payloads in `karyo-product-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `ItemDataCreated` | `ItemData` | a product is created | `itemDataId`, `number`, `name`, `clientId` | `ProductService.kt:118` |
| `ItemDataUpdated` | `ItemData` | a product's fields change | `itemDataId`, `number`, `changedFields` | `ProductService.kt:192` |
| `ItemDataStateChanged` | `ItemData` | a product is activated or deactivated | `itemDataId`, `number`, `oldState`, `newState`, `clientId` | `ProductService.kt:239` |
| `ItemDataDeleted` | `ItemData` | a product is deleted | `itemDataId`, `number`, `name`, `clientId` | `ProductService.kt:256` |

### Warehouse layout (`karyo-layout-core`; payloads in `karyo-layout-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `LocationLockChanged` | `StorageLocation` | a location's lock type changes | `locationId`, `locationName`, `oldLockType`, `newLockType`, `clientId` | `LocationService.kt:234` |
| `LocationAllocationChanged` | `StorageLocation` | a location's allocation percentage changes | `locationId`, `locationName`, `oldAllocation`, `newAllocation`, `clientId` | `LocationService.kt:346` |

### Inventory (`karyo-inventory-core`; payloads in `karyo-inventory-api`, `InventoryEvents.kt`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `StateChanged` | `StockUnit` | a stock unit is created, or its state changes | `stockUnitId`, `itemDataId`, `itemDataNumber`, `unitLoadId`, `oldState`, `newState`, `amount`, `locationId`, `locationName` | `StockService.kt:295`, `:432` |
| `AmountChanged` | `StockUnit` | a stock unit's amount is adjusted or transferred; also on every reservation, release or reservation transfer, where `changeAmount` is zero and `activityCode` is `RESERVE`, `RELEASE` or `TRANSFER_RESERVATION` | `stockUnitId`, `itemDataId`, `itemDataNumber`, `oldAmount`, `newAmount`, `changeAmount`, `recordType`, `activityCode`, `locationId`, `locationName` | `StockService.kt:353`, `:714`; `StockAmountEventPublisher.kt:24` |
| `LockChanged` | `StockUnit` or `UnitLoad` | a lock is set on a stock unit, or on a unit load and its contents | `entityType`, `entityId`, `oldLock`, `newLock`, `locationId` | `StockService.kt:469`; `UnitLoadService.kt:620` |
| `PackagingUnitChanged` | `StockUnit` | a stock unit's packaging unit changes | `entityType`, `entityId`, `oldPackagingUnitId`, `newPackagingUnitId`, `locationId` | `StockService.kt:509` |
| `Deleted` | `StockUnit` | a stock unit is deleted | `stockUnitId`, `itemDataId`, `itemDataNumber`, `amount`, `locationId` | `StockService.kt:580` |
| `StockUnitPurged` | `StockUnit` | the purge removes a terminal stock unit | `stockUnitId`, `itemDataId`, `itemDataNumber`, `unitLoadId`, `amount` | `StockPurgeService.kt:219` |
| `UnitLoadTransferred` | `UnitLoad` | a unit load moves to a location or onto a carrier, or is created in place by a move | `unitLoadId`, `labelId`, `fromLocationId`, `fromLocationName`, `toLocationId`, `toLocationName`, `stockUnitCount` | `UnitLoadService.kt:440`, `:501`; `DefaultStockMover.kt:137` |
| `UnitLoadClientChanged` | `UnitLoad` | a unit load changes goods owner (published once per owner) | `unitLoadId`, `labelId`, `oldClientId`, `newClientId`, `stockUnitCount` | `UnitLoadService.kt:236` |
| `UnitLoadTrashed` | `UnitLoad` | a unit load is retired | `unitLoadId`, `labelId`, `locationId`, `stockUnitIds` | `UnitLoadTerminator.kt:121` |
| `UnitLoadRevived` | `UnitLoad` | a retired unit load is revived by a pick | `unitLoadId`, `labelId`, `locationId`, `stockUnitIds` | `DefaultStockPicker.kt:350` |
| `UnitLoadPurged` | `UnitLoad` | the purge removes an empty terminal unit load | `unitLoadId`, `labelId` | `StockPurgeService.kt:238` |

### Receiving and delivery orders (`karyo-orders-core`; payloads in `karyo-orders-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `AsnStateChanged` | `Asn` | an advance shipping notice changes state | `asnId`, `asnNumber`, `oldState`, `newState`, `clientId`, `occurredAt` | `AsnService.kt:302` |
| `GoodsReceiptLineReceived` | `GoodsReceipt` | a receipt line is received | `goodsReceiptId`, `goodsReceiptLineId`, `asnId`, `itemDataId`, `amount`, `stockUnitId`, `unitLoadId`, `unitLoadLabel`, `locationId`, `locationName`, `qaHold`, `clientId`, `occurredAt`, `storageStrategyId` | `GoodsReceiptService.kt:647` |
| `GoodsReceiptLineReversed` | `GoodsReceipt` | a received line is reversed | `goodsReceiptLineId`, `goodsReceiptId`, `stockUnitId`, `unitLoadId`, `itemDataId`, `amount`, `clientId` | `GoodsReceiptService.kt:621` |
| `GoodsReceiptStateChanged` | `GoodsReceipt` | a goods receipt changes state | `goodsReceiptId`, `receiptNumber`, `oldState`, `newState`, `clientId`, `occurredAt` | `GoodsReceiptService.kt:697` |
| `DeliveryOrderStateChanged` | `DeliveryOrder` | a delivery order changes state | `orderId`, `orderNumber`, `oldState`, `newState`, `clientId`, `occurredAt` | `OrderService.kt:437` |

### Transport orders (`karyo-tasks-core`; payloads in `karyo-tasks-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `TransportOrderStateChanged` | `TransportOrder` | a transport order changes state | `transportOrderId`, `orderNumber`, `oldState`, `newState`, `clientId`, `occurredAt` | `TransportOrderEmitter.kt:59` |
| `TransportOrderCompleted` | `TransportOrder` | a transport order completes | `transportOrderId`, `orderNumber`, `transportType`, `unitLoadId`, `unitLoadLabel`, `sourceLocationId`, `sourceLocationName`, `destinationLocationId`, `destinationLocationName`, `operatorId`, `clientId`, `occurredAt`, `itemDataId`, `amount`, `confirmedAmount`, `partial` | `TransportOrderEmitter.kt:93` |

### Picking, packing and shipping (`karyo-fulfillment-core`; payloads in `PickOrderEvents.kt`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `PickOrderCreated` | `PickOrder` | a pick order is created on release, as a batch pick order, or as an extinguish order (`deliveryOrderId` is null for the last two) | `pickOrderId`, `pickOrderNumber`, `deliveryOrderId`, `clientId`, `pickCount`, `occurredAt` | `PickOrderService.kt:265`; `WavePickService.kt:284`; `ExtinguishService.kt:228` |
| `PickOrderPicked` | `PickOrder` | every pick on the order is confirmed | `pickOrderId`, `pickOrderNumber`, `deliveryOrderId`, `clientId`, `occurredAt` | `PickOrderService.kt:415` |
| `PickOrderReleased` | `PickOrder` | a claimed pick order is handed back to the pool; `managerOverride` is true only when the releaser is not the holder | `pickOrderId`, `pickOrderNumber`, `deliveryOrderId`, `releasedFrom`, `releasedBy`, `managerOverride`, `clientId`, `occurredAt` | `PickOrderService.kt:735` |
| `PickOrderCanceled` | `PickOrder` | a pick order is force-finished, cancelling its open picks | `pickOrderId`, `pickOrderNumber`, `deliveryOrderId`, `clientId`, `canceledPickCount`, `keptPickedCount`, `occurredAt` | `PickLifecycleService.kt:128` |
| `PickOrderPicksAdded` | `PickOrder` | picks are added to an existing pick order | `pickOrderId`, `pickOrderNumber`, `deliveryOrderId`, `clientId`, `addedCount`, `occurredAt` | `PickTopUpService.kt:215` |
| `pick.bulk-confirmed` | `PickOrder` | a bulk pick is confirmed on a batch pick order | `pickOrderId`, `sourceStockUnitId`, `pickedAmount`, `filledSlices`, `shortSlices`, `slices` | `BulkPickService.kt:136` |
| `PickShortfallReported` | `Pick` | a short pick's remainder is reported under the partial-ship shortfall strategy | `pickId`, `deliveryOrderId`, `deliveryOrderLineId`, `itemDataId`, `shortfall`, `resolution`, `clientId`, `occurredAt` | `PartialShipShortfallStrategy.kt:25` |
| `ShipmentStateChanged` | `Shipment` | a shipment changes state while packing, shipping or consolidating | `shipmentId`, `shipmentNumber`, `deliveryOrderId`, `oldState`, `newState`, `clientId`, `occurredAt` | `PackingService.kt:479`; `ShippingService.kt:152`; `DefaultConsolidationPackPort.kt:435` |
| `ShipmentCanceled` | `Shipment` | a shipment is cancelled | `shipmentId`, `shipmentNumber`, `deliveryOrderId`, `clientId`, `restoredUnitCount`, `occurredAt` | `ShippingLifecycleService.kt:400` |
| `ShippingUnitRemoved` | `Shipment` | a shipping unit is removed from a shipment | `shipmentId`, `shippingUnitId`, `shippingUnitNumber`, `resultingState`, `clientId`, `occurredAt` | `ShippingLifecycleService.kt:416` |
| `shipment.group.opened` | `Shipment` | a consolidation group's shipment is opened | a map: `consolidationGroupId`, `waveId`, `orders` | `DefaultConsolidationPackPort.kt:123` |
| `shipment.container.closed` | `Shipment` | a consolidation container is closed | a map: `containerId`, `weight` | `DefaultConsolidationPackPort.kt:222` |

Batch pick orders and consolidation are driven by the wave-fulfilment engine through seams the free
module declares and implements (`ConsolidationPackPort.kt:13`). In a free installation nothing
creates a batch pick order or a consolidation group, so the batch variant of `PickOrderCreated`,
`pick.bulk-confirmed`, `shipment.group.opened` and `shipment.container.closed` are published only
when that engine is installed.

### Stocktaking (`karyo-stocktaking-core`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `CountOrderReleased` | `CountOrder` | a claimed count order is handed back to the pool (its state stays `GENERATED`) | `countOrderId`, `orderNumber`, `locationId`, `locationName`, `releasedFrom`, `releasedBy`, `managerOverride`, `clientId`, `occurredAt` | `StocktakingService.kt:687` |

### Document archive (`karyo-docstore-core`; payloads in `karyo-docstore-api`)

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `document.stored` | `Document` | a rendered document is archived with `?store=true` | `documentId`, `entityType`, `entityId`, `documentType`, `clientId` | `DocumentStoreService.kt:71` |
| `document.deleted` | `Document` | an archived document is deleted | `documentId`, `entityType`, `entityId`, `documentType`, `clientId` | `DocumentStoreService.kt:121` |

### The relay's own

| Event type | Aggregate | Published when | `data` fields | Published at |
|---|---|---|---|---|
| `webhook.ping` | `Webhook` | `POST /api/v1/webhook-subscriptions/{id}/test` | `message` (always `"ping"`) | `WebhookSubscriptionService.kt:93` |

### Event types the commercial engines add

When the commercial engines are installed they publish further event types through the same outbox,
and the relay delivers them exactly like the ones above: there is no allowlist, so a `*` or prefix
subscription starts receiving them the moment they first publish. Their names and payloads are not
declared in any module in this repository. See
[Gating and degradation](../commercial/gating-and-degradation.md) for what each engine does when it
is absent.

### Naming, and why it matters to a pattern

Two naming conventions coexist. Forty-three types are PascalCase noun-verbs (`ItemDataCreated`,
`GoodsReceiptStateChanged`, `TransportOrderCompleted`); five are dotted lowercase
(`document.stored`, `document.deleted`, `pick.bulk-confirmed`, `shipment.group.opened`,
`shipment.container.closed`). `DomainEvent`'s KDoc reserves a third form,
`karyo.{service}.{entity}.{event-type}`, which nothing uses (`DomainEvent.kt:12-13`).

Because `EventMatcher` prefix-matches on a raw string, the split is not cosmetic. `document.*`
catches both document events cleanly. There is no equally cheap way to catch every pick-order event,
because `PickOrder*` catches five of the six while `pick.bulk-confirmed` needs a second pattern; and
the five shipment-aggregate types need three patterns (`Shipment*`, `ShippingUnitRemoved`,
`shipment.*`).

Five event types are bare verbs with no aggregate in the name - `StateChanged`, `AmountChanged`,
`LockChanged`, `PackagingUnitChanged` and `Deleted` - in a namespace shared by every aggregate.
Today `StateChanged`, `AmountChanged`, `PackagingUnitChanged` and `Deleted` are published only for
`StockUnit`, but `LockChanged` is already published for two aggregate types under the same name
(`StockService.kt:469` for a stock unit, `UnitLoadService.kt:620` for a unit load); both carry a
`LockChangedEvent` payload whose `entityType` field is the only discriminator. A subscriber matching
`LockChanged` must read `aggregateType` or `data.entityType` to know what it received, and nothing
prevents a future module from claiming `Deleted` for something else.

## Related

- [Events and the outbox](../architecture/events-and-outbox.md) - the internal half
- `services/integration-hub-service/karyo-webhooks-core/README.md` - the relay's own SSRF and configuration notes
- [Identity for an integrating system](identity-for-an-integrating-system.md) - who may manage subscriptions, and why an `INTEGRATOR` cannot
- [Strategies and runtime configuration §5](strategies-and-runtime-configuration.md#5-about-forty-environment-knobs-one-of-them-in-the-operators-template) - the six `karyo.webhooks.*` knobs
