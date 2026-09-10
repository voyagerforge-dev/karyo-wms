# Commercial engines

Karyo's free product is complete on its own. Nine optional engines extend it and are licensed
separately; their code is not in this repository. This page is the outside view: what each engine
does, what it needs, what it deliberately does not do, and what a free installation shows in its
place.

The mechanism - how the build picks the engines up, how the entitlement gate works and what it does
not cover - is in [The commercial boundary](../architecture/commercial-boundary.md). How each engine
refuses, and what a lapsed entitlement does to work in flight, is in
[Gating and degradation](gating-and-degradation.md).

## Nine modules, eight keys

| Engine | Entitlement key | What it does | What it does not do |
|---|---|---|---|
| Event monitors | `monitors` | Runs scheduled warehouse-risk detectors and delivers fired alerts by email or Slack | The detector catalogue is fixed by the engine; delivery does nothing until a channel is configured |
| Demand forecasting | `forecasting` | Produces read-only, on-demand per-SKU demand forecasts and reorder-point suggestions | Does not place purchase orders or execute replenishment |
| Slotting advisor | `slotting` | Compares pick velocity with slot desirability and advises promotion or demotion | Does not select a target bin or move stock; cannot advise demoting a SKU with no picks in the window |
| Reorder simulation | `simulation` | Backtests naive and safety-stock reorder policies against demand history, on demand | Is not a real-time model of the warehouse |
| Cartonization | `cartonization` | Splits picked goods across cartons by line and quantity limits | Is not geometric or 3D packing optimisation |
| Document templates | `documents` | Keeps versioned per-goods-owner overrides for generated PDF and ZPL documents | Overrides only a fixed list of documents; the document archive and ordinary generation stay free |
| Cross-docking | `advanced-fulfillment` | Routes matching receipts to outbound staging, with ordinary putaway as the fallback | Has no screen of its own; does nothing until a matching rung is enabled |
| Wave fulfilment | `advanced-fulfillment` | Selects and allocates orders for batch picking, sorting and cross-order pack-out | Does not replace free picking and packing - it orchestrates them |
| Order streaming | `advanced-fulfillment` | Releases eligible orders in micro-batches and tracks waiting or stalled work | Does not recover stalled work on its own or send notifications |

Three of the nine share the `advanced-fulfillment` key, so a customer buys eight things, not nine,
and buying Advanced Fulfillment buys cross-docking, waves and order streaming together.

Wave fulfilment is best described as commercial orchestration over free picking and packing
primitives, and so are cross-docking and order streaming: each reaches the warehouse through free
code, as the next sections show.

## What each engine needs before it does anything

Every engine needs two things first: its module in the image, which means a build made with the
commercial checkout present, and its key in a signed licence
([Licence and entitlement](../operations/licence-and-entitlement.md)). Beyond that:

| Engine | Also needs |
|---|---|
| Event monitors | A delivery channel: `karyo.alerts.email.recipients` (empty means the email channel refuses delivery) or `karyo.alerts.slack.webhook-url` (`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt:43-53`) |
| Cartonization | An order strategy whose packout strategy is `CARTONIZATION`. Box limits are `karyo.packing.cartonization.max-lines-per-box` and `max-amount-per-box` (`:66-78`); the shipped default is **one line per box**, which maximises cartons |
| Cross-docking | One or both matching rungs enabled per client - `karyo.crossdock.pre-distributed`, `karyo.crossdock.opportunistic`, both default false (`:100-129`) |
| Wave fulfilment | For scheduled release, `karyo.wave.auto-release` for the client and `waveAutoRelease` on the strategy, both default off (`:130-139`) |
| Order streaming | `karyo.streaming.enabled` for the client, default false, and a strategy or order whose release mode is `STREAM` (`:140-147`) |
| Forecasting, slotting, simulation | Pick history inside their window; tuning keys under `karyo.forecasting`, `karyo.slotting` and `karyo.simulation` in `services/karyo-app/src/main/resources/application.yaml:174-191` |
| Document templates | An operations administrator to author overrides; the bundled templates render otherwise |

## What a free installation shows in their place

| Surface | What a free installation shows |
|---|---|
| Insights > Monitors, Forecasting, Slotting, Simulation; Fulfillment > Waves, Streaming; Admin > Document templates | A locked add-on panel. Each page checks the entitlement before it queries, so it never calls the refusing endpoint |
| The dashboard's exception card | Locked the same way |
| Warehouse > Items | The forecast columns and the Class A/B/C slotting filters stay empty: their queries run only when the engine is entitled (`frontend/web/src/pages/items/use-item-analytics.ts:29-41`) |
| The order-strategy form | A padlock beside `CARTONIZATION` and beside release mode `STREAM`; the strategy still saves |
| Receiving and Tasks | Ordinary putaway. Cross-docking has no screen to lock |
| The floor app's Sort and Pack-out transactions | Still on the menu, and an ordinary error when tapped (**known defect**) |
| Admin > System properties | The engines' knobs, listed and inert |
| The database | The engines' tables, created and empty |

## There is one commercial image and it contains all nine

With a commercial checkout present, the settings file includes all nine engines and the app picks up
all nine (`settings.gradle.kts:164-174`, `services/karyo-app/build.gradle.kts:64-71`). There is no
per-engine build flag. So there are exactly two build shapes:

