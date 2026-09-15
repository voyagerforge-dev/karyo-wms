# The configuration boundary

The question an implementation consultant asks on day one: **what can a person change without
writing code, what needs a build-time extension, and what needs core work?**

Karyo has four answers, in descending order of how easily they can be changed. The boundaries
between them are not declared in any one place; this document assembles them from the code.

| Tier | Changed by | Takes effect | Scope | Surface |
|---|---|---|---|---|
| 1. Runtime store | An administrator in the browser | Immediately | Per goods owner, or instance-wide | 16 catalog keys |
| 2. Configuration data | An administrator over REST | Immediately | Varies by entity | Layout, strategies, products, users, clients |
| 3. Environment | An operator editing config, then restarting | On restart | Instance-wide | 26 `karyo.*` properties, plus 17 read only by commercial engines |
| 4. Extension JAR | A developer, then a rebuilt image | On redeploy | Instance-wide | 79 SPI interfaces |

Anything not on that list is core work.

Tiers 1 and 2 are described in
[the runtime configuration store](runtime-configuration-store.md),
[warehouse layout configuration](warehouse-layout-configuration.md),
[strategies and policies](strategies-and-policies.md),
[goods owners and clients](goods-owners-and-clients.md),
[users, roles and permissions](users-roles-and-permissions.md) and
[reference data](reference-data.md). This document covers tiers 3 and 4, and the entitlement
gate that cuts across all four.

## Tier 3: environment knobs

Twenty-six `karyo.*` properties are injected as `@ConfigProperty` values in the main code of
this repository:

| Area | Keys |
|---|---|
| ai | `provider`, `proposal-ttl-seconds` |
| auth-audit | `enabled` |
| demo | `enabled`, `history-days`, `location-count`, `orders-per-day`, `seed`, `sku-count` |
| fulfillment | `pick-bin-unit-load-type-id` |
| inventory | `purge.batch-size`, `purge.enabled` |
| license | `entitlements`, `key`, `public-key` |
| print | `url` |
| receiving | `allow-over-receipt` |
| replenishment | `auto-scan-enabled`, `scan-interval` |
| sequence | `generator` |
| webhooks | `backoff-base`, `backoff-cap`, `batch-size`, `http-timeout`, `max-attempts` |
| work | `dispatch-strategy` |

Seventeen more are injected by the commercial engines, which are not in this repository:

| Area | Keys |
|---|---|
| forecasting | `ewma-alpha`, `history-days`, `horizon-days`, `lead-time-days`, `review-period-days`, `service-level` |
| monitors | `delivery-batch-size`, `delivery-max-attempts` |
| simulation | `history-days`, `lead-time-days`, `review-period-days`, `service-level`, `simulator` |
| slotting | `a-threshold`, `b-threshold`, `history-days`, `mismatch-threshold` |

The forecasting, slotting and simulation keys have values in the public `application.yaml`,
beside the engines' scheduler intervals (`karyo.monitors.*`, `karyo.crossdock.sweep-interval`,
`karyo.wave.auto-interval`, `karyo.streaming.interval`)
(`services/karyo-app/src/main/resources/application.yaml:170-191,231-244`). In a free build
the beans that read them are absent, so those keys are present and inert.

Exactly one of the environment knobs - `karyo.receiving.allow-over-receipt` - is also a catalog
key, and it is the only one an administrator can change on a running instance or vary per goods
owner. The runtime store's own KDoc frames it as the place environment knobs are meant to go:
the catalog "grows as existing `@ConfigProperty` knobs migrate onto the runtime store"
(`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyCatalog.kt:27-34`).
The other thirteen catalog keys are not `@ConfigProperty` injections anywhere; their consumers
read them through the store, whose third rung still falls back to an environment value of the
same name.

Several environment knobs are the kind of setting a 3PL varies per customer: replenishment scan
cadence, work dispatch strategy, and - in the commercial engines - the ABC thresholds slotting
uses and the six forecasting parameters. All of them are instance-wide and restart-only, and why
these knobs are environment-only is not recorded.

There is a related convention worth carrying forward because it is stated as a rule and obeyed
consistently: an injected `@ConfigProperty` must never default to the empty string, the
"SRCFG00040 boot-trap rule"
(`services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/config/ReceivingConfig.kt:16-19`,
`libs/karyo-sequence/src/main/kotlin/com/karyo/sequence/SequenceConfig.kt:11-12`). Each
config-holder bean also exists separately rather than being injected into a service directly,
so the service stays constructible in plain unit tests without CDI.

