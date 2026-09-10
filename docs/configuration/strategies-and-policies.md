# Strategies and policies

Karyo has two strategy tables an administrator edits: `order_strategies` and
`storage_strategies`. Between them they carry most of the behavioural policy a deployment
tunes - how stock is chosen, whether an order parks in PACKING, where a pallet is put away,
whether waves release themselves. Both are reachable from **Strategies** in the operational
shell (`frontend/web/src/pages/strategies/`).

What each flag *does* to the algorithms belongs to
[allocation and reservation](../functional/allocation-and-reservation.md),
[picking](../functional/picking.md) and
[putaway and location finding](../functional/putaway-and-location-finding.md).
This document is about the configuration surface: what is a column and what is loose JSON, how
a strategy gets bound to work, and what an administrator cannot do. The decision behind the
strategy pattern is [ADR 0018](../architecture/decisions/0018-strategy-driven-configuration.md).

## The two tables do not agree on tenancy

`OrderStrategy` extends `BaseEntity` and carries no `client_id`. Its KDoc gives the reason:
"System-level order configuration (no clientId - silo tenancy makes the company implicit)"
(`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/domain/model/OrderStrategy.kt:10-16`).

`StorageStrategy` extends `TenantEntity` and is per goods owner
(`services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/StorageStrategy.kt:6-8`).

Both readings of silo tenancy are defensible on their own; together they mean a 3PL can give
goods owner A a different putaway policy from goods owner B, but cannot give them different
order-handling policies. The ordering resolver makes the asymmetry visible:
`OrderStrategyContext` carries a `clientId` field that the built-in resolver never reads
(`services/order-service/karyo-orders-api/src/main/kotlin/com/karyo/orders/spi/OrderStrategyResolver.kt:34-39`;
`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/DefaultOrderStrategyResolver.kt:19-24`).
The seam for per-owner order strategy exists and is unused. Why the two tables differ is not
recorded, and the code does not settle it.

## How each strategy is bound

The two use different mechanisms, and the difference matters at commissioning time.

**An order strategy is bound to an order**, by id, resolved through a priority chain of
`OrderStrategyResolver` beans where the first non-null name wins and the built-in registers
last (`OrderStrategyResolver.kt:3-15,24-27`). The built-in returns the order's own
`orderStrategyId`, or the seeded `DEFAULT` when the order names none
(`DefaultOrderStrategyResolver.kt:19-24`). Every installation has a `DEFAULT` row: it is
seeded by migration, idempotently
(`services/karyo-app/src/main/resources/db/migration/orders/V405__seed_default_order_strategy.sql`).
So order strategy always resolves to something, and an administrator who configures nothing
still gets coherent behaviour.

**A storage strategy is bound to a product.** The finder takes the request's explicit
`storageStrategyId` if there is one, and otherwise the incoming stock's product-level
`ItemData.defaultStorageStrategyId`
(`services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/service/LocationFinderService.kt:370-383`).
There is no seeded default storage strategy and no instance-wide fallback row: when neither
rung produces one, the finder proceeds with a null strategy and hardcoded constants, of which
`DEFAULT_ONLY_CLIENT_LOCATION = true` is the one that changes placement
(`LocationFinderService.kt:239,639`).

The practical consequence is a real setup burden: **putaway policy is configured product by
product.** A warehouse with 20,000 SKUs and one putaway policy must stamp
`defaultStorageStrategyId` onto 20,000 products, or accept the strategy-less defaults.

### A mistyped strategy id is silent

**Known defect.** `ProductService.createProduct` validates `itemUnitId` and refuses an unknown
one
(`services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/service/ProductService.kt:76-77`)
but accepts `defaultStorageStrategyId`, `defaultUnitLoadTypeId` and `zoneId` unchecked
(`ProductService.kt:107-109`; update does the same at `ProductService.kt:183`).

Downstream, `resolveStrategyById` returns null for a missing row and logs nothing; for a
strategy belonging to another goods owner it logs a warning and returns null
(`LocationFinderService.kt:392-403`). Both cases are described as "fail-closed", which is the
right instinct for a putaway that must not use someone else's policy.

Put together, an administrator who types the wrong strategy id on a product gets a product that
saves cleanly, a putaway that silently uses the strategy-less defaults, and - in the
missing-row case - no log line anywhere. Nothing at any point tells them their configuration is
not in effect.

## What is a column, and what is loose JSON

`OrderStrategy` has fifteen typed columns and one `JSONB` column called `extension_properties`,
described as "the relief valve for extension config instead of new columns"
(`OrderStrategy.kt:10-16,51-53`). The relief valve carries shipped product behaviour.

Fourteen keys are read out of it by production code, none of them declared anywhere:

| Key | Read at | Default |
|---|---|---|
| `releaseMode` | `messaging/StreamingConfigParser.kt:19` | `MANUAL` |
| `streamBatchSize` | `StreamingConfigParser.kt:20` | 50, clamped 1..1000 |
| `streamMaxWaitSeconds` | `StreamingConfigParser.kt:15` | 30 |
| `streamAbandonSeconds` | `StreamingConfigParser.kt:16` | 1800, floored at max-wait |
| `streamTimingStrategy` | `StreamingConfigParser.kt:17` | `time-size` |
| `waveAutoRelease` | `messaging/DefaultOrderReleasePort.kt:251` | `false` |
| `waveMaxOrders` | `DefaultOrderReleasePort.kt:252` | 200 |
| `wavePickMode` | `DefaultOrderReleasePort.kt:253` | `HYBRID` |
| `waveShortageAction` | `DefaultOrderReleasePort.kt:254` | `SKIP` |
| `waveSelectionStrategy` | `DefaultOrderReleasePort.kt:255` | `due-date-priority` |
| `waveDueWithinDays` | `DefaultOrderReleasePort.kt:256` | none |
| `waveMinPrio` | `DefaultOrderReleasePort.kt:257` | none |
| `waveIncludeUndated` | `DefaultOrderReleasePort.kt:258` | `true` |
| `waveSelectionRuleId` | `DefaultOrderReleasePort.kt:259` | none |