- **Community.** This repository alone. No `LicensedModuleInstallation` bean, so
  `LicenseEdition.of` reports `community`
  (`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseEdition.kt:21-22`).
- **Commercial.** This repository with the commercial checkout, carrying all nine.

**Entitlement, not installation, is the whole boundary in a commercial deployment.** A customer who
buys `slotting` alone receives an image containing all nine engines, all wired into CDI, all with
their tables migrated, and eight of them refusing to act. One artefact serves every customer. It also
has a consequence nothing records: the engines can depend on each other's beans and nobody will
notice until an installation holds one entitlement without the other.

Commercial images are built and delivered outside this repository.

## Their data lives in free territory

Every engine's schema is in this repository's aggregator, not in the engine: the monitors,
cross-docking, wave and streaming migrations and the document templates table are applied to every
installation, and the wave and streaming engines also stamp columns onto free tables
([Data and persistence](../architecture/data-and-persistence.md#the-commercial-engines-schema-lives-here)).
**The free community edition creates every engine's tables and never writes a row into them.**

Cartonization, forecasting, slotting and simulation add no schema at all: they are pure reads.

## They mostly drive free code

None of the three Advanced Fulfillment engines touches stock directly. Each one reaches the warehouse
through an SPI whose only implementation is an Apache-2.0 bean in this repository:

| Engine | Free port | Free implementation |
|---|---|---|
| Wave fulfilment | `OrderReleasePort`, `BatchPickPort` | `.../orders/messaging/DefaultOrderReleasePort.kt`, `.../fulfillment/service/WavePickService.kt` |
| Order streaming | `StreamingReleasePort`, `PickReleasePort` | `.../orders/messaging/DefaultStreamingReleasePort.kt`, `.../fulfillment/service/DefaultPickReleasePort.kt` |
| Cross-docking | `CrossDockOrdersPort`, `TransportOrderPort` | `.../orders/service/DefaultCrossDockOrdersPort.kt`, `.../tasks/service/DefaultTransportOrderPort.kt` |

The traffic runs the other way too. `karyo-tasks-core`, which is free, injects
`Instance<CrossDockLookup>` and skips auto-putaway for a line the engine claimed
(`.../tasks/service/TaskService.kt:77-81`). `karyo-fulfillment-core`, which is free, refuses to pack a
wave member whose picks sit on a shared cart and tells the caller to pack it at its consolidation
group (`.../fulfillment/service/ConsolidatedOrderGuard.kt:36-43`). Free code knows about the engines
by design, through interfaces it owns.

The four insight engines - monitors, forecasting, slotting and simulation - are the opposite shape:
they own no writes to warehouse state and read the free schema with native SQL, against tables such
as `karyo.picks`, `karyo.stock_units`, `karyo.inventory_journals`, `karyo.transport_orders` and
`karyo.delivery_orders`.

## What the disclosure endpoint tells a caller

`GET /api/v1/license` is `@PermitAll` and deliberately never gated
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseResource.kt:27-45`). Anonymous callers
get the edition alone. Authenticated callers get the edition plus the entitlement set, intersected
with what the image installs:

```kotlin
val availableEntitlements = licenseService.entitlements()
    .filterTo(sortedSetOf()) { it in installedEntitlements }
```

The intersection is what stops a token from appearing to unlock code a community build does not
contain. On a commercial image it is a no-op, because the image installs all eight keys. The console's
`useLicense` hook caches this with `staleTime: Infinity` and the comment "entitlements don't change
within a session; a full reload picks up any change server-side"
(`frontend/web/src/features/license/use-license.ts:4-9`), which is right given that the backend
resolves entitlements once at construction.

## The nine engines and the free product's own settings screen

`SystemPropertyCatalog` lives in `karyo-auth-core`, which is Apache-2.0, and it carries entries for
cross-docking, waves, order streaming and cartonization, plus the two alert-delivery keys the
monitors engine reads
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt:43-53,66-78,100-147`).
**Known defect:** a free community installation's **Admin > System properties** therefore lists
knobs for engines that build cannot contain. Setting them is harmless and does nothing.

That is the price of keeping one catalogue rather than a per-module registry. The catalogue's own
KDoc frames it as a code-defined list that "grows as existing `@ConfigProperty` knobs migrate onto the
runtime store" (`SystemPropertyCatalog.kt:27-34`). Nothing weighs the cost.

## Known gaps between what the product says and what it does

- **The floor is not covered by the console's convention.** The console locks every commercial
  screen; the floor app's Sort and Pack-out do not
  ([Gating and degradation](gating-and-degradation.md#the-floor-does-not)).
- **The forecasting locked panel overstates the engine's input.** It says forecasts are "computed from
  your pick and receiving history" (`frontend/web/src/pages/insights/forecasting-page.tsx:37-39`); the
  engine reads pick history only.
- **Cartonization's shipped default maximises cartons.** One line per box is what an installation gets
  until someone changes it.

Questions about the commercial engines go through [SUPPORT.md](../../SUPPORT.md).

## Related

- [The commercial boundary](../architecture/commercial-boundary.md) - the build overlay and the gate
- [Gating and degradation](gating-and-degradation.md) - refusals, locked screens and lapses
- [Licence and entitlement](../operations/licence-and-entitlement.md) - installing a licence
