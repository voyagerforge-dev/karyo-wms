# Modules and boundaries

How Karyo's Gradle modules fit together, the rule that keeps them apart, and the three couplings
the module graph does not show.

Derived from `settings.gradle.kts`, every `services/**/build.gradle.kts` and
`libs/**/build.gradle.kts`, and the CDI wiring they produce.

## The shape

One deployable, `:services:karyo-app`, aggregates every free module as an ordinary Gradle project
dependency (`services/karyo-app/build.gradle.kts:36-77`). There is no second process
([ADR 0001](decisions/0001-modular-monolith.md)). With nothing beside this checkout the build has
44 subprojects: six shared libraries, 21 `-api` modules, 14 `-core` modules, the `karyo-demo`
leaf, the on-demand `karyo-inventory-ext-example`, and the app itself.

Each domain is a `karyo-{domain}-api` / `karyo-{domain}-core` pair: the `api` module holds DTOs,
SPI interfaces and cross-module event payloads, the `core` module holds JPA entities, services and
REST resources ([ADR 0006](decisions/0006-api-and-core-modules.md)).

Seven `-api` modules have no `-core` beside them in this repository: monitors, forecasting,
slotting, simulation, cross-docking, waves and order streaming. Their implementations are commercial
engines, included only when a commercial checkout is present (see
[The commercial boundary](commercial-boundary.md)). Two further engines, cartonization and document
templates, have no `api` of their own: they implement SPIs declared elsewhere - `PackoutStrategy` in
`karyo-fulfillment-api` and `DocumentTemplateProvider` in `libs/karyo-documents`. A tenth engine,
3PL billing, has no module of its own: it ships inside `karyo-monitors-core`.

Shared libraries: `karyo-common` (base entities, `Patchable<T>`, warehouse time zone),
`karyo-events` (the outbox), `karyo-security` (tenant context and scope), `karyo-license`
(entitlement gate), `karyo-documents` (rendering), `karyo-sequence` (number generation).

## The rule and its exceptions

`core` depends on its own `api` and on foreign `api` modules, never on a foreign `core`
([ADR 0006](decisions/0006-api-and-core-modules.md)). Grepping every build file for
cross-directory `-core` edges confirms three exceptions, and only three:

| Module | Foreign cores | What its build file says |
|---|---|---|
| `karyo-ai-core` | 10 | "tool beans call these services in-process" (`services/ai-service/karyo-ai-core/build.gradle.kts:11-32`) |
| `karyo-demo` | 8 | "Deliberate cross-core coupling" for a production-disabled leaf (`services/demo-service/karyo-demo/build.gradle.kts:6-26`) |
| `karyo-monitors-core` (commercial) | 1, `karyo-replenishment-core` | Labelled, not justified |

The aggregator is not an exception: assembling every `core` is its job. ADR 0006 treats all three
as waivers, not precedent.

The third edge belongs to the commercial event-monitors engine, whose below-reorder-point detector
calls `ReplenishmentService.needs(clientId)`
(`.../replenishment/service/ReplenishmentService.kt:215`). `karyo-replenishment-api` contains no
SPI it could have used instead. Why the edge was accepted rather than an SPI added is not recorded.

It is also the only dependency that crosses the repository boundary, and it points the safe way:
from the commercial side into this repository, never out of it. A free checkout is therefore
self-sufficient, and the commercial build needs this repository's source tree rather than
published API jars.

The pattern that keeps the graph clean when a dependency would otherwise point the wrong way is
declare-in-your-own-`api`, implement-elsewhere: `OpenPickGuard`
(`.../inventory/api/spi/OpenPickGuard.kt`), `PurgeBlockerLookup`
(`.../inventory/api/spi/PurgeBlockerLookup.kt`), `PickZoneLookup`
(`.../fulfillment/spi/PickZoneLookup.kt`).

## Three couplings the module graph does not show

This is the most important structural fact in this document. The Gradle graph is one of four
coupling channels, and reading it alone will mislead you about what depends on what.

