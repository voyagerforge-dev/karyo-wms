# Strategies and runtime configuration

The different places Karyo's behaviour is configured from, what each is authoritative for, and
which knobs an integrator or implementer can actually reach.

## 1. Five mechanisms, deliberately distinct

Karyo's behaviour is set in five places, and they should not be confused with one another: typed
strategy-entity columns, strategy JSONB keys, the runtime `system_properties` store, MicroProfile
configuration from `application.yaml` and the environment (which is also the third rung of the
`system_properties` ladder), and CDI strategy beans
([ADR 0018](../architecture/decisions/0018-strategy-driven-configuration.md)).

| Mechanism | Scope | Changed by | Validated |
|---|---|---|---|
| `OrderStrategy` columns | instance-wide (no `clientId`) | `PUT /api/v1/order-strategies/{id}` | Typed columns, bean validation |
| `StorageStrategy` columns | per goods owner (`TenantEntity`) | `PUT /api/v1/storage-strategies/{id}` | Typed columns |
| `OrderStrategy.extensionProperties` | instance-wide | same PUT | none - raw JSONB |
| `system_properties` | per client, with a client-0 fallback | `PUT /api/v1/system-properties/{key}` | catalogue type check, for catalogue keys only |
| `karyo.*` MicroProfile config | instance-wide | environment variable at deploy | none beyond type coercion |
| CDI strategy beans | instance-wide | rebuild ([extension SPIs](extension-spis-and-installation.md)) | boot-time name validation, for the name-selected seams |

## 2. `OrderStrategy` is instance-wide; `StorageStrategy` is per owner

`OrderStrategy` carries fourteen typed columns - the reservation flags (`useLockedStock`,
`preferComplete`, `preferMatching`, `completeHandling`, `enforceLot`), the four named-strategy
selectors (`shortPickMode`, `shortfallStrategy`, `pickDifferenceStrategy`, `packoutStrategy`), the
four progression flags (`sendToPacking`, `sendToShipping`, `createShippingOrder`,
`createTypeOrders`) and `defaultDestinationLocationId` - plus the JSONB column. It extends
`BaseEntity`, not `TenantEntity`, and its KDoc gives the reason: "System-level order configuration
(no clientId - silo tenancy makes the company implicit)" (`OrderStrategy.kt:10-16`).

`StorageStrategy` extends `TenantEntity` and is therefore per goods owner
(`StorageStrategy.kt:8`). So does `FixAssignment`, and so does `ItemDataArea`.

