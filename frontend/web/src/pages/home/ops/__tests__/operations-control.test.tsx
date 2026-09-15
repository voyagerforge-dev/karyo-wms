import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ControlPrefsProvider } from '@/pages/home/ops/control-prefs-provider';
import { SampleDataProvider } from '@/features/sample-data/sample-data-provider';
import type { OpsData } from '@/pages/home/ops/use-ops-data';

const mockOpsData = vi.fn<() => OpsData>();
const mockDemoEnabled = vi.fn<() => boolean>();

vi.mock('@/pages/home/ops/use-ops-data', () => ({
  useOpsData: () => mockOpsData(),
}));

vi.mock('@/features/sample-data/use-demo-enabled', () => ({
  useDemoEnabled: () => mockDemoEnabled(),
}));

const { OperationsControl } = await import('@/pages/home/ops/operations-control');

// OperationsControl renders SampleDataCard, which reads useSampleData() --
// it needs a SampleDataProvider (and the QueryClientProvider that provider
// itself depends on) in the tree, same as the real AppShell wiring.
function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        SampleDataProvider,
        null,
        createElement(ControlPrefsProvider, null, createElement(OperationsControl)),
      ),
    ),
  );
}

const BASE_OPS_DATA: OpsData = {
  kpis: {
    status: 'ready',
    data: [
      {
        label: 'Inventory accuracy',
        value: '99.2%',
        points: '0,14 8,15 16,11 24,13 32,9 40,10 50,7 58,6',
        tone: 'up',
        delta: { arrow: '▲', text: '0.3%' },
        context: 'vs prior period',
      },
      {
        label: 'Throughput',
        value: '142/day',
        points: '0,17 8,14 16,15 24,11 32,12 40,9 50,7 58,8',
        tone: 'up',
        delta: { arrow: '▲', text: '8/day' },
        context: 'vs prior period',
      },
      {
        label: 'Order cycle time',
        value: '6.2h',
        points: '',
        tone: 'up',
        delta: { arrow: '▼', text: '2.0h' },
        context: 'vs prior period',
      },
      {
        label: 'Utilization',
        value: '76.0%',
        points: '',
        tone: 'up',
        delta: null,
        context: 'Live snapshot',
      },
    ],
  },
  throughput: {
    status: 'ready',
    data: {
      bars: [
        { label: 'Mon', pct: 67, isPeak: false },
        { label: 'Tue', pct: 100, isPeak: true },
        { label: 'Wed', pct: 50, isPeak: false },
      ],
      peakText: 'PEAK 15 SEP 180',
      avgText: 'AVG 130',
    },
  },
  zone: {
    status: 'ready',
    data: {
      cells: [
        { color: 'rgb(var(--acc))', title: 'A · A-01 — occupied' },
        { color: '#23201A', title: 'A · A-02 — empty' },
        { color: '#FF6A45', title: 'B · B-01 — locked' },
      ],
      title: 'Zone occupancy',
      sub: 'FACILITY 50% FULL',
      badgeText: '1 LOCKED',
      badgeTone: 'danger',
      legendUnit: 'STATE',
      legend: [
        { color: 'rgb(var(--acc))', label: 'Occupied' },
        { color: '#23201A', label: 'Empty' },
        { color: '#FF6A45', label: 'Locked' },
      ],
    },
  },
  exceptions: {
    status: 'ready',
    data: [{ type: 'EXPIRY RISK', detail: 'lot 42 · 4 lots expiring', age: '2m', severity: 'danger' }],
  },
};

