# The commercial boundary

Karyo is Apache-2.0. Ten optional engines are licensed separately and their code is not in this
repository. This document describes where the free product stops, how one build picks the engines
up when they are present, and what the entitlement gate does and does not cover.

Derived from `settings.gradle.kts`, `services/karyo-app/build.gradle.kts`, `libs/karyo-license/`,
and every `require`/`isEntitled` call site visible from this repository.

## The boundary is per Gradle module

Nine `-core` modules are commercial
([ADR 0020](decisions/0020-free-and-commercial-boundary-per-module.md)). Everything else is
Apache-2.0 and is here: every `-api` module, every SPI the engines implement, the shared libraries
including the licence gate itself, both front ends, the schema and the deployment material. The
boundary is the module, never the containing service directory: `services/fulfillment-service/`
holds the free `karyo-fulfillment-core`, and in a full build the commercial cartonization engine
sits beside it; `services/document-service/` holds the free `karyo-docstore-core`, and in a full
build the document-templates engine sits beside it.

| Engine | Commercial module | Entitlement key |
|---|---|---|
| Wave fulfilment | `karyo-wave-core` | `advanced-fulfillment` |
| Cross-docking | `karyo-crossdock-core` | `advanced-fulfillment` |
| Order streaming | `karyo-streaming-core` | `advanced-fulfillment` |
| Cartonization | `karyo-cartonization-core` | `cartonization` |
| Document templates | `karyo-doctemplates-core` | `documents` |
| Event monitors | `karyo-monitors-core` | `monitors` |
| 3PL billing | `karyo-monitors-core` | `three-pl` |
| Demand forecasting | `karyo-forecasting-core` | `forecasting` |
| Slotting advisor | `karyo-slotting-core` | `slotting` |
| Reorder simulation | `karyo-simulation-core` | `simulation` |

Three modules share one key. A customer buying Advanced Fulfillment gets waves, cross-docking and
order streaming together. One module carries two engines: `karyo-monitors-core` holds 3PL billing,
under its own `three-pl` key, beside event monitors. [Commercial engines](../commercial/README.md)
describes what each engine does.

## Two repositories, one build

The commercial modules live in a separate private repository. This repository's build includes them
only when a checkout of it is present (`settings.gradle.kts:150-194`):

- `-Pkaryo.commercial=<path>` or `KARYO_COMMERCIAL=<path>` names the checkout explicitly; otherwise
  a sibling directory named `karyo-commercial` is used when it exists (`:176-183`).
- A named path that is not a commercial checkout fails the build (`:185-188`) rather than silently
  producing a free image under a full-product command.
- Each of the nine is then included, with its project directory taken from the checkout (`:164-174`,
  `:189-193`).

`services/karyo-app/build.gradle.kts` follows whatever the settings file decided. It keeps the same
list of nine (`:5-16`), adds whichever of them exist as implementation dependencies (`:64-71`),
grafts the commercial test suites onto the app's own test source set when a commercial checkout
provides them and hands them to `detekt` as well (`:18-34`), and stages the licence files the
application image carries, each included engine's own licence among them (`:173-213`).

| | This checkout alone | With a commercial checkout |
|---|---|---|
| Gradle subprojects | 44 | 53 |
| `karyo-app` dependencies | the free cores | the free cores plus the nine |
| Tests and `detekt` | the free suites | the free suites plus the commercial suites |
| Image | community edition; no licence can unlock code that is not on disk | commercial edition; the licence decides what runs |
| Image licence label | `Apache-2.0` | `Apache-2.0 AND LicenseRef-Karyo-Commercial`, with each engine's own licence under `/app/commercial-licenses/` |
| Build command | `./gradlew :services:karyo-app:quarkusBuild` | identical |

The edition is a property of the image, not of its licence: a build carrying no
`LicensedModuleInstallation` bean is `community`, any other build is `commercial`
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseEdition.kt:3-23`).

## What stays public

A free installation carries more of the commercial engines than their absence suggests. All of it
is here on purpose: the free product declares the seams it does not fill, and keeping the schema and
configuration in one place means `application.yaml` and the Flyway history are the same in both
builds.

- **Their `-api` modules**, seven of them, with the extension seams each engine declares - for
  example `Detector` in `karyo-monitors-api`, `ForecastModel` in `karyo-forecasting-api` and
  `WaveSelectionStrategy` in `karyo-wave-api`.
- **The free SPIs they plug into**: `PackoutStrategy` in `karyo-fulfillment-api`,
  `DocumentTemplateProvider` in `libs/karyo-documents`, and the release, pick and transport ports
  the engines call
  ([Commercial engines](../commercial/README.md#they-mostly-drive-free-code)).
- **Their schema.** The monitors, cross-docking, wave and streaming migrations, the document
  templates table and several columns on free tables, all applied to every installation
  ([Data and persistence](data-and-persistence.md#the-commercial-engines-schema-lives-here)).
- **Their configuration keys.** `karyo.monitors`, `karyo.forecasting`, `karyo.slotting`,
  `karyo.simulation`, `karyo.crossdock`, `karyo.wave` and `karyo.streaming` in
  `services/karyo-app/src/main/resources/application.yaml:170-191,231-244`, read by beans that a free
  build does not contain. The runtime catalogue lists the engines' knobs too
  ([Commercial engines](../commercial/README.md#the-ten-engines-and-the-free-products-own-settings-screen)).
- **Their screens.** Both front ends are wholly public and include every commercial screen. The
  console shows a locked panel in their place; the floor app does not
  ([Gating and degradation](../commercial/gating-and-degradation.md)).

## Entitlement resolution

`LicenseService` resolves entitlements **once, at construction**, on an `@ApplicationScoped` bean,
in a documented order
([`LicenseService.kt:8-20`](../../libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseService.kt#L8-L20),
[ADR 0021](decisions/0021-signed-entitlement-resolved-at-startup.md)):

1. `karyo.license.key` set and it verifies (Ed25519 against the bundled vendor public key) gives the
   token's entitlements.
2. Set but not verifying (bad signature, expired, malformed) gives the empty set. A present but
   invalid licence is never silently downgraded to the plain fallback below. That is the important
   property.
3. No signed key falls back to the plain `karyo.license.entitlements` value (`KARYO_LICENSE`).

Two consequences follow from resolve-once: a licence change requires a restart, and entitlements are
**global to the instance**, not per goods owner - `isEntitled(moduleKey)` takes no `clientId`
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseService.kt:72`). Both are coherent
under silo tenancy, where one instance serves one operating company and the licence belongs to that
company.

