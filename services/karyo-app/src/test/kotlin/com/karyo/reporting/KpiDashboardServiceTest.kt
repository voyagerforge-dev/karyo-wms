package com.karyo.reporting

import com.karyo.reporting.repository.DailyAccuracy
import com.karyo.reporting.repository.DailyCycleTime
import com.karyo.reporting.repository.DailyThroughput
import com.karyo.reporting.repository.KpiViewRepository
import com.karyo.reporting.service.KpiDashboardService
import com.karyo.reporting.service.KpiRange
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.time.Instant
import java.time.LocalDate

/**
 * A KPI whose denominator is zero is undefined, and the tile must say so with `value = null`
 * rather than format the zero. These tests pin that contract for each measure and for the delta,
 * against a stubbed [KpiViewRepository] so the windows are fully controlled.
 */
class KpiDashboardServiceTest {
    private val repo = mockk<KpiViewRepository>()
    private val service = KpiDashboardService(repo)
    private val now: Instant = Instant.parse("2026-09-15T06:00:00Z")
    private val client = 7L

    @BeforeEach
    fun emptyWarehouse() {
        every { repo.accuracy(any(), any(), any()) } returns emptyList()
        every { repo.throughput(any(), any(), any()) } returns emptyList()
        every { repo.cycleTime(any(), any(), any()) } returns emptyList()
        every { repo.utilization(any()) } returns (0L to 0L)
    }

    @Test
    fun `every tile is undefined on an empty warehouse`() {
        val res = service.build(client, KpiRange.D7, now)

        assertEquals(listOf("accuracy", "throughput", "cycleTime", "utilization"), res.tiles.map { it.key })
        res.tiles.forEach { tile ->
            assertNull(tile.value, "${tile.key} value")
            assertNull(tile.delta, "${tile.key} delta")
            assertEquals("up", tile.tone, "${tile.key} tone")
            assertTrue(tile.series.isEmpty(), "${tile.key} series")
        }
        assertTrue(res.chart.outbound.isEmpty())
    }

    @Test
    fun `accuracy stays undefined while lines exist but none has been counted`() {
        every { repo.accuracy(client, any(), any()) } returns listOf(
            DailyAccuracy(LocalDate.of(2026, 9, 14), accurateLines = 0, totalLines = 0),
        )

        val accuracy = service.build(client, KpiRange.D7, now).tiles.first { it.key == "accuracy" }

        assertNull(accuracy.value)
        assertTrue(accuracy.series.isEmpty(), "an uncounted day is not a 0% point")
    }

    @Test
    fun `a defined window without a prior one carries a value but no delta`() {
        val (start, _) = KpiRange.D7.window(now)
        every { repo.accuracy(client, start, now) } returns listOf(
            DailyAccuracy(LocalDate.of(2026, 9, 13), accurateLines = 0, totalLines = 0),
            DailyAccuracy(LocalDate.of(2026, 9, 14), accurateLines = 9, totalLines = 10),
        )
        every { repo.throughput(client, start, now) } returns listOf(
            DailyThroughput(LocalDate.of(2026, 9, 14), unitsPicked = 120.0, unitsShipped = 3.0, unitsReceived = 40.0),
        )
        every { repo.cycleTime(client, start, now) } returns listOf(
            DailyCycleTime(LocalDate.of(2026, 9, 14), orderCount = 2, totalHours = 9.0),
        )
        every { repo.utilization(client) } returns (3L to 4L)

        val tiles = service.build(client, KpiRange.D7, now).tiles.associateBy { it.key }

        assertEquals("90.0%", tiles.getValue("accuracy").value)
        assertEquals(listOf(90.0), tiles.getValue("accuracy").series.map { it.value })
        assertEquals("120/day", tiles.getValue("throughput").value)
        assertEquals("4.5h", tiles.getValue("cycleTime").value)
        assertEquals("75.0%", tiles.getValue("utilization").value)
        tiles.values.forEach { tile ->
            assertNull(tile.delta, "${tile.key} delta")
            assertEquals("up", tile.tone, "${tile.key} tone")
        }
    }

    @Test
    fun `delta and tone compare two defined windows`() {
        val (start, _) = KpiRange.D7.window(now)
        val (pStart, pEnd) = KpiRange.D7.priorWindow(now)
        every { repo.cycleTime(client, start, now) } returns listOf(
            DailyCycleTime(LocalDate.of(2026, 9, 14), orderCount = 1, totalHours = 6.0),
        )
        every { repo.cycleTime(client, pStart, pEnd) } returns listOf(
            DailyCycleTime(LocalDate.of(2026, 9, 7), orderCount = 1, totalHours = 4.0),
        )

        val cycleTime = service.build(client, KpiRange.D7, now).tiles.first { it.key == "cycleTime" }

        assertEquals("6.0h", cycleTime.value)
        assertEquals("+2.0h", cycleTime.delta)
        assertEquals("warning", cycleTime.tone, "cycle time went up, which is the bad direction")
    }
}
