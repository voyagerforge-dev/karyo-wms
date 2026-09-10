# Building Karyo

What a build of Karyo produces, which files hold which version, how vulnerable transitive
dependencies are answered, and what makes a distributed jar state its own licence.

Derived from `settings.gradle.kts`, `build.gradle.kts`, `buildSrc/`, `gradle/`,
`services/karyo-app/build.gradle.kts`, `config/` and `.github/workflows/ci.yml`.

## One deployable, forty-four subprojects

`settings.gradle.kts` includes forty-four Gradle subprojects - six shared libraries, the domain
`-api` and `-core` modules, the demo-data engine and the extension example - and exactly one of
them is a deployable: `:services:karyo-app`, the aggregator that assembles every core into one
Quarkus image (`settings.gradle.kts:147-148`). Every other module is a library that ends up on its
classpath ([ADR 0001](../architecture/decisions/0001-modular-monolith.md)).

The whole product is built by one task:

```
./gradlew :services:karyo-app:quarkusBuild -Dquarkus.profile=prod
```

which is the command `scripts/deploy-server.sh:605` runs, the command
`.github/workflows/ci.yml:172-173` runs, and the command `scripts/scan-image.sh:60` runs. It
produces a Quarkus fast-jar layout under `services/karyo-app/build/quarkus-app/` -
`quarkus-run.jar`, `lib/`, `app/` and `quarkus/` - and that directory is what
`infrastructure/docker/Dockerfile.service:65-68` copies into the image.

Nothing publishes a jar. The module jars exist only as inputs to that layout, which is why a
release is a source tree and the images built from it rather than Maven coordinates.

A JDK 21 is required, not a JRE: `javac` must be available. The build uses the checked-in
wrapper, so no separate Gradle installation is needed.

`karyo-app`'s build file also carries the one build-time augmentation switch:
`karyoInventoryExample`, a Gradle property that adds the extension example module to the image
and is "off in ordinary images" (`services/karyo-app/build.gradle.kts:42-45`). It is the mechanism
an augmented build uses; see [extension SPIs and installation](../integration/extension-spis-and-installation.md).

## Building with the commercial engines

The nine commercial engines are not in this repository. `settings.gradle.kts:150-194` includes
them only when a commercial checkout is present, taking their project directories from it: point
at one with `-Pkaryo.commercial=<path>` or `KARYO_COMMERCIAL=<path>`, or place it as a sibling
directory named `karyo-commercial`. An explicitly named path that is not a commercial checkout
fails the build rather than silently producing a free image. `services/karyo-app/build.gradle.kts`
adds whatever was included to the application's dependencies and grafts the commercial test suites
onto its test source set (`services/karyo-app/build.gradle.kts:5-34,64-71`).

With nothing beside this checkout, the same command builds the complete free product: forty-four
subprojects, and an image in which no licence can unlock an engine, because no engine is on disk.
The boundary itself is described in [the commercial boundary](../architecture/commercial-boundary.md)
and [ADR 0020](../architecture/decisions/0020-free-and-commercial-boundary-per-module.md).

