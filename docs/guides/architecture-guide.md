# Architecture guide

The invariants a change must not break, why each one exists, and how you would break it without
noticing. Read this before you touch a module boundary, a migration, identity, configuration or the
commercial seam. It is written for someone who already knows Kotlin, Quarkus and JPA; the
[architecture overview](../architecture/overview.md) is the map it assumes.

Each rule links to the decision record or document that owns it. When a rule here and the code
disagree, the code is what runs: raise it, and fix whichever is wrong.

## Module boundaries

| Invariant | Why | How it breaks quietly |
|---|---|---|
| A `-core` depends on `-api` modules and `libs/*`, never on another module's `-core` | Keeps each domain's implementation replaceable and the contract surface explicit ([ADR 0006](../architecture/decisions/0006-api-and-core-modules.md)) | Nothing mechanical checks it. A new `implementation(project(":...-core"))` passes every build check; only review catches it |
| The three existing waivers (`karyo-ai-core`, `karyo-demo`, and one commercial engine's edge into `karyo-replenishment-core`) are not precedent | Each has a specific, stated reason, or a recorded absence of one | Adding a fourth "by analogy" |
| When a dependency would point the wrong way, declare the interface in your own `-api` and let the other module implement it | `OpenPickGuard`, `PurgeBlockerLookup` and `PickZoneLookup` all work this way ([Modules and boundaries](../architecture/modules-and-boundaries.md)) | Importing the other module's service instead |
| An event payload that another module observes lives in the firing module's `-api` | The observer then needs no edge to the firing module's core | Declaring the payload in the `-core`, which forces a core-to-core edge on every observer |
| Every module whose beans the application must discover carries `META-INF/beans.xml` | Without it Quarkus does not index the module's beans | The application starts and the module's endpoints and services are silently missing |
| Proxied classes are opened by the `allopen` plugin's annotation list (`buildSrc/src/main/kotlin/karyo.kotlin-conventions.gradle.kts:12-19`) | Kotlin classes are final; CDI and JPA need to subclass them | A class whose only proxy-relevant annotation is missing from the list stays final |
| Modules call each other in-process, through injected SPIs; there is no HTTP between modules | One process, one transaction ([ADR 0001](../architecture/decisions/0001-modular-monolith.md)) | A REST client to `localhost`; nginx answers `/api/internal/` with 404 so such a route could never be reached from outside either |

The Gradle graph is one of four coupling channels. Before you rename a table, a column or a stored
enum code, search for native SQL that reads it from another module: reporting's views and the
commercial insight engines read shared tables directly and break at runtime, not at compile time
([ADR 0011](../architecture/decisions/0011-reporting-reads-the-database-directly.md)).

## Transactions and events

- **Choose an observer's transaction phase deliberately, and say why in the code.** An observer in
  the firing transaction succeeds or fails with the change and can veto it; an `AFTER_SUCCESS`
  observer sees committed state and cannot undo the change that fired it
  ([ADR 0008](../architecture/decisions/0008-synchronous-rest-and-cdi-events.md)). Putaway task
  creation after a goods receipt, and packing after the last pick, are after-success on purpose
  (`PackingService.kt:140` says the annotation is load-bearing). Moving one of them into the
  transaction, or out of it, changes what a failure means.
- **A change that matters outside the process is written to the outbox in the same transaction.**
  Never call a webhook or any other external system from inside a business transaction
  ([ADR 0009](../architecture/decisions/0009-transactional-outbox.md)).
- **The relay and several schedulers assume one application instance.** `ConcurrentExecution.SKIP`
  only stops a tick overlapping the previous tick in the same JVM. A second instance against the
  same database delivers every webhook twice.
- **Stock state is current rows plus a journal row in the same transaction**
  ([ADR 0010](../architecture/decisions/0010-crud-with-an-inventory-journal.md)). A stock mutation
  that does not write its journal row is a defect, and so is an update to a journal row.

## Stock

- **`StockUnit` is never cached.** Only reference data goes in the Caffeine cache
  ([ADR 0012](../architecture/decisions/0012-caffeine-for-reference-data-only.md)).
- **`0 <= reserved_amount <= amount`** is enforced by the database
  (`services/karyo-app/src/main/resources/db/migration/inventory/V103__create_stock_units.sql:22-23`)
  and must hold in the owning service before it gets there; a violated constraint is an HTTP 500,
  not a validation message.
- **Reservation, physical transfer and shipping are distinct operations.** Reserving does not move
  stock, moving does not release a reservation, and shipping is its own state change. The
  [stock model](../functional/stock-model-and-states.md) and
  [allocation and reservation](../functional/allocation-and-reservation.md) state the rules.
- **Algorithm order and tie-breaks are behaviour.** Stock selection, location finding and
  replenishment source choice have documented orders; change them only with the document and a test
  that pins the new order.

## Persistence

- **An applied migration is immutable, comments included.** Flyway validates checksums at boot, so a
  prose edit stops every existing installation from starting. Add a forward migration
  ([ADR 0005](../architecture/decisions/0005-flyway-migrations-at-boot.md)).
- **Migrations live in the application**, under `services/karyo-app/src/main/resources/db/migration/<module>/`,
  and **a new directory must be added to `quarkus.flyway.locations`** or it silently never runs.
- **Use your module's version band.** The bands interleave and `out-of-order` is on. The 1300 band is
  shared by two modules; read ADR 0005's band table before numbering a crossdock or docstore
  migration.
- **Test the upgrade, not only the fresh schema.** A migration that works on an empty database can
  fail on a long-lived one that applied the bands in a different order.
- **References to another module's rows are ids, never foreign keys**, validated through the owning
  module's lookup SPI ([ADR 0007](../architecture/decisions/0007-cross-module-references-by-id.md)).
  Before deleting a row other modules may point at, ask them through an SPI, as the stock purge does
  with `PurgeBlockerLookup`.
- **A decision that has to stay correctable lives in code, not in a migration comment**
  (`KpiViewRepository.kt:26`).

## Identity and owner scope

- **One installation is one operating company. `client_id` is the goods owner, not a permission, and
  owner 0 is the system owner, not an administrator**
  ([ADR 0014](../architecture/decisions/0014-silo-tenancy-and-goods-owners.md)).
- **Operation roles and `principal_kind` are independent axes.** A role says what a principal may do;
  its kind says whose rows it may do it to. An absent or unrecognised kind resolves to OWNER, the
  restrictive one ([ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md)).
  Never grant a role to fix a scoping problem.
- **Scope goes through `TenantScope`**: `readScope()` for reads, `writeScope()` for writes. The two
  are identical today and are kept apart because their reasons differ; pick the right one.
- **Isolation is application code only.** There is no row-level security and Hibernate's
  `tenantFilter` is never enabled. A query that forgets the scope leaks across owners with nothing
  underneath it.
- **Work without a request names its owner.** A scheduler or port-to-port call passes `clientId`
  explicitly and, where it needs a context, builds one with `TenantContext.ownerScoped(clientId, actor)`
  (`libs/karyo-security/src/main/kotlin/com/karyo/security/TenantContext.kt:51`). On a scheduled
  thread the request scope is active but unprimed, so an ambient read returns owner 0 without an
  error. Keep actor attribution too: the journal names who acted.
- **Realm mappers stay aligned** across both token-issuing clients and both realm files. A missing
  mapper does not fail; the claim is absent and the restrictive default applies silently.
  `RealmPrincipalKindClaimTest` exercises the real mapper pipeline; `@TestSecurity` alone does not.
- **`karyo-admin` manages users; `karyo-backend` reads the sign-in audit.** Never widen either to do
  the other's job ([ADR 0013](../architecture/decisions/0013-keycloak-oidc.md)).

## Configuration

- **Read the runtime property ladder before adding a knob.** A setting in the property store resolves
  from the goods owner's row, then the system owner's row, then configuration, then the default, so a
  database row can override an environment variable
  ([the runtime configuration store](../configuration/runtime-configuration-store.md)).
  `SystemPropertyCatalog` is the register of known keys.
- **A `@ConfigProperty` string needs a non-empty default.** An empty default is a start-up failure
  (`application.yaml:134-136`).
- **A Kotlin default parameter must not read an injected field.** The generated `$default` bridge
  reads the CDI client proxy's field, not the bean's; resolve the value inside the method body
  (`PickOrderService.kt:114`).
- **Opt-in stays opt-in.** The demo data engine, the stock purge, the replenishment scheduler,
  external delivery and the AI copilot are off or explicit by default for a reason; a change must not
  switch one on.

## Front ends

- **The server is the authority.** Route guards and hidden menu entries mirror roles; they do not
  replace the `@RolesAllowed` check or the owner scope on the resource
  ([Front ends](../architecture/frontend.md)).
- **A queued floor action is not a server success.** The floor app queues selected operations while
  offline; only the server's response confirms them ([ADR 0016](../architecture/decisions/0016-two-frontends-same-origin.md)).
- **Commercial features gate in the page, not the router**, so a locked feature still has an address
  and explains itself.

## Extensions and the commercial boundary

- **Extensions compile against `-api` modules and are built into the image before Quarkus
  augmentation.** Nothing is uploaded into a running application
  ([ADR 0019](../architecture/decisions/0019-extensions-compile-into-the-build.md)).
- **No commercial behaviour in a free module, and no free module names a commercial one.** The
  engines plug in through SPIs declared in the Apache-2.0 `-api` modules
  ([ADR 0020](../architecture/decisions/0020-free-and-commercial-boundary-per-module.md)). A change to
  such an SPI is a change to a contract something outside this repository implements; treat it as a
  breaking change unless it is additive.
- **A licence decides which present engines run; it cannot install one that is absent.** The public
  verification key has one home, in `libs/karyo-license`
  ([ADR 0021](../architecture/decisions/0021-signed-entitlement-resolved-at-startup.md)).

## Build and dependencies

- **Versions live in the catalog.** The Quarkus platform is an enforced platform, so a plain
  constraint cannot raise a version it manages; a security floor goes through the root build's
  `securityFloor` ([ADR 0003](../architecture/decisions/0003-gradle-kotlin-dsl-and-version-catalog.md)).
- **Images are reproducible.** Every image build carries `SOURCE_DATE_EPOCH=0` (Docker) or
  `--timestamp 0` (Podman), and a new build site must be added to
  `scripts/check-image-reproducibility.sh`, or it is simply not checked
  ([ADR 0023](../architecture/decisions/0023-reproducible-container-images.md)).
- **openhtmltopdf is LGPL-2.1 and is never shaded into Karyo's own jars**
  ([THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)); the build verifies the legal files inside
  every jar.

## Tests

- **Backend tests run against the assembled application**, in `services/karyo-app/src/test/kotlin`,
  because a `-core` cannot boot on its own. `config/test-runner-contracts.json` decides which runner
  discovers which file ([Testing](../architecture/testing.md)).
- **Give test data unique synthetic ids.** Test profiles can share state within one run; never rely on
  an empty table.
- **Read skipped counts.** One failed application boot can skip most of the suite and still exit
  cleanly enough to look green.
- **Positive, rejection and owner-boundary tests** belong with every change that touches a resource:
  that the right principal can, that the wrong role cannot, and that another goods owner cannot.

## Related

- [Architecture overview](../architecture/overview.md) - the shape these rules protect
- [Decision records](../architecture/decisions/README.md) - why each rule exists
- [Developer onboarding](developer-onboarding.md) - the working loop
- [Maintaining this repository](maintaining-this-repository.md) - keeping the documents true as the rules are applied
