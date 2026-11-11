import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Lightbulb, Sparkles, X } from 'lucide-react';
import type { Insight } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { Button, Card, cx } from './ui';

const TONE = {
  critical: { Icon: CircleAlert, color: 'var(--critical)', word: 'Urgent' },
  warn: { Icon: AlertTriangle, color: 'var(--serious)', word: 'Heads up' },
  info: { Icon: Lightbulb, color: 'var(--accent)', word: 'Idea' },
  good: { Icon: CheckCircle2, color: 'var(--good)', word: 'Win' },
} as const;

export function InsightCard({ insight, compact }: { insight: Insight; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRefresh();
  const tone = TONE[insight.severity];
  const act = async (verb: 'apply' | 'dismiss') => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/insights/${insight.id}/${verb}`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update');
      setBusy(false);
    }
  };
  return (
    <article className={cx('rise group relative flex gap-3 rounded-2xl border border-edge bg-raised p-4', busy && 'opacity-60')}>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklab, ${tone.color} 16%, transparent)`, color: tone.color }}>
        <tone.Icon size={16} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="font-medium text-ink-2">{tone.word}</span>
          {insight.source === 'assistant' && (
            <span className="inline-flex items-center gap-1">
              <Sparkles size={11} aria-hidden /> from your assistant
            </span>
          )}
        </p>
        <h3 className="mt-0.5 pr-6 text-[15px] font-semibold leading-snug">{insight.title}</h3>
        {!compact && <p className="mt-1 text-sm leading-relaxed text-ink-2">{insight.body}</p>}
        {error && <p className="mt-2 text-[13px] text-critical">{error}</p>}
        {insight.action && (
          <div className="mt-3">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act('apply')}>
              {insight.action.label}
            </Button>
          </div>
        )}
      </div>
      <button aria-label="Dismiss" title="Dismiss" disabled={busy} onClick={() => act('dismiss')} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-sunken hover:text-ink">
        <X size={15} />
      </button>
    </article>
  );
}

/** Suggestions for one area of the app, or all of them; collapses past `limit`. */
export function InsightList({ insights, area, limit = 4, title = 'Suggestions', emptyNote }: { insights: Insight[]; area?: Insight['area'][]; limit?: number; title?: string; emptyNote?: string }) {
  const [all, setAll] = useState(false);
  const list = area ? insights.filter((i) => area.includes(i.area)) : insights;
  if (!list.length) {
    if (!emptyNote) return null;
    return (
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-ink-2">{emptyNote}</p>
      </Card>
    );
  }
  const shown = all ? list : list.slice(0, limit);
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className="text-[15px] font-semibold">
          {title} <span className="ml-1 font-normal text-muted">{list.length}</span>
        </h2>
        {list.length > limit && (
          <button onClick={() => setAll((v) => !v)} className="text-[13px] font-medium text-accent-ink hover:underline">
            {all ? 'Show fewer' : `Show all ${list.length}`}
          </button>
        )}
      </div>
      <div className="grid gap-2">
        {shown.map((i) => (
          <InsightCard key={i.id} insight={i} />
        ))}
      </div>
    </section>
  );
}
