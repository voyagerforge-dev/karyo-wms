# Developer onboarding

From a clean clone to a merged change. This guide assumes you can read Kotlin and TypeScript and
have used Git; it does not assume you know Karyo or warehouse software. Every command runs from the
repository root unless a step says otherwise.

Karyo is one Kotlin and Quarkus application, `:services:karyo-app`, assembled from Gradle modules,
plus two React and TypeScript front ends. The projects under `services/` are libraries inside that
one application, not services you run separately. The [architecture overview](../architecture/overview.md)
is the ten-minute version of the whole.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| JDK, including `javac` | 21 | Backend build and tests |
| Node.js and npm | 24.x (the one line declared in `.nvmrc`) | Both front ends and the browser-test helpers |
| Python | 3 | The deploy script's configuration validation |
| Docker, or Podman with podman-compose | Current stable | Dev Services, the development Keycloak, the deployed stack |
| Git | 2.x | Source control |

**Check the JDK before anything else.** Both `java -version` and `javac -version` must report 21. A
Java runtime without a compiler fails at the very first build step, while Gradle resolves the
toolchain for `buildSrc`, with "does not provide the required capabilities: [JAVA_COMPILER]". If
several JDKs are installed, set `JAVA_HOME` to the JDK 21 and put `$JAVA_HOME/bin` first on `PATH`.

Version pins live in [`gradle/libs.versions.toml`](../../gradle/libs.versions.toml), the wrapper
properties and each front end's lockfile. Use the checked-in `./gradlew`; do not install a separate
Gradle or upgrade dependencies to get through setup.

A local session uses ports **8080** (the application), **8180** (Keycloak), **5005** (the debugger),
**5173** (the desktop console) and **5174** (the floor app). The development services use fixture
credentials; never expose them on an untrusted network.

## Clone and build

```bash
git clone https://github.com/voyagerforge-dev/karyo-wms.git
cd karyo-wms
./gradlew --version

./gradlew :services:karyo-app:quarkusBuild -x test
npm ci --prefix frontend/web && npm run build --prefix frontend/web
npm ci --prefix frontend/mobile && npm run build --prefix frontend/mobile
```

The backend output is the Quarkus fast-jar in `services/karyo-app/build/quarkus-app/`; each front
end builds into its own `dist/`. A build is not a running warehouse. [Building Karyo](../operations/building.md)
explains what else the build produces.

## Boot a local session

A session has four parts: Keycloak, which you start; PostgreSQL, which Quarkus Dev Services starts
for you; the application in dev mode; and the two front-end dev servers.

### 1. Start Keycloak

```bash
export DEV_PROJECT="karyo-dev-$(id -u)"
podman-compose -p "$DEV_PROJECT" \
  -f infrastructure/docker/docker-compose.dev.yml up -d keycloak      # or: docker compose -p ...
curl -f http://localhost:8180/realms/karyo/.well-known/openid-configuration
```

This starts only Keycloak from the development compose file, not its PostgreSQL or Pact broker. It
imports the [development realm](../../infrastructure/keycloak/karyo-realm.json) with its fixture
users. Wait until the discovery request returns 200, which takes about twenty seconds. A project
name of your own keeps your containers apart from anyone else's on the same machine; it does not
change the fixed host port.

### 2. Start the application

```bash
# Rootless Podman only: point Testcontainers at your user's socket.
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"
export TESTCONTAINERS_RYUK_DISABLED=true

export QUARKUS_COMPOSE_DEVSERVICES_ENABLED=false
export QUARKUS_LANGCHAIN4J_OLLAMA_DEVSERVICES_ENABLED=false
export QUARKUS_DATASOURCE_DEVSERVICES_IMAGE_NAME=docker.io/postgres:16-alpine
./gradlew :services:karyo-app:quarkusDev
```

What each setting is for:

- The datasource Dev Service starts an ephemeral PostgreSQL and Flyway migrates it on boot. Left
  alone it picks a newer PostgreSQL major version than the one the deployed stack runs; the image
  override keeps development on the production image.
- The Ollama Dev Service would otherwise start a local model container and download a model on
  first run. The copilot is off by default (`KARYO_AI_PROVIDER` defaults to `none`), so nothing
  needs it. See [ADR 0027](../architecture/decisions/0027-ai-copilot-over-tool-calls.md).
- Compose Dev Services is switched off explicitly: the compose file in the application's resources
  is not discovered, and the switch keeps it that way rather than leaving it to chance. See
  [ADR 0028](../architecture/decisions/0028-quarkus-dev-services.md).

The application listens on `http://localhost:8080`. Check it:

```bash
curl -f http://localhost:8080/q/health/ready
curl -f http://localhost:8080/api/v1/ping
```

**Health is not sign-in.** Without step 1, dev mode still starts and both requests above return
200, but nobody can sign in: the application expects Keycloak at `localhost:8180`
(`services/karyo-app/src/main/resources/application.yaml:43-47`) and nothing else starts one. Always
finish by signing in.

### 3. Start the front ends

In two more terminals:

```bash
npm run dev --prefix frontend/web -- --strictPort
npm run dev --prefix frontend/mobile -- --strictPort
```

