import { cn } from '@/lib/utils';
import type { ThroughputView } from '@/pages/home/ops/ops-adapters';
import { PanelNotice } from '@/pages/home/ops/panel-notice';
import type { PanelState } from '@/pages/home/ops/panel-state';

interface ThroughputCardProps {
  state: PanelState<ThroughputView>;
}

/**
 * Throughput card: header + mono PEAK/AVG sub, over a 158px daily bar chart.
 * Peak bar paints solid lime, others lime-dim; a zero day paints a hairline
 * baseline rather than a small bar.
 *
 * There is no hourly backing series, only the daily `chart.outbound` window
 * from `GET /insights/kpis`; the range selector living in `OperationsControl`
 * maps to that real `?range=` window.
 */
export function ThroughputCard({ state }: ThroughputCardProps) {
  if (state.status === 'loading') {
    return <PanelNotice title="Throughput" testId="throughput-loading">Loading…</PanelNotice>;
  }
  if (state.status === 'error') {
    return (
      <PanelNotice title="Throughput" tone="danger" testId="throughput-error">
        Could not load throughput.
      </PanelNotice>
    );
  }

  const view = state.data;
  if (view.bars.length === 0) {
    return <PanelNotice title="Throughput" testId="throughput-empty">No activity in this range.</PanelNotice>;
  }

  // Column spacing follows the bar count: a week gets the wide, rounded bars of the
  // prototype; a month packs them; anything denser has no gap at all, so the columns
  // alone share the width and a full year of days still fits inside the card.
  const gap = view.bars.length <= 7 ? 'gap-2.5' : view.bars.length <= 31 ? 'gap-1' : 'gap-0';

  return (
    <section className="rounded-2xl border border-border bg-card p-[var(--cpad,22px)]">
      <div className="mb-6">
        <h2 className="m-0 text-[15px] font-semibold text-foreground">Throughput</h2>
        <p className="numeric m-0 mt-1 text-[11px] tracking-[0.04em] text-muted-foreground/80">
          {view.peakText} · {view.avgText}
        </p>
      </div>

      <div className={cn('relative flex h-[158px] items-end', gap)}>
        {view.bars.map((b, i) => (
          <div
            key={`${b.label}-${i}`}
            // basis-0 + min-w-0: every day shares the width equally, so ninety columns still
            // fit inside the card instead of sizing to their labels and spilling out of it.
            className="flex h-full min-w-0 flex-1 basis-0 flex-col items-center justify-end gap-2"
          >
            <div
              className={cn(
                'w-full max-w-[32px] rounded-[5px_5px_2px_2px]',
                view.bars.length > 7 && 'rounded-[2px_2px_1px_1px]',
                b.pct === 0 && 'h-[2px] rounded-none bg-border',
              )}
              style={
                b.pct === 0
                  ? undefined
                  : { height: `${b.pct}%`, background: b.isPeak ? 'var(--acc-color)' : 'var(--acc-dim)' }
              }
            />
            {/* A fixed-height slot with the label taken out of flow: every column keeps the same
                baseline whether or not it carries a tick, and no label can widen its column. */}
            <div className="relative h-[15px] w-full shrink-0">
              <span
                className={cn(
                  'numeric absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[10px] leading-[15px]',
                  b.isPeak ? 'text-primary' : 'text-muted-foreground/70',
                )}
              >
                {b.label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
