import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Account, AppState, PayoffStrategy } from '../../shared/types';
import { addMonths, simulatePayoff, type PayoffDebt } from '../../shared/payoff';
import { api, useRefresh } from '../lib/api';
import { monthYear, monthsToWords, usd, usd2, usdCompact, useCountUp } from '../lib/format';
import { ChartFrame, LineChart, Meter } from '../components/charts';
import { InsightList } from '../components/Insights';
import { Amount, Button, Card, CardHeader, Empty, Segmented, cx } from '../components/ui';

export function Debt({ state, go, addDebt, editAccount }: { state: AppState; go: (page: string) => void; addDebt: () => void; editAccount: (a: Account) => void }) {
  const refresh = useRefresh();
  const saved = state.settings;
  const [strategy, setStrategy] = useState<PayoffStrategy>(saved.strategy);
  const [extra, setExtra] = useState(saved.extra_payment);
  const [lump, setLump] = useState('');
  const [saving, setSaving] = useState(false);

  // Follow changes made elsewhere (a suggestion applied, the assistant, another device).
  useEffect(() => {
    setStrategy(saved.strategy);
    setExtra(saved.extra_payment);
  }, [saved.strategy, saved.extra_payment]);

  const debts: PayoffDebt[] = useMemo(() => state.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), [state.debts]);
  const lumpSum = Math.max(0, Number(lump) || 0);
  const plan = useMemo(() => simulatePayoff(debts, strategy, extra, lumpSum), [debts, strategy, extra, lumpSum]);
  const baseline = useMemo(() => simulatePayoff(debts, strategy, 0), [debts, strategy]);
  const other = useMemo(() => simulatePayoff(debts, strategy === 'avalanche' ? 'snowball' : 'avalanche', extra, lumpSum), [debts, strategy, extra, lumpSum]);

  const total = useCountUp(state.totals.debt);
  const months = useCountUp(plan.months ?? 0, 350);
  const interest = useCountUp(plan.totalInterest, 350);
  const dirty = strategy !== saved.strategy || extra !== saved.extra_payment;
  const minimums = debts.reduce((s, d) => s + d.minPayment, 0);
  const maxExtra = Math.max(1000, Math.ceil((saved.extra_payment * 2) / 500) * 500, Math.ceil(minimums / 500) * 500);

  if (!debts.length) {
    return (
      <Card>
        <Empty
          title={state.accounts.length ? 'No debt on file' : 'Add what you owe'}
          body="Add each card and loan with its balance, rate and minimum payment. Keel works out the order to pay them in, your debt-free date, and what each extra dollar saves."
          action={
            <Button variant="primary" onClick={addDebt}>
              <Plus size={15} /> Add a debt
            </Button>
          }
        />
      </Card>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/settings', { strategy, extra_payment: extra });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const horizon = Math.max(plan.timeline.length, Math.min(baseline.timeline.length, plan.timeline.length * 2 + 12));
  const clip = (t: number[]) => t.slice(0, horizon);
  const labels = Array.from({ length: horizon }, (_, i) => monthYear(addMonths(state.today, i)));
  const tickAt = [0, Math.floor((horizon - 1) / 3), Math.floor(((horizon - 1) * 2) / 3), horizon - 1].filter((v, i, a) => a.indexOf(v) === i);
  const monthsSaved = baseline.months != null && plan.months != null ? baseline.months - plan.months : null;
  const interestSaved = baseline.totalInterest - plan.totalInterest;
  const altDiff = other.totalInterest - plan.totalInterest;
  const estimated = state.debts.filter((d) => d.min_estimated);
  const order = plan.order.map((id) => state.debts.find((d) => d.id === id)!);
  const target = order.find((d) => (plan.payoffMonth[d.id] ?? 1) > 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-5 lg:col-span-5">
          <p className="text-[13px] font-medium text-ink-2">Debt-free</p>
          <p className="mt-1 text-[44px] font-semibold leading-none tracking-tight sm:text-5xl">{plan.months != null ? monthYear(addMonths(state.today, Math.round(months))) : 'Not yet'}</p>
          <p className="mt-2 text-sm text-ink-2">{plan.months != null ? `${monthsToWords(Math.round(months))} from now on this plan` : 'At these payments the balance never reaches zero. Raise the extra payment below.'}</p>
          <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
            <div>
              <dt className="text-xs text-muted">You owe</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold">{usd(total)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Interest still to pay</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold">{usd(interest)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Monthly payment</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold">{usd(minimums + extra)}</dd>
            </div>
          </dl>
          {(extra > 0 || lumpSum > 0) && monthsSaved != null && (
            <p className="mt-4 rounded-xl bg-sunken px-3 py-2 text-[13px] text-ink-2">
              Compared with minimums only, this plan finishes <strong className="font-semibold text-ink">{monthsToWords(Math.max(0, monthsSaved))} sooner</strong> and saves <strong className="font-semibold text-ink">{usd(interestSaved)}</strong> in interest.
            </p>
          )}
        </Card>

        <Card className="lg:col-span-7">
          <ChartFrame
            title="Balance over time"
            hint="Drag the slider and the projection moves with it"
            legend={[
              { label: 'Your plan', color: 'var(--s1)' },
              { label: 'Minimums only', color: 'var(--context)' },
            ]}
            table={{
              head: ['Month', 'Your plan', 'Minimums only'],
              rows: Array.from({ length: horizon }, (_, i) => i).filter((i) => i % 3 === 0 || i === horizon - 1).map((i) => [labels[i], i < plan.timeline.length ? usd(plan.timeline[i]) : usd(0), i < baseline.timeline.length ? usd(baseline.timeline[i]) : usd(0)]),
            }}
          >
            <LineChart
              ariaLabel="Projected total debt balance, your plan against minimum payments only"
              height={220}
              zeroBased
              series={[
                { name: 'Minimums only', color: 'var(--context)', values: clip(baseline.timeline), context: true },
                { name: 'Your plan', color: 'var(--s1)', values: clip(plan.timeline), area: true },
              ]}
              labels={labels}
              tickLabels={tickAt.map((i) => [i, i === 0 ? 'Now' : labels[i]])}
              format={usdCompact}
            />
          </ChartFrame>
        </Card>
      </div>

      <Card className="p-5">
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="flex items-baseline justify-between">
              <label htmlFor="extra" className="text-[15px] font-semibold">
                Extra each month
              </label>
              <span className="tabular text-2xl font-semibold">{usd(extra)}</span>
            </div>
            <input
              id="extra"
              type="range"
              min={0}
              max={maxExtra}
              step={25}
              value={Math.min(extra, maxExtra)}
              onChange={(e) => setExtra(Number(e.target.value))}
              style={{ ['--fill' as string]: `${(Math.min(extra, maxExtra) / maxExtra) * 100}%` }}
              aria-valuetext={`${usd(extra)} extra per month`}
              className="mt-2"
            />
            <p className="flex justify-between text-xs text-muted">
              <span>Minimums only ({usd(minimums)})</span>
              <span>{usd(maxExtra)}</span>
            </p>
            <p className="mt-3 text-[13px] text-ink-2">
              {target ? (
                <>
                  Paid on top of every minimum and aimed at <strong className="font-semibold text-ink">{target.name}</strong> first. When a debt clears, its payment rolls onto the next one.
                </>
              ) : null}
              {state.monthlyIncomeAvg > 0 && ` In a typical month you keep about ${usd(state.monthlyIncomeAvg - state.monthlySpendAvg)} after spending.`}
            </p>
          </div>
          <div className="space-y-4 lg:col-span-5">
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink-2">Order</p>
              <Segmented
                label="Payoff order"
                value={strategy}
                onChange={setStrategy}
                options={[
                  { value: 'avalanche', label: 'Highest rate first' },
                  { value: 'snowball', label: 'Smallest balance first' },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted">
                {Math.abs(altDiff) < 1
                  ? 'For your debts both orders work out the same.'
                  : strategy === 'avalanche'
                    ? `Costs ${usd(altDiff)} less interest than smallest-balance-first.`
                    : `Clears your first debt sooner; costs ${usd(-altDiff)} more interest than highest-rate-first.`}
              </p>
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink-2">What if I paid a lump sum now?</p>
              <Amount value={lump} onChange={setLump} placeholder="e.g. a tax refund" aria-label="One-off lump sum" />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : dirty ? 'Save as my plan' : 'Plan saved'}
              </Button>
              {dirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setStrategy(saved.strategy);
                    setExtra(saved.extra_payment);
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      <InsightList insights={state.insights} area={['debt']} limit={3} title="Debt suggestions" />

      <Card className="flex flex-wrap items-center gap-2 p-4">
        <p className="mr-auto text-sm text-ink-2">More ways to bring this down</p>
        <Button size="sm" onClick={() => go('plan?tool=refinance')}>
          Check a balance transfer or loan
        </Button>
        <Button size="sm" onClick={() => go('plan?tool=compare')}>
          Debt or invest?
        </Button>
        <Button size="sm" onClick={() => go('plan?tool=windfall')}>
          Plan a lump sum
        </Button>
      </Card>

      <Card>
        <CardHeader
          title="Payoff order"
          hint={estimated.length ? `${estimated.length === 1 ? `${estimated[0].name} is` : `${estimated.length} debts are`} using an estimated rate or minimum. Add the real figures for an exact date.` : 'In the order your plan pays them off'}
          action={
            <Button size="sm" onClick={addDebt}>
              <Plus size={14} /> Add
            </Button>
          }
        />
        <ol className="divide-y divide-line px-5 pb-2 pt-1">
          {order.map((d, i) => {
            const when = plan.payoffMonth[d.id];
            const account = state.accounts.find((a) => a.id === d.id)!;
            const underwater = plan.underwater.includes(d.id);
            return (
              <li key={d.id}>
                <button onClick={() => editAccount(account)} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 py-3 text-left">
                  <span className={cx('flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold', i === 0 ? 'bg-accent text-on-accent' : 'bg-sunken text-ink-2')}>{i + 1}</span>
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold">{d.name}</span>
                      {i === 0 && <span className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-accent-ink">Paying first</span>}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {d.kind} · {d.apr}% APR · {usd2(d.min_payment)}/mo minimum{d.min_estimated ? ' (estimated)' : ''}
                      {underwater ? ' · minimum does not cover interest' : ''}
                    </span>
                    {d.credit_limit ? (
                      <span className="mt-2 block max-w-xs">
                        <Meter label={`${d.name} credit used`} value={d.balance} max={d.credit_limit} tone={d.balance / d.credit_limit >= 0.7 ? 'warning' : 'accent'} height={6} />
                        <span className="mt-1 block text-xs text-muted">
                          {Math.round((d.balance / d.credit_limit) * 100)}% of {usd(d.credit_limit)} limit
                        </span>
                      </span>
                    ) : null}
                  </span>
                  <span className="text-right">
                    <span className="tabular block text-sm font-semibold">{usd2(d.balance)}</span>
                    <span className="block text-xs text-muted">{when ? `Paid off ${monthYear(addMonths(state.today, when))}` : 'No end date yet'}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