Open the desktop console at `http://localhost:5173/` and the floor app at `http://localhost:5174/m/`.
Both dev servers send `/api` to the application on 8080 and `/auth` to Keycloak on 8180.
`--strictPort` refuses to fall back silently to another port, which would break the sign-in
redirects.

### 4. Sign in

The development realm carries these fixture users. They exist only in the development realm; the
production realm has no human users at all.

| Username | Password | Role | Principal kind | Goods owner |
|---|---|---|---|---|
| `admin` | `admin` | `ADMIN` | OPS | 0, the system owner |
| `manager` | `manager` | `MANAGER`, `integration-admin` | OPS | 1 |
| `operator` | `operator` | `OPERATOR` | OPS | 1 |
| `viewer` | `viewer` | `VIEWER` | OPS | 1 |
| `tenant2-operator` | `operator` | `OPERATOR` | OWNER | 2 |

Signing in as `admin` lands on the Operations Control dashboard. An empty warehouse is normal: each
KPI shows a dash with a note such as *No storage locations* until you create master data, which
the [implementer guide](implementer-guide.md) walks through with synthetic data.

**Known defect, local only.** Through the Vite dev servers the Keycloak sign-in page renders without
its styles and its "Show password" button does nothing. The dev servers route `/api` and `/auth`
but not the `/resources/` path Keycloak loads its assets from; the deployed stack's nginx does. The
form itself works.

### 5. Stop

Stop the application and both dev servers with Ctrl-C; Quarkus stops the database it started. Then
stop your Keycloak:

```bash
podman-compose -p "$DEV_PROJECT" -f infrastructure/docker/docker-compose.dev.yml down
```

## Test and debug

Use a fresh terminal for tests, without the dev-mode datasource settings above. Keep `DOCKER_HOST`
and `TESTCONTAINERS_RYUK_DISABLED` if you use rootless Podman.

```bash
# A pure JVM test: no application boot, no containers.
./gradlew :services:karyo-app:test --tests 'com.karyo.common.PatchableTest'

# A test that boots the application against a Dev Services PostgreSQL.
QUARKUS_HTTP_TEST_PORT=0 ./gradlew :services:karyo-app:test \
  --tests 'com.karyo.inventory.api.v1.HealthResourceTest'

# Front-end unit tests and lint.
(cd frontend/web && npx vitest run && npm run lint)
(cd frontend/mobile && npx vitest run && npm run lint)
```

- `QUARKUS_HTTP_TEST_PORT=0` gives each test run a random HTTP port. The `-D` system-property form is
  not reliably forwarded to the test JVM.
- The full backend suite is `QUARKUS_HTTP_TEST_PORT=0 ./gradlew test`. The application's test worker
  may use up to 5 GB of heap (`services/karyo-app/build.gradle.kts:156`); budget for it. Then run
  `./gradlew detekt`, which checks against a committed baseline.
- **Read executed, failed and skipped counts, not the exit status.** One failed application boot
  can skip most of the backend suite. Reports land in
  `services/karyo-app/build/reports/tests/test/index.html`.
