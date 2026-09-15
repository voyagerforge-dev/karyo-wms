package com.karyo.reporting.api.v1.dto

/** One point in a daily series — `value` is a raw number for the sparkline polyline. */
data class RangePoint(val day: String, val value: Double)

/**
 * A KPI tile. `value`/`delta` are preformatted display strings; `series` is raw for the sparkline.
 *
 * `value` is `null` when the measure is undefined over the window: no counted lines (accuracy),
 * no activity days (throughput), no shipped orders (cycle time) or no storage locations
 * (utilization). Formatting that zero denominator as "0.0%" would present a fabricated figure as a
 * measurement, so the tile says nothing instead. `delta` is `null` unless both this window and the
 * prior one have a defined value; `tone` is "up" whenever there is no delta to colour.
 */
data class KpiTile(
    val key: String,        // "accuracy" | "throughput" | "cycleTime" | "utilization"
    val label: String,
    val value: String?,     // e.g. "98.4%", "1,240/day", "6.2h", "72%"; null when undefined
    val delta: String?,     // e.g. "+0.6%", "-0.3h"; null when no prior/utilization/undefined
    val tone: String,       // "up" (good) | "warning" (down-bad)
    val series: List<RangePoint>,
)

/** Trend chart: outbound (picked) vs received daily units. */
data class KpiChart(val outbound: List<RangePoint>, val received: List<RangePoint>)

data class KpiDashboardResponse(
    val range: String,
    val rangeLabel: String,
    val tiles: List<KpiTile>,
    val chart: KpiChart,
)
