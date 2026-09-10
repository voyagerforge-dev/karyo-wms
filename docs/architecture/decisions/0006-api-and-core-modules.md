# ADR 0006: `-api` modules hold contracts, `-core` modules hold implementations, and no core depends on another

**Status:** Accepted

## Context

Every module runs in one process ([ADR 0001](0001-modular-monolith.md)), so nothing at runtime
stops one module from reaching into another's entities and services. The boundary between modules
is only as strong as the build graph that describes it. Held, it keeps each domain understandable
on its own, lets a client's extension compile against contracts rather than implementations
([ADR 0019](0019-extensions-compile-into-the-build.md)), and lets the commercial engines plug into
the free product through published seams
([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).

## Decision

- Each domain is a pair of modules. `karyo-<domain>-api` holds DTOs, SPI interfaces and the event
  payloads other modules observe. `karyo-<domain>-core` holds JPA entities, repositories, services
  and REST resources.
- A `-core` depends on its own `-api`, on other modules' `-api`, and on `libs/*`. **It never depends
  on another module's `-core`**, apart from the three waivers below.
- When a dependency would point the wrong way, the module that needs the answer declares the
  interface in its own `-api` and the module that has the answer implements it. `OpenPickGuard` is
  declared in inventory and implemented by fulfillment (`OpenPickGuard.kt:3-8`);
  `PurgeBlockerLookup` is declared in inventory and implemented by fulfillment, orders, stocktaking
  and tasks (`PurgeBlockerLookup.kt:24-25`); `PickZoneLookup` is declared in fulfillment
  (`PickZoneLookup.kt:8`).
- An event payload that another module observes is declared in the firing module's `-api`, so the
  observer needs no edge to the firing module's core (`WavePickActivityEvent.kt:3-7`).
- `-api` modules depend on each other with `implementation`. The single `api(...)` edge is
  `karyo-wave-api` on `karyo-orders-api`, because the wave SPIs expose orders types in their own
  signatures (`services/wave-service/karyo-wave-api/build.gradle.kts:10-11`).
- Every module whose beans the application must discover carries a `META-INF/beans.xml`;
  twenty-three modules do.
- **Three waivers**, recorded as waivers and not as precedent:
  1. `karyo-ai-core` depends on ten other cores. Its copilot tools are thin wrappers over domain
     services called in-process; routing every tool through a new SPI would mean inventing a lookup
     interface per tool (`services/ai-service/karyo-ai-core/build.gradle.kts:11-32`).
  2. `karyo-demo` depends on eight other cores. It is a leaf module that is off in production and
     invisible when off - its routes answer 404 unless `KARYO_DEMO=on` - and it reuses the domain
     entities and repositories to construct back-dated demo data
     (`services/demo-service/karyo-demo/build.gradle.kts:6-26`; `DemoEnabledFilter.kt:19-23`;
     `services/karyo-app/src/main/resources/application.yaml:246`).
  3. One commercial engine, `karyo-monitors-core`, depends on `karyo-replenishment-core` to call the
     replenishment service's needs query. **Its reason is not recorded.** `karyo-replenishment-api`
     holds only its DTOs and `ReplenishmentStrategy`, so there is no SPI the engine could have used
     instead. It is also the one dependency that runs from a commercial engine into a free core, so
     the commercial build needs this repository's source tree, not only its `-api` jars.
- A new `-core`-to-`-core` dependency needs, at minimum, a justification comment in the build file.
  Unless it is a production-disabled leaf or an in-process tool facade, the right answer is an SPI
  in the owning `-api`.

## Consequences

- The contract surface is explicit: each `-api` is what other modules, extensions and the
  commercial engines may rely on.
- Which bean satisfies an SPI is resolved by CDI at runtime. The graph shows who consumes a
  contract, not who fulfils it.
- **Nothing mechanical enforces the rule.** No ArchUnit test, no Gradle dependency check and no
  Detekt rule fails on a new `-core`-to-`-core` edge. The waiver list above is re-proved by grepping
  the build files, and a fourth edge would pass every check the build runs.
- The Gradle graph is one of four coupling channels, not the whole picture. Modules also couple
  through the shared schema ([ADR 0011](0011-reporting-reads-the-database-directly.md)), through
  CDI events that observers bind by type ([ADR 0008](0008-synchronous-rest-and-cdi-events.md)), and
  through SPI implementations resolved at runtime
  ([Modules and boundaries](../modules-and-boundaries.md)).
- Every cross-module question costs an interface in the owning `-api`. The free tree has
  thirty-seven lookup, port and guard interfaces in its `-api` modules.
- A `-core` cannot boot on its own, so its tests run in the aggregator against the real
  implementation of every SPI it consumes ([ADR 0001](0001-modular-monolith.md)).

## Alternatives considered

- **One module per domain, with no `-api`/`-core` split.** Rejected: contract and implementation
  would blur into one unit that can only be consumed whole, and extracting a module later would be
  impossible. The split costs little.
- **A network boundary between modules.** Rejected; see [ADR 0001](0001-modular-monolith.md).

## Evidence

- `settings.gradle.kts:10-148` - every domain as an `-api`/`-core` pair
- `services/ai-service/karyo-ai-core/build.gradle.kts:11-32` - waiver 1 and its comment
- `services/demo-service/karyo-demo/build.gradle.kts:6-26` - waiver 2 and its comment
- `services/demo-service/karyo-demo/src/main/kotlin/com/karyo/demo/api/v1/DemoEnabledFilter.kt:19-23` - the demo routes answer 404 when off
- `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/spi/OpenPickGuard.kt:3-19` - declare here, implement there
- `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/spi/PurgeBlockerLookup.kt:24-29` - the same pattern, four implementors
- `services/fulfillment-service/karyo-fulfillment-api/src/main/kotlin/com/karyo/fulfillment/event/WavePickActivityEvent.kt:3-13` - a payload placed in `-api` to avoid a core edge
- `services/wave-service/karyo-wave-api/build.gradle.kts:10-11` - the one `api(...)` edge
- [Modules and boundaries](../modules-and-boundaries.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - why the boundary is a build rule rather than a network
- [ADR 0007](0007-cross-module-references-by-id.md) - the data half of the same boundary
- [ADR 0019](0019-extensions-compile-into-the-build.md) - extensions build against `-api` modules
- [ADR 0020](0020-free-and-commercial-boundary-per-module.md) - the commercial engines plug into `-api` seams
