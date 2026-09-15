import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PanelNoticeProps {
  title: string;
  /** `danger` for a failed load; `muted` (default) for loading and honest-empty states. */
  tone?: 'muted' | 'danger';
  testId?: string;
  children: ReactNode;
}

/**
 * A dashboard card reduced to its title and one line of status: the shape every tile takes
 * while its data is loading, when the load failed, or when there is honestly nothing to show.
 */
export function PanelNotice({ title, tone = 'muted', testId, children }: PanelNoticeProps) {
  return (
    <section data-testid={testId} className="rounded-2xl border border-border bg-card p-[var(--cpad,22px)]">
      <h2 className="m-0 text-[15px] font-semibold text-foreground">{title}</h2>
      <p className={cn('mt-4 text-[12px]', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}>
        {children}
      </p>
    </section>
  );
}
