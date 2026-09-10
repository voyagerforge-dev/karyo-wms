# ADR 0008: Synchronous REST at the edge, synchronous CDI events inside, each observer in a chosen transaction phase

**Status:** Accepted

## Context

Two kinds of caller need two kinds of coupling. Everything outside the process - the desktop
console, the floor app, integrating systems - needs an answer before it can continue: an operator
scanning a location for a pick needs the available stock now, not eventually. Inside the process,
modules need to react to one another's state changes without depending on one another
([ADR 0006](0006-api-and-core-modules.md)), and some reactions must be part of the change that
caused them while others must happen only once that change has committed.

## Decision

- **At the edge, synchronous REST.** JAX-RS resources on Quarkus REST, versioned under `/api/v1`
  with a stated error contract ([ADR 0017](0017-versioned-rest-api-and-error-contract.md)).
  Forty-seven resource classes are rooted there. The only push from Karyo to the outside is webhooks,
  fed by the outbox ([ADR 0009](0009-transactional-outbox.md)).
- **Between modules, direct calls.** A module calls another through an SPI bean injected by CDI
  ([ADR 0006](0006-api-and-core-modules.md)). There is no HTTP between modules and no REST client
  for one; nginx answers `/api/internal/` with 404 (`infrastructure/docker/nginx/nginx.conf:100-102`).
  An operation that spans modules runs in one JTA transaction.
- **For state changes, synchronous CDI events.** The firing module injects `Event<T>` and fires a
  payload type declared in its `-api`; observers anywhere in the assembled application receive it
  by type. No code in this repository uses asynchronous CDI events.
- **Every observer chooses its transaction phase, and the choice is part of the design:**
  - *Inside the firing transaction* (the default) when the reaction must succeed or fail with the
    change. Reversing a goods-receipt line fires an event that the tasks module observes
    in-transaction, so a putaway that cannot be cancelled rolls the reversal back
    (`GoodsReceiptService.kt:621-622`, `TaskService.kt:146-156`). Layout keeps location allocation in
    step with every unit-load transfer inside the same transaction
    (`UnitLoadTransferredObserver.kt:12-29`).
  - *After success*, in a new transaction, when the reaction needs the committed state or must never
    fail the change. Receiving a line creates its putaway task only after the receipt commits, so the
    unit load and its stock are visible (`TaskService.kt:109-121`). Confirming the last pick opens
    packing after commit, because a same-transaction call cannot see the confirmation it follows
    (`PackingService.kt:140-163`).
  - A commercial engine that must claim a received line before putaway sees it observes inside the
    receiving transaction. Normal putaway, after success, asks `CrossDockLookup` whether the line
    was claimed and proceeds if it was not; when no engine is present, no bean answers and putaway
    always proceeds (`CrossDockLookup.kt:3-16`, `TaskService.kt:76-81`).
- A lifecycle event that matters outside its module is also written to the outbox in the same
  transaction ([ADR 0009](0009-transactional-outbox.md)).

## Consequences

- A change and its in-process consequences commit or roll back together. There are no sagas, no
  compensation steps and no eventual consistency between modules.
- Observers compile against payload types in `-api` modules, never against the module that fires
  them, so the dependency points the right way.
- Event coupling is invisible in the Gradle graph. An observer binds by payload type across the whole
  application and is found only by reading the observers
  ([Events and the outbox](../events-and-outbox.md)).
- The phase is load-bearing. An in-transaction observer that throws rolls back the change that
  fired it; an after-success observer that fails leaves the change committed, and nothing runs the
  observer again.
- External callers get a synchronous answer or an error, never an eventual one.

## Alternatives considered

- **A message broker between modules.** Rejected: inside one process a notification can join the
  caller's transaction, while a broker adds a component to operate, eventual consistency and
  idempotent-consumer machinery to what is a method call.
- **HTTP between modules.** Rejected: it spends network calls, timeouts, retries, circuit breakers
  and contract tests on what is a method call, and turns every cross-module operation into a
  distributed transaction.
- **Sagas across modules, choreographed or orchestrated.** Not needed: a multi-module operation is
  one transaction.
- **Asynchronous notification for everything.** Rejected: warehouse operations have hard consistency
  needs. A pick or a putaway needs to know about stock and locations immediately and consistently.
- **GraphQL for the external API.** Rejected: the screens and integrations use well-defined views
  rather than ad-hoc queries, and GraphQL's batching and field-level authorisation machinery would
  not pay for itself.

## Evidence

- `infrastructure/docker/nginx/nginx.conf:100-102` - no internal HTTP route
- `services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/GoodsReceiptService.kt:621-622`,
  `:647-648` - events fired inside the receiving transaction
- `services/task-service/karyo-tasks-core/src/main/kotlin/com/karyo/tasks/service/TaskService.kt:109-121` -
  an after-success observer
- `services/task-service/karyo-tasks-core/src/main/kotlin/com/karyo/tasks/service/TaskService.kt:146-156` -
  an in-transaction observer that can veto
- `services/fulfillment-service/karyo-fulfillment-core/src/main/kotlin/com/karyo/fulfillment/service/PackingService.kt:140-163` -
  why after-success is load-bearing
- `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/messaging/UnitLoadTransferredObserver.kt:12-29` -
  allocation kept in step inside the transaction
- `services/task-service/karyo-tasks-api/src/main/kotlin/com/karyo/tasks/spi/CrossDockLookup.kt:3-16` -
  the seam a commercial observer answers through
- [Events and the outbox](../events-and-outbox.md), [HTTP API surface](../../integration/http-api-surface.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - one process is what makes synchronous events possible
- [ADR 0006](0006-api-and-core-modules.md) - payload types live in `-api` modules
- [ADR 0009](0009-transactional-outbox.md) - the out-of-process half of the same notification
- [ADR 0017](0017-versioned-rest-api-and-error-contract.md) - the external REST contract
