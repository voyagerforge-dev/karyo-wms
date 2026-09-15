import type { KpiTile } from '@/types/insights';

/** Placeholder shown in a KPI's value slot when the measure is undefined (`value === null`). */
export const KPI_UNDEFINED_VALUE = '–';

const UNDEFINED_NOTE: Record<KpiTile['key'], string> = {
  accuracy: 'No counted lines in range',
  throughput: 'No activity in range',
  cycleTime: 'No orders shipped in range',
  utilization: 'No storage locations',
};

/**
 * The one-line note under a KPI value: why there is no value, why there is no delta, or what
 * the delta compares against. The backend nulls `value` when the measure's denominator is zero
 * over the window (see `KpiTile` in the reporting API) and nulls `delta` when either window is
 * undefined; utilization is a live snapshot and never has one.
 */
export function kpiContext(tile: Pick<KpiTile, 'key' | 'value' | 'delta'>): string {
  if (tile.value === null) return UNDEFINED_NOTE[tile.key];
  if (tile.delta === null) return tile.key === 'utilization' ? 'Live snapshot' : 'No prior period';
  return 'vs prior period';
}