The consequence: one `order-write` holder tunes allocation and packout for every goods owner in the
silo, and the KDoc's "silo tenancy makes the company implicit" is true of the company and silent
about the goods owner ([Strategies and policies](../configuration/strategies-and-policies.md) covers
it from the administrator's side). Seen from an integration, `GET /api/v1/order-strategies` and
`GET /api/v1/storage-strategies` return collections with opposite tenancy semantics and nothing on
the wire distinguishes them. Neither `OrderStrategyResponse` (`OrderStrategyDtos.kt:66`) nor
`StorageStrategyResponse` (`StorageStrategyResponse.kt:3-18`) carries a `clientId`, so a caller
reading the two collections cannot tell that editing one changes every goods owner's behaviour while
editing the other changes one owner's. Only `OrderStrategyDtos.kt:9` says so, in a KDoc.

## 3. The JSONB "relief valve" is where Karyo keeps commercial-engine configuration

`order_strategies.extension_properties` is a `JSONB NOT NULL DEFAULT '{}'`
(`V401__create_order_strategies.sql:9`). Its entity KDoc describes it as "the relief valve for
extension config instead of new columns" (`OrderStrategy.kt:13-15`).

Karyo itself stores fourteen un-namespaced keys in that same map. They are declared in the public
`karyo-orders-api` and parsed in the public `karyo-orders-core`, and they are read by the two
commercial engines that release orders - wave fulfilment and order streaming:

- Wave (`OrderReleasePort.kt:77-87`, parsed at `DefaultOrderReleasePort.kt:250-260`):
  `waveAutoRelease`, `waveMaxOrders`, `wavePickMode`, `waveShortageAction`,
  `waveSelectionStrategy`, `waveDueWithinDays`, `waveMinPrio`, `waveIncludeUndated`,
  `waveSelectionRuleId`
- Streaming (`OrderReleasePort.kt:89-99`, parsed at `StreamingConfigParser.kt:12-25`):
  `releaseMode`, `streamBatchSize`, `streamMaxWaitSeconds`, `streamAbandonSeconds`,
  `streamTimingStrategy`

There is no reserved-prefix rule, no published list of the keys Karyo has claimed, and no validation
on write - `OrderStrategyService.kt:106` serialises whatever map the request carried. An extension
author who namespaces their own keys is safe by luck; one who does not, and picks `releaseMode`,
silently changes how orders are released once the streaming engine is installed.

`StorageStrategy` has no equivalent. `storage_strategies` carries no JSONB extension column - not in
`V306__create_storage_strategies.sql`, not in `V312__storage_strategy_flags.sql`, and not on the
entity - so putaway configuration an extension needs has nowhere to live but `system_properties`.

## 4. The `system_properties` ladder is the only per-tenant runtime knob

`SystemPropertyService.kt:9-27` states the resolution ladder per key: stored row for the exact
client, then the stored client-0 row, then the MicroProfile config value for the same key, then the
caller-supplied default. A stored row whose value is null does not satisfy a rung; `DELETE` is how a
key is unset. There is no caching, and the KDoc names the condition under which one should be added.

That ladder is what makes a database row beat an environment variable, and it does so on purpose.

`SystemPropertyCatalog.kt:37-166` holds sixteen catalogue entries across ten groups: receiving
(1), alerts (2), replenishment (1), packing (2), shipping (1), inventory (1), cross-docking (4),
waves (1), streaming (1) and 3PL billing (2). The alert, packing, cross-docking, wave, streaming
and 3PL billing entries are read by commercial engines; in a free installation they are stored and
returned, and read by nothing. Each entry carries a type, a group, a description, a default, and
two flags:

- `secret` masks the value in the effective view for **every** principal including SYS, while
  in-process consumers still read the real value (`SystemPropertyCatalog.kt:13-18`). One key uses
  it: the Slack webhook URL.
- `ownerWritable = false` restricts `PUT`/`DELETE` to an ops principal, so a goods-owner admin
  cannot store a client row above an operator-set hard stop
  (`SystemPropertyCatalog.kt:19-24`, enforced at `SystemPropertyResource.kt:104-114`). Seven keys use
  it: over-receipt, the Slack webhook, purge retention, the cross-dock staging window and expiry
  action, and the 3PL storage rate and billing currency.

The catalogue's own KDoc records that non-catalogue keys may still be stored - "extension/custom
knobs" - and that they get no type validation and no metadata in the effective view
(`SystemPropertyCatalog.kt:27-34`). That is the one runtime-configurable extension surface Karyo
offers, and `RuntimePropertyLookup` (`karyo-auth-api`) is how an in-process extension reads it
without depending on `karyo-auth-core`.

## 5. About forty environment knobs, one of them in the operator's template

`application.yaml:156-265` is the `karyo.*` block. Almost every leaf is written as
`${KARYO_SOMETHING:default}`, and the file explains why the defaults are never empty strings: a
resolved empty value is treated by smallrye-config as missing (`SRCFG00040`) and fails boot once any
bean injects the property, so `"none"`, `"off"` and `"STRICT_PRIORITY"` are non-empty sentinels
(`application.yaml:164-169`, `:192-201`).

Two sub-trees break the `${ENV:default}` pattern and are written as bare literals:

**`karyo.webhooks.*`** (`application.yaml:252-258`) - `poll-interval`, `batch-size`,
`http-timeout`, `max-attempts`, `backoff-base`, `backoff-cap`. MicroProfile's environment mapping
still reaches them (`KARYO_WEBHOOKS_MAX_ATTEMPTS` and friends), and
`scripts/render_compose_env.py:39-46` passes any non-`KC_`/non-`POSTGRES_` variable through to the
application's environment file, so an operator *can* set them. Nothing tells them the variables
exist: the file uses the explicit-indirection convention everywhere else, and the relay's README
documents the six keys by their property names only
(`services/integration-hub-service/karyo-webhooks-core/README.md:41-52`).

**`karyo.shipping.ship-from.*`** (`application.yaml:259-265`) - the shipper block printed at the top
of every bill of lading (`templates/bol.html:5`, bound at `ShipmentDocumentService.kt:313-318`). Its
values, and the `@WithDefault`s in `ShipFromConfig.kt:8-12`, are `Karyo Demo Warehouse`,
`1 Logistics Way`, `Distribution City`, `00000`, `US`. **Known defect:** every bill of lading a real
installation prints carries that address until someone sets five environment variables that appear
in no template, no runbook and no catalogue entry.

`scripts/.env.prod.example` exposes twenty variables. Sixteen are database, Keycloak or deployment
settings; `KARYO_PUBLIC_ORIGIN`, `KARYO_DOMAIN` and `KARYO_KEYCLOAK_MAINTENANCE_PORT` shape the
deployment; `KARYO_LICENSE` is the entitlement token (`scripts/.env.prod.example:90`). None of the
roughly forty `karyo.*` behaviour knobs is in it. They are discoverable only by reading
`application.yaml` in the source tree.

## 6. Name-selected strategies fail loudly; priority-selected ones do not

Three seams are selected by a configured name rather than by priority, and all three treat an
unknown name as a hard failure rather than a silent fallback:

- `karyo.work.dispatch-strategy` - `STRICT_PRIORITY` or `TRAVEL_PATH`; an unknown name fails at
  dispatch time. `application.yaml:193-196` records the reason: priority-based selection let any
  custom strategy under `Int.MAX_VALUE` silently take over the default (see
  [Work allocation](../functional/work-allocation.md)).
- `karyo.sequence.generator` - `TIMESTAMP_RANDOM` or `FORMATTED_COUNTER`; validated at boot by
  `SequenceNumberService.validateOnStartup` (`application.yaml:197-201`).
- `CountScopeStrategy` - always resolved by name, because `FullWarehouseScope` outranks
  `ExplicitLocationScope` on priority and an unnamed resolve would escalate every cycle count into a
  warehouse-wide freeze (see [Stocktaking](../functional/stocktaking.md)).

The `OrderStrategy` name columns behave differently: `shortfallStrategy`, `pickDifferenceStrategy`
and `packoutStrategy` are `VARCHAR` columns with string defaults and no boot-time validation, and
resolution falls through to the priority chain when the name matches nothing. So a typo in
`packoutStrategy` silently gets the built-in `ONE_TO_ONE`, while a typo in
`KARYO_WORK_DISPATCH_STRATEGY` refuses to run.

## Related

- [Extension SPIs and how one is installed](extension-spis-and-installation.md)
- [Documents and printing](documents-and-printing.md) - where the ship-from block ends up
- [Strategies and policies](../configuration/strategies-and-policies.md) - the per-seam register from the administrator's side
- [The runtime configuration store](../configuration/runtime-configuration-store.md) - `system_properties` in full
