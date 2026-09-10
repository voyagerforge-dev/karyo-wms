package com.karyo.app.admin

import jakarta.annotation.security.RolesAllowed
import jakarta.enterprise.context.ApplicationScoped
import jakarta.enterprise.inject.spi.BeanManager
import jakarta.inject.Inject
import jakarta.ws.rs.GET
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType

/**
 * One row per declared SPI interface: [fqn] to look up via [Class.forName], plus the owning
 * [module] name (matches the `services/` folder naming used by the static frontend catalog,
 * `frontend/web/src/pages/admin/spi-catalog.ts`).
 */
private data class SpiSeamRef(val fqn: String, val module: String)

/** One resolved row in the live SPI registry response. */
data class ExtensionInfo(
    val spiInterface: String,
    val spiFqn: String,
    val module: String,
    val implementations: List<String>,
    val implementationCount: Int,
)

/**
 * Live SPI-registry endpoint (Phase B14) — the runtime counterpart of the static
 * `SPI_CATALOG` in `frontend/web/src/pages/admin/spi-catalog.ts`.
 *
 * `karyo-app` depends on the domain `-core` modules via non-transitive `implementation`,
 * so it cannot import the SPI interface types at compile time. Every module's classes are
 * present on the runtime classpath, though, so this resource resolves each declared
 * fully-qualified interface name via [Class.forName] and asks the CDI [BeanManager] which
 * beans actually satisfy it. An interface that fails to resolve (module not on the
 * classpath) is silently dropped -- honest, not fabricated. An interface that resolves but
 * has zero loaded beans is still reported, with an empty `implementations` list, because a
 * declared seam with no active implementation is itself useful information.
 */
@Path("/api/v1/admin/extensions")
@ApplicationScoped
@Produces(MediaType.APPLICATION_JSON)
class AdminExtensionsResource {

    @Inject
    lateinit var beanManager: BeanManager

    @GET
    @RolesAllowed("ADMIN")
    fun listExtensions(): List<ExtensionInfo> =
        CURATED_SPI_SEAMS
            .mapNotNull { seam -> resolve(seam) }
            .sortedWith(compareBy({ it.module }, { it.spiInterface }))

    private fun resolve(seam: SpiSeamRef): ExtensionInfo? {
        val spiClass = runCatching { Class.forName(seam.fqn) }.getOrNull() ?: return null
        val implementations = beanManager.getBeans(spiClass)
            .map { it.beanClass.simpleName }
            .distinct()
            .sorted()
        return ExtensionInfo(
            spiInterface = spiClass.simpleName,
            spiFqn = seam.fqn,
            module = seam.module,
            implementations = implementations,
            implementationCount = implementations.size,
        )
    }

