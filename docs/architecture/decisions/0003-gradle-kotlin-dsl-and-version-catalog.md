# ADR 0003: The build is Gradle with the Kotlin DSL, a version catalog and convention plugins

**Status:** Accepted

## Context

The free build is 44 Gradle subprojects - six libraries, twenty-one `-api` modules, fourteen free
`-core` modules, the demo module, an extension example and the application - and nine more join it
when a commercial checkout is present ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).
All of it is Kotlin ([ADR 0002](0002-kotlin-on-quarkus.md)) assembled by the Quarkus Gradle
plugin. Versions have to agree across every module, every module needs the same compiler and test
setup, and the build is the natural home for the checks that must never be skipped: legal files in
every jar, security floors on transitive dependencies, static analysis and test integrity.

## Decision

- Gradle, always run through the checked-in wrapper (`gradle/wrapper/gradle-wrapper.properties:3`),
  with every build script in the Kotlin DSL.
- One root project, `karyo-wms`. `settings.gradle.kts` is the module graph, including the optional
  commercial overlay (`settings.gradle.kts:1`, `settings.gradle.kts:10-148`, `settings.gradle.kts:150-194`).
- Versions live in the version catalog, `gradle/libs.versions.toml`.
- Two precompiled convention plugins in `buildSrc` carry what every module shares:
  `karyo.kotlin-conventions` (Kotlin JVM, `allopen`, `jpa`, the Java 21 toolchain, compiler flags)
  and `karyo.quarkus-service` (the Quarkus plugin, JaCoCo, the JUnit Platform). A module's own build
  file lists only its dependencies.
- The root `build.gradle.kts` holds what applies to the whole build: one version for everything
  (`build.gradle.kts:28-30`); jar legal-file verification wired into `check`
  (`build.gradle.kts:95-106`); security floors for transitive dependencies
  (`build.gradle.kts:109-121` and the `securityFloor` calls that follow); Detekt
  (`build.gradle.kts:236-241`); OWASP dependency-check (`build.gradle.kts:243-249`); and a
  test-integrity gate that fails the build when a project with test sources has no deterministic
  test task, or when that task is disabled, skipped, a dry run or set to ignore failures
  (`build.gradle.kts:253-266`, `build.gradle.kts:268`).
- Parallel execution and the build cache are on (`gradle.properties:1-3`).
- Optional modules are selected by properties, not by editing build files. The extension example
  is built as a module but enters the application only with `-PkaryoInventoryExample=true`
  (`services/karyo-app/build.gradle.kts:42-45`); the commercial engines enter with
  `-Pkaryo.commercial` or its equivalents ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).

## Consequences

- Build scripts are type-checked and completed by the IDE; a mistake fails at configuration time.
- Versions and module conventions are written once and apply everywhere.
- The gates that must hold - legal files in jars, security floors, test integrity - run inside
  `./gradlew check` and `./gradlew test`, not in a separate script someone can forget.
- The Quarkus and Kotlin plugin versions are written twice, in the catalog and in
  `buildSrc/build.gradle.kts:11-15`, whose comment says they must match. Nothing checks that they do.
- The Quarkus BOM is an enforced platform, so a plain dependency constraint cannot raise a version
  it manages; those floors must go through `securityFloor` (`build.gradle.kts:109-121`).
- The Kotlin DSL configures more slowly than the Groovy DSL, and Gradle upgrades can break plugins.
- The static-analysis gate runs a prerelease of Detekt (`gradle/libs.versions.toml:7`). Why a
  prerelease was chosen is not recorded.
- The logic that includes the commercial engines is public, in `settings.gradle.kts`; reading it
  tells anyone that nine engines exist and where they plug in
  ([ADR 0020](0020-free-and-commercial-boundary-per-module.md)).

## Alternatives considered

- **Maven.** Rejected: verbose XML, weaker incremental builds, parent-POM inheritance that is less
  flexible than convention plugins, and no type-checked build scripts.
- **Bazel.** Rejected: a steep learning curve, little ready-made Kotlin and Quarkus support, and a
  setup cost out of proportion at this scale.
- **Gradle with the Groovy DSL.** Not taken: the Kotlin DSL keeps build scripts in the same language
  as the application and type-checks them, at the cost of slower configuration.

## Evidence

- `gradle/wrapper/gradle-wrapper.properties:3` - the pinned Gradle distribution
- `gradle/libs.versions.toml` - the version catalog
- `buildSrc/src/main/kotlin/karyo.kotlin-conventions.gradle.kts:1-26` - the Kotlin convention plugin
- `buildSrc/src/main/kotlin/karyo.quarkus-service.gradle.kts:1-22` - the Quarkus convention plugin
- `buildSrc/build.gradle.kts:10-16` - the plugin versions, repeated from the catalog
- `build.gradle.kts:28-30`, `build.gradle.kts:95-106`, `build.gradle.kts:109-121`,
  `build.gradle.kts:236-249`, `build.gradle.kts:253-266` - the build-wide version and gates
- `gradle.properties:1-3` - parallel execution and caching
- [Building](../../operations/building.md)

## Related

- [ADR 0002](0002-kotlin-on-quarkus.md) - the language and framework the build compiles
- [ADR 0020](0020-free-and-commercial-boundary-per-module.md) - the commercial overlay in `settings.gradle.kts`
- [ADR 0023](0023-reproducible-container-images.md) - what happens to the build's output
- [ADR 0024](0024-conventional-commits-and-semver.md) - how the one version moves
