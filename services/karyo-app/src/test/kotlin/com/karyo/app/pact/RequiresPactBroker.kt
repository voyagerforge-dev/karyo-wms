package com.karyo.app.pact

import org.junit.jupiter.api.condition.EnabledIfSystemProperty

/**
 * Runs a Pact provider verification only against a broker someone named, and makes it strict there.
 *
 * With no `pact.broker.url`, JUnit skips the class and reports the reason below. These tests used to
 * report a pass instead - "No pacts found to verify" - because `@IgnoreNoPactsToVerify` turned an
 * unreachable broker into zero interactions and zero interactions into success. They no longer carry
 * that annotation, so once a broker is named, one that cannot be reached, or that holds no pact for
 * the provider, fails the test.
 *
 * `-Dpact.broker.url` on the Gradle command line reaches the forked test JVM only through the
 * forwarding in services/karyo-app/build.gradle.kts. CI's `pact-verify` job starts an ephemeral
 * broker, publishes the console's consumer pacts to it, names it this way, and then checks that
 * every published interaction was verified.
 */
@Target(AnnotationTarget.CLASS)
@EnabledIfSystemProperty(
    named = "pact.broker.url",
    matches = ".+",
    disabledReason = "no Pact broker named: pass -Dpact.broker.url=<url> to verify this provider's contracts",
)
annotation class RequiresPactBroker
