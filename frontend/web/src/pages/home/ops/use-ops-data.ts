import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useKpis } from '@/features/insights/use-kpis';
import { useOccupancy } from '@/features/insights/use-occupancy';
import { useLicense } from '@/features/license/use-license';
import { getAlerts } from '@/pages/monitors/monitors-api';
import type { ReportRange } from '@/types/insights';
import { panelState, type PanelState } from './panel-state';
import {
  kpisToCells,
  kpiChartToThroughput,
  occupancyToZoneField,
  alertsToExceptions,
  type KpiCell,
  type ThroughputView,
  type ZoneField,
  type ExceptionRow,
} from './ops-adapters';

/** The exceptions panel has one more state than the others: the engine behind it is licensed. */
export type ExceptionsState = PanelState<ExceptionRow[]> | { status: 'locked' };

export interface OpsData {
  kpis: PanelState<KpiCell[]>;
  throughput: PanelState<ThroughputView>;
  zone: PanelState<ZoneField>;
  exceptions: ExceptionsState;
}

/**
 * Assembles real API data for the home "Operations Control" dashboard's 4
 * tiles (KPI strip, throughput, zone heatmap, exceptions) via the pure
 * adapters in `ops-adapters.ts`, each wrapped in a `PanelState` so a tile can
 * tell "loading" and "failed" apart from "genuinely empty".
 *
 * `useMonitors()` (the Event Monitors screen's hook) doesn't expose the raw
 * `AlertDto[]` list it fetches internally, so firing alerts are queried here
 * directly against `GET /api/v1/alerts?status=FIRING` — same query key as
 * `use-monitors.ts` (`['alerts', 'FIRING']`) so React Query dedupes/caches
 * consistently if both screens are mounted. The query is only enabled once
 * the `monitors` entitlement is confirmed, so an unlicensed instance never
 * hits (and 403s against) the gated endpoint.
 */
export function useOpsData(range: ReportRange): OpsData {
  const license = useLicense();
  const monitorsEntitled = license.isEntitled('monitors');

  const kpisQuery = useKpis(range);
  const occupancyQuery = useOccupancy();
  const alertsQuery = useQuery({
    queryKey: ['alerts', 'FIRING'],
    queryFn: () => getAlerts('FIRING'),
    staleTime: 10_000,
    enabled: monitorsEntitled,
  });

  const { data: alerts, isError: alertsFailed } = alertsQuery;
  const exceptions = useMemo<ExceptionsState>(() => {
    // Until the licence has resolved, entitlement is undecided: neither the locked panel nor
    // an empty list may be claimed yet.
    if (license.data === undefined) return { status: license.isError ? 'error' : 'loading' };
    if (!monitorsEntitled) return { status: 'locked' };
    return panelState(alerts, alertsFailed, alertsToExceptions);
  }, [license.data, license.isError, monitorsEntitled, alerts, alertsFailed]);

  // Only a real, loaded firing count becomes a KPI cell; `null` (cell omitted) covers
  // "not entitled", "still fetching" and "failed", so a genuine zero is never confused
  // with an unresolved fetch.
  const openExceptions = exceptions.status === 'ready' ? exceptions.data.length : null;

  const { data: kpiRes, isError: kpisFailed } = kpisQuery;
  const { data: occupancyRes, isError: occupancyFailed } = occupancyQuery;
  const kpis = useMemo(
    () => panelState(kpiRes, kpisFailed, (res) => kpisToCells(res, openExceptions)),
    [kpiRes, kpisFailed, openExceptions],
  );
  const throughput = useMemo(
    () => panelState(kpiRes, kpisFailed, kpiChartToThroughput),
    [kpiRes, kpisFailed],
  );
  const zone = useMemo(
    () => panelState(occupancyRes, occupancyFailed, occupancyToZoneField),
    [occupancyRes, occupancyFailed],
  );

  return { kpis, throughput, zone, exceptions };
}
