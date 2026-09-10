# Testing

Where Karyo's tests live, which runner finds them, what each kind proves, and what the continuous
integration workflow runs.

Derived from the source tree, `config/test-runner-contracts.json` and `.github/workflows/ci.yml`.

## Backend tests are centralised in the aggregator

| Location | Test files |
|---|---|
| `services/karyo-app/src/test` | 323 (321 Kotlin sources and two test resources) |
| `libs/karyo-license/src/test` | 7 |
| `services/inventory-service/karyo-inventory-ext-example/src/test` | 1 |
| **Total** | **331** |

Almost every backend test lives in one module, and 275 of the Kotlin sources there are
`@QuarkusTest` classes, each of which boots the assembled application. With no commercial checkout
present, `./gradlew test` runs 318 test classes and 1,747 tests, four of which - the Pact provider
tests, which need a broker - are reported as skipped ([contract testing](#contract-testing)).

The test tree mirrors the module packages - `fulfillment/`, `inventory/`, `orders/`, `tasks/` and so
on - so the tests are organised per module logically while living in a single Gradle module
physically. The few small packages named for commercial engines (`forecasting/`, `monitors/`,
`simulation/`, `slotting/`, `wave/`) test the public `-api` contracts of those engines, not the
engines themselves.

When a commercial checkout is present, its suites are grafted onto this same test source set
(`services/karyo-app/build.gradle.kts:18-34`), so they run against the same assembled application.

## Why, and what it costs

No document explains the arrangement; it follows from `@QuarkusTest`. A Quarkus test boots the CDI
container, and a `-core` module in isolation is not a bootable application: it has no aggregated
extension set, no datasource, no Flyway locations, and its SPI dependencies are unsatisfied because
the implementing beans live in modules it must not depend on. Testing one module in isolation would
mean that module providing fake implementations of every contract it consumes. Testing it in the
aggregator means testing it against the real ones. For a system whose central risk is cross-module
interaction, that is the more valuable test.

The costs are real and visible in the build:

- **Heap.** `services/karyo-app/build.gradle.kts:146-156` sets `maxHeapSize = "5g"`. Its comment
  records why: the unconfigured default was exhausted by accumulated Hibernate query-plan and ANTLR
  parser state, and 3g was later outgrown by `@TestProfile` classes each restarting the application
  in the same JVM. That is a direct consequence of one JVM running several hundred `@QuarkusTest`
  classes.
- **Feedback time.** No module can be tested alone, so any change re-runs against the full
  application.
- **Extractability.** [ADR 0006](decisions/0006-api-and-core-modules.md) and
  [ADR 0007](decisions/0007-cross-module-references-by-id.md) keep modules extractable by forbidding
  foreign `core` dependencies and cross-boundary foreign keys. The test suite is the part that would
  not travel: an extracted module would have no tests of its own.
- **Failure legibility.** One failed Quarkus boot can skip most of the suite. Read the skipped count
  as well as the failures.

## Runner discovery

`config/test-runner-contracts.json` is shared by the root `build.gradle.kts`, both Vitest configs and
both Playwright configs, so discovery rules are not forked into prose or a second config. Four
contracts cover the ordinary suites:

- **gradle**: prefixes `buildSrc/`, `libs/`, `services/`, path segment `/src/test/`, with
  `require_unfiltered` and `require_junit_platform`.
- **playwright**: every spec file under `tests/e2e/tests/`, with `forbid_skips` enforced by a
  custom reporter (`tests/e2e/fixtures/no-skipped-tests-reporter.ts`) and `forbid_only`.
- **vitest-mobile** and **vitest-web**: the two front-end trees.

The same file lists five **operational** sources, each with its runner and the reason it is kept out
of the ordinary suites: a licence re-mint utility that needs the vendor's private key, which is not
in this repository (`libs/karyo-license/src/operationalTest`, run by the `operationalTest` Gradle
task), and four Playwright checks under `tests/e2e/operational/` that need a live AI provider, a
disposable database container, the installed inventory extension or a reachable webhook receiver
(`tests/e2e/playwright.operational.config.ts`). None of them runs in CI.

## Contract testing

Pact provider tests exist for four providers (`auth/pact`, `inventory/pact`, `layout/pact`,
`product/pact` under `services/karyo-app/src/test/kotlin/com/karyo/`), with consumer tests in
`AuthTokenClaimsPactConsumerTest.kt` and under `frontend/web/src/test/pact/`. Each provider test
fetches its pacts from the broker named by `pact.broker.url`, and runs only when one is named
(`services/karyo-app/src/test/kotlin/com/karyo/auth/pact/AuthPactProviderTest.kt:27-30`). The
condition is `@RequiresPactBroker`
(`services/karyo-app/src/test/kotlin/com/karyo/app/pact/RequiresPactBroker.kt`): with no broker
named, JUnit skips the class and reports why; with one named, a broker that cannot be reached, or
that holds no pact for the provider, fails the test. None of the four ignores I/O errors or an
empty broker, because a verification that passes when its target is unreachable is worse than no
verification.

The Gradle test task forwards `pact.broker.url` into the forked test JVM
(`services/karyo-app/build.gradle.kts:158-170`). A `-D` on the Gradle command line does not reach a
forked Test JVM, so without the forwarding a named broker would never enable the tests.

The four therefore run in one place: CI's `pact-verify` job (`.github/workflows/ci.yml:194-289`).
It starts an ephemeral broker, generates the console's consumer pacts with Vitest, publishes them
and fails unless there are exactly four, runs the provider tests against the broker, and fails
unless the number of interactions verified equals the number published. `package` waits on it. In
`test`, and in any local run that names no broker, the four are reported as skipped, not passed.

## Front-end and browser tests

- **Vitest**, in both front ends: `frontend/web` 116 test files and 1,057 tests, `frontend/mobile` 39
  test files and 180 tests. CI runs both (`.github/workflows/ci.yml:85-87` and the `mobile` job).
- **Playwright**, in `tests/e2e`: 34 spec files and 106 tests, which need a running stack
  (`scripts/run-e2e.sh`). CI does not raise a stack; it runs the fixture helper tests and collects
  every spec with `--list` (`ci.yml:94-100`), which proves they parse and that every fixture
  resolves, not that they pass.

## Environment

Backend tests use Quarkus Dev Services: Testcontainers starts PostgreSQL (`postgres:16-alpine`) and
Keycloak, and Compose Dev Services is disabled for tests so every run starts from a clean database
(`services/karyo-app/src/test/resources/application.properties:2-12`). Within one run, all
`@QuarkusTest` classes share that database, so tests must use unique synthetic IDs rather than
assume an empty one. Any Docker-compatible container runtime works. `QUARKUS_HTTP_TEST_PORT=0` avoids
port collisions between concurrent runs, and CI sets it (`ci.yml:55`) after printing the container
runtime it depends on (`ci.yml:51-52`).

## Related

- [The delivery pipeline](../operations/README.md) - every CI job, not only the test ones
- [Developer onboarding](../guides/developer-onboarding.md) - running the suites locally
- [Modules and boundaries](modules-and-boundaries.md) - why the modules cannot be tested alone
