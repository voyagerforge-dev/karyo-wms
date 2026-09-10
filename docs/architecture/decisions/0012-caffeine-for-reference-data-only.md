# ADR 0012: An in-process Caffeine cache holds reference data only; stock is never cached

**Status:** Accepted

## Context

Picking, putaway and receiving read the same reference data over and over within one operation:
products by id, number and barcode, item units, locations by id and scan code, zones, areas,
location types, clusters, storage strategies, storage areas and unit-load types. It changes rarely.

Stock does the opposite. Stock units and unit loads change on every pick, reservation, transfer and
count. Serving a stale amount or a stale location is the most dangerous caching mistake a
warehouse system can make: it produces double picks and phantom inventory.

Karyo runs as one application process per installation ([ADR 0001](0001-modular-monolith.md),
[ADR 0022](0022-compose-four-container-deployment.md)), so an in-process cache is seen by every
request the installation serves.

## Decision

- **Reference data is cached in process with the Quarkus cache (Caffeine).** Each cache is declared
  by name in `application.yaml` with an `expire-after-write` and a `maximum-size`: thirteen caches,
  sixty minutes for most and thirty for the two location lookups.
- **Reads are `@CacheResult`; the owning service's writes invalidate** with `@CacheInvalidate` or
  `@CacheInvalidateAll`. The time-to-live is the safety net for anything that changes a row without
  going through those methods.
- **Stock units and unit loads are never cached.** No cache annotation exists on any stock-unit or
  unit-load read, and none may be added.
- **The runtime property store is not cached.** Its reads are bounded indexed lookups on
  administrative paths; its KDoc names the condition under which a short-TTL cache should be added.
- There is no distributed cache.

## Consequences

- Reference lookups inside selection and putaway are served from memory, and there is no cache
  infrastructure to deploy or operate.
- Stock reads always hit the database, so an operator never sees an amount another transaction has
  already changed.
- Invalidation is local to the writing service's methods. A change made any other way - a
  migration, a direct SQL fix, the demo reset's `TRUNCATE ... RESTART IDENTITY` - leaves stale entries
  until they expire. The demo reset has to invalidate eleven caches explicitly for exactly this
  reason.
- The design assumes one application instance. A second instance would keep its own cache and never
  see the first one's invalidations.

## Alternatives considered

- **A distributed cache (Redis) as a second level.** Rejected. Its purpose is to share cached data and
  invalidations between several processes or replicas. Karyo runs one process per installation, so
  there is nothing to share, and it would be one more container to deploy and watch.
- **No cache at all.** Not chosen. The recorded reason for caching reference data is the volume of
  repeated lookups inside every selection and putaway pass; no measurement of the benefit in the
  single-process deployment is recorded.

## Evidence

- `services/karyo-app/src/main/resources/application.yaml:58-102` - the thirteen cache declarations and their limits
- `services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/service/UnitLoadTypeService.kt:20,27,39,79` - a cached read and the writes that invalidate it
- `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/service/ProductService.kt:42,48,375,381` - product caches by id and by number
- `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/service/LocationService.kt:68,74,373,379` - location caches by id and by scan code
- `services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyService.kt:22-25` - why the property store is not cached
- `services/demo-service/karyo-demo/src/main/kotlin/com/karyo/demo/service/DemoDataService.kt:116-137` - the explicit invalidation a direct table reset needs

## Related

- [ADR 0001](0001-modular-monolith.md) - one process, which makes an in-process cache sufficient
- [ADR 0010](0010-crud-with-an-inventory-journal.md) - current stock read directly from its rows
- [ADR 0022](0022-compose-four-container-deployment.md) - the single-instance deployment the cache assumes
- [Runtime and configuration](../runtime-and-configuration.md) - where the cache block sits in the configuration
