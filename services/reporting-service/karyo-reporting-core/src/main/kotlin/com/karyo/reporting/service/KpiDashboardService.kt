package com.karyo.reporting.service

import com.karyo.reporting.api.v1.dto.KpiChart
import com.karyo.reporting.api.v1.dto.KpiDashboardResponse
import com.karyo.reporting.api.v1.dto.KpiTile
import com.karyo.reporting.api.v1.dto.RangePoint
import com.karyo.reporting.repository.DailyCycleTime
import com.karyo.reporting.repository.DailyThroughput
import com.karyo.reporting.repository.KpiViewRepository
import jakarta.enterprise.context.ApplicationScoped
import java.time.Instant

/**
 * Builds the four KPI tiles and the trend chart for one window.
 *
 * Every measure here is a ratio or an average, and each one is undefined when its denominator
 * is zero: there is no accuracy until a line has been counted, no cycle time until an order has
 * shipped, no throughput average without an activity day, no utilization without a storage
 * location. Such a tile carries `value = null` (see [KpiTile]) rather than a formatted zero,
 * because "0.0%" on an empty warehouse reads as a measurement that was never taken. The same
 * rule governs the delta: it exists only when both windows are defined.
 */
@ApplicationScoped
class KpiDashboardService(private val repo: KpiViewRepository) {

    fun build(clientId: Long, range: KpiRange, now: Instant): KpiDashboardResponse {
        val (start, end) = range.window(now)
        val (pStart, pEnd) = range.priorWindow(now)

        // --- Accuracy (accurate / counted lines; undefined until a line has been counted) ---
        val acc = repo.accuracy(clientId, start, end)
        val accPrior = repo.accuracy(clientId, pStart, pEnd)
        val accTile = tile(
            key = "accuracy", label = "Inventory accuracy", higherIsGood = true,
            current = ratio(acc.sumOf { it.accurateLines }, acc.sumOf { it.totalLines }),
            prior = ratio(accPrior.sumOf { it.accurateLines }, accPrior.sumOf { it.totalLines }),
            format = KpiFormat::percent, formatDelta = KpiFormat::deltaPercent,
            // A day whose lines are all still uncounted has no accuracy either; plotting it as 0%
            // would draw a fabricated dip, so it is left out of the sparkline.
            series = acc.filter { it.totalLines > 0 }
                .map { RangePoint(it.day.toString(), it.accurateLines.toDouble() / it.totalLines * 100) },
        )

        // --- Throughput (avg daily unitsPicked only — unitsShipped is a shipment count, not unit amount) ---
        val thr = repo.throughput(clientId, start, end)
        val thrPrior = repo.throughput(clientId, pStart, pEnd)
        val thrTile = tile(
            key = "throughput", label = "Throughput", higherIsGood = true,
            current = avgPicked(thr), prior = avgPicked(thrPrior),
            format = KpiFormat::perDay, formatDelta = KpiFormat::deltaUnits,
            series = thr.map { RangePoint(it.day.toString(), it.unitsPicked) },
        )

        // --- Cycle time (avg hours = sum(total_hours)/sum(order_count); lower is good) ---
        val ct = repo.cycleTime(clientId, start, end)
        val ctPrior = repo.cycleTime(clientId, pStart, pEnd)
        val ctTile = tile(
            key = "cycleTime", label = "Order cycle time", higherIsGood = false,
            current = avgHours(ct), prior = avgHours(ctPrior),
            format = KpiFormat::hours, formatDelta = KpiFormat::deltaHours,
            series = ct.map { RangePoint(it.day.toString(), if (it.orderCount == 0L) 0.0 else it.totalHours / it.orderCount) },
        )

        // --- Utilization (current snapshot, no trend) ---
        val (occ, usable) = repo.utilization(clientId)
        val utilTile = tile(
            key = "utilization", label = "Utilization", higherIsGood = true,
            current = ratio(occ, usable), prior = null,
            format = KpiFormat::percent, formatDelta = KpiFormat::deltaPercent,
            series = emptyList(),
        )

        // Chart: outbound = unitsPicked (outbound-volume proxy); received = unitsReceived.
        // Both are true unit amounts — unitsShipped (shipment count) is intentionally excluded.
        val chart = KpiChart(
            outbound = thr.map { RangePoint(it.day.toString(), it.unitsPicked) },
            received = thr.map { RangePoint(it.day.toString(), it.unitsReceived) },
        )

        return KpiDashboardResponse(range.code, range.label, listOf(accTile, thrTile, ctTile, utilTile), chart)
    }

    /** `null` when the denominator is zero: the ratio is undefined, not 0. */
    private fun ratio(num: Long, den: Long): Double? = if (den == 0L) null else num.toDouble() / den

    /** Average units picked per activity day; `null` when the window has no activity day. */
    private fun avgPicked(rows: List<DailyThroughput>): Double? =
        if (rows.isEmpty()) null else rows.sumOf { it.unitsPicked } / rows.size

    /** Average hours per shipped order; `null` when nothing shipped in the window. */
    private fun avgHours(rows: List<DailyCycleTime>): Double? {
        val n = rows.sumOf { it.orderCount }
        return if (n == 0L) null else rows.sumOf { it.totalHours } / n
    }

    private fun tile(
        key: String,
        label: String,
        higherIsGood: Boolean,
        current: Double?,
        prior: Double?,
        format: (Double) -> String,
        formatDelta: (Double, Double) -> String,
        series: List<RangePoint>,
    ): KpiTile {
        val comparable = current != null && prior != null
        return KpiTile(
            key = key,
            label = label,
            value = current?.let(format),
            delta = if (comparable) formatDelta(current, prior) else null,
            tone = if (comparable) KpiFormat.tone(higherIsGood, current, prior) else "up",
            series = series,
        )
    }
}
