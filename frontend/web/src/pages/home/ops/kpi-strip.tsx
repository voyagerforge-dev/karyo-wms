import { cn } from '@/lib/utils';
import { KPI_UNDEFINED_VALUE } from '@/features/insights/kpi-notes';
import type { DeltaTone, KpiCell } from '@/pages/home/ops/ops-adapters';
import type { PanelState } from '@/pages/home/ops/panel-state';

const STROKE: Record<DeltaTone, string> = {
  up: 'var(--acc-color)',
  warning: 'var(--warning-foreground)',
  danger: 'var(--destructive)',
};

const DELTA_CLASS: Record<DeltaTone, string> = {
  up: 'text-primary',
  warning: 'text-warning-foreground',
  danger: 'text-destructive',
};

/** A change that rounds to zero is neither good nor bad, whatever side of zero the raw values fell. */
const LEVEL_DELTA_CLASS = 'text-muted-foreground';

interface KpiStripProps {
  state: PanelState<KpiCell[]>;
}

function StripNotice({ tone, testId, children }: { tone: 'muted' | 'danger'; testId: string; children: string }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'mb-[var(--secmb,20px)] flex items-center justify-center rounded-2xl border border-border bg-card p-6 text-[12px]',
        tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

/**
 * The KPI strip: a single rounded bar divided into equal cells by right
 * borders. Each cell: micro-label, mono value + inline 58×24 sparkline, then
 * the delta arrow and a context note. An undefined measure shows a
 * placeholder and its note instead of a number; a cell with no delta shows
 * no arrow.
 */
export function KpiStrip({ state }: KpiStripProps) {
  if (state.status === 'loading') {
    return <StripNotice tone="muted" testId="kpi-strip-loading">Loading KPIs…</StripNotice>;
  }
  if (state.status === 'error') {
    return <StripNotice tone="danger" testId="kpi-strip-error">Could not load KPIs.</StripNotice>;
  }

  const kpis = state.data;
  if (kpis.length === 0) {
    return <StripNotice tone="muted" testId="kpi-strip-empty">No KPI data yet.</StripNotice>;
  }

  return (
    <div className="mb-[var(--secmb,20px)] flex flex-col overflow-hidden rounded-2xl border border-border bg-card sm:flex-row">
      {kpis.map((kpi, i) => (
        <div
          key={kpi.label}
          className={cn(
            'flex-1 p-[var(--kpad,16px_18px)]',
            i < kpis.length - 1 && 'border-b border-border sm:border-b-0 sm:border-r',
          )}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
            {kpi.label}
          </div>
          <div className="mt-2.5 flex items-end justify-between">
            <span
              className={cn(
                'numeric text-[25px] font-bold tracking-[-0.02em]',
                kpi.value === null
                  ? 'text-muted-foreground/60'
                  : kpi.valueDanger
                    ? 'text-destructive'
                    : 'text-foreground',
              )}
            >
              {kpi.value ?? KPI_UNDEFINED_VALUE}
            </span>
            <svg
              width="58"
              height="24"
              viewBox="0 0 58 24"
              fill="none"
              preserveAspectRatio="none"
              aria-hidden
            >
              <polyline
                points={kpi.points}
                stroke={STROKE[kpi.tone]}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="mt-[9px] flex items-center gap-2">
            {kpi.delta && (
              <span
                className={cn(
                  'numeric text-[11px] font-bold',
                  kpi.delta.arrow === '=' ? LEVEL_DELTA_CLASS : DELTA_CLASS[kpi.tone],
                )}
              >
                {kpi.delta.arrow} {kpi.delta.text}
              </span>
            )}
            <span className="text-[11px] text-muted-foreground/70">{kpi.context}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