- **Four skipped tests are expected.** The Pact provider tests run only against a broker named with
  `-Dpact.broker.url`, and are otherwise reported as skipped, with that reason. CI's `pact-verify`
  job is where they run ([contract testing](../architecture/testing.md#contract-testing)).
- Backend integration tests live in `services/karyo-app/src/test/kotlin`, not beside each module,
  because they exercise the assembled application. `config/test-runner-contracts.json` owns which
  runner discovers which files. [Testing](../architecture/testing.md) describes the whole tree.
- The browser suites under `tests/e2e/` need a deployed stack, not this dev session. Start with
  `scripts/run-e2e.sh --help` and [deploying](../operations/deploying.md).

**Debugging.** Dev mode listens for a JVM debugger on `localhost:5005`; attach your IDE there,
with the Gradle JVM set to JDK 21. Save a Kotlin change and make another request to see live reload.
In the browser, the network panel separates an API failure from a sign-in redirect or a stale floor
app bundle.

## Find your way around the code

[`settings.gradle.kts`](../../settings.gradle.kts) is the module graph and
[`services/karyo-app/build.gradle.kts`](../../services/karyo-app/build.gradle.kts) is what the
running application assembles. Start there to answer whether something is compiled, on the running
classpath, or not part of this repository at all.

| Concern | Where it lives |
|---|---|
| The application: configuration, every Flyway migration, integration tests | [`services/karyo-app/`](../../services/karyo-app/) |
| Stock and unit loads, products, locations, goods owners, users, settings | [inventory](../../services/inventory-service/), [product](../../services/product-service/), [layout](../../services/warehouse-layout-service/), [auth](../../services/auth-service/) |
| Receiving and delivery orders; transport orders; picking, packing and shipping | [orders](../../services/order-service/), [tasks](../../services/task-service/), [fulfillment](../../services/fulfillment-service/) |
| Counts, replenishment, the work inbox | [stocktaking](../../services/stocktaking-service/), [replenishment](../../services/replenishment-service/), [work](../../services/work-service/) |
| Webhooks, reporting, the optional copilot, the document archive, the demo data engine | [integration hub](../../services/integration-hub-service/), [reporting](../../services/reporting-service/), [AI](../../services/ai-service/), [documents](../../services/document-service/), [demo](../../services/demo-service/) |
| The contracts the commercial engines implement | the `-api` modules of monitoring, forecasting, slotting, simulation, crossdock, wave and streaming; see [the commercial boundary](../architecture/commercial-boundary.md) |
| Shared foundations | [`libs/`](../../libs/): common, events, security, license, documents, sequence |
| Desktop console and floor app | [`frontend/web/src`](../../frontend/web/src/), [`frontend/mobile/src`](../../frontend/mobile/src/) |

### Trace a feature in both directions

From a screen: route and component, then the front end's API call, then the REST resource and its
role and licence checks, then the service transaction, then repositories, SPIs and events, then
the migrations. Then read the tests and the document that states the behaviour. From a backend
defect, walk the same route backwards to find the operator action that triggers it.

```bash
rg -n 'StockSelectionFilter|StockSelectionService' services libs
rg -n 'stock-units' frontend/web/src frontend/mobile/src services
```

| Question | Code | Behaviour and tests |
|---|---|---|
| Why was this stock selected? | [`StockSelectionService`](../../services/inventory-service/karyo-inventory-core/src/main/kotlin/com/karyo/inventory/service/StockSelectionService.kt), [inventory screens](../../frontend/web/src/pages/inventory/) | [Allocation and reservation](../functional/allocation-and-reservation.md), [inventory service tests](../../services/karyo-app/src/test/kotlin/com/karyo/inventory/service/) |
| Why will this order not release? | [`OrderService`](../../services/order-service/karyo-orders-core/src/main/kotlin/com/karyo/orders/service/OrderService.kt), [order screens](../../frontend/web/src/pages/orders/) | [Allocation and reservation](../functional/allocation-and-reservation.md), [order tests](../../services/karyo-app/src/test/kotlin/com/karyo/orders/) |
| Why will this floor move not start? | [`TaskService`](../../services/task-service/karyo-tasks-core/src/main/kotlin/com/karyo/tasks/service/TaskService.kt), [floor menu](../../frontend/mobile/src/menu/) | [Putaway and location finding](../functional/putaway-and-location-finding.md), [task tests](../../services/karyo-app/src/test/kotlin/com/karyo/tasks/) |
| Why does one goods owner see another's records? | [security library](../../libs/karyo-security/src/main/kotlin/com/karyo/security/) and each resource's scope call | [Identity and tenancy](../architecture/identity-and-tenancy.md), [`TenantScopeTest`](../../services/karyo-app/src/test/kotlin/com/karyo/security/TenantScopeTest.kt), [`CrossOwnerWriteTest`](../../services/karyo-app/src/test/kotlin/com/karyo/security/CrossOwnerWriteTest.kt), [realm tests](../../services/karyo-app/src/test/kotlin/com/karyo/app/auth/) |

When the code, a document and a decision record disagree, the code is what runs. Say so in an
issue rather than quietly picking one; a document that loses to the code is a documentation defect
worth filing.

## Make your first change

[CONTRIBUTING.md](../../CONTRIBUTING.md) owns the route; in short:

1. Pick or open an issue, and branch from `main` (`feature/`, `fix/`, `refactor/` or `docs/`).
2. For a defect, reproduce it through the real user or API journey first, then write a test that
   fails for the right reason.
3. Read the [architecture guide](architecture-guide.md) before touching a module boundary, a
   migration, identity or configuration.
4. Update the document that owns the behaviour you changed, in the same pull request.
5. Run the checks CONTRIBUTING lists, read the counts, and open the pull request against `main`
   with the template filled in honestly.

## Troubleshooting

| Symptom | Next check |
|---|---|
| `JAVA_COMPILER` capability error, or no `javac` | `JAVA_HOME` and both Java versions; a runtime is not enough |
| Container runtime missing | Your socket and `DOCKER_HOST`; on a shared machine, ask its owner rather than reconfiguring their daemon |
| Healthy backend, sign-in unavailable | Keycloak on 8180: repeat step 1 and its discovery request |
| Sign-in page without styles | The known local defect above; the form still works |
| Address already in use, or a wrong redirect | The five fixed ports, and `--strictPort` on both dev servers |
| Many skipped backend tests | Find the first application boot failure before reading anything downstream |
| A setting appears to be ignored | A database row can override an environment variable: see [the runtime configuration store](../configuration/runtime-configuration-store.md) |
| 401, 403, or a goods owner's data missing | The user's `principal_kind` and `client_id` claims, not a role grant: see [identity and tenancy](../architecture/identity-and-tenancy.md) |
| Flyway checksum mismatch | An applied migration was edited: restore its bytes and add a new migration instead |

## Related

- [Architecture guide](architecture-guide.md) - the invariants a change must not break
- [Implementer guide](implementer-guide.md) - configuring a warehouse, and extending Karyo
- [Maintaining this repository](maintaining-this-repository.md) - keeping code and documents true
- [Testing](../architecture/testing.md) - what each test runner proves
