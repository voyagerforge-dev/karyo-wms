package com.karyo.layout.pact

import au.com.dius.pact.provider.junit5.HttpTestTarget
import au.com.dius.pact.provider.junit5.PactVerificationContext
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider
import au.com.dius.pact.provider.junitsupport.Provider
import au.com.dius.pact.provider.junitsupport.State
import au.com.dius.pact.provider.junitsupport.loader.PactBroker
import com.karyo.app.pact.RequiresPactBroker
import com.karyo.layout.domain.model.Area
import com.karyo.layout.domain.model.LocationType
import com.karyo.layout.domain.model.StorageLocation
import com.karyo.layout.repository.AreaRepository
import com.karyo.layout.repository.LocationTypeRepository
import com.karyo.layout.repository.StorageLocationRepository
import io.quarkus.test.junit.QuarkusTest
import io.quarkus.test.security.TestSecurity
import io.quarkus.test.security.oidc.Claim
import io.quarkus.test.security.oidc.OidcSecurity
import jakarta.inject.Inject
import jakarta.transaction.Transactional
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.TestTemplate
import org.junit.jupiter.api.extension.ExtendWith
import java.math.BigDecimal

/**
 * Pact provider verification for layout-service (warehouse-layout-service).
 *
 * Verifies that the layout-service REST API satisfies all consumer contracts
 * published to the Pact Broker. Each @State method seeds real entity data so
 * provider verification returns actual responses matching the contract.
 */
@QuarkusTest
@Provider("layout-service")
@PactBroker(url = "\${pact.broker.url}")
@RequiresPactBroker
@TestSecurity(user = "manager", roles = ["layout-read", "layout-write"])
@OidcSecurity(claims = [Claim(key = "client_id", value = "1")])
class LayoutPactProviderTest {

    @ConfigProperty(name = "quarkus.http.test-port")
    var port: Int = 0

    @Inject
    lateinit var areaRepository: AreaRepository

    @Inject
    lateinit var locationTypeRepository: LocationTypeRepository

    @Inject
    lateinit var storageLocationRepository: StorageLocationRepository

    // Quarkus + pact-jvm 4.6.17 known limitation -- see ProductPactProviderTest for the full writeup.
    // Real seeding happens here in @BeforeEach (CDI-injected instance); @State methods are inert
    // markers so pact-jvm still recognizes/matches every state a consumer interaction declares.
    @BeforeEach
    @Transactional
    fun setup(context: PactVerificationContext?) {
        context?.target = HttpTestTarget("localhost", port)
        val stateNames = context?.interaction?.providerStates?.map { it.name }?.toSet() ?: emptySet()
        if ("locations exist" in stateNames) seedLocation()
        if ("area and location type exist" in stateNames) seedAreaAndLocationType()
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider::class)
    fun verifyPact(context: PactVerificationContext?) {
        context?.verifyInteraction()
    }

    @State("locations exist")
    fun locationsExist() {
        // no-op: real seeding happens in setup() above -- see the comment there.
    }

    @State("area and location type exist")
    fun areaAndLocationTypeExist() {
        // no-op: real seeding happens in setup() above -- see the comment there.
    }

    private fun seedLocation() {
        val area = Area().apply {
            name = "Receiving ${System.nanoTime()}"
            usages = "STORAGE"
        }
        areaRepository.persist(area)

        val locationType = LocationType().apply {
            name = "Standard Rack ${System.nanoTime()}"
        }
        locationTypeRepository.persist(locationType)

        val location = StorageLocation().apply {
            name = "A-01-01-${System.nanoTime()}"
            clientId = 1
            this.locationType = locationType
            this.area = area
            allocation = BigDecimal.ZERO
            lockType = 0
        }
        storageLocationRepository.persist(location)
    }

    private fun seedAreaAndLocationType() {
        // Seed area and location type for the "create location" POST endpoint.
        // The consumer sends areaId and locationTypeId in the request body.
        val area = Area().apply {
            name = "Receiving ${System.nanoTime()}"
            usages = "STORAGE"
        }
        areaRepository.persist(area)

        val locationType = LocationType().apply {
            name = "Standard Rack ${System.nanoTime()}"
        }
        locationTypeRepository.persist(locationType)
    }
}
