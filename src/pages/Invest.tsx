import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import type { Account, AppState, AssetClass, Holding } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { timeAgo, usd, usd2, useCountUp } from '../lib/format';
import { SegmentedBar, type Segment } from '../components/charts';
import { ASSET_LABEL } from '../components/forms';
import { InsightList } from '../components/Insights';
import { Amount, Button, Card, CardHeader, Delta, Empty, ErrorNote, Sheet } from '../components/ui';

/** Fixed colour per asset class — it never changes with ranking or filtering. */
const CLASS: { id: AssetClass; color: string; darkText?: boolean }[] = [
  { id: 'us_stock', color: 'var(--s1)' },
  { id: 'intl_stock', color: 'var(--s2)' },
  { id: 'bond', color: 'var(--s3)' },
  { id: 'cash', color: 'var(--s4)', darkText: true },
  { id: 'crypto', color: 'var(--s5)' },
  { id: 'other', color: 'var(--s6)' },
];

function TargetEditor({ current, mix, onClose }: { current: AppState['settings']['target_allocation']; mix: Record<AssetClass, number>; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(CLASS.map((c) => [c.id, String(Math.round(current?.[c.id] ?? (current ? 0 : mix[c.id])))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRefresh();
  const total = CLASS.reduce((s, c) => s + (Number(values[c.id]) || 0), 0);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.patch('/settings', { target_allocation: Object.fromEntries(CLASS.map((c) => [c.id, Number(values[c.id]) || 0]).filter(([, v]) => (v as number) > 0)) });
      refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
      setBusy(false);
    }
  };
  return (
    <Sheet title="Target mix" onClose={onClose}>
      <p className="mb-3 text-sm text-ink-2">The mix you want to hold over the long run. Keel compares it with what you actually hold and tells you when the gap is worth acting on.</p>
      <div className="space-y-2">
        {CLASS.map((c) => (
          <div key={c.id} className="grid grid-cols-[1fr_96px] items-center gap-3">
            <span className="flex items-center gap-2 text-sm">
              <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />
              {ASSET_LABEL[c.id]}
              <span className="text-xs text-muted">now {Math.round(mix[c.id])}%</span>
            </span>
            <Amount value={values[c.id]} onChange={(v) => setValues({ ...values, [c.id]: v })} prefix="" suffix="%" aria-label={`${ASSET_LABEL[c.id]} target percent`} />
          </div>
        ))}
      </div>
      <p className={`mt-3 text-[13px] ${Math.round(total) === 100 ? 'text-muted' : 'text-critical'}`}>Total {Math.round(total)}%{Math.round(total) === 100 ? '' : ' — needs to add up to 100%'}</p>
      <ErrorNote>{error}</ErrorNote>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" disabled={busy || Math.round(total) !== 100} onClick={save}>
          Save target
        </Button>
      </div>
    </Sheet>
  );
}

export function Invest({ state, addAccount, addHolding, editHolding }: { state: AppState; addAccount: () => void; addHolding: () => void; editHolding: (h: Holding) => void }) {
  const refresh = useRefresh();
  const [editTarget, setEditTarget] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [quoteNote, setQuoteNote] = useState('');
  const accounts = state.accounts.filter((a) => a.type === 'investment');
  const total = useCountUp(state.totals.investments);

  if (!accounts.length) {
    return (
      <Card>
        <Empty
          title="Add your investments"
          body="Link a brokerage or retirement account, or add one by hand with just a total. Add individual holdings whenever you want the allocation breakdown."
          action={
            <Button variant="primary" onClick={addAccount}>
              <Plus size={15} /> Add an investment account
            </Button>
          }
        />
      </Card>
    );
  }

  // Accounts entered as a single total (no holdings) are shown but cannot be classified.
  const held = new Set(state.holdings.map((h) => h.account_id));
  const unclassified = accounts.filter((a) => !held.has(a.id)).reduce((s, a) => s + a.balance, 0);
  const value = (h: Holding) => h.quantity * h.price;
  const classified = state.holdings.reduce((s, h) => s + value(h), 0);
  const mix = Object.fromEntries(CLASS.map((c) => [c.id, classified ? (state.holdings.filter((h) => h.asset_class === c.id).reduce((s, h) => s + value(h), 0) / classified) * 100 : 0])) as Record<AssetClass, number>;
  const target = state.settings.target_allocation;
  const segs = (source: Partial<Record<AssetClass, number>>): Segment[] => CLASS.map((c) => ({ label: ASSET_LABEL[c.id], value: source[c.id] ?? 0, color: c.color, darkText: c.darkText }));
  const cost = state.holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const withCost = state.holdings.filter((h) => h.cost_basis != null).reduce((s, h) => s + value(h), 0);
  const lastPrice = state.holdings.map((h) => h.price_updated_at).filter(Boolean).sort().pop() ?? null;

  const refreshQuotes = async () => {
    setQuoting(true);
    setQuoteNote('');
    try {
      const { updated } = await api.post<{ updated: number }>('/quotes/refresh');
      setQuoteNote(updated ? `${updated} price${updated === 1 ? '' : 's'} updated` : 'Prices are current, or the quote service could not be reached');
      refresh();
    } catch (e) {
      setQuoteNote(e instanceof Error ? e.message : 'Could not refresh prices');
    } finally {
      setQuoting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-5 lg:col-span-5">
          <p className="text-[13px] font-medium text-ink-2">Invested</p>
          <p className="mt-1 text-[44px] font-semibold leading-none tracking-tight sm:text-5xl">{usd(total)}</p>
          <div className="mt-2">{cost > 0 ? <Delta value={withCost - cost} format={usd} suffix={`on ${usd(cost)} paid in`} /> : <span className="text-[13px] text-muted">Add what you paid for a holding to see gains</span>}</div>
          <div className="mt-5 flex items-center gap-2 border-t border-line pt-4">
            <Button size="sm" onClick={refreshQuotes} disabled={quoting}>
              <RefreshCw size={14} className={quoting ? 'animate-spin' : ''} /> Refresh prices
            </Button>
            <span className="text-xs text-muted">{quoteNote || `Prices as of ${timeAgo(lastPrice)}`}</span>
          </div>
          <ul className="mt-4 space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-ink-2">{a.name}</span>
                <span className="tabular font-medium">{usd(a.balance)}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="lg:col-span-7">
          <CardHeader
            title="Allocation"
            hint={target ? 'What you hold against the mix you are aiming for' : 'How your holdings split by asset class'}
            action={
              <Button size="sm" onClick={() => setEditTarget(true)}>
                {target ? 'Edit target' : 'Set a target'}
              </Button>
            }
          />
          {classified > 0 ? (
            <div className="px-5 pb-5 pt-4">
              <p className="mb-1.5 text-xs font-medium text-ink-2">Now</p>
              <SegmentedBar tall ariaLabel="Current allocation" segments={segs(mix)} format={(n) => usd((n / 100) * classified)} />
              {target && (
                <>
                  <p className="mb-1.5 mt-4 text-xs font-medium text-ink-2">Target</p>
                  <SegmentedBar ariaLabel="Target allocation" segments={segs(target)} format={(n) => `${n}%`} />
                </>
              )}
              <table className="tabular mt-4 w-full text-[13px]">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="pb-1 font-medium">Asset class</th>
                    <th className="pb-1 text-right font-medium">Value</th>
                    <th className="pb-1 text-right font-medium">Now</th>
                    {target && <th className="pb-1 text-right font-medium">Target</th>}
                    {target && <th className="pb-1 text-right font-medium">Gap</th>}
                  </tr>
                </thead>
                <tbody>
                  {CLASS.filter((c) => mix[c.id] > 0.05 || (target?.[c.id] ?? 0) > 0).map((c) => {
                    const gap = mix[c.id] - (target?.[c.id] ?? 0);
                    return (
                      <tr key={c.id} className="border-t border-line">
                        <td className="py-1.5">
                          <span className="flex items-center gap-2">
                            <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />
                            {ASSET_LABEL[c.id]}
                          </span>
                        </td>
                        <td className="py-1.5 text-right">{usd((mix[c.id] / 100) * classified)}</td>
                        <td className="py-1.5 text-right">{Math.round(mix[c.id])}%</td>
                        {target && <td className="py-1.5 text-right text-ink-2">{Math.round(target[c.id] ?? 0)}%</td>}
                        {target && (
                          <td className="py-1.5 text-right text-ink-2">
                            {Math.abs(gap) < 0.5 ? 'on target' : `${Math.abs(Math.round(gap))} pts ${gap > 0 ? 'over' : 'under'}`}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {unclassified > 0 && <p className="mt-3 text-xs text-muted">{usd(unclassified)} sits in accounts without individual holdings and is left out of this breakdown.</p>}
            </div>
          ) : (
            <p className="px-5 pb-5 pt-3 text-sm text-ink-2">Add the holdings inside your accounts to see how your money splits across stocks, bonds and cash.</p>
          )}
        </Card>
      </div>

      <InsightList insights={state.insights} area={['invest']} limit={3} title="Portfolio suggestions" />

      <Card>
        <CardHeader
          title="Holdings"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={addAccount}>
                Add account
              </Button>
              <Button size="sm" onClick={addHolding}>
                <Plus size={14} /> Holding
              </Button>
            </div>
          }
        />
        <div className="px-5 pb-3 pt-1">
          {accounts.map((a: Account) => {
            const list = state.holdings.filter((h) => h.account_id === a.id);
            return (
              <section key={a.id} className="border-t border-line pt-3 first:border-0">
                <h3 className="flex items-baseline justify-between text-sm">
                  <span className="font-semibold">
                    {a.name} <span className="ml-1 font-normal text-muted">{a.institution}</span>
                  </span>
                  <span className="tabular font-semibold">{usd(a.balance)}</span>
                </h3>
                {list.length ? (
                  <ul className="mt-1 divide-y divide-line">
                    {list.map((h) => {
                      const v = value(h);
                      const gain = h.cost_basis != null ? v - h.cost_basis : null;
                      return (
                        <li key={h.id}>
                          <button onClick={() => editHolding(h)} disabled={!h.manual} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 py-2 text-left disabled:cursor-default">
                            <span className="min-w-0">
                              <span className="block truncate text-sm">
                                {h.symbol && <span className="mr-2 font-semibold">{h.symbol}</span>}
                                <span className={h.symbol ? 'text-ink-2' : 'font-medium'}>{h.name}</span>
                              </span>
                              <span className="tabular block text-xs text-muted">
                                {h.quantity.toLocaleString('en-US', { maximumFractionDigits: 4 })} × {usd2(h.price)} · {ASSET_LABEL[h.asset_class]} · {classified ? Math.round((v / classified) * 100) : 0}% of holdings
                              </span>
                            </span>
                            <span className="tabular text-right">
                              <span className="block text-sm font-semibold">{usd(v)}</span>
                              {gain != null && (
                                <span className="block text-xs text-muted">
                                  {gain >= 0 ? '▲' : '▼'} {usd(Math.abs(gain))} {gain >= 0 ? 'gain' : 'loss'}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="py-2 text-xs text-muted">Tracked as a single total. Add holdings to include it in the allocation.</p>
                )}
              </section>
            );
          })}
        </div>
      </Card>

      {editTarget && <TargetEditor current={target} mix={mix} onClose={() => setEditTarget(false)} />}
    </div>
  );
}
