# Karyo WMS agent guide

Guidance for agents working in this repository. It points at the authoritative sources rather than
restating them; where this file and a source disagree, the source wins.

- **Documentation map:** [docs/README.md](docs/README.md) lists every document. It is the answer to
  "why is it like this": the [decision records](docs/architecture/decisions/README.md) give each
  decision's reason, and say plainly where no reason is recorded.
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) is the change route - branch model, commits,
  checks, pull requests. The invariants a change must not break are in the
  [architecture guide](docs/guides/architecture-guide.md).

## Build and test

A real JDK 21 with `javac` is required; a Java runtime alone fails while Gradle resolves `buildSrc`.

```bash
./gradlew :services:karyo-app:quarkusBuild        # the one deployable
QUARKUS_HTTP_TEST_PORT=0 ./gradlew test          # backend tests; Dev Services need a container runtime
./gradlew detekt
```

Read executed, failed and skipped counts, not the exit status. The full set of checks, the front
ends included, is in [CONTRIBUTING.md](CONTRIBUTING.md#checks-before-you-open-a-pull-request); a
running local session is in [developer onboarding](docs/guides/developer-onboarding.md#boot-a-local-session).

## Module boundary

- An `-api` module holds DTOs, SPI interfaces and the event payloads other modules observe - never
  entities, services or REST resources.
- A `-core` module holds JPA entities, repositories, services and REST resources, and never depends
  on another module's `-core`. The three recorded waivers are not precedent.
- [ADR 0006](docs/architecture/decisions/0006-api-and-core-modules.md) owns the rule, and
  [ADR 0007](docs/architecture/decisions/0007-cross-module-references-by-id.md) its data half: other
  modules' rows are referenced by id, never by foreign key.

## Coupling checklist

Cross-layer couplings an agent will miss from the file they opened. The module graph is in
[modules and boundaries](docs/architecture/modules-and-boundaries.md).

- **New Gradle module (four files, not one):** `settings.gradle.kts` `include(...)`; aggregator
  `implementation(project(...))` in `services/karyo-app/build.gradle.kts` (cores are libraries, not
  deployables; also the explicit Quarkus extension union there); `META-INF/beans.xml` for CDI
  discovery; and `quarkus.flyway.locations` in
  `services/karyo-app/src/main/resources/application.yaml` if you add a new `db/migration/<dir>`.
  Dropping one of those is silent: the project compiles, the JAR is invisible at runtime, or
  Flyway never runs. `buildSrc` `allOpen` must keep `@Path`, `@ApplicationScoped`,
  `@RequestScoped`, `@Entity`, `@MappedSuperclass`, `@QuarkusTest`.
- **Tests live in the aggregator.** Backend tests are almost all under
  `services/karyo-app/src/test`, not beside the core. Changing a core without the karyo-app test is
  how it ships untested. CI still runs `./gradlew test` across every module.
- **SPI implemented in a foreign core.** Cores must not depend on foreign cores. The workaround is
  an SPI in `*-api` implemented by another domain's core, wired by CDI in the aggregator. Changing
  the interface without the foreign implementation (or its karyo-app test) is the silent break.
  Examples: `ReservationRefMover` (inventory-api; orders-core and fulfillment-core),
  `TransportDemandLookup` (layout-api; tasks-core), `ReplenishmentSourceSelector` (inventory-api;
  replenishment-core consumes it).
- **Frontend contract surfaces are not the REST resource.** A DTO field change needs the TS type
  and the page test (`frontend/web/src/types/`, matching page). A new page needs
  `frontend/web/src/config/navigation.ts`, `frontend/web/src/routes/router.tsx` and
  `frontend/web/src/components/command/command-palette.tsx` together, or it 404s from some entry
  points.
- **Two Keycloak realms, not one.** `infrastructure/keycloak/karyo-realm.json` (dev) and
  `karyo-realm-prod.json` (prod). Claim mappers for `principal_kind` and roles must stay aligned on
  both token-issuing clients. `--import-realm` skips an existing realm, so a JSON-only edit does
  not migrate a live Keycloak.
- **Deploy env example is load-bearing.** New knobs belong in `scripts/.env.prod.example` and
  `SystemPropertyCatalog`, not only `application.yaml`. Runtime resolution is client row -> SYS
  row -> config -> catalog.
- **Image-build sites are a fixed list** in `scripts/check-image-reproducibility.sh` `BUILD_SITES`
  (today: `.github/workflows/ci.yml`, `scripts/deploy-server.sh`, `scripts/scan-image.sh`). A
  fifth `docker build -f infrastructure/docker/Dockerfile.service` in a new file is invisible to
  the PR audit. The audit checks `--timestamp 0` / `SOURCE_DATE_EPOCH=0` on those known sites, not
  tree-wide.
- **Node 24 is declared once and mirrored four ways.** `.nvmrc` (repo root) is the one
  declaration. `scripts/lib/node-runtime.sh` reads it for both the deploy and E2E preflights
  (accepting exactly that major); the three package manifests mirror it as `engines.node
  ^24.0.0` in the lockfile root, with `engine-strict=true` in each `.npmrc`; CI resolves it
  through `setup-node` `node-version-file: .nvmrc`; and the nginx builder stages use
  `node:24-alpine`. `tests/e2e/fixtures/node-runtime-preflight.test.ts` keeps every mirror equal
  to `.nvmrc`.
- **Vendor public key has one home:**
  `libs/karyo-license/src/main/resources/com/karyo/license/vendor-public-key.txt`, read by
  `VendorKey`. Do not duplicate the bytes.
- **Publication / commercial boundary.** This tree is the public product; there is no
  `publication-policy.json` or classify job. A new path is public by landing here. Commercial
  engines live outside and plug in through `-api` SPIs
  ([the commercial boundary](docs/architecture/commercial-boundary.md)). Do not add commercial
  behaviour to a free module.

Pact consumer specs vs provider tests barely co-change; the coupling is the `pact-verify` job.
`config/test-runner-contracts.json` is the include/exclude owner for Gradle, Vitest, Playwright and Node test.

## Gate map

Executable: [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Narrative:
[the delivery pipeline](docs/operations/README.md#the-delivery-pipeline). Merge:
[CONTRIBUTING.md](CONTRIBUTING.md#review-and-merge).

One workflow, GitHub-hosted `ubuntu-latest`, eight jobs. Triggers: push to `main`, pull request
against `main`, `workflow_dispatch`. `package` waits on every other job except `scan`; `scan`
waits on `package` and runs on the same triggers, including pull requests.

| Job | Blocks a PR? | What it actually guards |
|---|---|---|
| `compile` | **blocks** | `compileKotlin compileTestKotlin`. Does not run `verifyJarLegalFiles` (that hangs off `check`, which CI never runs). |
| `test` | **blocks** | `./gradlew test` (every module). Pact provider tests are skipped here; they are not proof. |
| `frontend` | **blocks except lint** | vitest, production build, Playwright `--list` and helper tests. Web lint is `continue-on-error: true` (the only named exemption). Does not execute E2E. |
| `mobile` | **blocks** | lint, vitest, build. Lint is clean and blocking, unlike web. |
| `quality` | **blocks** | `./gradlew detekt` only. New findings fail; baseline debt does not. No image-audit, no OWASP. |
| `pact-verify` | **blocks** | ephemeral broker, exactly four consumer pacts, provider tests, verified-interaction count equals published count. |
| `package` | **blocks** | image-determinism **audit**, both images with `SOURCE_DATE_EPOCH=0`. Publishes nothing. Reproducibility is not proved (`--prove` is local). |
| `scan` | **blocks** | Trivy CRITICAL+HIGH on the application image, `--exit-code 1`. Nginx image is not scanned. |

What will not sink the PR job: web lint, live Playwright E2E, `./gradlew check` / jar legal-file
verification, OWASP, image `--prove`, coverage percentages.

Local `./gradlew test` is not Pact proof. Do not widen the web-lint exemption. CODEOWNERS
requests `@loom-loki`; whether a red check or a review blocks merge is a repository setting, not
the workflow.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
