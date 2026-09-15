# Contributing to Karyo

Karyo is developed here, in the open. Issues and pull requests are welcome. This file states the
rules every change is held to and links the document that owns each one, rather than restating it:
a second copy is a copy that goes stale.

- Need help rather than a change? [SUPPORT.md](SUPPORT.md).
- Found a security problem? [SECURITY.md](SECURITY.md). Never open an ordinary issue for it.
- How we work together: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before your first change

1. Get a working checkout: [developer onboarding](docs/guides/developer-onboarding.md) goes from a
   clone to a running local session and a passing test. A real JDK 21 is required, not only a Java
   runtime.
2. Read the [architecture guide](docs/guides/architecture-guide.md). It lists the invariants a
   change must not break, and why each one exists.
3. Find the module you are changing. [Modules and boundaries](docs/architecture/modules-and-boundaries.md)
   explains the module graph; [docs/README.md](docs/README.md) maps every document.

## Branch model

`main` is the default branch and the only long-lived one. It is the base for every pull request,
and releases are tagged from it.

- Branch from the current `main`, using the prefixes `feature/`, `fix/`, `refactor/` or `docs/`.
  If you do not have write access, fork the repository and branch in your fork.
- **Nobody pushes to `main` directly**, maintainers included. Every change arrives through a pull
  request.
- Keep a branch short-lived and rebase it on `main` rather than merging `main` into it.

## Commits

Use a [Conventional Commit](https://www.conventionalcommits.org/) subject, per
[ADR 0024](docs/architecture/decisions/0024-conventional-commits-and-semver.md): `feat`, `fix`,
`refactor`, `perf`, `test`, `docs`, `ci` or `chore`, with the domain or area as the scope
(`inventory`, `fulfillment`, `frontend-web`, `build`). A breaking change to a published contract
adds `!` after the type or a `BREAKING CHANGE:` footer.

Before staging, read `git diff --check`, the changed paths and the staged diff for secrets,
generated output, edits to applied migrations and changes to the free/commercial boundary.

Do not add agent or tool attribution lines to commit messages.

## The change route

1. **Start from an issue** for anything larger than a small fix, so the scope is agreed before the
   work is done. A proposal describes the warehouse operation, not the implementation you have in
   mind for it.
2. **For a defect, reproduce it first**, through the real user or API journey on an isolated
   target with synthetic data, before changing any code. Then add a regression test that fails for
   the right reason on the old behaviour. Never use a live warehouse as a test fixture.
3. **Keep the change bounded** to the owning module and its `-api` contract. Include positive,
   rejection and owner-boundary tests where they apply.
4. **Change a decision deliberately.** If the change contradicts a
   [decision record](docs/architecture/decisions/README.md), rewrite that record in the same pull
   request and say why.
5. **Update the document that owns the fact** in the same pull request that changes the behaviour.
   [docs/README.md](docs/README.md) says which document that is. When the issue you are fixing
   names the documents its fix must update, update each one, or say in the pull request why it
   does not need it.

## Engineering rules

The [architecture guide](docs/guides/architecture-guide.md) owns them: module boundaries,
transactions and events, stock invariants, migrations, identity and owner scope, configuration,
the front ends, extensions and the commercial boundary. Some edges are worth naming here because
getting them wrong is expensive and quiet:

- **Applied Flyway migrations are immutable, comments included.** A prose edit changes the checksum
  and stops existing installations from starting. Add a forward migration.
- **Operation roles and OPS/OWNER principal kind are independent**, and owner id 0 is the system
  owner, not an administrator.
- **`StockUnit` is never cached.** Reservation, physical transfer and shipping are distinct
  operations.
- **Cross-module references are IDs validated through the owning lookup SPI**, never new foreign
  keys between modules, and a `-core` never depends on another module's `-core`.
- **No commercial behaviour in a free module.** The commercial engines plug in through SPIs
  declared in the `-api` modules; the free code names none of them.

## Checks before you open a pull request

Run what CI runs for the parts you touched, and read the **executed, failed and skipped** counts,
not only the exit status. One failed Quarkus boot can skip most of the backend suite.

```bash
./gradlew compileKotlin compileTestKotlin
QUARKUS_HTTP_TEST_PORT=0 ./gradlew test        # needs a container runtime for Dev Services
./gradlew detekt
./scripts/check-image-reproducibility.sh
./scripts/scan-image.sh                        # image and dependency changes; needs Podman

(cd frontend/web && npm ci && npm run lint && npm test && npm run build)
(cd frontend/mobile && npm ci && npm run lint && npm test && npm run build)
(cd tests/e2e && npm ci && npm run test:helpers && npx playwright test --list)
```

`./gradlew test` reports the four Pact provider tests as skipped: they run only against a broker,
which CI's `pact-verify` job provides. If you change an API the desktop console calls,
[contract testing](docs/architecture/testing.md#contract-testing) says what that job checks.

[Building Karyo](docs/operations/building.md) and the [delivery pipeline](docs/operations/README.md#the-delivery-pipeline)
describe what each check proves. For a documentation change, check that every relative link you
added resolves.

Do not widen lint, test, security or coverage exemptions to get to green, and do not reset a
database, grant a role, repair a migration checksum or rotate a key to make a check pass. If you
find an unrelated defect, report it as its own issue. State observed failures and what you did not
run in the pull request, rather than describing an unrun check as passed.

## Pull requests

Open the pull request against `main`. The
[pull-request template](.github/PULL_REQUEST_TEMPLATE.md) asks for what a reviewer needs: the
problem in the operator's terms, the scope, the boundaries touched, the exact commands you ran and
their results, what the change does not prove, and its migration and upgrade impact.

## Review and merge

- [CODEOWNERS](CODEOWNERS) requests a reviewer automatically. A maintainer merges once the review
  is done and CI is green.
- Read the actual checks, not only the summary. `frontend/web` lint is a known non-blocking step,
  and its output can precede an unrelated real failure.
- Merging releases nothing. A release is a tag on `main`; [releasing](docs/guides/releasing.md)
  owns how one is cut.

## The commercial engines

The ten commercial engines are not in this repository and cannot be changed here. Their `-api`
modules and the SPI seams they implement are, and those take contributions like any other module:
they are part of the free product's contract. [The commercial boundary](docs/architecture/commercial-boundary.md)
explains where the line runs.

## Licence of contributions

Karyo is licensed under [Apache-2.0](LICENSE). Under section 5 of that licence, a contribution you
intentionally submit for inclusion is licensed under the same terms, unless you explicitly state
otherwise.
