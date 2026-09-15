import { describe, it, expect } from 'vitest';
import {
  kpisToCells,
  kpiChartToThroughput,
  occupancyToZoneField,
  alertsToExceptions,
} from '../ops-adapters';
import type { KpiDashboardResponse, OccupancyResponse, RangePoint } from '@/types/insights';
import type { AlertDto } from '@/pages/monitors/monitors-api';

const kpiRes: KpiDashboardResponse = {
  range: '7D',
  rangeLabel: 'Last 7 days',
  tiles: [
    {
      key: 'accuracy',
      label: 'Inventory accuracy',
      value: '99.2%',
      delta: '+0.3%',
      tone: 'up',
      series: [
        { day: '2026-09-13', value: 99 },
        { day: '2026-09-14', value: 99.2 },
      ],
    },
    {
      key: 'throughput',
      label: 'Throughput',
      value: '142/day',
      delta: '+5/day',
      tone: 'up',
      series: [
        { day: '2026-09-13', value: 130 },
        { day: '2026-09-14', value: 142 },
      ],
    },
    { key: 'cycleTime', label: 'Order cycle time', value: '6.2h', delta: '-2.0h', tone: 'up', series: [] },
    { key: 'utilization', label: 'Utilization', value: '76.0%', delta: null, tone: 'up', series: [] },
  ],
  chart: {
    outbound: [
      { day: '2026-09-14', value: 120 },
      { day: '2026-09-15', value: 180 },
      { day: '2026-09-16', value: 90 },
    ],
    received: [
      { day: '2026-09-14', value: 60 },
      { day: '2026-09-15', value: 40 },
      { day: '2026-09-16', value: 30 },
    ],
  },
};

/** The backend's shape for an empty warehouse: every measure undefined. */
const undefinedRes: KpiDashboardResponse = {
  ...kpiRes,
  tiles: kpiRes.tiles.map((t) => ({ ...t, value: null, delta: null, series: [] })),
  chart: { outbound: [], received: [] },
};

describe('kpisToCells', () => {
  it('maps the 4 real KPI keys into KpiCell shape', () => {
    const cells = kpisToCells(kpiRes, null);
    expect(cells).toHaveLength(4);
    expect(cells.map((c) => c.label)).toEqual([
      'Inventory accuracy',
      'Throughput',
      'Order cycle time',
      'Utilization',
    ]);
    expect(cells[0].value).toBe('99.2%');
  });

  it('derives the delta arrow from the sign of the delta string', () => {
    const cells = kpisToCells(kpiRes, null);
    expect(cells[0].delta).toEqual({ arrow: '▲', text: '0.3%' });
    expect(cells[2].delta).toEqual({ arrow: '▼', text: '2.0h' });
    expect(cells[0].context).toBe('vs prior period');
  });

  it('marks a change that rounds to zero as level rather than up or down', () => {
    const level = { ...kpiRes, tiles: [{ ...kpiRes.tiles[2], delta: '+0.0h' }, { ...kpiRes.tiles[0], delta: '-0.0%' }] };
    const cells = kpisToCells(level, null);
    expect(cells[0].delta).toEqual({ arrow: '=', text: '0.0h' });
    expect(cells[1].delta).toEqual({ arrow: '=', text: '0.0%' });
  });

  it('carries no delta (and so no arrow) when the backend sends none', () => {
    const cells = kpisToCells(kpiRes, null);
    expect(cells[3].delta).toBeNull();
    expect(cells[3].context).toBe('Live snapshot');

    const noPrior = { ...kpiRes, tiles: [{ ...kpiRes.tiles[0], delta: null }] };
    expect(kpisToCells(noPrior, null)[0]).toMatchObject({ delta: null, context: 'No prior period' });
  });

  it('keeps an undefined measure undefined and says why, instead of inventing a zero', () => {
    const cells = kpisToCells(undefinedRes, null);
    expect(cells.map((c) => c.value)).toEqual([null, null, null, null]);
    expect(cells.every((c) => c.delta === null)).toBe(true);
    expect(cells.map((c) => c.context)).toEqual([
      'No counted lines in range',
      'No activity in range',
      'No orders shipped in range',
      'No storage locations',
    ]);
  });

  it('builds a sparkline points string from a non-empty series, and an empty string for an empty series', () => {
    const cells = kpisToCells(kpiRes, null);
    expect(cells[0].points.length).toBeGreaterThan(0);
    expect(cells[2].points).toBe('');
  });

  it('appends an Open exceptions cell when a firing count is supplied', () => {
    const cells = kpisToCells(kpiRes, 6);
    expect(cells).toHaveLength(5);
    expect(cells[4]).toMatchObject({
      label: 'Open exceptions',
      value: '6',
      tone: 'danger',
      valueDanger: true,
      delta: null,
      context: 'Firing now',
    });
  });

  it('omits the exceptions cell when count is null (monitors not entitled or not loaded)', () => {
    expect(kpisToCells(kpiRes, null)).toHaveLength(4);
  });

  it('does not paint the exceptions cell danger when the count is zero', () => {
    const cells = kpisToCells(kpiRes, 0);
    expect(cells[4].value).toBe('0');
    expect(cells[4].tone).toBe('up');
    expect(cells[4].valueDanger).toBe(false);
  });
});