The trap here is the interaction with tier 1. The runtime store accepts and stores **any** key,
catalog or not (`SystemPropertyCatalog.kt:30-32`,
`services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/config/SystemPropertyService.kt:159-167`).
An administrator can therefore write `karyo.work.dispatch-strategy` into the system-properties
screen, see it saved, see it listed, and have it do nothing - because the consumer holds an
injected value resolved once at construction and never consults the store. Nothing on the
screen distinguishes a key that is wired from one that is inert.

## Tier 4: extension JARs

Karyo's extension model is CDI beans compiled into the build
([ADR 0019](../architecture/decisions/0019-extensions-compile-into-the-build.md)). Strategy
seams resolve by priority with a built-in registering last, so a custom implementation
pre-empts the default without configuration - the pattern is stated on `OrderStrategyResolver`
(`services/order-service/karyo-orders-api/src/main/kotlin/com/karyo/orders/spi/OrderStrategyResolver.kt:3-15,24-27`)
and repeated for packout, carrier and putaway strategies. There is a reference extension
demonstrating the drop-in pattern, `HazmatStockFilter` in `karyo-inventory-ext-example`, which
is not wired into the running application by default
(`frontend/web/src/pages/admin/spi-catalog.ts:77-85`). How an extension is built and installed
is in [extension SPIs and installation](../integration/extension-spis-and-installation.md).

Counting every top-level interface declared in an `spi` package under a main source set gives
**79**. Every one of them is in an Apache-2.0 module: the commercial engines implement seams
declared here, and declare none of their own.

The admin **Extensions (SPI)** page is backed by a live registry that resolves a list of
fully-qualified names through `Class.forName` and asks the CDI `BeanManager` which beans satisfy
each one
(`services/karyo-app/src/main/kotlin/com/karyo/app/admin/AdminExtensionsResource.kt:28-69`).
The list holds **77** entries: every declared seam except two that are not extension points,
`ReservationSourceState` (an opaque snapshot) and `ConcurrentStateChange` (a marker an exception
carries). Its comment states the rule and its consequence - "Any other absence is a defect in
this list" (`AdminExtensionsResource.kt:72-92`).

The mechanism's comments are careful. An interface that fails to resolve is dropped as "honest,
not fabricated", and one that resolves with zero beans is still reported, "because a declared
seam with no active implementation is itself useful information"
(`AdminExtensionsResource.kt:36-39`). That is how the commercial engines' seams appear in a free
installation: their `-api` modules are here, so seams such as `CrossDockingMatcher`,
`WaveSelectionStrategy` and `ReleaseTimingStrategy` are listed with no implementation
(`AdminExtensionsResource.kt:88-91`). The seams that configuration knobs name are all on the
list - `CrossDockingMatcher`, which the system-property catalog itself names as the SPI the
opportunistic cross-dock rung matches through (`SystemPropertyCatalog.kt:113-117`), and the
two selected by the `streamTimingStrategy` and `waveSelectionStrategy` strategy knobs.

Two limits remain.

- **The list is complete by a rule, and still maintained by hand.** Nothing fails when a new
  `spi` interface is added without a row: the registry's test checks two known entries, not
  completeness
  (`services/karyo-app/src/test/kotlin/com/karyo/app/admin/AdminExtensionsResourceTest.kt:14-27`).
- **Presence is not a promise that a seam is safe to implement.** In-process lookups and ports -
  `ClientLookup`, `RuntimePropertyLookup`, `StockMover`, `OpenPickGuard` and the rest of the
  cross-module read contracts - sit in the same list as genuine extension points, and nothing in
  the response tells them apart (`AdminExtensionsResource.kt:83-86`). The
  `RuntimePropertyLookup` KDoc says in as many words that it is not an extension seam
  (`services/auth-service/karyo-auth-api/src/main/kotlin/com/karyo/auth/spi/RuntimePropertyLookup.kt:14-16`).

