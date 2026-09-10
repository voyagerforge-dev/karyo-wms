plugins {
    id("karyo.quarkus-service")
}

// Kept in step with settings.gradle.kts, which decides whether these projects exist at all.
val commercialCores = listOf(
    ":services:monitoring-service:karyo-monitors-core",
    ":services:forecasting-service:karyo-forecasting-core",
    ":services:slotting-service:karyo-slotting-core",
    ":services:simulation-service:karyo-simulation-core",
    ":services:crossdock-service:karyo-crossdock-core",
    ":services:wave-service:karyo-wave-core",
    ":services:streaming-service:karyo-streaming-core",
    ":services:document-service:karyo-doctemplates-core",
    ":services:fulfillment-service:karyo-cartonization-core",
)

// The commercial suites are grafted onto this module's test source set rather than living
// in a project of their own: they exercise the assembled application, which only exists
// here. The path is derived from a commercial project's own directory, so it follows
// wherever settings.gradle.kts pointed and needs no second convention to agree with.
val commercialTests = rootProject.findProject(":services:wave-service:karyo-wave-core")
    ?.projectDir
    ?.resolve("../../../tests/app")
    ?.normalize()
    ?.takeIf { it.isDirectory }

if (commercialTests != null) {
    kotlin.sourceSets.named("test") { kotlin.srcDir(commercialTests) }
    // The `detekt` task lints the conventional src/ directories, not the source set, so the grafted
    // suites are handed to it explicitly; without this `./gradlew detekt` never reads them.
    // config/detekt/detekt.yml gives them the same test-source exemptions as src/test.
    tasks.named<dev.detekt.gradle.Detekt>("detekt") { source(commercialTests) }
}

