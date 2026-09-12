# Operations

How Karyo is built, packaged, deployed, run, upgraded and recovered, and what the delivery pipeline
checks on every change.

| Document | What it covers |
|---|---|
| [Building](building.md) | The one deployable, the three version authorities, security floors, static analysis, the deterministic-test contract, and the licence notices packaged into every jar |
| [Container images](container-images.md) | The two images, their labels and base images, the reproducibility guard and the image scan |
| [Deploying](deploying.md) | The runbook: prerequisites, the environment file, the first administrator, credential rotation, changing an existing Keycloak realm, and what each stage of the deploy script does |
| [Operating an installation](operating-an-installation.md) | Scheduled jobs, health, metrics, tracing and logs, the maintenance window, and verifying an installation |
| [Upgrade, backup and recovery](upgrade-backup-and-recovery.md) | Moving to a new release, backing up and restoring both databases, and what no restore can undo |
| [Licence and entitlement](licence-and-entitlement.md) | What a licence is, how it reaches a deployment, and what it cannot do |
| [Troubleshooting](troubleshooting.md) | Failures an installation produces once it is running, and what each means |

## The delivery pipeline

One workflow, GitHub-hosted runners, eight jobs, and no destination.

### Where it runs

`.github/workflows/ci.yml` runs on GitHub Actions, on `ubuntu-latest` runners, for every push to
`main`, every pull request against `main`, and on manual dispatch (`.github/workflows/ci.yml:3-8`).
Its token is read-only (`:10-11`), and a newer run on the same ref cancels the older one
(`:13-15`).

### The jobs, and what each one gates

| Job | Needs | What it runs | Blocking |
|---|---|---|---|
| `compile` | - | `./gradlew compileKotlin compileTestKotlin` (`ci.yml:18-32`) | yes |
| `test` | `compile` | `./gradlew test`: every module's test task, with the `@QuarkusTest` suites starting their own PostgreSQL and Keycloak through Dev Services on the runner's Docker (`ci.yml:34-63`) | yes |
| `frontend` | - | `frontend/web`: install, lint, vitest, build; then the end-to-end helper tests and collection of every Playwright spec, with no live stack (`ci.yml:65-100`) | yes, except lint |
| `mobile` | - | `frontend/mobile`: install, lint, vitest, build (`ci.yml:102-126`) | yes |
| `quality` | `compile` | `./gradlew detekt` (`ci.yml:128-150`) | yes |
| `pact-verify` | `compile` | an ephemeral Pact Broker, the console's four consumer pacts generated with Vitest and published to it, the four Pact provider tests run against it, and a check that every published interaction was verified (`ci.yml:208-303`) | yes |
| `package` | all six | the image-determinism audit, the production `quarkusBuild`, both images built with `SOURCE_DATE_EPOCH=0`, and the application image saved as a workflow artefact for `scan` (`ci.yml:152-202`) | yes |
| `scan` | `package` | Trivy CRITICAL+HIGH on the application image, `--exit-code 1` (`ci.yml:304-344`) | yes |

`quality` and `pact-verify` depend on `compile` alone rather than on `test`, so that one failing
test does not hide every static-analysis finding or broken contract behind it. `package` names
every other job except `scan`, so no image is built from a tree whose tests, contracts, analysis
or front-end builds failed. `scan` names `package`, so it always scans the image that job just
built. The test, quality and Pact verification reports are uploaded as workflow artefacts and
kept for seven days; the application image artefact is kept for one day and exists only so
`scan` can run on a fresh GitHub-hosted VM.

### The one non-blocking exemption

`frontend/web`'s lint step carries `continue-on-error: true`, and its step name gives the reason:
pre-existing findings (`ci.yml:81-84`). Everything else blocks, including the floor PWA's lint.

### What a green run does not prove

- **The end-to-end specs are collected, not run.** They need a running stack, which the workflow
  does not raise (`ci.yml:91-100`). `scripts/run-e2e.sh` runs them against a target an operator
  provides.
- **Only the desktop console's contract is verified.** `pact-verify` checks the four APIs the
  console's consumer pacts describe; nothing else on the HTTP surface has a contract artefact (see
  [the HTTP API surface](../integration/http-api-surface.md)).
- **Gradle's `check` is never run**, so the jar legal-file verification wired into it
  (`build.gradle.kts:106`) runs in no job; see [building](building.md#licence-notices-packaged-and-verified).
- **OWASP dependency-check is not run**, although every Kotlin module applies it
  (`build.gradle.kts:243-250`).
- **Only the application image is scanned, and only at CRITICAL and HIGH.** The nginx image is
  not scanned. `scripts/scan-image.sh` is the local reproduction of the `scan` job; see
  [container images](container-images.md#scanning-an-image).
- **Reproducibility is audited, not proved.** The audit reads the build commands; the double build
  that proves identical content gives an identical image is run by hand (see
  [container images](container-images.md#reproducibility)).
- **Only the free image's licence label is exercised.** The application image build refuses a label
  that disagrees with the licence files it staged (`Dockerfile.service:75-93`), but CI builds the
  free image alone. An image of the full product is built, and so checked, only where a commercial
  checkout is present ([container images](container-images.md#licence-labels)).
- **Nothing here decides whether a red check blocks a merge.** That is a repository setting, not
  part of the workflow.

### Where the images go

Nowhere. The `package` job builds both images and publishes nothing, and its last step says so out
loud rather than passing silently (`ci.yml:199-202`). Whoever runs Karyo builds its images from
source with the [deploy script](deploying.md); commercial images are built and delivered outside
this repository. How a release is cut is in [releasing](../guides/releasing.md).

## Related

- [Runtime and configuration](../architecture/runtime-and-configuration.md) - the four containers
  and how configuration resolves
- [Testing](../architecture/testing.md) - what the test suites the pipeline runs actually cover
- [ADR 0022](../architecture/decisions/0022-compose-four-container-deployment.md) - Compose with four
  containers
- [ADR 0023](../architecture/decisions/0023-reproducible-container-images.md) - reproducible images
