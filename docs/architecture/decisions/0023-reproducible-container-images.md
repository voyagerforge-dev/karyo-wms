# ADR 0023: Container images are built reproducibly

**Status:** Accepted

## Context

An installation runs two images built from this repository: the application image from
`infrastructure/docker/Dockerfile.service` and the web image from
`infrastructure/docker/Dockerfile.nginx`. An upgrade replaces both, and most of an upgrade does not
change most of the application image: its dependency layer holds hundreds of jars, about 94 MiB,
and a typical release changes none of them.

Left alone, identical content does not produce an identical image. `quarkusBuild` stamps every
dependency jar with the time of the build, and a container `COPY` records file times in the layer,
so the dependency layer takes a new digest on every build. Separately, `apk` writes a
wall-clock-stamped log file into the layer that runs it. Layer and blob deduplication both key on
the digest, so without a fix an upgrade re-transfers the whole payload instead of what changed.

## Decision

- **Every build of either image carries a determinism setting on the build command itself:**
  `--timestamp 0` for Podman or Buildah, `SOURCE_DATE_EPOCH=0` for Docker BuildKit, which has no
  equivalent flag. `scripts/deploy-server.sh` keeps both spellings in one helper so that no call
  site chooses between them.
- **Both Dockerfiles delete `/var/log/apk.log` in the same `RUN` that creates it.**
- With both halves, two builds of one tree produce the same image ID.
- **`scripts/check-image-reproducibility.sh` guards the rule.** Its default audit reads every
  command that builds either Dockerfile at a fixed list of build sites -
  `.github/workflows/ci.yml`, `scripts/deploy-server.sh` and `scripts/scan-image.sh` - and fails if
  one lacks the setting. A setting elsewhere in the same file does not count; a call to a helper
  counts only when every build inside that helper carries the setting. `--prove` builds the
  application image twice with `--no-cache`, restamping every dependency jar in between, and fails
  unless the two image IDs match.
- **CI runs the audit** in the `package` job, before either image is built.

## Consequences

- An upgrade transfers only the layers whose content changed.
- An unchanged release is recognisable as unchanged: the same tree gives the same image ID.
- **The audit guards the inputs, not the property.** Only `--prove` shows that two builds agree,
  and it needs Podman and a built application, so CI does not run it. It is run by hand.
- The list of build sites is fixed. A new file that builds either image is not audited until it is
  added to the list.
- Reproducible is not the same as current. The `apk upgrade` layer is cached on its instruction
  and its parent, so a builder that already holds a base image keeps using it; a build that must
  pick up the newest base has to pull it explicitly, as `scripts/scan-image.sh` does.

## Alternatives considered

- **Accepting a new digest on every build.** Rejected: every upgrade would re-transfer the whole
  image, whatever changed.
- **Counting the determinism setting once per file.** Rejected in the audit's own design: a flag
  elsewhere in a file does not cover a build command that lost its own, so every command is checked
  on its own.
- **Building the application image with Jib instead of a Dockerfile.** The extension is declared
  in the application build and not used; the image is the JVM fast-jar layered by
  `Dockerfile.service`. Why the Dockerfile route was preferred is not recorded.

## Evidence

- `scripts/check-image-reproducibility.sh:4-43` - the cause, measured, and what the script checks
- `scripts/check-image-reproducibility.sh:63-68` - the fixed list of build sites
- `scripts/check-image-reproducibility.sh:164-228` - the double build
- `infrastructure/docker/Dockerfile.service:27-34` and `infrastructure/docker/Dockerfile.nginx:19-21`
  - the `apk.log` deletion
- `infrastructure/docker/Dockerfile.service:14-23` - what the `apk upgrade` layer does and does not
  refresh
- `scripts/deploy-server.sh:655-665` - one helper, both spellings
- `.github/workflows/ci.yml:166-184` - the audit, then both images built with `SOURCE_DATE_EPOCH=0`
- [Container images](../../operations/container-images.md)

## Related

- [ADR 0022](0022-compose-four-container-deployment.md) - the deployment the two images run in
- [ADR 0003](0003-gradle-kotlin-dsl-and-version-catalog.md) - the build that produces the
  application the image layers
