import { useMemo, useState } from 'react';
import { CornerDownLeft, Plus } from 'lucide-react';
import { parseQuickEntry } from '../../shared/quickadd';
import { categoryLabel } from '../../shared/categories';
import { api, useRefresh } from '../lib/api';
import { dayLabel, usd2 } from '../lib/format';
import { cx } from './ui';

/**
 * One-line entry: type "coffee 4.50" or "rent 1450 yesterday" and press Enter.
 * The preview underneath shows how it was understood before anything is saved.
 */
export function QuickAdd({ autoFocus, onAdded, className }: { autoFocus?: boolean; onAdded?: () => void; className?: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = useRefresh();
  const preview = useMemo(() => (text.trim() ? parseQuickEntry(text) : null), [text]);

  const submit = async () => {
    if (!text.trim() || busy) return;
    if (!preview) {
      setNote({ ok: false, text: 'Add an amount, for example "coffee 4.50".' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/quick-add', { text });
      setNote({ ok: true, text: `Added ${preview.name} · ${usd2(preview.amount)}` });
      setText('');
      refresh();
      onAdded?.();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not add' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex h-11 items-center gap-2 rounded-xl border border-edge bg-raised pl-3 pr-1.5 focus-within:border-accent"
      >
        <Plus size={16} className="shrink-0 text-muted" aria-hidden />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNote(null);
          }}
          autoFocus={autoFocus}
          aria-label="Quick add a transaction"
          placeholder="Quick add: coffee 4.50 · rent 1450 yesterday · +2400 paycheck"
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          enterKeyHint="done"
        />
        <button type="submit" disabled={busy || !text.trim()} aria-label="Add transaction" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition enabled:hover:bg-sunken enabled:hover:text-ink disabled:opacity-40">
          <CornerDownLeft size={15} />
        </button>
      </form>
      <p aria-live="polite" className={cx('mt-1 min-h-[18px] px-1 text-xs', note ? (note.ok ? 'text-good-ink' : 'text-critical') : 'text-muted')}>
        {note
          ? note.text
          : preview
            ? `${preview.amount > 0 ? 'Money in' : 'Spending'} · ${preview.name} · ${usd2(Math.abs(preview.amount))} · ${categoryLabel(preview.category)} · ${dayLabel(preview.date)}`
            : ''}
      </p>
    </div>
  );
}