**1. The shared schema.** Some modules read other domains' tables directly through native SQL and
declare no dependency on the owning module at all:

| Reader | Reads | Owner |
|---|---|---|
| `KpiViewRepository` in `karyo-reporting-core` | `karyo.kpi_*` views | reporting's own `V1001`-`V1006` views over inventory, orders and fulfillment |
| The demand forecasting engine | `karyo.picks`, inventory on-hand | fulfillment, inventory |
| The slotting advisor | `karyo.stock_units`, `karyo.unit_loads`, `karyo.storage_locations`, `karyo.zones` | inventory and layout |
| The reorder simulation engine | fulfillment tables | fulfillment |

The three commercial insight engines have no free domain module on their Gradle classpath at all.
Read their build files and they look like isolated leaves. They are not: they read this
repository's schema directly, and changing one of those tables, or an encoding their queries
filter on, changes a contract they depend on with nothing in this repository to flag it (see
[Data and persistence](data-and-persistence.md#the-read-side-bypasses-the-module-boundary)).

Reading the shared schema directly is a recorded decision for reporting
([ADR 0011](decisions/0011-reporting-reads-the-database-directly.md)). It has a cost: the coupling
is invisible to the build, so it breaks at runtime rather than at compile time.

**2. The CDI event bus.** Observers bind by payload type across the whole aggregated classpath.
The wave engine observes `WavePickActivityEvent`, which `karyo-fulfillment-core` fires. There is
no Gradle edge from fulfillment to the wave engine and there should not be - the payload type
deliberately lives in `karyo-fulfillment-api` "so wave-core can `@Observes` it without a
cross-core Gradle edge" (`.../fulfillment/event/WavePickActivityEvent.kt:7`). The dependency is
real, it points the right way, and it is only visible if you read the observer.

**3. SPI implementor resolution.** A `core` depends on a foreign `api` to get an interface, but
which bean implements it is resolved by CDI at runtime. The graph tells you a module consumes a
contract; it does not tell you who satisfies it - and in a full build some of the satisfiers are
commercial engines this repository cannot see.

## What enforces the rule

Nothing mechanical. There is no ArchUnit test, no Gradle dependency-verification rule, and no
Detekt rule that fails a build on a new `core`-to-`core` edge. The rule is held by
[ADR 0006](decisions/0006-api-and-core-modules.md) and by review. The grep that produced the
table above is the only way to re-prove it.

## One deliberate Gradle outlier

`karyo-wave-api` is the only module in the repository that uses `api(...)` rather than
`implementation(...)` (`services/wave-service/karyo-wave-api/build.gradle.kts:10-11`):

```kotlin
// Orders API for WaveOrderView and ShortageView SPIs
api(project(":services:order-service:karyo-orders-api"))
```

Correct as written: `karyo-wave-api`'s own public SPI signatures expose `karyo-orders-api` types,
so consumers need them transitively. It is the only `api` module that depends on another `api`
module, which is why it is the only place the distinction arises.

## Aggregator declarations

`services/karyo-app/build.gradle.kts` declares every free `core` (`:40-63`), then adds whichever
commercial cores the settings file included (`:64-71`). It additionally declares the union of
Quarkus extensions explicitly even though they arrive transitively (`:82-108`), "so the aggregator
app is the single source of truth for the assembled image". That is a deliberate redundancy and
the file says so.

`karyo-inventory-ext-example` is always a subproject, but it reaches the image only when
`-PkaryoInventoryExample=true` (`:38-41`), with the comment "Deliberate build-time augmentation,
never a runtime JAR upload." That matches the extensibility contract: extensions are on the
classpath before Quarkus augmentation, never uploaded into a running image
([ADR 0019](decisions/0019-extensions-compile-into-the-build.md)).

## Related

- [Data and persistence](data-and-persistence.md) - the shared schema from the other side
- [Events and the outbox](events-and-outbox.md) - the event bus in detail
- [The commercial boundary](commercial-boundary.md) - how the commercial cores join the build
- [Extension SPIs and installation](../integration/extension-spis-and-installation.md) - building
  on the SPIs
