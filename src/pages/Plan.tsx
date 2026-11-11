import { useEffect, useMemo, useState } from 'react';
import type { AppState } from '../../shared/types';
import { addMonths, type PayoffDebt } from '../../shared/payoff';
import { allocateWindfall, compareRefinance, dailyInterest, debtVsInvest, forecast, independenceNumber, monthReached, weightedApr, type RefinanceOption, type WindfallStep } from '../../shared/planning';
import { monthYear, monthsToWords, usd, usd2, usdCompact, useCountUp } from '../lib/format';
import { ChartFrame, LineChart, SegmentedBar } from '../components/charts';
import { Amount, Card, Field, Segmented, Slider, cx } from '../components/ui';
import { Rows, Verdict, num, when } from './plan/common';
import { Owning, RentOrBuy, Renting, useScenario } from './plan/Housing';
import { Match, Paychecks } from './plan/Pay';

type Tool = 'windfall' | 'compare' | 'refinance' | 'forecast' | 'match' | 'paychecks' | 'renting' | 'owning' | 'rentbuy';
const TOOLS: { id: Tool; label: string; group: 'Money' | 'Housing'; blurb: string }[] = [
  { id: 'windfall', group: 'Money', label: 'Windfall', blurb: 'Where a bonus, refund or other lump sum does the most good.' },
  { id: 'compare', group: 'Money', label: 'Debt or invest', blurb: 'The same spare money each month, sent to debt first or invested from day one.' },
  { id: 'refinance', group: 'Money', label: 'Refinance', blurb: 'Whether a 0% balance transfer or a consolidation loan would actually save you money.' },
  { id: 'forecast', group: 'Money', label: 'Forecast', blurb: "Where your current plan leads over the next decades, in today's dollars." },
  { id: 'match', group: 'Money', label: 'Employer match', blurb: 'Whether you are collecting everything your employer will add to your retirement savings.' },
  { id: 'paychecks', group: 'Money', label: 'Paychecks', blurb: 'Your pay schedule turned into a per-paycheck plan, with the extra checks and upcoming bills called out.' },
  { id: 'renting', group: 'Housing', label: 'Renting', blurb: 'What your rent costs now and as it rises, and what a cheaper or pricier place would do to your plans.' },
  { id: 'owning', group: 'Housing', label: 'Owning', blurb: 'The full monthly cost of a home, the cash it takes to get in, and what your income and debts support.' },
  { id: 'rentbuy', group: 'Housing', label: 'Rent or buy', blurb: 'Both paths with equal spending, including how your mortgage interest would have grown if invested instead.' },
];

const readTool = (): Tool => {
  const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tool');
  return (TOOLS.find((x) => x.id === t)?.id ?? 'windfall') as Tool;
};

// --- Windfall -------------------------------------------------------------------------------

const STEP_COLOR: Record<WindfallStep['target'], string> = { cushion: 'var(--s3)', debt: 'var(--s1)', emergency: 'var(--s4)', invest: 'var(--s2)' };
const STEP_NAME: Record<WindfallStep['target'], string> = { cushion: 'Cushion', debt: 'Debt', emergency: 'Emergency fund', invest: 'Invest' };