describe('OperationsControl', () => {
  beforeEach(() => {
    // Default: demo mode off, matching the real default (KARYO_DEMO unset).
    // Individual tests below override this to assert the card's presence.
    mockDemoEnabled.mockReturnValue(false);
  });

  it('renders the 4 real KPI labels', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.getByText('Inventory accuracy')).toBeInTheDocument();
    expect(screen.getAllByText('Throughput').length).toBeGreaterThan(0);
    expect(screen.getByText('Order cycle time')).toBeInTheDocument();
    expect(screen.getByText('Utilization')).toBeInTheDocument();
  });

  it('paints a delta arrow only for a KPI that has a delta', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.getByText('▲ 0.3%')).toBeInTheDocument();
    expect(screen.getByText('▼ 2.0h')).toBeInTheDocument();
    expect(screen.getByText('Live snapshot')).toBeInTheDocument();
    // Utilization has no delta: exactly the three real arrows, no bare "▲" for the fourth cell.
    expect(screen.getAllByText(/^[▲▼] /)).toHaveLength(3);
  });

  it('shows a placeholder and its note for an undefined KPI, never a zero', () => {
    mockOpsData.mockReturnValue({
      ...BASE_OPS_DATA,
      kpis: {
        status: 'ready',
        data: [
          { label: 'Inventory accuracy', value: null, points: '', tone: 'up', delta: null, context: 'No counted lines in range' },
        ],
      },
    });
    renderDashboard();
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText('No counted lines in range')).toBeInTheDocument();
    expect(screen.queryByText(/^[▲▼]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.0%/)).not.toBeInTheDocument();
  });

  it('paints a change that rounds to zero neutral, not in the tone of its raw direction', () => {
    mockOpsData.mockReturnValue({
      ...BASE_OPS_DATA,
      kpis: {
        status: 'ready',
        data: [
          { label: 'Inventory accuracy', value: '98.4%', points: '', tone: 'warning', delta: { arrow: '=', text: '0.0%' }, context: 'vs prior period' },
          { label: 'Throughput', value: '100/day', points: '', tone: 'warning', delta: { arrow: '▼', text: '3/day' }, context: 'vs prior period' },
        ],
      },
    });
    renderDashboard();
    const level = screen.getByText('= 0.0%');
    expect(level).toHaveClass('text-muted-foreground');
    expect(level).not.toHaveClass('text-warning-foreground');
    expect(screen.getByText('▼ 3/day')).toHaveClass('text-warning-foreground');
  });

  it('renders throughput bars with no Shift toggle', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Shift' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Day' })).not.toBeInTheDocument();
  });

  it('renders real zone cells + facility pct', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.getByTitle('A · A-01 — occupied')).toBeInTheDocument();
    expect(screen.getByTitle('B · B-01 — locked')).toBeInTheDocument();
    expect(screen.getByText(/FACILITY 50% FULL/)).toBeInTheDocument();
  });

  it('maps a firing alert into an exception row', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.getByText('EXPIRY RISK')).toBeInTheDocument();
    expect(screen.getByText('lot 42 · 4 lots expiring')).toBeInTheDocument();
  });

  it('shows a locked empty-state for exceptions when monitors is not entitled', () => {
    mockOpsData.mockReturnValue({ ...BASE_OPS_DATA, exceptions: { status: 'locked' } });
    renderDashboard();
    expect(screen.getByTestId('exceptions-locked')).toBeInTheDocument();
    expect(screen.queryByText('EXPIRY RISK')).not.toBeInTheDocument();
  });

  it('shows the quiet empty state when monitors is entitled and nothing is firing', () => {
    mockOpsData.mockReturnValue({ ...BASE_OPS_DATA, exceptions: { status: 'ready', data: [] } });
    renderDashboard();
    expect(screen.getByText('No open exceptions.')).toBeInTheDocument();
  });

  it('says every panel is loading while its data is pending, and never claims an empty result', () => {
    mockOpsData.mockReturnValue({
      kpis: { status: 'loading' },
      throughput: { status: 'loading' },
      zone: { status: 'loading' },
      exceptions: { status: 'loading' },
    });
    renderDashboard();
    expect(screen.getByTestId('kpi-strip-loading')).toBeInTheDocument();
    expect(screen.getByTestId('throughput-loading')).toBeInTheDocument();
    expect(screen.getByTestId('zone-loading')).toBeInTheDocument();
    expect(screen.getByTestId('exceptions-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('exceptions-locked')).not.toBeInTheDocument();
    expect(screen.queryByText(/no .* (yet|range)\.?/i)).not.toBeInTheDocument();
    expect(screen.queryByText('No open exceptions.')).not.toBeInTheDocument();
  });

  it('says a panel could not load when its request failed, instead of showing it empty', () => {
    mockOpsData.mockReturnValue({
      kpis: { status: 'error' },
      throughput: { status: 'error' },
      zone: { status: 'error' },
      exceptions: { status: 'error' },
    });
    renderDashboard();
    expect(screen.getByText('Could not load KPIs.')).toBeInTheDocument();
    expect(screen.getByText('Could not load throughput.')).toBeInTheDocument();
    expect(screen.getByText('Could not load occupancy.')).toBeInTheDocument();
    expect(screen.getByText('Could not load exceptions.')).toBeInTheDocument();
    expect(screen.queryByText(/no .* yet\./i)).not.toBeInTheDocument();
  });

  it('names the honest empty state of each card when the data is real and empty', () => {
    mockOpsData.mockReturnValue({
      kpis: { status: 'ready', data: [] },
      throughput: { status: 'ready', data: { bars: [], peakText: 'PEAK –', avgText: 'AVG –' } },
      zone: {
        status: 'ready',
        data: { ...BASE_OPS_DATA.zone.status === 'ready' ? BASE_OPS_DATA.zone.data : ({} as never), cells: [] },
      },
      exceptions: { status: 'ready', data: [] },
    });
    renderDashboard();
    expect(screen.getByText('No KPI data yet.')).toBeInTheDocument();
    expect(screen.getByText('No activity in this range.')).toBeInTheDocument();
    expect(screen.getByText('No storage locations yet.')).toBeInTheDocument();
    expect(screen.getByText('No open exceptions.')).toBeInTheDocument();
  });

  it('never renders the deleted mock tiles', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    renderDashboard();
    expect(screen.queryByText(/active waves/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dock doors/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/picker/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/copilot/i)).not.toBeInTheDocument();
  });

  // SampleDataCard mounts only when the /api/v1/demo/status probe resolves
  // enabled -- previously unconditional, a dead surface on any deployment
  // with KARYO_DEMO off (the default).
  it('hides SampleDataCard when the demo-status probe resolves disabled (or fails)', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    mockDemoEnabled.mockReturnValue(false);
    renderDashboard();
    expect(screen.queryByTestId('sample-data-card')).not.toBeInTheDocument();
  });

  it('shows SampleDataCard when the demo-status probe resolves enabled', () => {
    mockOpsData.mockReturnValue(BASE_OPS_DATA);
    mockDemoEnabled.mockReturnValue(true);
    renderDashboard();
    expect(screen.getByTestId('sample-data-card')).toBeInTheDocument();
  });
});