A second, static catalog backs the same page when the live registry is unavailable.
`spi-catalog.ts` holds ten entries - nine compiled seams and one entry for the JSONB strategy
knobs - and describes itself as intentionally static (`spi-catalog.ts:1-16`). The live registry
requires `ADMIN` while the page is reachable with `user-admin`, so a `user-admin` administrator
without `ADMIN` is shown the static list, with a note saying so (see
[users, roles and permissions](users-roles-and-permissions.md#three-vocabularies-in-one-product)).
The admin sidebar's badge on **Extensions (SPI)** counts the static catalog, not the live one
(`frontend/web/src/config/admin-navigation.ts:72`). Two lists kept in step by hand, one a small
subset of the other, with nothing checking either.

## The entitlement gate cuts across every tier

Every commercial engine is gated by a licence entitlement key, listed in
[commercial engines](../commercial/README.md#ten-engines-nine-modules-eight-keys). Each key is
declared by a commercial engine's `LicensedModuleInstallation` bean
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicensedModuleInstallation.kt:3`). No such
bean is in this repository, so a free build installs no entitlement and reports itself as the
community edition: the edition is a property of the image rather than of its licence state, and "an
entitlement list can only ever be a subset of what the build installs"
(`libs/karyo-license/src/main/kotlin/com/karyo/license/LicenseEdition.kt:3-22`). How a licence
reaches a running instance belongs to
[licence and entitlement](../operations/licence-and-entitlement.md); what the gate does and does not
hold, to [the commercial boundary](../architecture/commercial-boundary.md).

What matters here is that the gate is visible on some configuration screens and invisible on
another.

**Visible.** The order strategy form consults the licence and locks the controls whose features
are not entitled - `releaseMode = STREAM` against `advanced-fulfillment`, and the cartonization
packout against `cartonization`
(`frontend/web/src/pages/strategies/order-strategy-form.tsx:9,16,69,201,204`). The document
templates page renders only a locked panel without `documents`
(`frontend/web/src/pages/admin/admin-templates-page.tsx:276-277`).

**Invisible.** The system properties screen does not. `SystemPropertyCatalog` has no licence
dependency, `SystemPropertyService.effectiveView` renders `catalog.all()` unconditionally
(`SystemPropertyService.kt:92-98`), and the page imports no licence hook. Twelve of the sixteen
catalog keys are read only by a commercial engine: two cartonization, two alerts (monitors),
four cross-dock, one wave, one streaming and two 3PL billing. A free installation shows all
sixteen, with types, descriptions, defaults and working Save buttons, and stores whatever is
written.

**Known defect.** The product already has the mechanism and applies it one screen away.

## Where the boundary actually falls

Pulling the configuration documents together, this is the honest answer to give an
implementation consultant:

**Configurable without code, and it works:** the warehouse layout in full - zones, areas,
clusters, storage and working areas, location types, the capacity matrix, locations, fix
assignments, planned occupancy; order and storage strategies including their JSONB knobs; goods
owners; users and role assignment; products and their capture rules; unit load types; units of
measure; webhook subscriptions; document templates where that commercial engine is installed and
entitled; and the sixteen runtime properties.

**Configurable only with a restart:** the environment knobs, including the replenishment scan,
work dispatch strategy and the sequence generator, and the commercial engines' slotting
thresholds and forecasting parameters.

**Configurable only by editing the database:** number ranges - format, length, end counter and
check digit (see [reference data](reference-data.md#number-ranges-have-no-administration-surface-at-all)).

**Configurable only through Keycloak's own console:** granting any of the twenty atomic roles,
because the product's user form offers only the seven composites (see
[users, roles and permissions](users-roles-and-permissions.md#what-the-admin-ui-cannot-express)).

**Needs an extension JAR and a rebuilt image:** any of the declared SPI seams - a carrier
adapter, a packout strategy, a putaway strategy, a work dispatch strategy, a stock selection
filter. A seam declared by a commercial engine's `-api` module - a detector, a forecast model -
takes effect only where that engine is installed.

**Needs core work:** a second warehouse in one installation; a per-goods-owner order strategy;
per-workstation configuration (the field exists and resolves to nothing - see
[the runtime configuration store](runtime-configuration-store.md#the-property-context-is-stored-offered-and-never-read));
deleting a storage strategy, an order strategy or a location cluster; deleting a user; moving a
user between goods owners; and any fine-grained permission model beyond the realm's twenty roles.

The last group is the one worth stating out loud, because four of its seven items look
configurable from the screens: a workstation context field, a strategy list, a user list and a
warehouse field on the user form all invite an administrator to do something the product will
accept and not perform.

## Related

- [Extension SPIs and installation](../integration/extension-spis-and-installation.md) - building and installing an extension
- [The commercial boundary](../architecture/commercial-boundary.md) - what the entitlement gate covers
- [Runtime and configuration](../architecture/runtime-and-configuration.md) - how environment configuration is resolved
- [ADR 0019](../architecture/decisions/0019-extensions-compile-into-the-build.md) - extensions compile into the build
- [ADR 0020](../architecture/decisions/0020-free-and-commercial-boundary-per-module.md) - the free and commercial boundary