The `@ConfigProperty` defaults there are all non-empty sentinels (`"none"`,
`VendorKey.NOT_OVERRIDDEN`) rather than `""`, with inline comments explaining that SmallRye treats
an empty resolved value as missing and fails boot (`:23-37`). The same trap recurs across the
repository, and this file is its clearest worked example.

## What the marker interface does, and does not, do

`LicensedModuleInstallation` is a one-property interface
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicensedModuleInstallation.kt:3-5`), and each
commercial engine declares one `@ApplicationScoped` implementation of it. It is tempting to read it
as the gate. It is not.

Its only consumer is `LicenseResource`, the disclosure endpoint, via
`LicenseEdition.installedEntitlements`
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseResource.kt:37-38`). A build shipping
no `LicensedModuleInstallation` at all is the free community edition; any other build is commercial.
The interface answers "what is in this image", not "may this caller proceed". A free build contains
no implementation of it.

## Enforcement is hand-written per call site

The engines use two styles, and the split is coherent once you see it.

**Hard gate.** `licenseService.require(key)` throws `LicenseRequiredException`, mapped to an HTTP 403
problem response whose `type` distinguishes "no licence" from "wrong role"
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseRequiredExceptionMapper.kt:10-25`).
Used where the engine *adds* a capability that has no free equivalent, so the honest answer to an
unlicensed caller is an error.

**Soft gate.** `if (!licenseService.isEntitled(key)) return null` or an early `return`. Used where
the engine *replaces* a free behaviour through an SPI priority chain, so the honest answer is to fall
through to the free implementation: the cartonization packout strategy returns null and the free
packout runs; the document-templates provider returns null and the built-in template is used.
Schedulers and observers in the engines use the same early return, so an unlicensed instance simply
does no work.

Cross-docking is the interesting hybrid: its REST surface hard-gates, but its receiving interceptor
soft-gates, because receiving must keep working - ordinary putaway is the structural fallback.

### Coverage audit

Every one of the 47 HTTP methods in the engines' REST surfaces is gated, 43 at the resource and the
remaining four one layer down in the service they delegate to. The per-resource table is in
[Gating and degradation](../commercial/gating-and-degradation.md#coverage-still-holds-and-still-nothing-keeps-it-holding).

So coverage is complete. What is missing is anything that keeps it complete. There is no CDI
interceptor binding, no annotation, no test and no build rule that fails when a new endpoint in an
engine forgets its gate. Roughly 47 hand-written call sites hold the commercial boundary by
convention, and re-counting them is the only way to re-prove it. The cross-docking "interceptor" is
named in the domain sense; it is a plain `@ApplicationScoped` observer, not a CDI `@Interceptor`, so
the pattern is not already in use.

## What the gate does not cover

- **Continuity.** Resolve-once means a lapse takes effect at the next restart, and what that restart
  lands on is not designed: cross-dock matches and released waves in flight are stranded
  ([Gating and degradation](../commercial/gating-and-degradation.md#what-a-licence-lapse-does-to-work-already-in-flight)).
- **Signing, in the fallback path.** The plain `KARYO_LICENSE` fallback is described as a
  development convenience, but `LicenseService` honours it in every profile
  (`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseService.kt:59-67`). **Known
  defect:** on a full build with no signed key configured, an unsigned `KARYO_LICENSE` value unlocks
  the engines it names.
- **The front end.** The console locks every commercial screen; the floor app's Sort and Pack-out
  transactions carry no licence check at all.
- **What a free installation carries.** The engines' tables, configuration keys and settings-screen
  entries are present and inert. Setting them does nothing.
- **Cross-engine dependencies.** In a full build all ten engines are installed whatever the licence
  says, so one engine depending on another's beans is invisible until an installation holds one
  entitlement without the other.

## The verification key

The public verification key has one home in this repository,
`libs/karyo-license/src/main/resources/com/karyo/license/vendor-public-key.txt`, read by `VendorKey`
(`libs/karyo-license/src/main/kotlin/com/karyo/license/VendorKey.kt:3-16`). The matching private
key, the minting tool and any licence token are never committed here; minting a licence and rotating
the vendor key both happen outside this repository.

## Related

- [Commercial engines](../commercial/README.md) - the ten engines, seen from outside
- [Gating and degradation](../commercial/gating-and-degradation.md) - how each one refuses
- [Licence and entitlement](../operations/licence-and-entitlement.md) - installing a licence
- [Building](../operations/building.md) - building with and without the commercial checkout
