# ADR 0028: Quarkus Dev Services supply local and test infrastructure

**Status:** Accepted

## Context

The application cannot run without PostgreSQL and Keycloak (ADR 0004, ADR 0013). A developer
running it locally and a test suite running in CI both need those two services, without installing
them on the machine and without one person's setup drifting from another's. A test suite also
needs a clean database on every run, so that no test depends on what an earlier one left behind.

Quarkus Dev Services start such dependencies in containers, on demand, for dev mode and for tests,
and wire the application to them.

## Decision

- **Tests use Dev Services.** The test profile starts an ephemeral PostgreSQL (`postgres:16-alpine`,
  the image the production stack runs) and the Keycloak Dev Service, turns Compose-based Dev
  Services off, and turns tracing and the Ollama Dev Service off. Every run starts from an empty
  database that Flyway migrates. Most tests replace the token with `@TestSecurity`.
- **Local development runs `./gradlew :services:karyo-app:quarkusDev`.** The datasource Dev Service
  starts an ephemeral PostgreSQL. **Keycloak is started explicitly**, from the `keycloak` service in
  `infrastructure/docker/docker-compose.dev.yml`, which imports the development realm and listens on
  port 8180, where the default OIDC settings expect it. The Ollama Dev Service is turned off
  (`QUARKUS_LANGCHAIN4J_OLLAMA_DEVSERVICES_ENABLED=false`) unless a local model is wanted.
- **A container runtime is a prerequisite for both.** CI's test job checks for one before it runs
  the suite.

## Consequences

- Tests need no installed database and no shared test server, and never see each other's data.
- CI works on any runner with a container runtime.
- **The dev-mode database is not the production version.** The dev profile names no image, so the
  datasource Dev Service starts its own default PostgreSQL image, a newer major version than the
  `postgres:16-alpine` the production stack and the test profile use.
- **Dev mode starts an Ollama Dev Service by default.** Nothing in the dev profile turns it off, so
  a first `quarkusDev` run pulls an Ollama container and preloads a model - a large download -
  unless the developer disables it.
- **Known defect: dev mode does not bring up Keycloak by itself.** The repository carries
  `services/karyo-app/src/main/resources/compose-devservices.yml`, defining PostgreSQL and Keycloak,
  and the dev profile's comment says Quarkus discovers it automatically; running `quarkusDev` on
  this tree does not start it. The Keycloak Dev Service does not start one either, because the OIDC
  server URL is configured explicitly, and the realm file the dev profile names for it in
  `quarkus.keycloak.devservices.realm-path` (keycloak-realm.json) is not in the repository. Without an explicitly started Keycloak the
  backend reports healthy, nobody can sign in, and the sign-in audit poller logs a warning every
  minute.
- The first run pulls container images, and every test run starts containers, which adds time.

## Alternatives considered

- **A Compose file of development services, started by hand.** Used for Keycloak, because the
  automatic route does not start it; not used for the database, where an ephemeral Dev Service gives
  a fresh schema on every run with no manual step.
- **Locally installed PostgreSQL and Keycloak.** Rejected: versions drift between machines, and the
  setup differs by operating system.
- **A virtual machine per developer.** Rejected: disproportionately heavy for two services.
- **A long-lived shared test database.** Rejected by the test profile's own configuration: an
  ephemeral database per run means no test depends on another's leftovers.

## Evidence

- `services/karyo-app/src/test/resources/application.properties:1-15` - the test profile's Dev
  Services, Compose Dev Services off, tracing off
- `karyo-app/.../application.yaml:268-273` - the Ollama Dev Service off in tests only
- `.github/workflows/ci.yml:48-56` - CI's test job, and its container-runtime check
- `services/karyo-app/src/main/resources/application.yaml:44` - the default OIDC server, on port
  8180
- `karyo-app/.../application.yaml:303-313` - the dev profile, its discovery comment and its realm
  file
- `services/karyo-app/src/main/resources/compose-devservices.yml:1-27` - the Compose file dev mode
  does not start
- `infrastructure/docker/docker-compose.dev.yml:1-6,30-40` - the Keycloak a developer starts
- `services/karyo-app/build.gradle.kts:138` - the Keycloak Dev Service on the test classpath
- [Developer onboarding](../../guides/developer-onboarding.md)
- [Testing](../testing.md)

## Related

- [ADR 0002](0002-kotlin-on-quarkus.md) - the platform that supplies Dev Services
- [ADR 0004](0004-one-postgresql-database-and-schema.md) - the database both routes need
- [ADR 0005](0005-flyway-migrations-at-boot.md) - the migrations every fresh database receives
- [ADR 0013](0013-keycloak-oidc.md) - the identity provider both routes need
