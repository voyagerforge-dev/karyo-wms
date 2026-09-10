# Releasing

How a version of Karyo is cut. A release is a tag on `main` and a GitHub release for it. Nothing
else is published: there is no release automation, no image registry and no artefact upload.

## What a release is

- **One version for the whole product.** `version` in the `allprojects` block of the root
  `build.gradle.kts` (`build.gradle.kts:30`) applies to every subproject
  ([ADR 0024](../architecture/decisions/0024-conventional-commits-and-semver.md)).
- **A tag `vMAJOR.MINOR.PATCH`** on the commit of `main` whose `build.gradle.kts` carries that
  version.
- **A GitHub release for the tag**, whose notes say what changed for someone running Karyo.

A release is not an image. CI builds both images on every push to `main` and publishes neither
(`.github/workflows/ci.yml:152-188`). An installation builds its own images from the tagged source
([Deploying Karyo](../operations/deploying.md)), and a release deploys nothing.

**There is no changelog file, by decision.** Release notes live in the GitHub release for each tag
and nowhere else, so there is no second document that has to be kept in step with the tags. To see
what changed between two versions, read their releases, or compare the two tags.

## Choose the version

Semantic Versioning, against Karyo's published contracts: the REST endpoints and their fields, the
webhook payloads, and the SPIs and DTOs in the `-api` modules.

| Change since the last release | Version |
|---|---|
| Any breaking change to a published contract | Major |
| New capability, compatible with every published contract | Minor |
| Fixes only | Patch |

The commercial engines implement SPIs from the `-api` modules, so an incompatible SPI change is a
major version even when nothing in this repository notices. A new migration can ship in any version;
one that needs an operator to act before or after the upgrade is called out in the notes.

## Cut it

1. **Open the release pull request.** Its only change is the version in `build.gradle.kts`. It goes
   through review like any other change ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
2. **Merge it once CI is green**, then confirm CI is green again on `main` at the merge commit: every
   job, with the backend, web and mobile test counts read rather than the summary.
3. **Tag exactly that commit**, with an annotated tag:

   ```bash
   VERSION=1.1.0                        # the version the release pull request set
   git switch main && git pull --ff-only
   git log -1 --format='%H %s'          # must be the release pull request's merge commit
   git tag -a "v$VERSION" -m "Karyo $VERSION"
   git push origin "v$VERSION"
   ```

4. **Create the GitHub release from the tag.** The notes say, for an operator: what changed; any
   migration, configuration or realm action needed, with a link to
   [upgrade, backup and recovery](../operations/upgrade-backup-and-recovery.md); and any breaking
   contract change, with the upgrade path for whoever integrates with it.

## Rules

- **A published tag never moves and is never reused.** A mistake in a release is fixed by the next
  version.
- **A release is cut only from `main`**, never from a branch or a commit that did not pass CI there.
- **Releasing is separate from deploying.** Say which one happened: a tag says a version exists, not
  that any installation runs it.
- **The commercial engines are released separately**, each against a tag of this repository. Nothing
  in this repository changes for that.

## Related

- [ADR 0024](../architecture/decisions/0024-conventional-commits-and-semver.md) - commits and versions
- [Upgrade, backup and recovery](../operations/upgrade-backup-and-recovery.md) - what an installation does with a new version
- [Operations and the delivery pipeline](../operations/README.md) - what CI builds and proves
- [Maintaining this repository](maintaining-this-repository.md) - keeping documents true across a release
