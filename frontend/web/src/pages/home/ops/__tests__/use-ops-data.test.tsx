import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { KpiDashboardResponse, OccupancyResponse } from '@/types/insights';
import type { AlertDto } from '@/pages/monitors/monitors-api';

const mockUseKpis = vi.fn();
const mockUseOccupancy = vi.fn();
const mockUseLicense = vi.fn();
const mockGetAlerts = vi.fn();

vi.mock('@/features/insights/use-kpis', () => ({ useKpis: () => mockUseKpis() }));
vi.mock('@/features/insights/use-occupancy', () => ({ useOccupancy: () => mockUseOccupancy() }));
vi.mock('@/features/license/use-license', () => ({ useLicense: () => mockUseLicense() }));
vi.mock('@/pages/monitors/monitors-api', () => ({ getAlerts: (status: string) => mockGetAlerts(status) }));

const { useOpsData } = await import('@/pages/home/ops/use-ops-data');

const kpiRes: KpiDashboardResponse = {
  range: '7D',
  rangeLabel: 'Last 7 days',
  tiles: [
    { key: 'accuracy', label: 'Inventory accuracy', value: '99.0%', delta: null, tone: 'up', series: [] },
    { key: 'throughput', label: 'Throughput', value: null, delta: null, tone: 'up', series: [] },
    { key: 'cycleTime', label: 'Order cycle time', value: null, delta: null, tone: 'up', series: [] },
    { key: 'utilization', label: 'Utilization', value: '50.0%', delta: null, tone: 'up', series: [] },
  ],
  chart: { outbound: [{ day: '2026-09-14', value: 12 }], received: [] },
};

const occupancyRes: OccupancyResponse = {
  zones: [{ zoneId: 1, zoneName: 'A', occupied: 1, total: 1, pct: 1, locations: [{ id: 1, name: 'A-01', state: 'occupied' }] }],
  unzoned: null,
  totals: { occupied: 1, total: 1, pct: 1 },
};

const alert: AlertDto = {
  id: 1,
  monitorKey: 'expiry-risk',
  monitorName: 'Expiry risk',
  severity: 'HIGH',
  status: 'FIRING',
  scope: 'lot 42',
  reason: '4 lots expiring',
  suggestedFix: '',
  observedValue: 4,
  firstFiredAt: new Date().toISOString(),
  lastSeenAt: '',
  resolvedAt: null,
};

const pending = { data: undefined, isError: false, isLoading: true };
const failed = { data: undefined, isError: true, isLoading: false };
const loaded = <T,>(data: T) => ({ data, isError: false, isLoading: false });

function license(entitlements: string[] | null, isError = false) {
  const data = entitlements ? { edition: 'commercial', entitlements } : undefined;
  return { data, isError, isLoading: !data && !isError, isEntitled: (key: string) => !!data?.entitlements.includes(key) };
}

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

describe('useOpsData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseKpis.mockReturnValue(loaded(kpiRes));
    mockUseOccupancy.mockReturnValue(loaded(occupancyRes));
    mockUseLicense.mockReturnValue(license([]));
  });

  it('reports every panel as loading while its query is still pending', () => {
    mockUseKpis.mockReturnValue(pending);
    mockUseOccupancy.mockReturnValue(pending);
    mockUseLicense.mockReturnValue(license(null));

    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    expect(result.current.kpis.status).toBe('loading');
    expect(result.current.throughput.status).toBe('loading');
    expect(result.current.zone.status).toBe('loading');
    expect(result.current.exceptions.status).toBe('loading');
  });

  it('reports a failed query as an error, not as empty data', () => {
    mockUseKpis.mockReturnValue(failed);
    mockUseOccupancy.mockReturnValue(failed);
    mockUseLicense.mockReturnValue(license(null, true));

    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    expect(result.current.kpis.status).toBe('error');
    expect(result.current.throughput.status).toBe('error');
    expect(result.current.zone.status).toBe('error');
    expect(result.current.exceptions.status).toBe('error');
  });

  it('adapts loaded KPIs and occupancy, keeping undefined measures undefined', () => {
    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    expect(result.current.kpis).toMatchObject({ status: 'ready' });
    const cells = result.current.kpis.status === 'ready' ? result.current.kpis.data : [];
    expect(cells.map((c) => c.value)).toEqual(['99.0%', null, null, '50.0%']);
    expect(result.current.throughput).toMatchObject({ status: 'ready', data: { avgText: 'AVG 12' } });
    expect(result.current.zone).toMatchObject({ status: 'ready', data: { sub: 'FACILITY 100% FULL' } });
  });

  it('locks the exceptions panel once the licence resolves without monitors, and never queries alerts', () => {
    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    expect(result.current.exceptions.status).toBe('locked');
    expect(mockGetAlerts).not.toHaveBeenCalled();
    const cells = result.current.kpis.status === 'ready' ? result.current.kpis.data : [];
    expect(cells).toHaveLength(4);
  });

  it('loads firing alerts when entitled and appends the open-exceptions cell from the real count', async () => {
    mockUseLicense.mockReturnValue(license(['monitors']));
    mockGetAlerts.mockResolvedValue([alert]);

    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    expect(result.current.exceptions.status).toBe('loading');
    await waitFor(() => expect(result.current.exceptions.status).toBe('ready'));
    expect(mockGetAlerts).toHaveBeenCalledWith('FIRING');
    expect(result.current.exceptions).toMatchObject({ data: [{ type: 'EXPIRY RISK', severity: 'danger' }] });
    const cells = result.current.kpis.status === 'ready' ? result.current.kpis.data : [];
    expect(cells).toHaveLength(5);
    expect(cells[4]).toMatchObject({ label: 'Open exceptions', value: '1' });
  });

  it('reports a failed alerts fetch as an error and leaves the open-exceptions cell out', async () => {
    mockUseLicense.mockReturnValue(license(['monitors']));
    mockGetAlerts.mockRejectedValue(new Error('503'));

    const { result } = renderHook(() => useOpsData('7D'), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.exceptions.status).toBe('error'));
    const cells = result.current.kpis.status === 'ready' ? result.current.kpis.data : [];
    expect(cells).toHaveLength(4);
  });
});
