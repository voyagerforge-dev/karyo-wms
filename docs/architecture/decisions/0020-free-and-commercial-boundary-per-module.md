# ADR 0020: The free and commercial boundary is drawn per Gradle module

**Status:** Accepted

## Context

Karyo is offered in two halves: a free warehouse management system under Apache-2.0, and nine
optional commercial engines licensed separately - event monitors, demand forecasting, slotting
advice, reorder simulation, cross-docking, wave fulfilment, order streaming, document templates
and cartonization.

The two halves meet at many points. A commercial engine implements an interface the free product
declares, observes events the free product fires, reads tables the free product owns, and appears
in the free front ends. The interfaces at those meeting points have to be readable, compilable and
implementable by anyone: the free product declares seams it does not fill, and an extension author
compiles against the same seams (ADR 0019).

A boundary drawn by service directory does not fit that shape. Two free domains hold a commercial
capability beside free code - fulfilment beside cartonization, the document archive beside
template administration - and every engine's interface module would fall on the commercial side
of its directory, taking the seams with it.

## Decision

- **The licence boundary is the Gradle module.** Nine `-core` modules are commercial. Every other
  module is Apache-2.0, including every `-api` module, every SPI a commercial engine implements,
  and `libs/karyo-license`, which holds the gate mechanism.
- **No module mixes free and commercial code.** Where a commercial capability belongs to a free
  domain it is its own module (`karyo-cartonization-core` beside `karyo-fulfillment-core`,
  `karyo-doctemplates-core` beside `karyo-docstore-core`), and the SPI it implements stays in the
  free module next to it: `PackoutStrategy` in `karyo-fulfillment-api`, `DocumentTemplateProvider`
  in `libs/karyo-documents`.
- **The module boundary is also the repository boundary.** The nine commercial modules are not in
  this repository. `settings.gradle.kts` includes them only when a commercial checkout is present
  (`-Pkaryo.commercial=<path>` or `KARYO_COMMERCIAL=<path>`, or a checkout found beside this one)
  and takes their project directories from it; `services/karyo-app` depends on whichever of them
  were included. With nothing beside this checkout the build is the complete free product.
- **Free code never names a commercial module.** The engines plug in through the SPIs and CDI
  events declared in the free `-api` modules, and are found at runtime.

## Consequences

- Whether a file is free is decided by where it lives. No list of paths has to agree with the tree,
  and nothing has to be filtered out of anything before it is published.
- Free code cannot come to depend on a commercial module by accident: the free build, which is
  what this repository's CI runs, has no such project to resolve, so the dependency fails to build.
- A licence cannot install code that is not on disk. A free build carries no commercial engine, so
  no entitlement can unlock one; such a build reports itself as the `community` edition
  (ADR 0021).
- An image says which halves it carries. Built with commercial engines, the application image holds
  each one's own licence and a licence label naming the commercial terms beside Apache-2.0; built
  from this repository alone it holds neither, and a label that disagrees with what the image holds
  fails the build.
- Anyone can build against every seam. An extension compiles against the Apache-2.0 `-api`
  modules only (ADR 0019).
- **The free repository still describes the commercial half in outline.** `settings.gradle.kts`
  names the nine module directories; the engines' `-api` modules, their Flyway migrations
  (`db/migration/{monitors,crossdock,wave,streaming}`), their configuration keys in
  `application.yaml` and their front-end screens are all here. A free installation therefore
  creates the engines' tables and leaves them empty, carries their keys unread, and shows their
  screens, which answer with a licence refusal. The schema and the interfaces are public; the
  algorithms are not.
- A change that touches both a commercial engine and the free seam it plugs into is two changes,
  in two repositories, reviewed and merged separately.
- One commercial engine depends on a free `-core` rather than on its `-api`: `karyo-monitors-core`
  uses `karyo-replenishment-core`. The edge points the permitted way, commercial on free, and it
  is one of the three recorded waivers of the module rule (ADR 0006). It also means a commercial
  build needs this repository's source tree, not only its interface jars.

## Alternatives considered

- **A boundary per service directory.** Rejected. It puts each engine's `-api` module under the
  commercial licence, which takes the interfaces the free product and extension authors compile
  against out of Apache-2.0, and it cannot separate cartonization from free fulfilment or template
  administration from the free document archive, which share a directory.
- **One repository holding both halves, with the free tree produced from it by filtering.**
  Rejected. Every filtering rule is a second place that has to agree with the first, and the free
  tree would be a rendering of the product rather than its source.
- **Publishing the free modules as jars for a separate commercial build to depend on.** Rejected.
  Because one engine depends on a free `-core`, that would mean publishing implementation jars of
  the free product as well as its interfaces - a distribution channel and a versioning surface
  with no other reason to exist.
- **A Gradle composite build joining two independent builds.** Rejected. The commercial build
  would need its own settings, convention plugins and version catalog, kept in step with these by
  hand.

## Evidence

- `settings.gradle.kts:150-194` - the optional commercial overlay
- `services/karyo-app/build.gradle.kts:5-34,64-71` - whatever was included is picked up, along
  with the commercial test suites
- `services/fulfillment-service/karyo-fulfillment-api/src/main/kotlin/com/karyo/fulfillment/spi/PackoutStrategy.kt`
  and `libs/karyo-documents/src/main/kotlin/com/karyo/documents/DocumentTemplateProvider.kt` - the
  two SPIs that stay free beside a commercial module
- `libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseEdition.kt:3-23` - the edition is
  a property of what the build contains
- `NOTICE:9-25` - the nine commercial modules, named as outside the Apache grant and absent from a
  build of this repository alone
- `services/karyo-app/build.gradle.kts:173-213` and `infrastructure/docker/Dockerfile.service:75-93`
  - the application image states which halves it carries
- [The commercial boundary](../commercial-boundary.md)
- [Commercial engines](../../commercial/README.md)

## Related

- [ADR 0001](0001-modular-monolith.md) - one deployable, assembled from modules
- [ADR 0006](0006-api-and-core-modules.md) - the `-api` and `-core` rule, and its three waivers
- [ADR 0019](0019-extensions-compile-into-the-build.md) - extensions build against the same seams
- [ADR 0021](0021-signed-entitlement-resolved-at-startup.md) - what decides which present engines
  may run