dependencies {
    // Domain modules (now libraries, each contributes entities, resources, services)
    // inventory-api is needed on the MAIN classpath too (not just test): the SC19
    // KeycloakEventPoller in com.karyo.app.auth maps events to JournalRecordType.
    implementation(project(":services:inventory-service:karyo-inventory-api"))
    implementation(project(":services:inventory-service:karyo-inventory-core"))
    // Deliberate build-time augmentation, never a runtime JAR upload. Off in ordinary images.
    if (providers.gradleProperty("karyoInventoryExample").map(String::toBooleanStrict).getOrElse(false)) {
        implementation(project(":services:inventory-service:karyo-inventory-ext-example"))
    }
    implementation(project(":services:product-service:karyo-product-core"))
    implementation(project(":services:warehouse-layout-service:karyo-layout-core"))
    implementation(project(":services:auth-service:karyo-auth-core"))
    implementation(project(":services:order-service:karyo-orders-core"))
    implementation(project(":services:task-service:karyo-tasks-core"))
    implementation(project(":services:fulfillment-service:karyo-fulfillment-core"))
    implementation(project(":services:replenishment-service:karyo-replenishment-core"))
    implementation(project(":services:stocktaking-service:karyo-stocktaking-core"))
    implementation(project(":services:work-service:karyo-work-api"))
    implementation(project(":services:work-service:karyo-work-core"))
    implementation(project(":services:integration-hub-service:karyo-webhooks-api"))
    implementation(project(":services:integration-hub-service:karyo-webhooks-core"))
    implementation(project(":services:reporting-service:karyo-reporting-api"))
    implementation(project(":services:reporting-service:karyo-reporting-core"))
    implementation(project(":services:ai-service:karyo-ai-api"))
    implementation(project(":services:ai-service:karyo-ai-core"))
    implementation(project(":services:demo-service:karyo-demo"))
    implementation(project(":services:document-service:karyo-docstore-core"))
    // The nine commercial engines are included by settings.gradle.kts only when a
    // commercial checkout is present. Whatever it included, this picks up; with
    // nothing beside this checkout the loop adds nothing and the image is the free
    // product. The engines plug in through SPIs declared in the Apache-2.0 -api
    // modules above, so no free code names one of them.
    commercialCores.forEach { path ->
        rootProject.findProject(path)?.let { implementation(project(path)) }
    }
    implementation(project(":libs:karyo-license"))
    implementation(project(":libs:karyo-documents"))
    implementation(project(":libs:karyo-sequence"))
    // Patchable<T> tri-state Jackson module (com.karyo.app.config.JacksonConfig) -- the
    // aggregator app is the one place that registers it as an ObjectMapperCustomizer.
    implementation(project(":libs:karyo-common"))

    // Quarkus BOM — manages all extension versions
    implementation(enforcedPlatform(libs.quarkus.bom))

    // Quarkus extensions must be present on the app classpath for augmentation.
    // They come transitively from the cores, but declare the union explicitly so
    // the aggregator app is the single source of truth for the assembled image.
    implementation(libs.quarkus.kotlin)
    implementation(libs.quarkus.rest)
    implementation(libs.quarkus.rest.jackson)
    implementation(libs.quarkus.rest.client.jackson)
    implementation(libs.quarkus.config.yaml)
    implementation(libs.quarkus.hibernate.orm.panache.kotlin)
    implementation(libs.quarkus.jdbc.postgresql)
    implementation(libs.quarkus.flyway)
    implementation(libs.quarkus.oidc)
    implementation(libs.quarkus.keycloak.admin.rest.client)
    implementation(libs.quarkus.hibernate.validator)
    implementation(libs.quarkus.smallrye.health)
    implementation(libs.quarkus.smallrye.fault.tolerance)
    implementation(libs.quarkus.micrometer.registry.prometheus)
    implementation(libs.quarkus.opentelemetry)
    implementation(libs.quarkus.logging.json)
    implementation(libs.quarkus.scheduler)
    implementation(libs.quarkus.mailer)
    implementation(libs.quarkus.qute)
    implementation(libs.openhtmltopdf.pdfbox)
    implementation(libs.quarkus.cache)
    implementation(libs.jackson.module.kotlin)
    implementation(libs.quarkus.container.image.jib)
    implementation(libs.quarkus.kubernetes)

    // Test dependencies
    // The cores expose their api modules and shared libs as `implementation`, so the
    // migrated test suites need them declared explicitly on the test compile classpath.
    testImplementation(project(":services:inventory-service:karyo-inventory-api"))
    testImplementation(project(":services:product-service:karyo-product-api"))
    testImplementation(project(":services:warehouse-layout-service:karyo-layout-api"))
    testImplementation(project(":services:auth-service:karyo-auth-api"))
    testImplementation(project(":services:order-service:karyo-orders-api"))
    testImplementation(project(":services:task-service:karyo-tasks-api"))
    testImplementation(project(":services:fulfillment-service:karyo-fulfillment-api"))
    testImplementation(project(":services:replenishment-service:karyo-replenishment-api"))
    testImplementation(project(":services:stocktaking-service:karyo-stocktaking-api"))
    testImplementation(project(":services:work-service:karyo-work-api"))
    testImplementation(project(":services:monitoring-service:karyo-monitors-api"))
    testImplementation(project(":services:forecasting-service:karyo-forecasting-api"))
    testImplementation(project(":services:slotting-service:karyo-slotting-api"))
    testImplementation(project(":services:simulation-service:karyo-simulation-api"))
    testImplementation(project(":services:document-service:karyo-docstore-api"))
    testImplementation(project(":services:crossdock-service:karyo-crossdock-api"))
    testImplementation(project(":services:wave-service:karyo-wave-api"))
    testImplementation(project(":services:streaming-service:karyo-streaming-api"))
    testImplementation(project(":libs:karyo-common"))
    testImplementation(project(":libs:karyo-events"))
    testImplementation(project(":libs:karyo-security"))
    testImplementation(project(":libs:karyo-license"))
    testImplementation(libs.quarkus.junit5)
    testImplementation(libs.quarkus.junit5.mockito)
    testImplementation(libs.quarkus.test.security.oidc)
    testImplementation(libs.quarkus.devservices.keycloak)
    testImplementation(libs.rest.assured)
    testImplementation(libs.mockk)
    testImplementation(libs.assertj.core)
    testImplementation(libs.quarkus.pact.provider)
    testImplementation(libs.quarkus.pact.consumer)
}

