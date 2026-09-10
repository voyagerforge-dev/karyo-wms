# Karyo documentation

Every document in this repository, one line each. The documents describe Karyo as it behaves
today, including its known defects, and each one names the files its claims come from so that a
reader can check them instead of trusting them.

**New here?** Read the [architecture overview](architecture/overview.md) for how Karyo is put
together, then [what Karyo does in a warehouse](#what-karyo-does-in-a-warehouse). Using an
installed Karyo rather than building it? Go straight to the [user guide](user-guide/README.md).

**Conventions.** A citation such as `services/.../ReplenishmentService.kt:47-87` names a file and
lines in this repository, relative to its root; `...` elides the middle of a long path, and a bare
`:61-66` means lines in the file cited just before it. A paragraph marked **Known defect**
describes behaviour that is wrong today and is tracked as an issue.

## Architecture

How the system is put together, and why.

| Document | What it covers |
|---|---|
| [Overview](architecture/overview.md) | One deployable, four containers, two front ends: the shape of the whole |
| [Modules and boundaries](architecture/modules-and-boundaries.md) | The `-api`/`-core` rule, its three waivers, and the couplings the module graph does not show |
| [Data and persistence](architecture/data-and-persistence.md) | One schema, Flyway version bands, entity base classes, cross-module reads |
| [Events and the outbox](architecture/events-and-outbox.md) | Synchronous CDI events, observer transaction phases, and the outbox's two readers |
| [Identity and tenancy](architecture/identity-and-tenancy.md) | Silo tenancy, goods owners, `principal_kind`, scope resolution, and what enforces isolation |
| [Front ends](architecture/frontend.md) | The desktop console and the floor PWA, route guards, and where entitlement is checked |
| [Runtime and configuration](architecture/runtime-and-configuration.md) | The four containers, nginx routing, the one configuration file, the schedulers |
| [The commercial boundary](architecture/commercial-boundary.md) | Where the free product stops, how a commercial checkout joins the build, and what the gate covers |
| [Testing](architecture/testing.md) | The test tree, the runners, and what each one proves |
| [Decision records](architecture/decisions/README.md) | The architecture decisions Karyo embodies today, numbered from 0001 |

## What Karyo does in a warehouse

The warehouse behaviour, rule by rule.

| Document | What it covers |
|---|---|
| [Stock model and states](functional/stock-model-and-states.md) | Unit loads, stock units, stock states, locks, availability and the inventory journal |
| [Receiving and quality holds](functional/receiving-and-quality-holds.md) | Advance shipping notices, goods receipt, over-receipt, returns, line reversal, and what a quality hold does |
| [Putaway and location finding](functional/putaway-and-location-finding.md) | The auto-putaway observer, the location finder's filters, strategy resolution, soft reservations |
| [Allocation and reservation](functional/allocation-and-reservation.md) | Order release, stock selection, complete-unit handling, and how a reservation is held |
| [Picking](functional/picking.md) | Pick-order generation, confirmation, short-pick recovery, substitution, cancellation |
| [Packing and shipping](functional/packing-and-shipping.md) | Packing, pack-out strategies, shipping units, manifest, dispatch, and unwinding a shipment |
| [Replenishment](functional/replenishment.md) | Fix-face and area replenishment, source selection, the top-up quantity, the opt-in scheduler |
| [Stocktaking](functional/stocktaking.md) | Count sessions, count types, what "freeze" means, submit, accept and recount |
| [Work allocation](functional/work-allocation.md) | The work inbox, its providers, dispatch strategies, eligibility, claim and release |

## Configuration

What a person may configure, and who may configure it.

| Document | What it covers |
|---|---|
| [The runtime configuration store](configuration/runtime-configuration-store.md) | The property catalog, its resolution ladder, per-owner scoping, secrets and operator-controlled keys |
| [Warehouse layout configuration](configuration/warehouse-layout-configuration.md) | Zones, areas, clusters, location types, locations, the capacity matrix, and what can be deleted |
| [Strategies and policies](configuration/strategies-and-policies.md) | Order and storage strategies, how each is bound, and their JSONB settings |
| [Goods owners and clients](configuration/goods-owners-and-clients.md) | The client model, retirement instead of deletion, the system client, the seeded owners |
| [Users, roles and permissions](configuration/users-roles-and-permissions.md) | The realm's roles, user provisioning, privilege boundaries, and what the admin screens cannot express |
| [Reference data](configuration/reference-data.md) | Item units, unit load types, products as configuration, number ranges |
| [The configuration boundary](configuration/the-configuration-boundary.md) | Runtime store, environment, build and core code: where each kind of change belongs |

## Integration and extension

What everything outside Karyo touches.

| Document | What it covers |
|---|---|
| [The HTTP API surface](integration/http-api-surface.md) | Base path, versioning, resource shape, pagination, filters, CSV export |
| [The error contract](integration/api-error-contract.md) | RFC 7807 problem details as the code produces them, and the paths that bypass them |
| [Identity for an integrating system](integration/identity-for-an-integrating-system.md) | The claims a token must carry, who can obtain one, and the `INTEGRATOR` role |
| [Webhooks and the event catalogue](integration/webhooks-and-the-event-catalogue.md) | Every event type, the envelope, signing, the two schedulers and the delivery guarantee |
| [Extension SPIs and installation](integration/extension-spis-and-installation.md) | The declared seams, the extensions registry, priorities, and build-time augmentation |
| [Strategies and runtime configuration](integration/strategies-and-runtime-configuration.md) | Strategy entities, JSONB settings, the property ladder and environment knobs, seen by an integrator |
| [Documents and printing](integration/documents-and-printing.md) | The document templates, the override seam, the render endpoints, printing |

## Operations

Building, deploying, running, upgrading and recovering an installation.

| Document | What it covers |
|---|---|
| [Operations and the delivery pipeline](operations/README.md) | The operations documents, and what CI builds and proves on every change |
| [Building Karyo](operations/building.md) | What a build produces, the version authorities, dependency floors, and the notices packaged into every jar |
| [Container images](operations/container-images.md) | The two images, their bases, and how they are built reproducibly |
| [Deploying Karyo](operations/deploying.md) | Prerequisites, environment validation, the first administrator, and the four containers |
| [Operating an installation](operations/operating-an-installation.md) | Schedulers, health, metrics, logs, credential rotation and maintenance |
| [Upgrade, backup and recovery](operations/upgrade-backup-and-recovery.md) | Migrations at boot, the upgrade path, backup and restore, and what cannot be rolled back |
| [Licence and entitlement](operations/licence-and-entitlement.md) | The signed licence, the runtime gate, editions, and what expiry does |
| [Troubleshooting](operations/troubleshooting.md) | Symptoms, their usual causes, and the next safe check |

## Commercial engines

| Document | What it covers |
|---|---|
| [Commercial engines](commercial/README.md) | The nine separately licensed engines seen from outside: what each offers, needs and does not do |
| [Gating and degradation](commercial/gating-and-degradation.md) | What each gate does in a free installation, and what a licence lapse does to work in flight |

## Guides

| Guide | For |
|---|---|
| [Developer onboarding](guides/developer-onboarding.md) | A developer new to Karyo: from a clone to a merged change |
| [Architecture guide](guides/architecture-guide.md) | A developer changing a boundary: the invariants you must not break, and why |
| [Implementer guide](guides/implementer-guide.md) | Configuring Karyo for a warehouse, and extending it for a client |
| [Maintaining this repository](guides/maintaining-this-repository.md) | Keeping the code, the documents and the decision records true to each other |
| [Releasing](guides/releasing.md) | Cutting a release |

## User guide

For the people who run the warehouse. [Start at the user guide's own index](user-guide/README.md).

| Page | Task |
|---|---|
| [Your first sign-in](user-guide/first-sign-in.md) | The two interfaces, which one you belong on, and what your role lets you see |
| [The desktop console](user-guide/desktop-console.md) | The planner and administrator surface |
| [The floor app](user-guide/floor-app.md) | The operator surface: the work inbox, the transaction menu, scanning, going offline |
| [Receive and put away](user-guide/receive-and-put-away.md) | Book in a delivery and put it away |
| [Find stock](user-guide/find-stock.md) | Find stock, and read available, allocated and held |
| [Pick an order](user-guide/pick-an-order.md) | Get an order picked |
| [Pack and ship](user-guide/pack-and-ship.md) | Pack a picked order and ship it |
| [Replenish](user-guide/replenish.md) | Keep pick faces stocked |
| [Count stock](user-guide/count-stock.md) | Count stock and correct the record |
| [Administer Karyo](user-guide/administer-karyo.md) | Goods owners, users, locations and settings |

## Reference

| Document | What it holds |
|---|---|
| [Requirements](reference/requirements.md) | What Karyo is required to do, and where each requirement is met |
| [Glossary](reference/glossary.md) | Warehouse and Karyo terms |
| [Data model](reference/data-model.md) | Entities, tables and migrations |