Defaults are declared on `WaveStrategyConfig` and `StreamingStrategyConfig`
(`services/order-service/karyo-orders-api/src/main/kotlin/com/karyo/orders/spi/OrderReleasePort.kt:77-100`).
The keys are parsed in the free orders module, but what they tune - wave release and order
streaming - is done by the commercial wave and streaming engines, which are not in this
repository ([commercial engines](../commercial/README.md)). In a free installation they are
stored, parsed and acted on by nothing.

Nothing validates a key or a value. `OrderStrategyService` serialises the submitted map
straight to JSON on create and update
(`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/OrderStrategyService.kt:106,135`),
and every reader uses `node.path(...)` with a default, which returns the default for a missing
node without complaint. A misspelled `waveAutorelease` is stored, echoed back, displayed on the
strategy detail page as part of the JSON block, and ignored.

The admin UI reflects the split honestly rather than hiding it. Five of the fourteen keys -
`releaseMode` and the four streaming knobs - have typed controls, and the form comments that
those five "own their keys and always win over anything left in the free-form JSON textarea"
(`frontend/web/src/pages/strategies/order-strategy-form.tsx:150-152`). The remaining nine wave
keys can only be reached by hand-typing raw JSON into a textarea whose only validation is that
the result parses to an object (`order-strategy-form.tsx:122-130,136`).

This is not a defect in behaviour; it is a mechanism that has outgrown its purpose. The relief
valve is the right call for one or two extension knobs. With fourteen product-owned knobs in
it, the product already has the thing this needs - a code-owned catalog with types, groups,
descriptions, defaults and validation, in `SystemPropertyCatalog`
([the runtime configuration store](runtime-configuration-store.md)) - and the wave keys are not
on it. Two configuration mechanisms of very different quality sit side by side, and the weaker
one carries the wave and streaming configuration.

One behaviour worth knowing before promising anything: when `releaseMode` is not `STREAM`, the
four streaming keys are omitted from the saved map entirely
(`order-strategy-form.tsx:153-165`). An administrator who tunes streaming, switches a strategy
to `MANUAL` for a week and saves, loses the tuning. Whether that is intended is not recorded.

## Storage strategy flags, and one stale comment

`StorageStrategy` carries nine behavioural fields (`StorageStrategy.kt:9-55`). Two of them,
`useAreaStrategyDate` and `useItemDataArea`, are declared with the comment "Column only in this
task; finder behavior lands in Task 3" (`StorageStrategy.kt:47-55`).

Both flags are live. Both are read by the finder, threaded into `AreaOccupancyReader` for
cross-area FIFO hiding and full-area hiding, and used by `CandidateOrdering` to prepend area
order and to suppress a redundant `STORAGEAREA` sort key
(`LocationFinderService.kt:564-565`, `service/AreaOccupancyReader.kt:46-47,61-74`,
`service/CandidateOrdering.kt:82-94`). There are dedicated tests for each
(`services/karyo-app/src/test/kotlin/com/karyo/layout/service/LocationFinderAreaTest.kt:270-600`).

**Known defect** (documentation). The comment is wrong in the way that costs most: an
implementation consultant reading the entity - the natural place to look when deciding what to
promise - is told two shipped features are inert.

The other flags carry rationale that is accurate and worth having in one place:
`manualSearch` "short-circuits the finder to 'no location found' immediately, before any
candidate query" so putaway falls back to manual placement (`StorageStrategy.kt:41-43`), and
`onlyClientLocation` defaults to `true` for the counting reason quoted in
[warehouse layout configuration](warehouse-layout-configuration.md#layout-configuration-is-instance-wide-the-locations-in-it-are-not).

`sorts` is a free-text comparator chain parsed by `StorageStrategySortParser`, and it is the one
free-text strategy field that *is* validated: an unknown token is refused with
`LayoutException.InvalidSortTokens` -> 400
(`service/StorageStrategySortParser.kt`, mapped at `exception/LayoutExceptionMapper.kt:27`).
That is the standard the JSONB knobs above do not meet, inside the same feature area.

## Neither strategy can be deleted

`OrderStrategyResource` exposes list, get, create and update
(`api/v1/OrderStrategyResource.kt:30-49`). `StorageStrategyResource` exposes list, get, create,
update, and get/set of the ordered area list (`api/v1/StorageStrategyResource.kt:24-60`).
Neither service has a delete method.

The built-in order resolver nevertheless guards against a deleted strategy: "The id is
validated at write time ..., so a miss here means a since-deleted strategy: deliberately fall
back to DEFAULT rather than fail a pick" (`DefaultOrderStrategyResolver.kt:21-23`). The
reasoning is sound and the fallback is the right one - but no route in the product can produce
the condition it defends against. Either the guard anticipates a delete route that does not
exist, or the route was removed and the guard stayed; nothing in the code or its documents says
which.

The practical effect for an administrator is the same either way: a strategy created by mistake
during commissioning is permanent.

## Related

- [Warehouse layout configuration](warehouse-layout-configuration.md) - the layout a storage strategy searches
- [Reference data](reference-data.md) - the product fields that bind a storage strategy
- [Strategies and runtime configuration](../integration/strategies-and-runtime-configuration.md) - strategy seams an extension can fill
- [ADR 0018](../architecture/decisions/0018-strategy-driven-configuration.md) - strategy-driven configuration