The same build decides what the application image says about its own licence.
`:services:karyo-app:imageLegalFiles`, which `quarkusBuild` depends on, stages the licence files the
image carries - with the commercial engines, each engine's own licence among them - and records the
licence expression the image's label must carry in `services/karyo-app/build/image-licenses`
(`services/karyo-app/build.gradle.kts:173-213`). Pass that value when building the image; see
[container images](container-images.md#licence-labels).

## Three version authorities, and only one of them is the product version

| Authority | Governs | Where |
|---|---|---|
| `allprojects.version` | the product release number | `build.gradle.kts:30` (`1.0.0`) |
| `gradle/libs.versions.toml` | dependency and plugin versions | the version catalog |
| `buildSrc/build.gradle.kts` | the Gradle plugin jars themselves | `buildSrc/build.gradle.kts:10-16` |

The product version is one line in the root build file; how and when it moves is in
[releasing](../guides/releasing.md) and [ADR 0024](../architecture/decisions/0024-conventional-commits-and-semver.md).

The third authority is a problem. `buildSrc/build.gradle.kts` hardcodes the Quarkus and Kotlin
plugin versions under the comment "versions MUST match `gradle/libs.versions.toml`", and nothing
checks that they do (`buildSrc/build.gradle.kts:11-15`, `gradle/libs.versions.toml:2-3`). **Known
defect.** Bump `quarkus` in the catalog alone and the platform BOM moves while the Gradle plugin
does not, so augmentation runs on one Quarkus version against a dependency set managed by another.

The Gradle wrapper pins the distribution URL but not its bytes
(`gradle/wrapper/gradle-wrapper.properties`): `validateDistributionUrl=true` constrains the host,
and there is no `distributionSha256Sum`. **Known defect.** Every build, including every build a
deploy host runs, executes whatever that URL serves.

## Security floors, in two mechanisms because one does not work

`build.gradle.kts` answers vulnerability findings in transitive dependencies with version *floors*
rather than pins - `require` raises anything below the floor and leaves anything at or above it
alone - so a later platform bump is never held back (`build.gradle.kts:109-120`).

Two mechanisms, and the file explains why:

- **A `constraints` block** for leaf transitives outside every BOM. `opennlp-tools` is the only
  entry, floored to 2.5.11 for two CRITICALs and a HIGH that arrive through
  `quarkus-langchain4j-core` (`build.gradle.kts:121-143`).
- **`resolutionStrategy.eachDependency`** for anything the Quarkus BOM manages. Every module
  applies that BOM with `enforcedPlatform`, whose forced versions beat a plain constraint outright
  and do so silently, so netty, Jackson, micrometer and the PostgreSQL driver go through a
  `securityFloor` helper that runs after conflict resolution (`build.gradle.kts:145-229`).

Two exclusions inside that block are worth knowing because they are the shape of mistake a
family-wide floor invites. `netty-tcnative` versions on its own 2.0.x line inside the `io.netty`
group, and `jackson-annotations` ships on a minor-only cadence, so a group-wide floor would demand
versions that have never been published and fail the whole configuration to resolve
(`build.gradle.kts:177-197`). Neither artefact is on the classpath today; both guards exist so that
adding one later fails no build.

`securityFloor` compares the numeric runs in a version left to right and ignores qualifiers, so
`4.1.121.Final < 4.1.136.Final` while `4.2.13.Final` is not below `4.1.136.Final`
(`build.gradle.kts:326-356`). Its own KDoc bounds it: correct for every coordinate that uses it,
wrong for a pre-release line, and not to be reached for there.

Each entry names the CVEs it clears and how to retire it - delete it, run
`./scripts/scan-image.sh`, and drop it for good if the finding does not come back. That is the
best-documented part of the build and it is worth keeping that way.

## Static analysis

Detekt is applied to every Kotlin module with a shared configuration
(`build.gradle.kts:231-238`), and existing findings are held in per-module
`detekt-baseline.xml` files so that they do not fail the build while new ones do. CI's `quality`
job runs `./gradlew detekt` and blocks on it (`.github/workflows/ci.yml:128-150`). With a commercial
checkout present it also lints the grafted commercial suites, which it would not find on its own:
the task reads a module's conventional `src/` directories, not its source sets
(`services/karyo-app/build.gradle.kts:30-33`). Those suites get the same exemptions as any test
source (`config/detekt/detekt.yml:45-64`).

Two things bound what that gate is worth. The pinned Detekt is an alpha prerelease
(`gradle/libs.versions.toml:7`), and why a prerelease was chosen is not recorded. And the
whole-module `detekt` task that CI invokes performs no type resolution, so every rule marked
`RequiresAnalysisApi` is silently disabled on it: a measured 73 enabled against 154 disabled,
recorded in the configuration's own comment (`config/detekt/detekt.yml:5-24`). Nothing in the
step's name or output says which rules did not run, and the baselines were captured against the
reduced set.

OWASP dependency-check is applied alongside it, failing at CVSS 7.0 and reading an optional
`NVD_API_KEY` (`build.gradle.kts:239-246`). No CI job runs it; it is run by hand, and without an
API key the NVD service is heavily rate-limited.

## The deterministic-test contract

`build.gradle.kts:13-26` reads `config/test-runner-contracts.json` at configuration time and
refuses to configure at all unless the Gradle contract rejects test filters and requires JUnit
Platform. Two later hooks enforce it: `gradle.projectsEvaluated` fails if a project with test
sources has no test task (`build.gradle.kts:249-262`), and `gradle.taskGraph.whenReady` walks
every `test` task in the graph and fails on any of the ways to run fewer tests than the source set
contains - disabled, conditionally skipped, dry run, ignoring failures, include or exclude patterns
at either the task or the filter level, engine or tag filters, omitted sources, or a
`testClassesDirs` that does not equal the complete test source-set output
(`build.gradle.kts:264-323`).

This is a delivery control, not a testing one. It exists so that a green pipeline cannot be
produced by narrowing what the suite runs, which is the failure mode a release gate is most
exposed to. What the suites themselves cover is in [testing](../architecture/testing.md).

## Licence notices, packaged and verified

Apache-2.0 section 4(d) requires the `NOTICE` to accompany a distribution. The root build packages
three files into every jar's `META-INF` (`build.gradle.kts:82-93`):

- `NOTICE`, from the repository root, identical for every module;
- `LICENSE`, **per module**: a module's own `LICENSE` file if it has one, otherwise the root
  Apache-2.0 text (`build.gradle.kts:84`). Every module in this repository takes the root text; a
  commercial `-core`, when a commercial checkout is overlaid, carries its own marker in its own
  project directory, and that is what its jar packages (`build.gradle.kts:66-72`);
- `THIRD-PARTY-NOTICES.md`, renamed to `THIRD-PARTY-NOTICES`, because the licence label
  deliberately does not enumerate the LGPL-2.1, EPL-2.0 and SIL-OFL-1.1 components a distribution
  contains (`build.gradle.kts:74-77,91`).

The copy alone guarantees nothing - Gradle's `metaInf` is silent about a missing source file, so
renaming `NOTICE` would empty every jar and fail no task. `VerifyJarLegalFiles`
(`buildSrc/src/main/kotlin/com/karyo/conventions/VerifyJarLegalFiles.kt`) reads the built jars
back and compares the packaged bytes against the files on disk, and its own KDoc states the bound
precisely: it is registered beside the copy over the same live `Jar` task collection, so it covers
exactly the jars the copy covers, and a module the convention never reaches is not covered
(`VerifyJarLegalFiles.kt:32-37`). `NOTICE` itself names the nine commercial modules as outside the
Apache grant (`NOTICE:9-25`), so a commercial module's jar carries a `NOTICE` that agrees with the
marker packaged beside it (`VerifyJarLegalFiles.kt:21-23`).

The task is wired into `check` (`build.gradle.kts:106`), which is the conventional place, and no CI
job runs `check`: the workflow names its Gradle tasks explicitly. **Known defect.** The licence
verification runs only when someone runs `./gradlew check` or `./gradlew verifyJarLegalFiles` by
hand, and the next verification a contributor wires into `check` the conventional way will not run
in CI either, with nothing to say so.

`THIRD-PARTY-NOTICES.md` is the weak link in an otherwise tight chain. It is byte-verified into
every jar and copied into both images, and it is a hand-maintained table of eight rows, dated
(`THIRD-PARTY-NOTICES.md:1-17`). No SBOM generator exists anywhere in the build, so nothing checks
that the table is complete.

## Related

- [Container images](container-images.md) - what is built from the fast-jar
- [The delivery pipeline](README.md#the-delivery-pipeline) - which of these checks CI runs
- [Developer onboarding](../guides/developer-onboarding.md) - building and running locally
- [ADR 0002](../architecture/decisions/0002-kotlin-on-quarkus.md) - Kotlin on Quarkus
- [ADR 0003](../architecture/decisions/0003-gradle-kotlin-dsl-and-version-catalog.md) - Gradle, the
  Kotlin DSL and the version catalog
