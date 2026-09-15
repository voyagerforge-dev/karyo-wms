import type { AlertDto, BackendSeverity } from '@/pages/monitors/monitors-api';
import { kpiContext } from '@/features/insights/kpi-notes';
import type { KpiDashboardResponse, OccupancyResponse, OccupancyState, RangePoint } from '@/types/insights';

/**
 * Pure real-data adapters for the home "Operations Control" dashboard.
 *
 * These turn real API response shapes (`/insights/kpis`, `/insights/occupancy`,
 * `/alerts`) into the exact presentational shapes the tile components
 * (`kpi-strip.tsx`, `throughput-card.tsx`, `zone-heatmap.tsx`,
 * `exceptions-card.tsx`) render.
 *
 * No fabrication: every field here is derived from a real response field, and
 * an absent measurement stays absent. A KPI the backend reports as undefined
 * (`value: null`) keeps a `null` value and gets a note saying why; a KPI with
 * no prior period gets no delta arrow; a day with zero picks gets a zero bar.
 */

/* -------------------------------------------------------------------------- */
/* KPI strip                                                                  */
/* -------------------------------------------------------------------------- */

export type DeltaTone = 'up' | 'warning' | 'danger';

export interface KpiDelta {
  /** Direction of the change; `=` when it rounds to zero at display precision. */
  arrow: '▲' | '▼' | '=';
  /** Sign-free magnitude, e.g. "0.3%" or "2.0h". */
  text: string;
}

export interface KpiCell {
  label: string;
  /** Pre-formatted value, or `null` when the measure is undefined (rendered as a placeholder). */
  value: string | null;
  /** Whether the big value paints in the danger color. */
  valueDanger?: boolean;
  /** Sparkline polyline points, 58x24 viewbox. Empty string when no series data. */
  points: string;
  tone: DeltaTone;
  /** Change against the prior period; `null` when there is none, so no arrow is painted. */
  delta: KpiDelta | null;
  /** One-line note under the value: what the delta compares against, or why there is none. */
  context: string;
}

const SPARK_WIDTH = 58;
const SPARK_HEIGHT = 24;
const SPARK_PAD = 2;

/** Normalizes a KPI series into a `58x24` SVG polyline `points` string. */
function seriesToPoints(series: RangePoint[]): string {
  if (series.length === 0) return '';
  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return series
    .map((p, i) => {
      const x = series.length === 1 ? 0 : (i / (series.length - 1)) * SPARK_WIDTH;
      const norm = (p.value - min) / range;
      const y = SPARK_HEIGHT - SPARK_PAD - norm * (SPARK_HEIGHT - SPARK_PAD * 2);
      return `${Math.round(x)},${Math.round(y)}`;
    })
    .join(' ');
}

/**
 * Splits a pre-formatted delta string (e.g. "+0.3%", "-2.0h") into arrow + sign-free text. A
 * change that rounds to zero ("+0.0h", "-0.0%") gets `=` rather than a direction it does not have.
 */
function parseDelta(delta: string | null): KpiDelta | null {
  if (!delta) return null;
  const trimmed = delta.trim();
  const text = trimmed.replace(/^[+-]/, '');
  const arrow = parseFloat(text) === 0 ? '=' : trimmed.startsWith('-') ? '▼' : '▲';
  return { arrow, text };
}

/**
 * Maps the 4 real KPI tiles (accuracy/throughput/cycleTime/utilization) into
 * `KpiCell`s, plus an optional 5th "Open exceptions" cell sourced from the
 * monitors firing count. `openExceptions` is `null` until a real count has
 * loaded (monitors not entitled, or still fetching): the cell is omitted
 * rather than fabricated.
 */
export function kpisToCells(res: KpiDashboardResponse, openExceptions: number | null): KpiCell[] {
  const cells: KpiCell[] = res.tiles.map((tile) => ({
    label: tile.label,
    value: tile.value,
    points: seriesToPoints(tile.series),
    tone: tile.tone,
    delta: parseDelta(tile.delta),
    context: kpiContext(tile),
  }));

  if (openExceptions !== null) {
    cells.push({
      label: 'Open exceptions',
      value: String(openExceptions),
      valueDanger: openExceptions > 0,
      points: '',
      tone: openExceptions > 0 ? 'danger' : 'up',
      delta: null,
      context: 'Firing now',
    });
  }

  return cells;
}

/* -------------------------------------------------------------------------- */
/* Throughput chart                                                           */
/* -------------------------------------------------------------------------- */

export interface ThroughputBar {
  /** Short axis label; empty for a bar that gets no tick on a long range. */
  label: string;
  /** Bar height as a percentage: 0 for a zero day, otherwise at least 8 so a small value stays visible. */
  pct: number;
  isPeak: boolean;
}

export interface ThroughputView {
  bars: ThroughputBar[];
  peakText: string;
  avgText: string;
}

const NO_VALUE = '–';

/** The backend buckets days as ISO `YYYY-MM-DD` in warehouse-local time; read it as a local date. */
function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });

/** "14 Sep" style day label for the PEAK read-out. */
function dayMonth(date: Date): string {
  return `${date.getDate()} ${MONTH.format(date)}`;
}

const DAY_MS = 86_400_000;

/** At most this many day-and-month ticks, so their labels never run into each other. */
const MAX_DAY_TICKS = 7;