function Windfall({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const [amount, setAmount] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('amount') || '1000');
  const value = num(amount);
  const plan = useMemo(
    () => allocateWindfall({ amount: value, cash: state.totals.cash, essentials: state.monthlyEssentials || 1000, emergencyMonths: state.settings.emergency_months, debts, strategy: state.settings.strategy, extra: state.settings.extra_payment }),
    [value, state, debts],
  );
  const saved = useCountUp(plan.interestSaved, 350);
  const sooner = plan.monthsBefore != null && plan.monthsAfter != null ? plan.monthsBefore - plan.monthsAfter : 0;
  const totals = (['cushion', 'debt', 'emergency', 'invest'] as const).map((t) => ({ label: STEP_NAME[t], color: STEP_COLOR[t], value: plan.steps.filter((s) => s.target === t).reduce((s, x) => s + x.amount, 0), darkText: t === 'emergency' }));

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="p-5 lg:col-span-4 lg:self-start">
        <Field label="How much came in?">
          <Amount value={amount} onChange={setAmount} placeholder="0" aria-label="Windfall amount" className="h-12 text-lg" />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          {[500, 1000, 2500, 5000, 10000].map((v) => (
            <button key={v} onClick={() => setAmount(String(v))} aria-pressed={value === v} className={cx('h-8 rounded-lg border px-3 text-[13px] font-medium transition', value === v ? 'border-accent text-accent-ink' : 'border-edge text-ink-2 hover:bg-sunken')}>
              {usd(v)}
            </button>
          ))}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
          The order: a month of essentials in cash, then any debt at 8% APR or more (highest rate first), then your full {state.settings.emergency_months}-month emergency fund, then investing.
        </p>
      </Card>
      <Card className="p-5 lg:col-span-8 lg:self-start">
        {value > 0 && plan.steps.length ? (
          <>
            <Verdict label={plan.toDebt > 0 ? 'Interest this saves you' : 'Split'} value={plan.toDebt > 0 ? usd(saved) : usd(value)}>
              {plan.toDebt > 0 ? (
                <>
                  {usd(plan.toDebt)} of it goes to debt{sooner > 0 ? <>, moving your debt-free date <strong className="font-semibold text-ink">{monthsToWords(sooner)} sooner</strong> to {when(state, plan.monthsAfter)}</> : null}.
                </>
              ) : (
                'None of it needs to go to expensive debt.'
              )}
            </Verdict>
            <div className="mt-5">
              <SegmentedBar ariaLabel="How the amount is split" segments={totals} format={usd} />
            </div>
            <ol className="mt-3 divide-y divide-line">
              {plan.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-3">
                  <span aria-hidden className="mt-1.5 h-2.5 w-2.5 rounded-[3px]" style={{ background: STEP_COLOR[s.target] }} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      {s.target === 'debt' ? `Pay ${s.label}` : s.label}
                    </span>
                    <span className="block text-xs text-muted">{s.note}</span>
                  </span>
                  <span className="tabular text-sm font-semibold">{usd(s.amount)}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-sm text-ink-2">Enter an amount to see where each dollar should go.</p>
        )}
      </Card>
    </div>
  );
}

// --- Debt or invest ---------------------------------------------------------------------------

