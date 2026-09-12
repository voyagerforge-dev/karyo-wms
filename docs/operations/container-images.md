# Container images

Karyo ships as two images, both built from this repository: the application and the nginx front
door. PostgreSQL and Keycloak come from public registries and are not Karyo images
(`infrastructure/docker/docker-compose.prod.yml:8,31`).

Derived from `infrastructure/docker/Dockerfile.service`, `infrastructure/docker/Dockerfile.nginx`,
`.dockerignore`, `scripts/check-image-reproducibility.sh`, `scripts/scan-image.sh`,
`scripts/deploy-server.sh` and `.github/workflows/ci.yml`.

| Image | Built from | Contains | Licence label |
|---|---|---|---|
| application | `infrastructure/docker/Dockerfile.service` | the Quarkus fast-jar of `:services:karyo-app`, with the commercial engines when the build included them | `Apache-2.0`, or `Apache-2.0 AND LicenseRef-Karyo-Commercial` with the commercial engines |
| nginx | `infrastructure/docker/Dockerfile.nginx` | both front-end bundles and the reverse proxy | `Apache-2.0` |

The deploy script tags them `karyo/karyo-app:latest` and `karyo/nginx:latest` unless told
otherwise (`scripts/deploy-server.sh:522-524`). CI tags them `karyo-app:<commit>` and
`karyo-nginx:<commit>` and publishes neither (`.github/workflows/ci.yml:174-202`). No registry
receives an image from this repository: whoever runs Karyo builds its images from source (see
[building](building.md)). An image of the full product is built from these same Dockerfiles with a
commercial checkout present, and is delivered outside this repository.

## Every image is built from the repository root

Both Dockerfiles take the repository root as their build context, each for its own reason:
`Dockerfile.service` copies the fast-jar and the licence files staged beside it out of
`services/karyo-app/build/`, and `Dockerfile.nginx` copies both `frontend/` trees and the root
licence files.

That makes `.dockerignore` at the root the only ignore file that applies to any image built here,
and the file says so: a per-directory one beside a Dockerfile "is simply not consulted"
(`.dockerignore:11-17`). It excludes every `node_modules` and `dist`, the `docs` tree, the
operator's environment files and the licence signing-key file (`.dockerignore:1-2,9,18-19`). It
also carries an instruction not to add `**/build`, because `Dockerfile.service` copies out of
exactly that path.

## Licence notices reach the recipient, not just the jar

