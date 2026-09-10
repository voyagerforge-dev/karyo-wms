# ADR 0024: Commits follow Conventional Commits, and releases follow Semantic Versioning

**Status:** Accepted

## Context

Karyo is one product, built from 44 Gradle subprojects and two front ends and released together
(ADR 0001). Its history has two kinds of reader. Contributors read it to find out what changed and
why. People who integrate with Karyo read the versions to decide whether an upgrade is safe:
systems calling the REST API (ADR 0017), systems receiving webhooks, and extension authors
compiling against the `-api` modules (ADR 0019). Both need the same two answers from the record:
what kind of change this is, and whether it breaks them.

## Decision

- **Commit subjects follow Conventional Commits:** `type(scope): description`. The types are
  `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci` and `chore`; a breaking change adds `!`
  after the type or a `BREAKING CHANGE:` footer. The scope names the area touched - a domain such
  as `inventory`, `orders` or `fulfillment`, or an area such as `frontend-web` or `build`.
- **Releases follow Semantic Versioning, with one version for the whole product:** `version` in
  the `allprojects` block of the root `build.gradle.kts`, applied to every subproject. A release is
  a tag of the form `vMAJOR.MINOR.PATCH` on `main` naming that version.
- **A breaking change to a published contract is a major version.** Published contracts are the
  REST endpoints and their fields, the webhook payloads, and the SPIs and DTOs in the `-api`
  modules.

## Consequences

- The history can be read by kind of change, and a version number says whether an upgrade can
  break an integration.
- **Nothing enforces either convention.** No commit-message check, no hook and no release
  automation is installed: nothing validates a subject, derives a version from history, or writes
  release notes. The version is one line, changed by hand when a release is cut.
- Because the product has one version, a change in any module moves the version of all of them.
- `frontend/web/package.json` and `frontend/mobile/package.json` carry `0.0.0`. The front ends are
  not versioned separately and do not report the product version.
- The REST API carries its own path version, `/api/v1`, which is independent of the product
  version (ADR 0017).

## Alternatives considered

- **Free-form commit messages.** Rejected: nothing about a change can be read from its subject, and
  the history cannot be sorted into what a release contains.
- **Calendar versioning.** Rejected: a date says when a release was made, not whether it breaks a
  consumer, and Karyo's REST API, webhooks and `-api` modules all have consumers who need the
  second answer.
- **A version per module.** Rejected: every module is built, released and versioned together, so
  separate numbers would diverge without meaning anything.
- **Deriving versions and release notes automatically from the commit history.** Not installed.
  Why it has not been is not recorded.

## Evidence

- `build.gradle.kts:28-35` - one version, applied to every subproject
- `frontend/web/package.json:4`, `frontend/mobile/package.json:4` - the front ends carry `0.0.0`
- [Contributing](../../../CONTRIBUTING.md) - the convention as a contributor meets it
- [Releasing](../../guides/releasing.md) - cutting a release

## Related

- [ADR 0001](0001-modular-monolith.md) - everything releases together
- [ADR 0017](0017-versioned-rest-api-and-error-contract.md) - the REST path version
- [ADR 0019](0019-extensions-compile-into-the-build.md) - extensions compile against the `-api`
  modules
