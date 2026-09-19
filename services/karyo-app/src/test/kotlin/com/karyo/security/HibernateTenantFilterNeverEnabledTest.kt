package com.karyo.security

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Executable guard for the owner-scoping model documented in
 * `docs/architecture/identity-and-tenancy.md` ("What actually enforces isolation"),
 * `docs/architecture/decisions/0014-silo-tenancy-and-goods-owners.md` and
 * `docs/reference/data-model.md`.
 *
 * Those documents rest on one code invariant: the Hibernate `@FilterDef`/`@Filter` named
 * `tenantFilter`, declared on `TenantEntity`
 * (`libs/karyo-common/src/main/kotlin/com/karyo/common/domain/BaseEntity.kt`), is DECLARED but
 * NEVER ENABLED. Owner isolation is therefore enforced by application code (`TenantScope`,
 * `readScope()`/`writeScope()`, explicit `clientId` predicates) and by nothing beneath it. The
 * filter is off deliberately: a Hibernate filter does not apply to primary-key `find()`/`get()`
 * or to native queries, so a filter-based boundary would look airtight in review and leak on the
 * most common call.
 *
 * The moment any main-source code calls `enableFilter(...)`, that model stops being true and the
 * documentation above silently becomes misleading. This test fails on that change so the author
 * must reconcile the code and the docs in the same pull request. It mirrors the file-scanning
 * contract style of [com.karyo.app.auth.ProductionComposeExposureTest].
 */
class HibernateTenantFilterNeverEnabledTest {

    private val enableFilterCall = Regex("""enableFilter\s*\(""")

    @Test
    fun `no main-source code enables a Hibernate filter`() {
        val root = projectRoot()
        val mainSources = mainSourceFiles(root)

        // Anti-vacuity anchor: a tree-walking guard is worthless if it silently scans nothing, so
        // prove the walk actually reaches the file that declares the filter this test guards. An
        // empty or mis-scoped scan would otherwise let the check below pass without detecting
        // anything.
        assertThat(mainSources.map { it.toString().replace('\\', '/') })
            .describedAs(
                "the main-source scan must reach the tenantFilter declaration site (BaseEntity.kt)",
            )
            .anyMatch { it.endsWith("com/karyo/common/domain/BaseEntity.kt") }

        val offenders = mainSources
            .filter { enableFilterCall.containsMatchIn(Files.readString(it)) }
            .map { root.relativize(it).toString() }
            .sorted()

        assertThat(offenders)
            .describedAs(
                "The owner-scoping model documented in docs/architecture/identity-and-tenancy.md " +
                    "and ADR 0014 relies on the Hibernate `tenantFilter` (declared on TenantEntity) " +
                    "being NEVER enabled - owner isolation is application-code-only. A main-source " +
                    "enableFilter(...) call invalidates that model. Either remove it, or update the " +
                    "documentation to describe the new enforcement layer.",
            )
            .isEmpty()
    }

    /** Every `.kt`/`.java` file under a `src/main` tree in the application modules. */
    private fun mainSourceFiles(root: Path): List<Path> =
        listOf("services", "libs")
            .map(root::resolve)
            .filter { Files.isDirectory(it) }
            .flatMap { module ->
                module.toFile().walkTopDown()
                    .onEnter { it.name != "build" }
                    .filter { it.isFile && (it.name.endsWith(".kt") || it.name.endsWith(".java")) }
                    .map { it.toPath() }
                    .filter { isMainSource(root.relativize(it)) }
                    .toList()
            }

    private fun isMainSource(relative: Path): Boolean {
        val segments = (0 until relative.nameCount).map { relative.getName(it).toString() }
        return segments.zipWithNext().any { (parent, child) -> parent == "src" && child == "main" }
    }

    private fun projectRoot(): Path {
        var directory: Path? = Paths.get("").toAbsolutePath()
        while (directory != null) {
            if (Files.exists(directory.resolve("settings.gradle.kts"))) {
                return directory
            }
            directory = directory.parent
        }
        error("project root not found")
    }
}