    companion object {
        // Every extension seam this repository declares: one row per top-level interface in a
        // `*.spi` package under services/ or libs/, and the list is complete by that rule rather
        // than curated by hand. The rule is what makes it checkable -- the previous list named 49
        // of the 77 and nothing said which 28 were missing or why, so the omissions read as
        // deliberate curation when they were only the modules added after the list was written.
        //
        // Two declared `*.spi` interfaces are deliberately not here, because neither is an
        // extension point: `ReservationSourceState` is the opaque snapshot ReservationRefMover
        // returns to its own caller, and `ConcurrentStateChange` is a marker an exception carries.
        // Any other absence is a defect in this list.
        //
        // Presence here is not a promise that the seam is safe to implement: several rows are
        // in-process lookups and ports with one implementation and no chain, which the module
        // boundary rules exclude from the strategy concept. Nothing in the response distinguishes
        // the two kinds yet, and that is tracked separately.
        //
        // A row whose module is not on the runtime classpath resolves to nothing and is dropped
        // from the response, which is how the nine commercial engines' seams behave in a free
        // installation: their `-api` module is here, so the seam is declared and listed with an
        // empty `implementations`, and the engine that would fill it is not installed.
        private val CURATED_SPI_SEAMS = listOf(
            // karyo-auth
            SpiSeamRef("com.karyo.auth.spi.ClientLookup", "karyo-auth"),
            SpiSeamRef("com.karyo.auth.spi.RuntimePropertyLookup", "karyo-auth"),
            // karyo-crossdock
            SpiSeamRef("com.karyo.crossdock.spi.CrossDockExpiryHandler", "karyo-crossdock"),
            SpiSeamRef("com.karyo.crossdock.spi.CrossDockingMatcher", "karyo-crossdock"),
            // karyo-forecasting
            SpiSeamRef("com.karyo.forecasting.spi.ForecastModel", "karyo-forecasting"),
            // karyo-fulfillment
            SpiSeamRef("com.karyo.fulfillment.spi.BatchPickPort", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.CarrierAdapter", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.ConsolidationPackPort", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.DocumentAvailabilityStrategy", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PackoutStrategy", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickCancelPort", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickDifferenceStrategy", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickOrderGroupingStrategy", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickReleasePort", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickRollupLookup", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.PickZoneLookup", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.ShipmentLookup", "karyo-fulfillment"),
            SpiSeamRef("com.karyo.fulfillment.spi.ShortfallStrategy", "karyo-fulfillment"),
            // karyo-inventory
            SpiSeamRef("com.karyo.inventory.api.spi.JournalEnricher", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.OpenPickGuard", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.PurgeBlockerLookup", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.ReplenishmentSourceSelector", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.ReservationRefMover", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockCountingPort", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockMover", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockPicker", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockReceiver", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockReserver", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockSelectionFilter", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockSummaryLookup", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.StockUnitLookup", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.UnitLoadLookup", "karyo-inventory"),
            SpiSeamRef("com.karyo.inventory.api.spi.UnitLoadMover", "karyo-inventory"),
            // karyo-layout
            SpiSeamRef("com.karyo.layout.spi.ClearingLocationLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.FixAssignmentLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.ItemDataAreaLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.LocationAreaUsageLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.LocationFilter", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.LocationFinder", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.LocationLockPort", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.PutawayLocationStrategy", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.StagingLocationLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.StorageLocationLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.StorageStrategyLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.TransportDemandLookup", "karyo-layout"),
            SpiSeamRef("com.karyo.layout.spi.WorkingAreaLookup", "karyo-layout"),
            // karyo-monitors
            SpiSeamRef("com.karyo.monitors.spi.AlertDeliveryChannel", "karyo-monitors"),
            SpiSeamRef("com.karyo.monitors.spi.Detector", "karyo-monitors"),
            // karyo-orders
            SpiSeamRef("com.karyo.orders.spi.CrossDockOrdersPort", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.DeliveryOrderLookup", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.GoodsReceiptLookup", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.OrderProgressionPort", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.OrderReleasePort", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.OrderReleaseValidator", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.OrderStrategyLookup", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.OrderStrategyResolver", "karyo-orders"),
            SpiSeamRef("com.karyo.orders.spi.StreamingReleasePort", "karyo-orders"),
            // karyo-product
            SpiSeamRef("com.karyo.product.spi.BarcodeResolver", "karyo-product"),
            SpiSeamRef("com.karyo.product.spi.PackagingUnitLookup", "karyo-product"),
            SpiSeamRef("com.karyo.product.spi.ProductLookup", "karyo-product"),
            SpiSeamRef("com.karyo.product.spi.SubstitutionLookup", "karyo-product"),
            // karyo-replenishment
            SpiSeamRef("com.karyo.replenishment.spi.ReplenishmentStrategy", "karyo-replenishment"),
            // karyo-sequence
            SpiSeamRef("com.karyo.sequence.spi.SequenceNumberGenerator", "karyo-sequence"),
            // karyo-simulation
            SpiSeamRef("com.karyo.simulation.spi.ReorderPolicySimulator", "karyo-simulation"),
            // karyo-slotting
            SpiSeamRef("com.karyo.slotting.spi.SlottingStrategy", "karyo-slotting"),
            // karyo-stocktaking
            SpiSeamRef("com.karyo.stocktaking.spi.CountScopeStrategy", "karyo-stocktaking"),
            // karyo-streaming
            SpiSeamRef("com.karyo.streaming.spi.ReleaseTimingStrategy", "karyo-streaming"),
            // karyo-tasks
            SpiSeamRef("com.karyo.tasks.spi.CrossDockLookup", "karyo-tasks"),
            SpiSeamRef("com.karyo.tasks.spi.TransportOrderPort", "karyo-tasks"),
            // karyo-wave
            SpiSeamRef("com.karyo.wave.spi.AllocationCustomizer", "karyo-wave"),
            SpiSeamRef("com.karyo.wave.spi.ConsolidationCustomizer", "karyo-wave"),
            SpiSeamRef("com.karyo.wave.spi.WaveSelectionStrategy", "karyo-wave"),
            // karyo-webhooks
            SpiSeamRef("com.karyo.webhooks.spi.DeliveryRetryPolicy", "karyo-webhooks"),
            SpiSeamRef("com.karyo.webhooks.spi.WebhookSigner", "karyo-webhooks"),
            // karyo-work
            SpiSeamRef("com.karyo.work.spi.WorkDispatchStrategy", "karyo-work"),
            SpiSeamRef("com.karyo.work.spi.WorkEligibilityResolver", "karyo-work"),
            SpiSeamRef("com.karyo.work.spi.WorkProvider", "karyo-work"),
        )
    }
}