describe('kpiChartToThroughput', () => {
  it('builds daily bars from chart.outbound with a normalized peak and weekday labels for a week', () => {
    const t = kpiChartToThroughput(kpiRes);
    expect(t.bars).toHaveLength(3);
    const peak = t.bars.find((b) => b.isPeak);
    expect(peak?.pct).toBe(100); // 2026-09-15 = 180 is the max -> 100%
    expect(t.bars[0].pct).toBe(Math.round((120 / 180) * 100));
    expect(t.bars.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed']);
    expect(t.peakText).toBe('PEAK 15 SEP 180');
    expect(t.avgText).toBe('AVG 130');
  });

  it('gives a zero day a zero bar rather than the small-value floor', () => {
    const res = { ...kpiRes, chart: { ...kpiRes.chart, outbound: [{ day: '2026-09-14', value: 0 }, { day: '2026-09-15', value: 400 }] } };
    const t = kpiChartToThroughput(res);
    expect(t.bars[0]).toMatchObject({ pct: 0, isPeak: false });
    expect(t.bars[1]).toMatchObject({ pct: 100, isPeak: true });
  });

  it('marks no peak and no peak day when every day is zero', () => {
    const res = { ...kpiRes, chart: { ...kpiRes.chart, outbound: [{ day: '2026-09-14', value: 0 }, { day: '2026-09-15', value: 0 }] } };
    const t = kpiChartToThroughput(res);
    expect(t.bars.every((b) => b.pct === 0 && !b.isPeak)).toBe(true);
    expect(t.peakText).toBe('PEAK –');
    expect(t.avgText).toBe('AVG 0');
  });

  it('labels a month of bars by day number every fifth bar and a longer range only where the month changes', () => {
    const days = (from: Date, n: number): RangePoint[] =>
      Array.from({ length: n }, (_, i) => {
        const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { day: iso, value: 10 + i };
      });

    const month = kpiChartToThroughput({ ...kpiRes, chart: { ...kpiRes.chart, outbound: days(new Date(2026, 8, 1), 20) } });
    expect(month.bars.map((b) => b.label).slice(0, 6)).toEqual(['1', '', '', '', '', '6']);

    const quarter = kpiChartToThroughput({ ...kpiRes, chart: { ...kpiRes.chart, outbound: days(new Date(2026, 7, 25), 40) } });
    const ticks = quarter.bars.map((b) => b.label).filter((l) => l !== '');
    expect(ticks).toEqual(['Aug', 'Sep', 'Oct']);
    expect(quarter.bars[0].label).toBe('Aug');
    expect(quarter.bars[7].label).toBe('Sep'); // 2026-09-01
  });

  it('handles an empty outbound series without crashing', () => {
    const empty: KpiDashboardResponse = { ...kpiRes, chart: { outbound: [], received: [] } };
    const t = kpiChartToThroughput(empty);
    expect(t.bars).toHaveLength(0);
    expect(t.peakText).toBe('PEAK –');
  });
});

describe('occupancyToZoneField', () => {
  it('renders one cell per real location, colored by state, with real facility pct', () => {
    const occ: OccupancyResponse = {
      zones: [
        {
          zoneId: 1,
          zoneName: 'A',
          occupied: 1,
          total: 2,
          pct: 0.5,
          locations: [
            { id: 1, name: 'A-01', state: 'occupied' },
            { id: 2, name: 'A-02', state: 'empty' },
          ],
        },
      ],
      unzoned: null,
      totals: { occupied: 1, total: 2, pct: 0.5 },
    };
    const z = occupancyToZoneField(occ);
    expect(z.cells).toHaveLength(2);
    // The backend's pct is a 0..1 fraction; the card shows it as a percentage.
    expect(z.sub).toBe('FACILITY 50% FULL');
  });

  it('includes unzoned locations in the flattened cell list', () => {
    const occ: OccupancyResponse = {
      zones: [],
      unzoned: {
        zoneId: null,
        zoneName: 'Unzoned',
        occupied: 0,
        total: 1,
        pct: 0,
        locations: [{ id: 3, name: 'X-01', state: 'locked' }],
      },
      totals: { occupied: 0, total: 1, pct: 0 },
    };
    const z = occupancyToZoneField(occ);
    expect(z.cells).toHaveLength(1);
    expect(z.badgeText).toContain('1');
    expect(z.badgeTone).toBe('danger');
  });
});

describe('alertsToExceptions', () => {
  it('maps AlertDto severity/reason/time into ExceptionRow', () => {
    const alerts: AlertDto[] = [
      {
        id: 1,
        monitorKey: 'expiry-risk',
        monitorName: 'Expiry risk',
        severity: 'HIGH',
        status: 'FIRING',
        scope: 'lot 42',
        reason: '4 lots expiring',
        suggestedFix: 'pick soon',
        observedValue: 4,
        firstFiredAt: new Date(Date.now() - 120000).toISOString(),
        lastSeenAt: '',
        resolvedAt: null,
      },
    ];
    const rows = alertsToExceptions(alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toContain('4 lots expiring');
    expect(rows[0].severity).toBe('danger'); // HIGH -> danger
  });

  it('maps MEDIUM -> warning and LOW -> info', () => {
    const base = {
      id: 1,
      monitorKey: 'k',
      monitorName: 'Some monitor',
      status: 'FIRING' as const,
      scope: '',
      reason: 'r',
      suggestedFix: '',
      observedValue: 0,
      firstFiredAt: new Date().toISOString(),
      lastSeenAt: '',
      resolvedAt: null,
    };
    const rows = alertsToExceptions([
      { ...base, id: 2, severity: 'MEDIUM' },
      { ...base, id: 3, severity: 'LOW' },
    ]);
    expect(rows[0].severity).toBe('warning');
    expect(rows[1].severity).toBe('info');
  });

  it('returns an empty list for an empty alert array', () => {
    expect(alertsToExceptions([])).toEqual([]);
  });
});
