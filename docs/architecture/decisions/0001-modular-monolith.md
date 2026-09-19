# ADR 0001: Karyo is one deployable modular monolith

**Status:** Accepted

## Context

Karyo runs one instance per operating company ([ADR 0014](0014-silo-tenancy-and-goods-owners.md)),
on a single host under Compose ([ADR 0022](0022-compose-four-container-deployment.md)). The unit
that scales is the customer installation, not a domain module: one company's warehouse traffic
lands on one host whatever the internal architecture.

Every module is built, versioned and released together. There is one version for the whole build
(`build.gradle.kts:28-30`), so no part of the backend has a release cadence of its own to exploit.

The domain is highly transactional. Receiving, reserving, picking, moving and shipping stock each
touch several domain areas - inventory, orders, fulfillment, tasks, layout - in one logical
operation. Spread across processes, each of those needs a distributed protocol with compensation
for partial failure. Inside one process it is one database transaction.

The domain still has real internal boundaries - inventory, product, layout, orders, tasks,
fulfillment, replenishment, stocktaking, work, webhooks, reporting, identity - and they are worth
holding as contracts even with no network between them.

## Decision

- The backend is one Quarkus application, `:services:karyo-app`. It depends on every domain module
  as an ordinary library and is the only backend process that runs
  (`services/karyo-app/build.gradle.kts:36-74`). It declares the union of Quarkus extensions
  explicitly so that the aggregator is the single source of truth for the assembled image
  (`services/karyo-app/build.gradle.kts:82-84`).
- Each domain stays its own pair of Gradle modules, `-api` and `-core`, under the rules in
  [ADR 0006](0006-api-and-core-modules.md).
- Modules call each other through SPI beans injected by CDI and notify each other with synchronous
  CDI events ([ADR 0008](0008-synchronous-rest-and-cdi-events.md)). There is no HTTP between
  modules; nginx answers `/api/internal/` with 404 (`infrastructure/docker/nginx/nginx.conf:123-125`).
- All modules persist into one PostgreSQL schema
  ([ADR 0004](0004-one-postgresql-database-and-schema.md)) through one Flyway history
  ([ADR 0005](0005-flyway-migrations-at-boot.md)), and refer to one another's rows by id only
  ([ADR 0007](0007-cross-module-references-by-id.md)).
- The commercial engines join the same process as further modules when they are present
  ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)). They are not separate services.

## Consequences

- A multi-module operation is a single transaction. There are no sagas, no compensation logic and
  no eventual consistency on the operational path.
- Cross-module contracts are checked by the compiler. A broken contract is a build failure, not a
  failed request.
- One image, one datasource, one migration history, one log stream. Local development is one
  `quarkusDev`.
- No module can be deployed or scaled on its own; every release ships everything.
- One process is one blast radius. A leak or a runaway query in any module degrades all of them.
- A deploy replaces the only instance, so every deploy is an outage (`scripts/deploy-server.sh:7`;
  see [Deploying](../../operations/deploying.md)).
- The supported deployment runs exactly one application instance, and at least the webhook relay
  depends on that ([ADR 0009](0009-transactional-outbox.md)).
- The boundaries are held by the Gradle graph and by review, not by a network, and nothing
  mechanical checks the graph ([ADR 0006](0006-api-and-core-modules.md)).
- A `-core` module is not a bootable application on its own, so backend tests run against the
  assembled application: 321 of the 329 backend test files in the free build live in
  `services/karyo-app/src/test` ([Testing](../testing.md)).
- Every module whose beans the application must discover carries a `META-INF/beans.xml`. Without
  it Quarkus does not index the module's beans, and the application starts with that module's
  endpoints and services silently missing.
- The seams an extraction would need exist - `-api` contracts, id-only references, the outbox -
  but so do couplings that would have to be undone first: reporting reads other modules' tables
  directly ([ADR 0011](0011-reporting-reads-the-database-directly.md)), and three modules depend on
  foreign cores ([ADR 0006](0006-api-and-core-modules.md)).

## Alternatives considered

- **Independently deployed services, one per domain, each with its own database, coordinated over
  REST and a message broker behind an API gateway on Kubernetes.** Rejected. It puts a fixed
  operating cost - a service per domain, a database per service, a broker cluster, a gateway,
  service-to-service security - on every installation for the life of the product, when an
  installation is one company on one host. Its main benefit, independent deployment, has no use
  when every module is built and released together. And it charges a distribution tax - HTTP
  clients, retries, circuit breakers, contract tests, saga compensation - on operations that are one
  transaction in one process.
- **Fewer, larger services.** Rejected: it keeps the whole distribution tax while giving up most of
  the independence that would justify it.
- **One application with no internal module structure.** Rejected: it discards the domain
  boundaries and makes extracting a module impossible later, while the `-api`/`-core` split costs
  little.
- **Functions or serverless.** Rejected: a stateful, transactional, self-hosted system with
  interactive response-time needs is close to the worst fit for a functions runtime.

## Evidence

- `settings.gradle.kts:10-148` - the module graph; `settings.gradle.kts:147-148` includes the aggregator
- `services/karyo-app/build.gradle.kts:36-74` - every core aggregated as a library
- `services/karyo-app/build.gradle.kts:82-84` - the aggregator as the single source of truth for the image
- `services/karyo-app/src/main/resources/application.yaml:11-16` - one datasource for every module
- `infrastructure/docker/docker-compose.prod.yml:7`, `:30`, `:73`, `:102` - the four containers:
  PostgreSQL, Keycloak, the application, nginx
- `infrastructure/docker/nginx/nginx.conf:123-125` - no internal HTTP route
- `scripts/deploy-server.sh:7` - a deploy recreates the stack
- [Modules and boundaries](../modules-and-boundaries.md), [Overview](../overview.md)

## Related

- [ADR 0004](0004-one-postgresql-database-and-schema.md) - one database and one schema for every module
- [ADR 0006](0006-api-and-core-modules.md) - the module rules that stand in for a network boundary
- [ADR 0007](0007-cross-module-references-by-id.md) - why modules hold each other's ids and never foreign keys
- [ADR 0008](0008-synchronous-rest-and-cdi-events.md) - how modules talk inside the process
- [ADR 0022](0022-compose-four-container-deployment.md) - the deployment this shape fits