Both runtime images carry `NOTICE`, `LICENSE` and `THIRD-PARTY-NOTICES` in `/app/`, with the same
reasoning: Karyo's own module jars already carry them under `META-INF` (see
[building](building.md#licence-notices-packaged-and-verified)), but nobody reads a licence by
unzipping a jar (`Dockerfile.service:40-49`). The nginx image copies them from the repository root
(`Dockerfile.nginx:51-52`). The application image copies what the build staged for it
(`Dockerfile.service:62`), because what it has to say depends on what the build assembled:
`:services:karyo-app:imageLegalFiles`, which `quarkusBuild` depends on, stages the three files for
every build and, when commercial engines were included, each engine's own licence marker
(`services/karyo-app/build.gradle.kts:173-213`). An image of the full product therefore also
carries `/app/commercial-licenses/<module>/LICENSE` for each engine in it, and its `NOTICE` names
all nine commercial modules as outside the Apache grant (`NOTICE:9-25`). The documented invocation
is

```
docker run --rm --entrypoint cat <image> /app/NOTICE
```

and the `--entrypoint` override is not optional, because `Dockerfile.service`'s exec-form `sh -c`
entrypoint would ignore the trailing argument and start the JVM instead.

## Licence labels

The nginx image carries `org.opencontainers.image.licenses="Apache-2.0"`, a literal
(`Dockerfile.nginx:54-56`): every bundle it serves, the commercial engines' screens included, is
Apache-2.0 front-end code.

The application image's label has to say what that build contains, so it is the build argument
`IMAGE_LICENSES`, `Apache-2.0` unless told otherwise. The build records the value to pass in
`services/karyo-app/build/image-licenses`: `Apache-2.0`, or
`Apache-2.0 AND LicenseRef-Karyo-Commercial` when commercial engines were included
(`services/karyo-app/build.gradle.kts:173-213`). A `RUN` step just before the label compares the
argument with the licence files staged into the image and fails the build when they disagree
(`Dockerfile.service:75-93`), so a forgotten argument cannot label an image that carries commercial
engines Apache-2.0 alone, and a free image cannot claim a commercial term. The deploy, scan and
reproducibility scripts pass the recorded value (`deploy-server.sh:670`, `scan-image.sh:66`,
`check-image-reproducibility.sh:193`), the production Compose file takes it from the environment
(`docker-compose.prod.yml:82`), and CI, which only ever builds the free image, relies on the
default.

Neither label enumerates the LGPL-2.1, EPL-2.0 and SIL-OFL-1.1 components a distribution contains;
the third-party inventory copied beside `NOTICE` is what discloses them.

## Base images, and three pinning disciplines

| Site | Base | Pinning |
|---|---|---|
| `Dockerfile.service:1` | `eclipse-temurin:21-jre-alpine` | floating tag |
| `Dockerfile.nginx:1,9` | `node:22-alpine` (both builder stages) | floating tag |
| `Dockerfile.nginx:17` | `nginx:1.30.4-alpine` | exact tag |
| `docker-compose.prod.yml:8,31` | `postgres:16-alpine`, `keycloak:26.0` | floating minor tag |

No base image is pinned by digest, and nothing records why each site uses the pinning style it
does.

`Dockerfile.service` adds `USER karyo` after creating an unprivileged account
(`Dockerfile.service:36,70`). `Dockerfile.nginx` adds neither, and it replaces the stock
`nginx.conf` wholesale (`Dockerfile.nginx:23-28`) with a file that carries no `user` directive
(`infrastructure/docker/nginx/nginx.conf:1-5`). Which account nginx's worker processes run as is
therefore decided by the base image's compiled-in default rather than by anything in this
repository - and the image without an explicit choice is the one exposed to the public origin.
This documentation does not state the resulting uid.

## The `apk upgrade` layer

Both runtime Dockerfiles run `apk upgrade --no-cache && rm -f /var/log/apk.log` before the
application layers (`Dockerfile.service:34`, `Dockerfile.nginx:21`). The reason is stated in the
file: a floating base tag tracks the publisher's rebuild cadence, not Alpine's package feed, so a
freshly pulled base can lag the package fixes Alpine has already published, and the layer takes
that catch-up instead of pinning a package version that is right only until the next advisory
(`Dockerfile.service:5-15`).

How fresh the layer is depends on the build host, because it is cache-keyed on its own
instruction text plus the parent layer, and a build reuses whatever base it already holds unless
told to pull (`Dockerfile.service:14-23`):

- **CI** runs on GitHub-hosted runners, which are fresh virtual machines, so a CI build does not
  reuse a base or an upgrade layer from an earlier run of the workflow
  (`.github/workflows/ci.yml:174-184`).
- **The deploy script** builds with `--no-cache` (`deploy-server.sh:659-665`), so the upgrade
  layer re-runs on every full deploy, but on top of whichever base tag the host has cached: it does
  not pass `--pull`.
- **`scripts/scan-image.sh`** passes `--pull=always` (`scan-image.sh:63`), and its header records
  the size of the gap on one identical tree: 7 CRITICAL and 64 HIGH findings from a cached base,
  against 2 CRITICAL and 36 HIGH from a freshly pulled one (`scan-image.sh:22-26`).

The comment at `Dockerfile.service:16-23` describes a CI runner that keeps its image store between
runs. That is not the workflow here; it is exactly the position of any long-lived build or deploy
host, where the catch-up freezes at whatever base was last pulled.

## Scanning an image

CI's `scan` job runs Trivy on the application image `package` just built, filtered to CRITICAL
and HIGH with `--exit-code 1` (`.github/workflows/ci.yml:304-344`). It uses the same triggers as
the rest of the workflow - push to `main`, pull request against `main`, manual dispatch - so a
finding fails the pull request and cannot merge green. GitHub-hosted jobs do not share an image
store, so `package` saves the image and uploads it as a one-day workflow artefact
(`ci.yml:185-197`) and `scan` downloads that artefact rather than rebuilding.

`scripts/scan-image.sh` is the local reproduction of that gate: it builds the application
fast-jar and image, exports the image, and runs Trivy from its official container under the
same severity filter and `--exit-code 1` (`scan-image.sh:4-14`, `:58-104`). It needs Podman and
a JDK. The `:ro,Z` bind mount it uses is load-bearing on an SELinux-enforcing host, where a
bare `:ro` is denied inside the scanning container with a message that reads like a
file-permission problem (`scan-image.sh:27-30`); CI keeps the same mount options so the two
stay one gate.

The scan covers the application image only, not nginx. Whether a given tree currently passes
is the `scan` job on that commit.

## Reproducibility

Two builds of identical content produce the same image ID, and both halves are needed to get
there ([ADR 0023](../architecture/decisions/0023-reproducible-container-images.md)):

1. `--timestamp 0` on Podman, or `SOURCE_DATE_EPOCH=0` on Docker BuildKit, which has no
   equivalent flag. `quarkusBuild` restamps all 347 dependency jars with the build time on every
   run, so without this the 94 MiB `lib/` COPY layer takes a fresh digest even when no dependency
   changed (`scripts/check-image-reproducibility.sh:7-21`).
2. Deleting `/var/log/apk.log` in the RUN that creates it. With the timestamp fix alone, that one
   3.5 KB wall-clock-stamped file was the only remaining difference and still churned its whole
   3.32 MiB layer (`Dockerfile.service:27-34`).

`scripts/check-image-reproducibility.sh` is the guard and has two halves. `--audit`, the default,
splits each declared build site into logical commands and requires every command that builds
either Dockerfile to carry the determinism setting *itself*, or to be a call to a helper in the
same file whose own build commands all carry it - which is how `deploy-server.sh` spells the two
runtimes (`check-image-reproducibility.sh:25-34`, `deploy-server.sh:656-665`). The setting is never
counted file-wide. The site list is fixed - `.github/workflows/ci.yml`, `scripts/deploy-server.sh`
and `scripts/scan-image.sh` (`check-image-reproducibility.sh:63-68`) - so a build in a new file is
not detected. `--prove` builds the application
image twice with `--no-cache` under Podman, restamping every `lib/` modification time in between,
and asserts that the image ID is unchanged (`check-image-reproducibility.sh:164-228`).

CI runs the audit as the first step of `package` (`.github/workflows/ci.yml:166-171`), so a change
that drops the setting fails before any image is built. Nothing in CI runs `--prove`, which needs
Podman and a built fast-jar; it is run by hand.

What reproducibility buys is layer deduplication: an upgrade transfers only the layers whose
content changed rather than the whole payload, and an unchanged release is recognisable as
unchanged.

## The frontend is built twice

`Dockerfile.nginx` is self-contained: two builder stages run `npm ci && npm run build` for
`frontend/web` and `frontend/mobile` and copy their `dist/` output into the serving image
(`Dockerfile.nginx:1-14,30-38`).

`scripts/deploy-server.sh:618-641` nonetheless runs both builds on the host first, and
`.dockerignore:2` excludes `**/dist`, so that output cannot enter the build context. The host
build is a pre-flight check whose product is discarded, and it is the reason a deploy host needs a
Node toolchain at all (see [deploying](deploying.md#what-has-to-be-on-the-host)). CI's `frontend`
and `mobile` jobs likewise build the bundles to test them, and the image build compiles them again.

## Related

- [Building](building.md) - the fast-jar these images package
- [Deploying](deploying.md) - Stages 2-4 of the deploy script, which build both images
- [The delivery pipeline](README.md#the-delivery-pipeline) - what CI builds and what it does not
- [ADR 0023](../architecture/decisions/0023-reproducible-container-images.md) - reproducible images
