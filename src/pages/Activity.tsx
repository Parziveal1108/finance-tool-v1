import { useEffect, useMemo, useState } from 'react';
import { Search, Upload } from 'lucide-react';
import type { AppState, Transaction } from '../../shared/types';
import { CATEGORIES, categoryLabel } from '../../shared/categories';
import { useTransactions } from '../lib/api';
import { monthYear, relativeDay, usd2 } from '../lib/format';
import { QuickAdd } from '../components/QuickAdd';
import { Button, Card, Empty, Select, cx } from '../components/ui';

export function Activity({ state, initialCategory, onImport, onOpen }: { state: AppState; initialCategory?: string; onImport: () => void; onOpen: (t: Transaction) => void }) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [category, setCategory] = useState(initialCategory ?? '');
  const [account, setAccount] = useState('');
  const [month, setMonth] = useState(initialCategory ? state.month.key : '');
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setLimit(100), [debounced, category, account, month]);

  const { data, isFetching } = useTransactions({ text: debounced, category, account, month, limit });
  const months = useMemo(() => {
    const out: string[] = [];
    const [y, m] = state.month.key.split('-').map(Number);
    for (let i = 0; i < 12; i++) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
    return out;
  }, [state.month.key]);

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const t of data?.transactions ?? []) (map.get(t.date) ?? map.set(t.date, []).get(t.date)!).push(t);
    return [...map.entries()];
  }, [data]);
  const accountName = (id: string | null) => state.accounts.find((a) => a.id === id)?.name ?? '';
  const filtered = !!(debounced || category || account || month);

  return (
    <div className="space-y-4">
      <QuickAdd />

      {/* One filter row scoping the whole list below. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" className="sm:w-40">
          <option value="">All dates</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthYear(m)}
            </option>
          ))}
        </Select>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="sm:w-44">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account" className="sm:w-48">
          <option value="">All accounts</option>
          {state.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <div className="relative sm:min-w-[180px] sm:flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search" aria-label="Search transactions" className="h-10 w-full rounded-xl border border-edge bg-raised pl-9 pr-3 text-sm outline-none placeholder:text-muted focus:border-accent" />
        </div>
        <Button onClick={onImport} className="col-span-2 sm:col-span-1">
          <Upload size={15} /> Import CSV
        </Button>
      </div>

      <Card className={cx('transition-opacity', isFetching && data && 'opacity-70')}>
        {groups.length ? (
          <>
            <p className="px-5 pt-4 text-[13px] text-muted">
              {data!.total.toLocaleString()} transaction{data!.total === 1 ? '' : 's'}
              {filtered ? ' match' : ''}
            </p>
            <div className="px-5 pb-3">
              {groups.map(([date, list]) => (
                <section key={date}>
                  <h3 className="sticky top-14 z-[1] -mx-5 bg-surface/95 px-5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted backdrop-blur lg:top-0">{relativeDay(date, state.today)}</h3>
                  <ul className="divide-y divide-line">
                    {list.map((t) => (
                      <li key={t.id}>
                        <button onClick={() => onOpen(t)} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 py-2.5 text-left">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{t.merchant || t.name}</span>
                            <span className="block truncate text-xs text-muted">
                              {categoryLabel(t.category)}
                              {accountName(t.account_id) && ` · ${accountName(t.account_id)}`}
                              {t.pending && ' · pending'}
                            </span>
                          </span>
                          <span className={cx('tabular text-sm font-semibold', t.amount > 0 && 'text-good-ink')}>
                            {t.amount > 0 ? '+' : ''}
                            {usd2(t.amount)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {data!.total > data!.transactions.length && (
                <div className="pt-3 text-center">
                  <Button variant="ghost" onClick={() => setLimit((l) => l + 200)}>
                    Show more
                  </Button>
                </div>
              )}
            </div>
          </>
        ) : (
          <Empty
            title={filtered ? 'Nothing matches those filters' : 'No transactions yet'}
            body={filtered ? 'Try a different month, category or search.' : 'Type one into the box above, import a statement, or link an account and they arrive on their own.'}
            action={!filtered ? <Button onClick={onImport}>Import a statement</Button> : undefined}
          />
        )}
      </Card>
    </div>
  );
}