function Compare({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const [monthly, setMonthly] = useState(200);
  const [ret, setRet] = useState(7);
  const [years, setYears] = useState<'5' | '10' | '20'>('10');
  const n = Number(years);
  const r = useMemo(() => debtVsInvest(debts, state.settings.strategy, state.settings.extra_payment, monthly, ret, n), [debts, state.settings, monthly, ret, n]);
  const months = n * 12;
  const adv = useCountUp(Math.abs(r.advantage), 350);
  const debtWins = r.advantage >= 0;
  const labels = Array.from({ length: months + 1 }, (_, i) => monthYear(addMonths(state.today, i)));
  const ticks: [number, string][] = Array.from({ length: 5 }, (_, k) => Math.round((k / 4) * months)).map((i) => [i, i === 0 ? 'Now' : addMonths(state.today, i).slice(0, 4)]);

  if (!debts.length) {
    return (
      <Card className="p-5">
        <p className="text-[15px] font-semibold">Nothing to compare: you have no debt on file.</p>
        <p className="mt-1 text-sm text-ink-2">With no balances to pay down, spare money goes to your emergency fund and then to investing. The Forecast tab shows where that leads.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-5 p-5 lg:col-span-4 lg:self-start">
        <Slider label="Spare money each month" value={monthly} onChange={setMonthly} min={25} max={2000} step={25} format={usd} hint={state.monthlyIncomeAvg > 0 ? `A typical month leaves you about ${usd(state.monthlyIncomeAvg - state.monthlySpendAvg)}.` : undefined} />
        <Slider label="Expected investment return" value={ret} onChange={setRet} min={0} max={12} step={0.5} format={(v) => `${v}% a year`} hint="Long-run stock returns have averaged roughly 7–10% before inflation, with bad years along the way." />
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-2">Compare over</p>
          <Segmented label="Horizon" value={years} onChange={setYears} options={[{ value: '5', label: '5 years' }, { value: '10', label: '10 years' }, { value: '20', label: '20 years' }]} />
        </div>
        <p className="text-xs leading-relaxed text-muted">Both paths spend exactly the same each month. Whenever debt needs less than its budget, the difference is invested. Taxes are left out.</p>
      </Card>
      <div className="space-y-4 lg:col-span-8">
        <Card className="p-5">
          <Verdict label={debtWins ? 'Paying debt first leaves you ahead by' : 'Investing first leaves you ahead by'} value={usd(adv)}>
            after {n} years.{' '}
            {r.breakEvenReturn == null ? (
              <>No realistic return makes investing first come out ahead of paying off balances at an average of {weightedApr(debts)}%.</>
            ) : r.breakEvenReturn === 0 ? (
              <>Investing first comes out ahead at any positive return, because your debt is cheap.</>
            ) : (
              <>
                Investing first only wins if your investments return more than <strong className="font-semibold text-ink">{r.breakEvenReturn}% a year</strong>. Paying debt is a certain return; the market is not.
              </>
            )}
          </Verdict>
          <div className="mt-5">
            <Rows
              head={['', 'Debt first', 'Invest first']}
              rows={[
                ['Debt-free', when(state, r.debtFirst.debtFreeMonth), when(state, r.investFirst.debtFreeMonth)],
                ['Interest paid on debt', usd(r.debtFirst.interestPaid), usd(r.investFirst.interestPaid)],
                [`New investments after ${n} years`, usd(r.debtFirst.invested[months]), usd(r.investFirst.invested[months])],
                ['Still owed then', usd(r.debtFirst.debt[months]), usd(r.investFirst.debt[months])],
                ['Investments minus debt', usd(r.debtFirst.net[months]), usd(r.investFirst.net[months])],
              ]}
            />
          </div>
          {state.settings.match.rate > 0 && (
            <p className="mt-4 rounded-xl bg-sunken px-3 py-2 text-[13px] text-ink-2">
              One exception either way: your employer's {state.settings.match.rate}% match. Contributions up to the match limit earn {state.settings.match.rate}% the day they go in, which no payoff can beat, so take all of it before sending extra to debt. The Employer match tab checks whether you are.
            </p>
          )}
        </Card>
        <Card>
          <ChartFrame
            title="Investments minus debt"
            hint="Counting only this money and your current debts. The gap between the lines is what the choice is worth."
            legend={[{ label: 'Debt first', color: 'var(--s1)' }, { label: 'Invest first', color: 'var(--s2)' }]}
            table={{ head: ['Year', 'Debt first', 'Invest first'], rows: Array.from({ length: n + 1 }, (_, y) => [y === 0 ? 'Now' : addMonths(state.today, y * 12).slice(0, 4), usd(r.debtFirst.net[y * 12]), usd(r.investFirst.net[y * 12])]) }}
          >
            <LineChart
              ariaLabel="Net position over time for paying debt first against investing first"
              height={220}
              series={[
                { name: 'Debt first', color: 'var(--s1)', values: r.debtFirst.net },
                { name: 'Invest first', color: 'var(--s2)', values: r.investFirst.net },
              ]}
              labels={labels}
              tickLabels={ticks}
              format={usdCompact}
            />
          </ChartFrame>
        </Card>
      </div>
    </div>
  );
}

// --- Refinance ---------------------------------------------------------------------------------

function Refinance({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const cards = state.debts.filter((d) => d.kind === 'Credit card').map((d) => d.id);
  const [picked, setPicked] = useState<string[]>(cards.length ? cards : state.debts.slice(0, 1).map((d) => d.id));
  const [kind, setKind] = useState<'transfer' | 'loan'>('transfer');
  const chosen = debts.filter((d) => picked.includes(d.id));
  const mins = chosen.reduce((s, d) => s + d.minPayment, 0);
  const [payment, setPayment] = useState('');
  const [fee, setFee] = useState('3');
  const [promo, setPromo] = useState('15');
  const [after, setAfter] = useState('');
  const [loanApr, setLoanApr] = useState('12');
  const [term, setTerm] = useState('36');
  const [loanFee, setLoanFee] = useState('0');

  const defaultPayment = Math.round(mins + state.settings.extra_payment);
  const pay = payment === '' ? defaultPayment : num(payment);
  const afterApr = after === '' ? weightedApr(chosen) || 25 : num(after);
  const opt: RefinanceOption = kind === 'transfer' ? { kind, feePct: num(fee), promoMonths: Math.max(1, Math.round(num(promo))), promoApr: 0, afterApr } : { kind, apr: num(loanApr), termMonths: Math.max(1, Math.round(num(term))), feePct: num(loanFee) };
  const r = useMemo(() => compareRefinance(chosen, pay, opt), [chosen.map((d) => d.id).join(), pay, JSON.stringify(opt)]); // eslint-disable-line react-hooks/exhaustive-deps
  const saving = useCountUp(Math.abs(r.savings), 350);

  if (!debts.length) {
    return (
      <Card className="p-5">
        <p className="text-[15px] font-semibold">No debt on file to refinance.</p>
      </Card>
    );
  }
  const optionName = kind === 'transfer' ? 'Balance transfer' : 'Loan';
  const dur = (m: number | null) => (m == null ? 'Never' : monthsToWords(m));

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-5 lg:self-start">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Which balances?</legend>
          <ul className="space-y-1">
            {state.debts.map((d) => (
              <li key={d.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-sunken">
                  <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} className="h-4 w-4 accent-[var(--accent)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{d.name}</span>
                    <span className="block text-xs text-muted">{d.apr}% APR</span>
                  </span>
                  <span className="tabular text-sm">{usd(d.balance)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Field label="What you pay toward these each month" hint={`Minimums come to ${usd2(mins)}.`}>
          <Amount value={payment === '' ? String(defaultPayment) : payment} onChange={setPayment} aria-label="Monthly payment toward these balances" />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-2">Compare with</p>
          <Segmented label="Refinance type" value={kind} onChange={setKind} options={[{ value: 'transfer', label: '0% balance transfer' }, { value: 'loan', label: 'Consolidation loan' }]} />
        </div>
        {kind === 'transfer' ? (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Transfer fee">
              <Amount value={fee} onChange={setFee} prefix="" suffix="%" aria-label="Transfer fee percent" />
            </Field>
            <Field label="0% lasts">
              <Amount value={promo} onChange={setPromo} prefix="" suffix="mo" aria-label="Promotional months" />
            </Field>
            <Field label="Rate after">
              <Amount value={after === '' ? String(afterApr) : after} onChange={setAfter} prefix="" suffix="%" aria-label="Rate after the promotion" />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Loan rate">
              <Amount value={loanApr} onChange={setLoanApr} prefix="" suffix="%" aria-label="Loan rate" />
            </Field>
            <Field label="Term">
              <Amount value={term} onChange={setTerm} prefix="" suffix="mo" aria-label="Loan term in months" />
            </Field>
            <Field label="Upfront fee">
              <Amount value={loanFee} onChange={setLoanFee} prefix="" suffix="%" aria-label="Loan origination fee percent" />
            </Field>
          </div>
        )}
      </Card>
      <Card className="p-5 lg:col-span-7 lg:self-start">
        {chosen.length ? (
          <>
            <Verdict label={r.savings >= 0 ? `${optionName} saves you` : `${optionName} costs you more by`} value={usd(saving)}>
              on {usd(r.balance)} of debt, counting interest and fees.
            </Verdict>
            <div className="mt-5">
              <Rows
                head={['', 'Keep as is', optionName]}
                rows={[
                  ['Monthly payment', usd2(r.current.payment), usd2(r.option.payment)],
                  ['Paid off in', dur(r.current.months), dur(r.option.months)],
                  ['Interest', usd(r.current.cost), usd(r.option.interest)],
                  ['Fees', usd(0), usd(r.option.fee)],
                  ['Total cost of borrowing', usd(r.current.cost), usd(r.option.cost)],
                ]}
              />
            </div>
            <div className="mt-4 space-y-2 text-[13px] leading-relaxed text-ink-2">
              {kind === 'transfer' && r.neededForPromo != null && (
                <p className="rounded-xl bg-sunken px-3 py-2">
                  {r.clearsInPromo ? (
                    <>At {usd2(r.option.payment)} a month the balance is gone before the 0% period ends. </>
                  ) : (
                    <>
                      At {usd2(r.option.payment)} a month some balance is left when the 0% period ends and starts costing {afterApr}%. Paying <strong className="font-semibold text-ink">{usd2(r.neededForPromo)} a month</strong> clears it in time.{' '}
                    </>
                  )}
                </p>
              )}
              {kind === 'loan' && Math.abs(r.option.payment - r.current.payment) >= 1 && (
                <p className="rounded-xl bg-sunken px-3 py-2">
                  The loan's fixed payment is {usd2(Math.abs(r.option.payment - r.current.payment))} a month {r.option.payment > r.current.payment ? 'more' : 'less'} than you pay now{r.option.payment < r.current.payment ? ', which frees cash but can stretch the debt out' : ''}.
                </p>
              )}
              <p>Approval, the rate and the limit depend on your credit. Either option only helps if the cleared cards stay cleared.</p>
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-2">Pick at least one balance to compare.</p>
        )}
      </Card>
    </div>
  );
}

// --- Forecast -----------------------------------------------------------------------------------

function ForecastTool({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const goalMoney = state.goals.filter((g) => g.progress < g.target_amount).reduce((s, g) => s + g.monthly_contribution, 0);
  const guess = Math.max(0, Math.round((state.monthlyIncomeAvg - state.monthlySpendAvg - state.settings.extra_payment - goalMoney) / 25) * 25);
  const [invest, setInvest] = useState(Math.min(3000, guess));
  const [ret, setRet] = useState(5);
  const [years, setYears] = useState<'10' | '20' | '30'>('20');
  const [rollover, setRollover] = useState(true);
  const n = Number(years);
  const months = n * 12;
  const run = (r: number) => forecast({ debts, strategy: state.settings.strategy, extra: state.settings.extra_payment, cash: state.totals.cash, investments: state.totals.investments, otherAssets: state.totals.otherAssets, monthlySave: goalMoney, monthlyInvest: invest, annualReturn: Math.max(0, r), years: n, rollover });
  const [mid, low, high] = useMemo(() => [run(ret), run(ret - 2), run(ret + 2)], [debts, state, invest, ret, n, rollover]); // eslint-disable-line react-hooks/exhaustive-deps
  const end = useCountUp(mid.net[months], 350);
  const fi = independenceNumber(state.monthlySpendAvg);
  const fiMonth = fi > 0 ? monthReached(mid.invested, fi) : null;
  const marks = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000].filter((v) => v > mid.net[0]).slice(0, 2);
  const labels = Array.from({ length: months + 1 }, (_, i) => monthYear(addMonths(state.today, i)));
  const ticks: [number, string][] = Array.from({ length: 5 }, (_, k) => Math.round((k / 4) * months)).map((i) => [i, i === 0 ? 'Now' : addMonths(state.today, i).slice(0, 4)]);

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-5 p-5 lg:col-span-4 lg:self-start">
        <Slider label="Invested each month" value={invest} onChange={setInvest} min={0} max={3000} step={25} format={usd} hint={goalMoney > 0 ? `On top of ${usd(goalMoney)} a month going to your goals.` : 'Started from what a typical month leaves you. Adjust to what you really put in.'} />
        <Slider label="Return after inflation" value={ret} onChange={setRet} min={0} max={10} step={0.5} format={(v) => `${v}% a year`} hint="Using an after-inflation figure keeps every number in today's dollars. 4–6% is a common planning range for a stock-heavy mix." />
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink-2">Look ahead</p>
          <Segmented label="Years" value={years} onChange={setYears} options={[{ value: '10', label: '10 years' }, { value: '20', label: '20 years' }, { value: '30', label: '30 years' }]} />
        </div>
        {debts.length > 0 && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-sunken px-3 py-2.5 text-[13px] text-ink-2">
            <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
            <span>
              When a debt is paid off, keep paying the same amount — into investments. <span className="text-muted">That is {usd(debts.reduce((s, d) => s + d.minPayment, 0) + state.settings.extra_payment)} a month once you are debt-free.</span>
            </span>
          </label>
        )}
      </Card>
      <div className="space-y-4 lg:col-span-8">
        <Card className="p-5">
          <Verdict label={`Net worth in ${n} years`} value={usd(end)}>
            in today's dollars, up from {usd(mid.net[0])}. Two points of return either way puts it between {usd(low.net[months])} and {usd(high.net[months])}.
          </Verdict>
          <ul className="mt-5 divide-y divide-line border-t border-line text-sm">
            {debts.length > 0 && (
              <li className="flex items-baseline justify-between gap-3 py-2.5">
                <span className="text-ink-2">Debt-free</span>
                <span className="font-medium">{when(state, mid.debtFreeMonth)}</span>
              </li>
            )}
            {marks.map((v) => {
              const m = monthReached(mid.net, v);
              return (
                <li key={v} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="text-ink-2">Net worth passes {usd(v)}</span>
                  <span className="font-medium">{m != null ? monthYear(addMonths(state.today, m)) : `Beyond ${n} years`}</span>
                </li>
              );
            })}
            {fi > 0 && (
              <li className="flex items-baseline justify-between gap-3 py-2.5">
                <span className="text-ink-2">
                  Investments could cover your spending <span className="text-muted">({usd(fi)}, 25× a year's spending)</span>
                </span>
                <span className="shrink-0 font-medium">{fiMonth != null ? monthYear(addMonths(state.today, fiMonth)) : `${Math.round((mid.invested[months] / fi) * 100)}% there in ${n} years`}</span>
              </li>
            )}
          </ul>
        </Card>
        <Card>
          <ChartFrame
            title="Net worth"
            hint={`Expected path at ${ret}% a year, with ${Math.max(0, ret - 2)}% and ${ret + 2}% for range`}
            legend={[{ label: 'Expected', color: 'var(--s1)' }, { label: 'Cautious and optimistic', color: 'var(--context)' }]}
            table={{ head: ['Year', 'Cautious', 'Expected', 'Optimistic'], rows: Array.from({ length: n + 1 }, (_, y) => [y === 0 ? 'Now' : addMonths(state.today, y * 12).slice(0, 4), usd(low.net[y * 12]), usd(mid.net[y * 12]), usd(high.net[y * 12])]) }}
          >
            <LineChart
              ariaLabel="Projected net worth under cautious, expected and optimistic returns"
              height={240}
              series={[
                { name: 'Optimistic', color: 'var(--context)', values: high.net, context: true },
                { name: 'Cautious', color: 'var(--context)', values: low.net, context: true },
                { name: 'Expected', color: 'var(--s1)', values: mid.net, area: true },
              ]}
              labels={labels}
              tickLabels={ticks}
              format={usdCompact}
            />
          </ChartFrame>
        </Card>
        <p className="px-1 text-xs leading-relaxed text-muted">A projection, not a promise: it assumes steady contributions and a smooth return, and real markets are neither. Home, vehicle and other assets are held at today's value.</p>
      </div>
    </div>
  );
}

// --- Page ---------------------------------------------------------------------------------------

export function Plan({ state }: { state: AppState }) {
  const [tool, setToolState] = useState<Tool>(readTool);
  useEffect(() => {
    const on = () => setToolState(readTool());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const setTool = (t: Tool) => {
    setToolState(t);
    history.replaceState(null, '', `#/plan?tool=${t}`);
  };
  const debts: PayoffDebt[] = useMemo(() => state.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), [state.debts]);
  const [scn, setScn] = useScenario(state);
  const perDay = dailyInterest(debts);
  const runway = state.monthlyEssentials > 0 ? state.totals.cash / state.monthlyEssentials : null;
  const kept = state.monthlyIncomeAvg > 0 ? (state.monthlyIncomeAvg - state.monthlySpendAvg) / state.monthlyIncomeAvg : null;
  const active = TOOLS.find((t) => t.id === tool)!;

  const Stat = ({ label, value, note }: { label: string; value: string; note: string }) => (
    <Card className="p-4">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-xs text-muted">{note}</p>
    </Card>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="order-last grid grid-cols-2 gap-3 lg:order-none lg:grid-cols-4">
        <Stat label="Debt costs you" value={debts.length ? `${usd2(perDay)} a day` : '$0 a day'} note={debts.length ? `${usd(perDay * 365)} a year in interest at today's balances` : 'No balances on file'} />
        <Stat label="Average rate on debt" value={debts.length ? `${weightedApr(debts)}%` : '—'} note={debts.length ? 'Weighted by balance; the bar investing has to clear' : 'Nothing owed'} />
        <Stat label="Cash runway" value={runway != null ? `${runway.toFixed(1)} months` : '—'} note={runway != null ? `of essentials (${usd(state.monthlyEssentials)} a month) if income stopped` : 'Needs a month of spending history'} />
        <Stat label="You keep" value={kept != null ? `${Math.round(kept * 100)}%` : '—'} note={kept != null ? `of income in a typical month, about ${usd(state.monthlyIncomeAvg - state.monthlySpendAvg)}` : 'Needs income history'} />
      </div>

      <div className="space-y-2">
        {(['Money', 'Housing'] as const).map((group) => (
          <div key={group} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{group}</span>
            <div className="scroll-quiet -mr-4 min-w-0 flex-1 overflow-x-auto pr-4 lg:mr-0 lg:pr-0">
              <div role="tablist" aria-label={`${group} tools`} className="inline-flex rounded-xl border border-edge bg-sunken p-0.5">
                {TOOLS.filter((t) => t.group === group).map((t) => (
                  <button key={t.id} role="tab" aria-selected={tool === t.id} onClick={() => setTool(t.id)} className={cx('h-9 whitespace-nowrap rounded-[10px] px-3 text-sm font-medium transition sm:px-4', tool === t.id ? 'bg-raised text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="px-1 text-sm text-ink-2">{active.blurb}</p>

      {tool === 'windfall' && <Windfall state={state} debts={debts} />}
      {tool === 'compare' && <Compare state={state} debts={debts} />}
      {tool === 'refinance' && <Refinance state={state} debts={debts} />}
      {tool === 'forecast' && <ForecastTool state={state} debts={debts} />}
      {tool === 'match' && <Match state={state} debts={debts} />}
      {tool === 'paychecks' && <Paychecks state={state} debts={debts} />}
      {tool === 'renting' && <Renting state={state} debts={debts} scn={scn} set={setScn} />}
      {tool === 'owning' && <Owning state={state} debts={debts} scn={scn} set={setScn} />}
      {tool === 'rentbuy' && <RentOrBuy state={state} scn={scn} set={setScn} />}
    </div>
  );
}
