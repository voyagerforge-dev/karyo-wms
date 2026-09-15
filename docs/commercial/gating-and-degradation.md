# Gating and degradation

How each commercial engine refuses, what a caller sees when it does, and what happens when an
entitlement that used to be there is not.

The mechanism - entitlement resolution order, resolve-once-at-boot, the marker interface, the two
gate styles and the absence of anything that keeps coverage complete - is in
[The commercial boundary](../architecture/commercial-boundary.md). This document is the per-engine
picture, plus the two places the picture breaks.

## The two refusals

`LicenseService.require(key)` throws `LicenseRequiredException`, mapped to **HTTP 403** with the
problem type `https://karyo.com/errors/license-required` and a detail naming the module
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseRequiredExceptionMapper.kt:16-25`). The
distinct `type` is what lets the console render an upsell rather than a generic forbidden. 403 with a
type was chosen over 402 Payment Required because some HTTP clients mishandle 402.

`LicenseService.isEntitled(key)` returns a boolean and callers return early or null.

## Per engine

| Engine | Style | Where | What an unentitled caller gets |
|---|---|---|---|
| Event monitors | hard + soft | 7 REST methods `require`; evaluator and delivery scheduler `isEntitled` | 403 on the API; no sweep, no alerts, no delivery |
| Demand forecasting | hard | 1 REST method | 403 |
| Slotting advisor | hard | 1 REST method | 403 |
| Reorder simulation | hard | 1 REST method | 403 |
| Cartonization | soft | `pack()` returns null | the free `ONE_TO_ONE` packout runs instead |
| Document templates | hard + soft | 4 service methods `require`; render provider returns null | 403 on administration; bundled templates render |
| Cross-docking | hard + soft | 3 REST methods `require`; interceptor and sweep `isEntitled` | 403 on the API; ordinary putaway happens |
| Wave fulfilment | hard + soft | 25 REST methods `require`; observer and scheduler `isEntitled` | 403 on the API; no progression, no auto-release |
| Order streaming | hard + soft | 3 REST methods `require`; scheduler `isEntitled` | 403 on the API; nothing streams |
| 3PL billing | hard | 2 REST methods | 403 |

The split is coherent: a **hard** gate where the engine adds a capability with no free equivalent,
so an error is the honest answer, and a **soft** gate where the engine replaces a free behaviour
through an SPI, so falling through is the honest answer.

## Coverage still holds, and still nothing keeps it holding

Counting HTTP method annotations against `require` calls in every engine's REST surface:

| Resource | Methods | Gated at the resource |
|---|---|---|
| `WaveResource` | 7 | 7 |
| `WaveSelectionRuleResource` | 7 | 7 |
| `PackoutResource` | 7 | 7 |
| `SortStationResource` | 4 | 4 |
| `CrossDockOrderResource` | 3 | 3 |
| `StreamingResource` | 3 | 3 |
| `AlertResource` | 3 | 3 |
| `MonitorResource` | 2 | 2 |
| `AlertDeliveryResource` | 2 | 2 |
| `BillingResource` | 2 | 2 |
| `ForecastResource` | 1 | 1 |
| `SlottingResource` | 1 | 1 |
| `SimulationResource` | 1 | 1 |
| `DocumentTemplateResource` | 4 | 0 |
| **Total** | **47** | **43** |

The last row is not a hole: all four methods delegate to the engine's `DocumentTemplateService`, whose
four public methods each open with a shared check that calls `licenseService.require("documents")`,
and the resource's KDoc says so.

What matters is the other half: there is no interceptor binding, no annotation, no test and no build
rule that fails when a new endpoint in an engine forgets its gate. Roughly forty-seven hand-written
call sites hold the commercial boundary by convention, and the table above is the only way to
re-prove it.

## The console tells the truth about all six screens

Every commercial screen renders a locked panel rather than an error when the entitlement is missing,
and every one of them checks the gate **before** mounting the data query, so an unentitled tenant
never calls the endpoint at all:

| Screen | Test id | Key |
|---|---|---|
| Insights > Monitors | `monitors-locked` | `monitors` |
| Insights > Forecasting | `forecasting-locked` | `forecasting` |
| Insights > Slotting | `slotting-locked` | `slotting` |
| Insights > Simulation | `simulation-locked` | `simulation` |
| Fulfillment > Waves | `waves-locked` | `advanced-fulfillment` |
| Fulfillment > Streaming | `streaming-locked` | `advanced-fulfillment` |
| Admin > Document templates | `templates-locked` | `documents` |

The dashboard's exception card (`exceptions-locked`) is gated the same way, and its hook explains
that the alerts query is enabled only once the `monitors` entitlement is confirmed, "so an unlicensed
instance never hits (and 403s against) the gated endpoint"
(`frontend/web/src/pages/home/ops/use-ops-data.ts:40-60`).

Two gates on the order-strategy form are **advisory only** and deliberately so: a padlock appears
beside `CARTONIZATION` and beside release mode `STREAM`, and the form still saves. The comment beside
the streaming one states the rule: "Does not block saving -- the strategy still saves as STREAM; the
streaming engine itself is what checks the license at run time"
(`frontend/web/src/pages/strategies/order-strategy-form.tsx:200-204`). That is right. Configuration is
not execution, and refusing to save would make a strategy un-configurable ahead of a purchase.

**Navigation is filtered by permission and never by entitlement**
(`frontend/web/src/config/navigation.ts:84-90`). All six commercial screens are always in the
sidebar, which is exactly what makes the locked panels an upsell rather than a dead end. That is
deliberate, and it matches
[what a free installation shows](README.md#what-a-free-installation-shows-in-their-place).

## The floor does not

`frontend/mobile` contains no licence check anywhere. Its numbered transaction menu gates on roles
alone, and two of the eight entries belong to the wave engine
(`frontend/mobile/src/menu/registry.ts:13-14`):

```
{ id: 'sort',    num: 7, label: 'Sort',     route: '/sort',    roles: ['fulfillment-write'] },
{ id: 'packout', num: 8, label: 'Pack-out', route: '/packout', roles: ['fulfillment-write'] },
```

**Known defect.** On an instance without `advanced-fulfillment`, an operator sees transactions 7 and
8 on the floor device, taps one, and gets the server's refusal as an ordinary error banner: both
screens show whatever detail the API returned
(`frontend/mobile/src/screens/packout-screen.tsx:9-10`, `frontend/mobile/src/screens/sort-screen.tsx:34-35`),
so the operator reads that the `advanced-fulfillment` module requires an active licence
entitlement. The 403's `license-required` problem type is not used: there is no locked state and the
two transactions stay on the menu. The console convention is not applied on the floor, where the
operator has the least context to interpret an error.

## What a licence lapse does to work already in flight

`LicenseService` resolves entitlements once at construction, so a lapse takes effect at the next
restart ([ADR 0021](../architecture/decisions/0021-signed-entitlement-resolved-at-startup.md)). What
no document covers is what the restart lands on.

For seven of the ten engines it is uneventful. Forecasting, slotting and simulation are pure reads,
so their screens simply lock. 3PL billing stores nothing, so its two endpoints simply refuse.
Cartonization degrades to the free packout on the next pack. Document templates degrade to the
bundled templates on the next render, which is the templates provider's stated intent. Monitors
stops sweeping, stops delivering, and leaves its existing alert rows in place and unreadable through
a 403 API.

**Known defect: cross-docking strands live matches.** The cross-dock expiry sweep returns immediately
when unentitled, so MATCHED and STAGED rows past their staging deadline are never disposed of: no
slice released, no fallback putaway minted, and no way to cancel them because
`POST /api/v1/cross-dock-orders/{id}/cancel` is hard-gated. The stock keeps its outbound reservation
and sits on the staging location until somebody unwinds it by hand.

**Known defect: waves strand the orders themselves, and this is the sharp one.** Three things are
true at once after a lapse:

1. The wave engine's progress observer returns early, so a RELEASED wave never advances and
   consolidation groups never reach SHIPPED. The observer treats its gate as a backstop because
   "wave rows only ever exist for an entitled tenant", which is true of creation and not of
   continuation.
2. Every `WaveResource`, `PackoutResource` and `SortStationResource` method returns 403, so the
   operator can neither sort, nor pack the group, nor cancel the wave.
3. The free per-order packing route refuses the member orders anyway:
   `ConsolidatedOrderGuard.requireNotConsolidated` throws "delivery order N is consolidated in wave
   W; pack it at its consolidation group"
   (`services/fulfillment-service/karyo-fulfillment-core/src/main/kotlin/com/karyo/fulfillment/service/ConsolidatedOrderGuard.kt:36-43`).

So a wave member whose batch picks are confirmed can be packed by **neither** route: the free one
refuses it and the commercial one is locked. The goods sit on a shared cart with live reservations
and no supported path forward. The guard is right, the gate is right, and together they close the
door. Each half handled its own case correctly; nothing handled the two together.

## One lookup contract is wrong about the unlicensed case

`CrossDockLookup`'s KDoc says "When the paid module is absent or unlicensed, no bean implementing this
interface exists at all", and `TaskService` repeats it: "No bean exists at all when that module is
absent/unlicensed" (`services/task-service/karyo-tasks-api/src/main/kotlin/com/karyo/tasks/spi/CrossDockLookup.kt:11-14`,
`.../tasks/service/TaskService.kt:77-81`).

Absent is right. Unlicensed is not: the cross-docking engine's lookup bean is a plain
`@ApplicationScoped` bean with no licence check, so on a commercial image it exists whatever the
entitlement says. The behaviour is still correct, because an unlicensed interceptor writes no rows
and the lookup therefore answers false, but the contract two files assert is not the one the code
implements, and the next person to make that lookup do more will rely on it.

## Related

- [Commercial engines](README.md) - what each engine is and needs
- [The commercial boundary](../architecture/commercial-boundary.md) - the gate and its limits
- [Frontend](../architecture/frontend.md#entitlement-gating-lives-in-the-page-not-the-router) - why
  gating lives in the page
