import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useOpsData } from '@/pages/home/ops/use-ops-data';
import { useControlPrefsContext } from '@/pages/home/ops/control-prefs-context';
import { useClock } from '@/hooks/use-clock';
import type { Density } from '@/pages/home/ops/use-density';
import { KpiStrip } from '@/pages/home/ops/kpi-strip';
import { ThroughputCard } from '@/pages/home/ops/throughput-card';
import { ZoneHeatmap } from '@/pages/home/ops/zone-heatmap';
import { ExceptionsCard } from '@/pages/home/ops/exceptions-card';
import { SampleDataCard } from '@/features/sample-data/sample-data-card';
import { useDemoEnabled } from '@/features/sample-data/use-demo-enabled';
import { RANGES, type ReportRange } from '@/types/insights';

/**
 * Operations Control: the floor manager's real-time command center (Screen 1).
 *
 * Four tiles, all backed by real endpoints via `useOpsData` (`GET /insights/kpis`,
 * `GET /insights/occupancy`, `GET /alerts`): KPI strip, Throughput, Zone occupancy,
 * Exceptions. Each tile receives a `PanelState` and renders loading, failed and
 * honestly-empty states distinctly, so nothing on this screen is a number that was
 * not measured. The prototype's other tiles (Copilot recs, Active waves, Dock doors,
 * Picker throughput) are gone: those engines don't exist yet.
 *
 * `SampleDataCard` sits above the KPI strip, mounted only when `useDemoEnabled()`
 * resolves true: on a deployment with `KARYO_DEMO` off its Load click would only 500.
 */
const DENSITIES: Array<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'command', label: 'Command' },
];

export function OperationsControl() {
  const [range, setRange] = useState<ReportRange>('7D');
  const ops = useOpsData(range);
  const clock = useClock();
  const { density, set } = useControlPrefsContext();
  const demoEnabled = useDemoEnabled();

  return (
    // data-density lives on <html> (set by ControlPrefsProvider) so the whole
    // surface shares it; the wrapper just tags the screen for tests.
    <div data-testid="dashboard-home">
      {/* Heading row */}
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="font-display m-0 text-[22px] text-foreground">Operations Control</h1>
          <p className="numeric m-0 mt-1 text-[10.5px] tracking-[0.06em] text-muted-foreground/70">
            REAL-TIME FLOOR · {clock || '—'}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {/* Range selector — drives the real ?range= window on the KPI/throughput query. */}
          <div className="numeric flex gap-[3px] rounded-[10px] border border-border bg-background p-[3px]">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  'rounded-[8px] px-3 py-1.5 text-[11.5px] tracking-[0.04em] transition-colors',
                  range === r
                    ? 'bg-primary font-bold text-primary-foreground'
                    : 'font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                {r}
              </button>
            ))}
          </div>
          {/* Density toggle: drives the spacing vars (--cpad/--kpad/--cgap/--secmb) the tiles use. */}
          <div className="numeric flex gap-[3px] rounded-[10px] border border-border bg-background p-[3px]">
            {DENSITIES.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => set('density', d.value)}
                className={cn(
                  'rounded-[8px] px-3 py-1.5 text-[11.5px] tracking-[0.04em] transition-colors',
                  density === d.value
                    ? 'bg-primary font-bold text-primary-foreground'
                    : 'font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {demoEnabled && <SampleDataCard />}

      <KpiStrip state={ops.kpis} />

      <div className="grid grid-cols-1 gap-[var(--cgap,20px)] lg:grid-cols-3">
        <ThroughputCard state={ops.throughput} />
        <ZoneHeatmap state={ops.zone} />
        <ExceptionsCard state={ops.exceptions} />
      </div>
    </div>
  );
}
