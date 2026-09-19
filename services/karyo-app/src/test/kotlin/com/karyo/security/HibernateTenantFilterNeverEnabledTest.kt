package com.karyo.security

import io.quarkus.test.junit.QuarkusTest
import jakarta.inject.Inject
import jakarta.persistence.EntityManager
import jakarta.transaction.Transactional
import org.assertj.core.api.Assertions.assertThat
import org.hibernate.Session
import org.junit.jupiter.api.Test

/**
 * Executable guard for the owner-scoping model documented in
 * `docs/architecture/identity-and-tenancy.md` ("What actually enforces isolation"),
 * `docs/architecture/decisions/0014-silo-tenancy-and-goods-owners.md` and
 * `docs/reference/data-model.md`.
 *
 * Those documents rest on one invariant: the Hibernate filter `tenantFilter`, declared on
 * `TenantEntity`, is declared but never enabled, so owner isolation is enforced by application
 * code (`TenantScope`, `readScope()`/`writeScope()`, explicit `clientId` predicates) and by nothing
 * beneath it. A Hibernate filter does not apply to primary-key `find()`/`get()` or to native
 * queries, so a filter-based boundary would look airtight in review and leak on the most common
 * call.
 *
 * The check runs against the booted persistence unit: the registered filter definition must not be
 * auto-enabled, and a transactional session opened outside any HTTP request must not have it
 * enabled. If either changes, reconcile the documentation above in the same pull request.
 */
@QuarkusTest
class HibernateTenantFilterNeverEnabledTest {

    @Inject
    lateinit var em: EntityManager

    @Test
    @Transactional
    fun `tenantFilter is declared but neither auto-enabled nor enabled on a live session`() {
        val session = em.unwrap(Session::class.java)
        val definition = session.sessionFactory.getFilterDefinition("tenantFilter")

        assertThat(definition.isAutoEnabled)
            .describedAs("tenantFilter must not be auto-enabled for every session")
            .isFalse()
        assertThat(session.getEnabledFilter("tenantFilter"))
            .describedAs("tenantFilter must not be enabled on the application's transactional session")
            .isNull()
    }
}
