# Requirements

What Karyo is required to do, one requirement per line, each with where this repository meets
it. Every row was checked against the source tree. How each warehouse operation behaves in
detail is described in the functional documents listed in the [documentation map](../README.md);
this register is the short list of requirements that carry an identifier.

Identifiers are stable once assigned and are never reused, so the numbering has gaps.
Performance, availability and security targets are requirements to verify, not measured
guarantees conferred by this register.

## Platform

| Id | Requirement | Where it is met |
|---|---|---|
| INFRA-01 | Every entity extends one shared base class carrying an identity key, an optimistic-lock version and assignable `created`/`modified` timestamps; owner-scoped entities add `client_id` | `libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt`; [data model](data-model.md#the-base-classes) |
| INFRA-02 | Domain changes that other systems consume are appended to a transactional outbox with a shared event envelope | `libs/karyo-events/src/main/kotlin/com/karyo/events/DomainEvent.kt`, `libs/karyo-events/src/main/kotlin/com/karyo/events/outbox/OutboxService.kt`; [events and the outbox](../architecture/events-and-outbox.md) |
| INFRA-03 | API errors are returned as a problem-details body with seven fields: `type`, `title`, `status`, `detail`, `instance`, `traceId`, `timestamp` | `libs/karyo-common/src/main/kotlin/com/karyo/common/exception/ProblemDetail.kt:10-18`; [API error contract](../integration/api-error-contract.md) |
| INFRA-04 | Every module builds through two tiers of convention plugins, `karyo.kotlin-conventions` and `karyo.quarkus-service`, with `allOpen` applied to six annotations and dependencies declared explicitly per module | `buildSrc/src/main/kotlin/karyo.kotlin-conventions.gradle.kts:13-18`, `buildSrc/src/main/kotlin/karyo.quarkus-service.gradle.kts` |
| INFRA-05 | One Keycloak realm defines every client (`karyo-web`, `karyo-backend`, `karyo-admin`) and every predefined role | `infrastructure/keycloak/karyo-realm.json`, `infrastructure/keycloak/karyo-realm-prod.json` |

## Authentication and access

| Id | Requirement | Where it is met |
|---|---|---|
| AUTH-01 | A person signs in with a username and password through Keycloak and receives a JWT access token and a refresh token | [Identity and tenancy](../architecture/identity-and-tenancy.md#keycloak); [ADR 0013](../architecture/decisions/0013-keycloak-oidc.md) |
| AUTH-02 | Access is role-based, with seven roles: `ADMIN`, `MANAGER`, `OPERATOR`, `RECEIVER`, `VIEWER`, `INTEGRATOR`, `AI_SERVICE` | `infrastructure/keycloak/karyo-realm.json`; [users, roles and permissions](../configuration/users-roles-and-permissions.md) |
| AUTH-03 | Goods-owner data isolation: an OWNER principal reads and writes only its own goods owner's data, an OPS principal spans goods owners, and the scope is applied in application code independently of role | [Identity and tenancy](../architecture/identity-and-tenancy.md#what-actually-enforces-isolation); [ADR 0014](../architecture/decisions/0014-silo-tenancy-and-goods-owners.md), [ADR 0015](../architecture/decisions/0015-principal-kind-independent-of-roles.md) |
| AUTH-04 | An administrator can create, edit, deactivate and reactivate users and assign or revoke their roles | `services/auth-service/karyo-auth-core/src/main/kotlin/com/karyo/auth/api/v1/UserResource.kt`; [administer Karyo](../user-guide/administer-karyo.md#users) |
| AUTH-05 | An account is locked for 30 minutes after 5 failed sign-ins | `infrastructure/keycloak/karyo-realm.json:19-22`, `infrastructure/keycloak/karyo-realm-prod.json:19-22` |
| AUTH-06 | Sign-in, sign-out and failed sign-in events are recorded in the audit trail, polled from Keycloak's events API | `services/karyo-app/src/main/kotlin/com/karyo/app/auth/KeycloakEventPoller.kt` |

## Warehouse layout

| Id | Requirement | Where it is met |
|---|---|---|
| LYOT-01 | Storage locations are grouped by zone, area and location cluster | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/StorageLocation.kt`; [warehouse layout configuration](../configuration/warehouse-layout-configuration.md) |
| LYOT-02 | Areas carry usages: goods in, goods out, picking, storage, transfer, replenish, buffer, cross-dock staging, pack staging and ship staging | `services/warehouse-layout-service/karyo-layout-api/src/main/kotlin/com/karyo/layout/vo/AreaUsage.kt` |
| LYOT-03 | Location types carry physical dimensions and weight or lifting capacity | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/LocationType.kt` |
| LYOT-04 | A location can be locked and unlocked, with a lock type of general, quarantine, stocktaking or damage | `services/warehouse-layout-service/karyo-layout-api/src/main/kotlin/com/karyo/layout/vo/LockType.kt` |
| LYOT-05 | A location can be resolved by its scan code | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/api/v1/LocationResource.kt:62` |
| LYOT-06 | Storage strategies are configurable, including item and client mixing rules and zone preferences | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/StorageStrategy.kt`; [strategies and policies](../configuration/strategies-and-policies.md) |
| LYOT-07 | Each location's allocation is maintained as unit loads arrive, leave and are revived, from in-process inventory events | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/service/LocationService.kt:335`, `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/messaging/UnitLoadTransferredObserver.kt` |
| LYOT-08 | A product can be fix-assigned to a location with minimum and maximum amounts | `services/warehouse-layout-service/karyo-layout-core/src/main/kotlin/com/karyo/layout/domain/model/FixAssignment.kt`; [replenishment](../functional/replenishment.md) |
| LYOT-09 | A location finder chooses putaway destinations, in process | [Putaway and location finding](../functional/putaway-and-location-finding.md) |

## Product master data

| Id | Requirement | Where it is met |
|---|---|---|
| PROD-01 | Products are created and maintained with a number (SKU), name, description, dimensions and weight | `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/domain/model/ItemData.kt` |
| PROD-02 | A product carries multiple barcodes (EAN, UPC, supplier codes) and can be looked up by any of them | `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/domain/model/ItemDataNumber.kt`, `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/api/v1/ProductResource.kt:67` |
| PROD-03 | Products are measured in item units typed as piece, weight, volume, length or other, with base units seeded | `services/product-service/karyo-product-api/src/main/kotlin/com/karyo/product/vo/ItemUnitType.kt`, `services/karyo-app/src/main/resources/db/migration/product/V201__create_item_units.sql` |
| PROD-04 | Packaging units carry a conversion amount | `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/domain/model/PackagingUnit.kt` |
| PROD-05 | Lot and shelf-life tracking are set per product | `services/product-service/karyo-product-core/src/main/kotlin/com/karyo/product/domain/model/ItemData.kt:44-47` |
| PROD-06 | A product is either active or inactive | `services/product-service/karyo-product-api/src/main/kotlin/com/karyo/product/vo/ItemDataState.kt` |
| PROD-07 | Serial numbers are recorded per product in one of three modes: not recorded, recorded at goods receipt, or always recorded | `services/product-service/karyo-product-api/src/main/kotlin/com/karyo/product/vo/SerialNoRecordType.kt` |

## Desktop console

| Id | Requirement | Where it is met |
|---|---|---|
| DASH-02 | Sidebar navigation shows each section only to users whose permissions allow it | `frontend/web/src/components/layout/app-sidebar.tsx`; [frontend](../architecture/frontend.md) |
| DASH-03 | A locations screen lists, creates and edits locations | `frontend/web/src/pages/locations/`; [administer Karyo](../user-guide/administer-karyo.md#warehouse-layout) |
| DASH-04 | A products screen lists, creates and edits products and manages their barcodes | `frontend/web/src/pages/products/use-products.ts` |
| DASH-05 | An inventory overview shows stock by location and product, and is filterable | `frontend/web/src/pages/inventory/`; [find stock](../user-guide/find-stock.md) |
| DASH-06 | A users screen manages users and their roles | `frontend/web/src/pages/users/use-users.ts`; [administer Karyo](../user-guide/administer-karyo.md#users) |
| DASH-08 | Error responses are shown as readable notifications built from the problem-details body | `frontend/web/src/lib/api-client.ts` |
| DASH-09 | The console has a dark mode toggle | `frontend/web/src/components/theme/mode-toggle.tsx` |
| DASH-11 | A zone-grid occupancy view shows per-location occupancy; it is not a physical floor plan | `frontend/web/src/pages/insights/occupancy-page.tsx`; [data model](data-model.md#kpi-views-not-tables) |
| DASH-12 | KPI reporting covers throughput, count accuracy, order cycle time and location utilisation | `frontend/web/src/pages/reports/reports-page.tsx`; [data model](data-model.md#kpi-views-not-tables) |

## Deployment

| Id | Requirement | Where it is met |
|---|---|---|
| DEPLOY-01 | The production profile reads the database and identity settings from environment variables | `services/karyo-app/src/main/resources/application.yaml:316-332` |
| DEPLOY-02 | Both front ends load the Keycloak URL at container start, so a domain change needs no rebuild | `infrastructure/docker/nginx/docker-entrypoint.sh:8`, `infrastructure/docker/nginx/docker-entrypoint.sh:18` |
| DEPLOY-03 | One Dockerfile, parameterised by a build argument, builds the application image | `infrastructure/docker/Dockerfile.service` |
| DEPLOY-04 | nginx routes `/api/` to the application, `/auth/` to Keycloak, `/m/` to the floor PWA and `/` to the desktop console | `infrastructure/docker/nginx/nginx.conf:127-181` |
| DEPLOY-05 | A single idempotent deploy script brings up the supported Compose deployment | `scripts/deploy-server.sh`; [deploying Karyo](../operations/deploying.md) |
| CLOUD-01 | The deploy script detects Docker or Podman | `scripts/deploy-server.sh` |
| CLOUD-02 | The application container's memory limit comes from the environment file (`APP_MEM_LIMIT`), with a default | `infrastructure/docker/docker-compose.prod.yml`, `scripts/.env.prod.example` |
| CLOUD-03 | JVM heap sizes are set per environment through `JAVA_OPTS`, with no image rebuild | `infrastructure/docker/Dockerfile.service`, `scripts/.env.prod.example` |
| CLOUD-04 | A second environment template sizes the stack for a 24 GB ARM64 host | `scripts/.env.prod.cloud-example` |
| IDEMPOTENT-01 | The deploy script offers `--quick`, `--reset-db` and `--help` | `scripts/deploy-server.sh` |
| IDEMPOTENT-02 | The deploy script validates the required environment variables before starting, and fails early on an empty or `CHANGE_ME` value | `scripts/deploy-server.sh` |
| IDEMPOTENT-03 | The deploy script checks the HTTP port and 5432 for conflicts and reports the process holding one | `scripts/deploy-server.sh` |
| IDEMPOTENT-04 | On a health-check timeout the deploy script prints the last 20 lines of the failing container's log | `scripts/deploy-server.sh` |

## Testing

| Id | Requirement | Where it is met |
|---|---|---|
| TEST-03 | Playwright end-to-end suites cover sign-in against a real Keycloak, create-read-update-delete screens, navigation and connected warehouse scenarios | `tests/e2e/tests/auth.spec.ts`, `tests/e2e/tests/navigation.spec.ts`, `tests/e2e/tests/scenarios.spec.ts`; [testing](../architecture/testing.md) |
| TEST-05 | Pact provider verification exists for four modules' REST APIs (auth, inventory, layout, product) and loads contracts from the Pact Broker named by `pact.broker.url`. It runs only when a broker is named, and is then strict: an unreachable broker or a missing pact fails it. With none named it is reported as skipped. CI's `pact-verify` job runs it against an ephemeral broker holding the console's consumer pacts, and fails unless every published interaction is verified | `services/karyo-app/src/test/kotlin/com/karyo/app/pact/RequiresPactBroker.kt`, `services/karyo-app/src/test/kotlin/com/karyo/inventory/pact/InventoryPactProviderTest.kt:36-39`, `.github/workflows/ci.yml:208-303` |
| TEST-06 | Consumer contracts cover the desktop console's calls to four APIs and the token claims inventory depends on | `frontend/web/src/test/pact/`, `services/karyo-app/src/test/kotlin/com/karyo/inventory/pact/AuthTokenClaimsPactConsumerTest.kt` |
| TEST-07 | The development Compose file runs a Pact Broker | `infrastructure/docker/docker-compose.dev.yml:42-49` |

## Related

- [Glossary](glossary.md) - the words these requirements use
- [Data model](data-model.md) - the tables behind them
- [Implementer guide](../guides/implementer-guide.md) - verifying them on a real installation