// Task 4 review fix-round: an aggregate run spanning every touched module's test classes in one
// JVM fork (com.karyo.sequence/.fulfillment/.orders/.tasks/.stocktaking/.inventory/.app/.work --
// several hundred @QuarkusTest classes) exhausted Gradle's unconfigured test-worker default heap
// (observed ~512m) with a Hibernate/ANTLR HQL-parsing OutOfMemoryError partway through, not a
// logic bug in any test. No maxHeapSize was set anywhere before this. 3g comfortably covers the
// accumulated Hibernate query-plan/ANTLR parser state across a run this size.
// Wave bulk-fulfillment sprint (2026-08-21): the sprint's new @QuarkusTest/@TestProfile classes,
// each restarting the test app in-JVM, outgrew 3g with a vertx-blocked-thread-checker
// OutOfMemoryError partway through the full suite, so it is raised to 5g.
tasks.withType<Test> {
    maxHeapSize = "5g"

    // Forward the Pact broker URL from the Gradle invocation into the FORKED test JVM.
    //
    // A Test task forks its own JVM and inherits no command-line -D at all: measured 2026-09-02
    // with a throwaway Gradle project, `System.getProperty` for the key came back null inside the
    // test worker. Without this, `./gradlew :services:karyo-app:test -Dpact.broker.url=...` sets
    // the property on the Gradle daemon only.
    //
    // It is load-bearing twice. The property is what enables the four *PactProviderTest classes
    // at all (@RequiresPactBroker in com.karyo.app.pact skips them, with the reason, when no
    // broker is named), and it is the only place their @PactBroker annotation reads the broker's
    // address from. CI's `pact-verify` job names its ephemeral broker this way, then checks that
    // every published interaction was verified.
    providers.systemProperty("pact.broker.url").orNull?.let { systemProperty("pact.broker.url", it) }
}

// ---------------------------------------------------------------------------------------------
// The licence files the application image carries at /app (infrastructure/docker/Dockerfile.service)
//
// Staged here rather than copied from the repository root, because what they have to say depends
// on what this build assembled. Every build stages NOTICE, the Apache-2.0 LICENSE and the
// third-party inventory. A build that included commercial engines also stages each one's own
// licence marker, as commercial-licenses/<module>/LICENSE, and records that the image label must
// then name the commercial terms too. The Dockerfile refuses a label that disagrees with what was
// staged, so a forgotten build argument cannot put a proprietary image out as Apache-2.0 alone.
// ---------------------------------------------------------------------------------------------
val commercialLicenceMarkers = commercialCores
    .mapNotNull { rootProject.findProject(it) }
    .associate { it.name to it.file("LICENSE") }
val imageLicences =
    if (commercialLicenceMarkers.isEmpty()) "Apache-2.0" else "Apache-2.0 AND LicenseRef-Karyo-Commercial"
val imageLicencesFile = layout.buildDirectory.file("image-licenses")

val imageLegalFiles = tasks.register<Sync>("imageLegalFiles") {
    group = "build"
    description = "Stages the licence files the application image carries, and records its licence expression."
    into(layout.buildDirectory.dir("image-legal"))
    from(rootProject.file("NOTICE"))
    from(rootProject.file("LICENSE"))
    from(rootProject.file("THIRD-PARTY-NOTICES.md")) { rename { "THIRD-PARTY-NOTICES" } }
    commercialLicenceMarkers.forEach { (module, marker) ->
        from(marker) { into("commercial-licenses/$module") }
    }
    inputs.property("imageLicences", imageLicences)
    outputs.file(imageLicencesFile)
    // `from` is silent about a missing file, so without this a commercial module with no marker of
    // its own would ship in the image with nothing stating its terms.
    doFirst {
        val missing = commercialLicenceMarkers.filterValues { !it.isFile }.keys
        if (missing.isNotEmpty()) {
            throw GradleException("Commercial modules with no LICENSE marker of their own: ${missing.joinToString()}")
        }
    }
    doLast { imageLicencesFile.get().asFile.writeText("$imageLicences\n") }
}

tasks.named("quarkusBuild") { dependsOn(imageLegalFiles) }
