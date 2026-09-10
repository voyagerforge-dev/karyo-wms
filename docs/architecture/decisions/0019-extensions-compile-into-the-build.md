# ADR 0019: Extensions are compiled into the build; nothing is uploaded into a running image

**Status:** Accepted

## Context

Implementers need to change Karyo's behaviour for a client - a stock-selection filter, a putaway
strategy, a carrier adapter - without forking the source.

Karyo is a Quarkus application packaged as a fast-jar image. Quarkus discovers CDI beans during
build-time augmentation, so the set of beans an image contains is fixed when it is built: a JAR placed
beside a running process is invisible to it.

Extension code runs inside the application process with the same trust as Karyo's own code. Nothing
sandboxes it.

## Decision

- **An extension is a module compiled against the Apache-2.0 `-api` modules and the CDI API only,**
  never against a `-core`. It carries `META-INF/beans.xml`, is added to the application build before
  Quarkus augmentation, and the image is rebuilt.
- **There is no runtime plugin mechanism:** no upload endpoint, no hot discovery, no directory scanned
  at start-up.
- **The worked example is `karyo-inventory-ext-example`.** Its build compiles against
  `karyo-inventory-api` and the CDI API with `compileOnly`. `HeldLotStockFilter` is active:
  `@Alternative @Priority(1000)` switches the CDI alternative on, and `priority() = 500` places it in
  the filter chain - two numbers doing two different jobs. `HazmatStockFilter` is deliberately inactive:
  an `@Alternative` with no `@Priority`. The module is always compiled and tested, and it is included
  in the application only when the build is run with `-PkaryoInventoryExample=true`.
- **The running application reports its seams.** `GET /api/v1/admin/extensions` (`ADMIN`) lists every
  interface declared in a `*.spi` package and the beans that implement each; a seam whose module is not
  on the classpath is dropped from the response.
- **Compatibility is not unconditional.** Additive, defaulted members aim to keep extensions working,
  but an extension must be recompiled and tested against each release. No `-api` artefact is published
  to a Maven repository; an extension builds against this repository's module graph.
- The commercial engines plug into their seams the same way, as build-time modules
  ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).

## Consequences

- An installation runs exactly the code that was built and tested into its image, and the image is the
  unit of deployment and rollback.
- Anyone can build their own extended free image, with no involvement from the vendor.
- Changing an extension is a rebuild and a redeploy.
- Extension code must preserve Karyo's invariants itself - stock arithmetic, owner isolation, the
  transaction it runs in. A bean is trusted in-process code.
- The registry does not distinguish a seam meant to be implemented from a single-implementation
  lookup or port that happens to live in an `spi` package. Presence in the list is not a promise that
  implementing it is safe, and a declared seam is not a promise that its consumer will call a second
  implementation.
- **Known defect.** Two seams' own documentation still describes discovery from "any JAR on the
  classpath" and deployment "in a client extension JAR" without saying the JAR must be present at
  build time.
- **Known defect.** The console's static catalogue of ten seams still drives the navigation badge and
  is what the extensions page falls back to when the live registry is unavailable, so an
  administrator can be shown ten seams where the registry reports every declared one.

## Alternatives considered

- **Drop-in JARs loaded by the running application.** Rejected. Quarkus resolves CDI beans at
  build-time augmentation, so a JAR added after the build is never discovered; supporting it would mean
  giving up the build-time model the application is packaged on.
- **Forking the source per client.** Not a supported route. The supported routes are configuration
  ([ADR 0018](0018-strategy-driven-configuration.md)), integration through the API and webhooks, and a
  build-time extension of a published contract. Why forks are excluded is not recorded beyond that
  preference.
- **Publishing the `-api` modules to a Maven repository** so an extension can build outside this
  repository. Not done: it would add a distribution channel and a versioning surface to own.

## Evidence

- `settings.gradle.kts:24` - the example module is always part of the build
- `services/karyo-app/build.gradle.kts:42-45` - included in the application only on request, "never a runtime JAR upload"
- `services/inventory-service/karyo-inventory-ext-example/build.gradle.kts:5-8` - compiled against the API module and CDI only
- `services/inventory-service/karyo-inventory-ext-example/src/main/resources/META-INF/beans.xml` - bean discovery for the extension module
- `services/inventory-service/karyo-inventory-ext-example/src/main/kotlin/com/karyo/inventory/ext/example/HeldLotStockFilter.kt:19-31` - activation priority and chain priority
- `services/inventory-service/karyo-inventory-ext-example/src/main/kotlin/com/karyo/inventory/ext/example/HazmatStockFilter.kt:13-23` - an alternative that is never activated
- `services/karyo-app/src/main/kotlin/com/karyo/app/admin/AdminExtensionsResource.kt:41-58,72-91` - the live registry and the rule that makes it complete
- `services/inventory-service/karyo-inventory-api/src/main/kotlin/com/karyo/inventory/api/spi/StockSelectionFilter.kt:8` and `services/warehouse-layout-service/karyo-layout-api/src/main/kotlin/com/karyo/layout/spi/LocationFilter.kt:21-22` - the two stale discovery descriptions
- `frontend/web/src/pages/admin/spi-catalog.ts:12-15`, `frontend/web/src/config/admin-navigation.ts:72` and `frontend/web/src/components/layout/admin-shell.tsx:47` - the static catalogue and where it is still used

## Related

- [ADR 0006](0006-api-and-core-modules.md) - why an extension compiles against `-api` only
- [ADR 0018](0018-strategy-driven-configuration.md) - how each seam selects among implementations
- [ADR 0020](0020-free-and-commercial-boundary-per-module.md) - the commercial engines as build-time modules
- [Extension SPIs and installation](../../integration/extension-spis-and-installation.md) - the seams and the installation route in full
- [Implementer guide](../../guides/implementer-guide.md) - building and verifying an extended image