/**
 * Axis labels for the daily bars. Bars exist only for days with activity, so the
 * style follows the calendar span from the first bar to the last, not the bar
 * count: within one week, weekday names; up to about two months, a "14 Sep" tick
 * on every fifth bar (spaced wider when there are too many bars for the ticks to
 * fit); anything longer is ticked only where the month changes. The columns are
 * too narrow for a label each, and an ISO date under every bar would be unreadable.
 */
function barLabels(days: string[]): string[] {
  const dates = days.map(parseDay);
  const spanDays = Math.round((dates[dates.length - 1].getTime() - dates[0].getTime()) / DAY_MS);
  if (spanDays < 7) return dates.map((d) => WEEKDAY.format(d));
  if (spanDays <= 62) {
    const stride = Math.max(5, Math.ceil(dates.length / MAX_DAY_TICKS));
    return dates.map((d, i) => (i % stride === 0 ? dayMonth(d) : ''));
  }
  return dates.map((d, i) => (i === 0 || d.getMonth() !== dates[i - 1].getMonth() ? MONTH.format(d) : ''));
}

/** Builds daily throughput bars from `chart.outbound` (units picked per activity day). */
export function kpiChartToThroughput(res: KpiDashboardResponse): ThroughputView {
  const series = res.chart.outbound;
  if (series.length === 0) {
    return { bars: [], peakText: `PEAK ${NO_VALUE}`, avgText: `AVG ${NO_VALUE}` };
  }

  const values = series.map((p) => p.value);
  const max = Math.max(...values);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const labels = barLabels(series.map((p) => p.day));

  const bars: ThroughputBar[] = series.map((p, i) => ({
    label: labels[i],
    pct: p.value === 0 ? 0 : Math.max(8, Math.round((p.value / max) * 100)),
    isPeak: max > 0 && p.value === max,
  }));

  const peakDay = max > 0 ? dayMonth(parseDay(series[values.indexOf(max)].day)).toUpperCase() : null;

  return {
    bars,
    peakText: peakDay ? `PEAK ${peakDay} ${max.toLocaleString()}` : `PEAK ${NO_VALUE}`,
    avgText: `AVG ${avg.toLocaleString()}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Zone occupancy heatmap                                                     */
/* -------------------------------------------------------------------------- */

export interface ZoneCell {
  /** Fill color hex / css value. */
  color: string;
  /** Tooltip text. */
  title: string;
}

export interface ZoneField {
  cells: ZoneCell[];
  title: string;
  sub: string;
  badgeText: string;
  badgeTone: 'danger' | 'accent';
  legendUnit: string;
  legend: { color: string; label: string }[];
}

const ZONE_COLOR: Record<OccupancyState, string> = {
  occupied: 'rgb(var(--acc))',
  empty: 'var(--accent)',
  locked: 'var(--danger)',
};

/**
 * Flattens every real location (across zones + unzoned) into one cell per
 * location, colored by its actual occupancy state. There is no pick-density
 * or replen-need backing metric, so only the occupancy view exists here.
 */
export function occupancyToZoneField(res: OccupancyResponse): ZoneField {
  const zones = res.unzoned ? [...res.zones, res.unzoned] : res.zones;
  const locations = zones.flatMap((zone) => zone.locations.map((loc) => ({ zone, loc })));

  const cells: ZoneCell[] = locations.map(({ zone, loc }) => ({
    color: ZONE_COLOR[loc.state],
    title: `${zone.zoneName} · ${loc.name} — ${loc.state}`,
  }));

  const lockedCount = locations.filter(({ loc }) => loc.state === 'locked').length;

  return {
    cells,
    title: 'Zone occupancy',
    // `totals.pct` is a 0..1 fraction (see `OccupancyTotals`), the same one the Occupancy page scales.
    sub: `FACILITY ${Math.round(res.totals.pct * 100)}% FULL`,
    badgeText: `${lockedCount} LOCKED`,
    badgeTone: lockedCount > 0 ? 'danger' : 'accent',
    legendUnit: 'STATE',
    legend: [
      { color: ZONE_COLOR.occupied, label: 'Occupied' },
      { color: ZONE_COLOR.empty, label: 'Empty' },
      { color: ZONE_COLOR.locked, label: 'Locked' },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Exceptions                                                                 */
/* -------------------------------------------------------------------------- */

export type ExceptionSeverity = 'danger' | 'warning' | 'info';

export interface ExceptionRow {
  type: string;
  detail: string;
  age: string;
  severity: ExceptionSeverity;
}

const SEVERITY_MAP: Record<BackendSeverity, ExceptionSeverity> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'info',
};

/** `"2m"` / `"3h"` / `"1d"` style relative age, no "ago" suffix (matches the tile's compact style). */
function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(diffMs / 60_000));
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/** Maps firing alerts into exception rows. HIGH -> danger, MEDIUM -> warning, LOW -> info. */
export function alertsToExceptions(alerts: AlertDto[]): ExceptionRow[] {
  return alerts.map((a) => ({
    type: a.monitorName.toUpperCase(),
    detail: a.scope ? `${a.scope} · ${a.reason}` : a.reason,
    age: relativeAge(a.firstFiredAt),
    severity: SEVERITY_MAP[a.severity],
  }));
}
