import { useMemo, useState } from 'react';
import type { AppState, HousingScenario } from '../../../shared/types';
import { simulatePayoff, type PayoffDebt } from '../../../shared/payoff';
import { defaultScenario, maxPrice, ownerMonthly, rentPath, rentVsBuy, upfront } from '../../../shared/housing';
import { futureValue } from '../../../shared/paycheck';
import { api, useRefresh } from '../../lib/api';
import { monthsToWords, usd, usdCompact, useCountUp } from '../../lib/format';
import { ChartFrame, ColumnChart, LineChart, SegmentedBar } from '../../components/charts';
import { Button, Card, Segmented, Slider } from '../../components/ui';
import { Facts, Note, Num, Rows, Verdict, useSaved, when } from './common';

type Set = (patch: Partial<HousingScenario>) => void;
const pctOf = (n: number) => `${Math.round(n * 100)}%`;

/** The housing scenario is shared by all three tabs and saved so the assistant sees it too. */
export function useScenario(state: AppState) {
  const rentGuess = state.budgets.find((b) => b.category === 'housing')?.average || 1500;
  return useSaved('housing', state.settings.housing, defaultScenario(rentGuess, state.settings.match.salary));
}

const grossOf = (state: AppState, scn: HousingScenario) => scn.gross_income ?? state.settings.match.salary ?? null;

// --- Renting ------------------------------------------------------------------------------------

export function Renting({ state, debts, scn, set }: { state: AppState; debts: PayoffDebt[]; scn: HousingScenario; set: Set }) {
  const [delta, setDelta] = useState(-100);
  const years = scn.years;
  const path = useMemo(() => rentPath(scn.rent, scn.rent_insurance_mo, scn.rent_growth, scn.inflation, years), [scn.rent, scn.rent_insurance_mo, scn.rent_growth, scn.inflation, years]);
  const takeHome = state.monthlyIncomeAvg;
  const gross = grossOf(state, scn);
  const share = takeHome > 0 ? scn.rent / takeHome : null;
  const total = useCountUp(path[path.length - 1]?.total ?? 0, 350);
  const last = path[path.length - 1];

  const extra = state.settings.extra_payment;
  const before = useMemo(() => simulatePayoff(debts, state.settings.strategy, extra), [debts, state.settings.strategy, extra]);
  const after = useMemo(() => simulatePayoff(debts, state.settings.strategy, Math.max(0, extra - delta)), [debts, state.settings.strategy, extra, delta]);
  const monthsDiff = before.months != null && after.months != null ? before.months - after.months : null;
  const cheaper = delta < 0;

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-4 lg:self-start">
        <Num label="Rent each month" value={scn.rent} onChange={(v) => set({ rent: v ?? 0 })} hint={state.budgets.find((b) => b.category === 'housing')?.average ? `You have been paying about ${usd(state.budgets.find((b) => b.category === 'housing')!.average)} a month for housing.` : undefined} />
        <div className="grid grid-cols-2 gap-3">
          <Num label="Renter's insurance" value={scn.rent_insurance_mo} onChange={(v) => set({ rent_insurance_mo: v ?? 0 })} suffix="/mo" />
          <Num label="Gross income" value={gross} onChange={(v) => set({ gross_income: v })} suffix="/yr" placeholder="Optional" />
        </div>
        <Slider label="Rent goes up" value={scn.rent_growth} onChange={(v) => set({ rent_growth: v })} min={0} max={10} step={0.5} format={(v) => `${v}% a year`} />
        <Slider label="Looking ahead" value={years} onChange={(v) => set({ years: v })} min={1} max={30} step={1} format={(v) => `${v} year${v === 1 ? '' : 's'}`} />
      </Card>
      <div className="space-y-4 lg:col-span-8">
        <Card className="p-5">
          <Verdict label={`Rent over the next ${years} year${years === 1 ? '' : 's'}`} value={usd(total)}>
            {share != null ? (
              <>
                Today it takes <strong className="font-semibold text-ink">{pctOf(share)} of your take-home pay</strong> ({usd(scn.rent)} of {usd(takeHome)} a month). {share > 0.4 ? 'That is high: above roughly a third, debt payoff and saving get squeezed.' : share > 0.33 ? 'That is around the usual ceiling of a third.' : 'That is under the usual ceiling of about a third.'}
              </>
            ) : (
              <>Once a month of income is recorded this also shows the share of your pay it takes.</>
            )}
          </Verdict>
          <div className="mt-5">
            <Facts
              rows={[
                ['Rent today', `${usd(scn.rent)} a month`],
                [`Rent in year ${years}`, `${usd(last?.monthly ?? scn.rent)} a month`],
                [`Paid in year ${years}`, usd(last?.annual ?? 0)],
                ...(gross ? ([['Share of gross income', `${pctOf((scn.rent * 12) / gross)} · 30% would be ${usd((gross * 0.3) / 12)} a month`]] as [string, string][]) : []),
              ]}
            />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">What a different rent would do</h2>
          <div className="mt-3">
            <Slider label={cheaper ? 'A cheaper place by' : delta > 0 ? 'A pricier place by' : 'Same rent'} value={delta} onChange={setDelta} min={-600} max={600} step={25} format={(v) => `${usd(Math.abs(v))} a month`} />
          </div>
          {delta !== 0 && (
            <div className="mt-3">
              <Facts
                rows={[
                  ...(debts.length
                    ? ([
                        [cheaper ? 'Sent to debt instead' : 'Taken from your debt payments', monthsDiff != null ? `Debt-free ${monthsToWords(Math.abs(monthsDiff))} ${monthsDiff >= 0 ? 'sooner' : 'later'} (${when(state, after.months)})` : when(state, after.months)],
                        ['Interest on your debts', `${usd(Math.abs(before.totalInterest - after.totalInterest))} ${before.totalInterest >= after.totalInterest ? 'less' : 'more'}`],
                      ] as [string, string][])
                    : []),
                  [`${cheaper ? 'Invested instead' : 'Not invested'} for ${years} years at ${scn.invest_return}%`, usd(futureValue(Math.abs(delta), scn.invest_return, years))],
                  [`Rent ${cheaper ? 'saved' : 'added'} over ${years} years`, usd(Math.abs(delta) * 12 * years)],
                ]}
              />
              {!cheaper && extra < delta && debts.length > 0 && <p className="mt-2 text-xs text-muted">Your extra debt payment is {usd(extra)} a month, so only that much can come out of it; the rest would have to come from elsewhere in your budget.</p>}
            </div>
          )}
        </Card>

        <Card>
          <ChartFrame title="Monthly rent by year" hint={`Rising ${scn.rent_growth}% a year`} table={{ head: ['Year', 'Monthly rent', 'Paid that year', 'Running total'], rows: path.map((y) => [y.year, usd(y.monthly), usd(y.annual), usd(y.total)]) }}>
            <LineChart ariaLabel="Monthly rent by year" height={190} series={[{ name: 'Monthly rent', color: 'var(--s1)', values: path.map((y) => y.monthly), area: true }]} labels={path.map((y) => `Year ${y.year}`)} tickLabels={path.length > 1 ? [[0, 'Year 1'], [path.length - 1, `Year ${path.length}`]] : [[0, 'Year 1']]} format={usdCompact} zeroBased />
          </ChartFrame>
        </Card>
      </div>
    </div>
  );
}

// --- Owning -------------------------------------------------------------------------------------

function BuyInputs({ scn, set, gross }: { scn: HousingScenario; set: Set; gross: number | null }) {
  return (
    <>
      <Num label="Home price" value={scn.price} onChange={(v) => set({ price: Math.max(1000, v ?? 0) })} />
      <div className="grid grid-cols-2 gap-3">
        <Num label="Down payment" value={scn.down_pct} onChange={(v) => set({ down_pct: Math.min(100, v ?? 0) })} prefix="" suffix="%" hint={usd((scn.price * scn.down_pct) / 100)} />
        <Num label="Mortgage rate" value={scn.rate} onChange={(v) => set({ rate: v ?? 0 })} prefix="" suffix="%" hint="Use a rate you were quoted" />
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-ink-2">Loan term</p>
        <Segmented label="Loan term" value={String(scn.term_years) as '30' | '20' | '15'} onChange={(v) => set({ term_years: Number(v) })} options={[{ value: '30', label: '30 years' }, { value: '20', label: '20 years' }, { value: '15', label: '15 years' }]} />
      </div>
      <details className="rounded-xl border border-edge px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium text-ink-2">Taxes, insurance, upkeep and fees</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Num label="Property tax" value={scn.tax_pct} onChange={(v) => set({ tax_pct: v ?? 0 })} prefix="" suffix="%/yr" />
          <Num label="Home insurance" value={scn.insurance_yr} onChange={(v) => set({ insurance_yr: v ?? 0 })} suffix="/yr" />
          <Num label="HOA or condo fee" value={scn.hoa_mo} onChange={(v) => set({ hoa_mo: v ?? 0 })} suffix="/mo" />
          <Num label="Maintenance" value={scn.maint_pct} onChange={(v) => set({ maint_pct: v ?? 0 })} prefix="" suffix="%/yr" />
          <Num label="PMI (under 20% down)" value={scn.pmi_pct} onChange={(v) => set({ pmi_pct: v ?? 0 })} prefix="" suffix="%/yr" />
          <Num label="Closing costs" value={scn.closing_pct} onChange={(v) => set({ closing_pct: v ?? 0 })} prefix="" suffix="%" />
        </div>
        <p className="mt-2 text-xs text-muted">Starting points only. Tax and insurance vary a lot by area; a listing or a lender estimate gives real figures.</p>
      </details>
      <Num label="Gross household income" value={gross} onChange={(v) => set({ gross_income: v })} suffix="/yr" placeholder="For lender ratios" />
    </>
  );
}

const PARTS: { key: 'pi' | 'tax' | 'insurance' | 'maintenance' | 'hoa' | 'pmi'; label: string; color: string; darkText?: boolean }[] = [
  { key: 'pi', label: 'Mortgage (principal and interest)', color: 'var(--s1)' },
  { key: 'tax', label: 'Property tax', color: 'var(--s2)' },
  { key: 'insurance', label: 'Home insurance', color: 'var(--s3)' },
  { key: 'maintenance', label: 'Maintenance', color: 'var(--s4)', darkText: true },
  { key: 'hoa', label: 'HOA', color: 'var(--s5)' },
  { key: 'pmi', label: 'PMI', color: 'var(--s6)' },
];

export function Owning({ state, debts, scn, set }: { state: AppState; debts: PayoffDebt[]; scn: HousingScenario; set: Set }) {
  const refresh = useRefresh();
  const [saving, setSaving] = useState(false);
  const cost = useMemo(() => ownerMonthly(scn), [scn]);
  const cash = upfront(scn);
  const full = useMemo(() => rentVsBuy(scn, scn.term_years), [scn]);
  const monthly = useCountUp(cost.total, 350);
  const gross = grossOf(state, scn);
  const grossMo = gross ? gross / 12 : null;
  const debtMins = debts.reduce((s, d) => s + d.minPayment, 0);
  const takeHome = state.monthlyIncomeAvg;
  const emergency = state.monthlyEssentials * state.settings.emergency_months;
  const leftAfter = state.totals.cash - cash.total;
  const hasGoal = state.goals.some((g) => /down ?payment|house|home/i.test(g.name));
  const withDebts = grossMo ? maxPrice(scn, Math.min(grossMo * 0.28, grossMo * 0.36 - debtMins)) : null;
  const withoutDebts = grossMo ? maxPrice(scn, grossMo * 0.28) : null;

  const bucket = scn.term_years > 20 ? 5 : scn.term_years > 10 ? 3 : 2;
  const groups: string[] = [];
  const interest: number[] = [];
  const principal: number[] = [];
  for (let y = 0; y < scn.term_years; y += bucket) {
    const end = Math.min(scn.term_years, y + bucket);
    groups.push(`Yr ${y + 1}–${end}`);
    interest.push(full.interestPaid[end] - full.interestPaid[y]);
    principal.push(full.paidIn[end] - full.paidIn[y]);
  }

  const createGoal = async () => {
    setSaving(true);
    try {
      await api.post('/goals', { name: 'Down payment', kind: 'purchase', target_amount: Math.round(cash.total), current_amount: 0, monthly_contribution: 0 });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-4 lg:self-start">
        <BuyInputs scn={scn} set={set} gross={gross} />
      </Card>
      <div className="space-y-4 lg:col-span-8">
        <Card className="p-5">
          <Verdict label="Owning this home costs" value={`${usd(monthly)} a month`}>
            in the first year, on a {usd(cash.loan)} loan.{takeHome > 0 && <> That is <strong className="font-semibold text-ink">{pctOf(cost.total / takeHome)} of your take-home pay</strong>{scn.rent > 0 ? <>, against {usd(scn.rent)} in rent now</> : null}.</>}
          </Verdict>
          <div className="mt-5">
            <SegmentedBar tall ariaLabel="Monthly cost of owning" segments={PARTS.map((p) => ({ label: p.label, value: cost[p.key], color: p.color, darkText: p.darkText }))} format={usd} />
          </div>
          <ul className="tabular mt-3 divide-y divide-line text-sm">
            {PARTS.filter((p) => cost[p.key] > 0).map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: p.color }} />
                  {p.label}
                </span>
                <span className="font-medium">{usd(cost[p.key])}</span>
              </li>
            ))}
          </ul>
          {cost.pmi > 0 && full.pmiEndsMonth != null && <p className="mt-2 text-xs text-muted">PMI drops off after about {monthsToWords(full.pmiEndsMonth)}, once the loan is down to 80% of the price.</p>}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold">Cash to get in</h2>
            <p className="mt-1 text-3xl font-semibold tracking-tight">{usd(cash.total)}</p>
            <div className="mt-3">
              <Facts
                rows={[
                  [`Down payment (${scn.down_pct}%)`, usd(cash.down)],
                  [`Closing costs (${scn.closing_pct}%)`, usd(cash.closing)],
                  ['Cash you have now', usd(state.totals.cash)],
                  [leftAfter >= 0 ? 'Left after buying' : 'Still to save', usd(Math.abs(leftAfter))],
                ]}
              />
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              {leftAfter < 0
                ? `You would also want your ${state.settings.emergency_months}-month emergency fund (${usd(emergency)}) intact on top, so the real target is about ${usd(cash.total + emergency)}.`
                : leftAfter < emergency
                  ? `That would leave less than your ${state.settings.emergency_months}-month emergency fund (${usd(emergency)}). A home brings repair bills, so keep that cushion separate.`
                  : `That still leaves your ${state.settings.emergency_months}-month emergency fund (${usd(emergency)}) intact.`}
            </p>
            {!hasGoal && (
              <Button size="sm" className="mt-3" onClick={createGoal} disabled={saving}>
                Track this as a savings goal
              </Button>
            )}
          </Card>
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold">What a lender would see</h2>
            {grossMo ? (
              <>
                <div className="mt-3">
                  <Facts
                    rows={[
                      ['Housing cost ÷ gross income', `${pctOf(cost.total / grossMo)} · guideline 28%`],
                      ['With your debt payments', `${pctOf((cost.total + debtMins) / grossMo)} · guideline 36%`],
                      ['Price those guidelines support', withDebts ? usd(withDebts) : 'None at these debts'],
                    ]}
                  />
                </div>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
                  {debtMins > 0 && withoutDebts != null && withDebts != null && withoutDebts > withDebts ? (
                    <>
                      Your {usd(debtMins)} a month of debt payments is what holds this down. With them cleared, the same guidelines support about <strong className="font-semibold text-ink">{usd(withoutDebts)}</strong> — one more reason the payoff plan comes first.
                    </>
                  ) : (
                    'Guidelines vary by lender and loan type; this is the common 28/36 rule, not an approval.'
                  )}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-ink-2">Add your gross household income on the left to see the ratios lenders use and the price they support, with and without your current debts.</p>
            )}
          </Card>
        </div>

        <Card>
          <ChartFrame
            title="Where the mortgage payments go"
            hint={`${usd(full.interestPaid[scn.term_years])} of interest over ${scn.term_years} years on a ${usd(cash.loan)} loan. Early payments are mostly interest.`}
            legend={[{ label: 'Interest', color: 'var(--s2)', kind: 'bar' }, { label: 'Principal', color: 'var(--s1)', kind: 'bar' }]}
            table={{ head: ['Years', 'Interest', 'Principal'], rows: groups.map((g, i) => [g, usd(interest[i]), usd(principal[i])]) }}
          >
            <ColumnChart ariaLabel="Interest and principal paid by period" height={200} groups={groups} series={[{ name: 'Interest', color: 'var(--s2)', values: interest }, { name: 'Principal', color: 'var(--s1)', values: principal }]} format={usdCompact} />
          </ChartFrame>
        </Card>
      </div>
    </div>
  );
}

// --- Rent or buy --------------------------------------------------------------------------------

export function RentOrBuy({ state, scn, set }: { state: AppState; scn: HousingScenario; set: Set }) {
  const n = scn.years;
  const p = useMemo(() => rentVsBuy(scn), [scn]);
  const edge = p.ownerNet[n] - p.renterNet[n];
  const shown = useCountUp(Math.abs(edge), 350);
  const cash = upfront(scn);
  const yearLabels = p.years.map((y) => (y === 0 ? 'Now' : `Year ${y}`));
  const ticks: [number, string][] = [...new Set([0, Math.round(n / 2), n])].map((i) => [i, i === 0 ? 'Now' : `Yr ${i}`]);
  const interestWins = p.interestInvested[n] > p.equity[n];

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-4 lg:self-start">
        <div className="grid grid-cols-2 gap-3">
          <Num label="Home price" value={scn.price} onChange={(v) => set({ price: Math.max(1000, v ?? 0) })} />
          <Num label="Rent instead" value={scn.rent} onChange={(v) => set({ rent: v ?? 0 })} suffix="/mo" />
          <Num label="Down payment" value={scn.down_pct} onChange={(v) => set({ down_pct: Math.min(100, v ?? 0) })} prefix="" suffix="%" />
          <Num label="Mortgage rate" value={scn.rate} onChange={(v) => set({ rate: v ?? 0 })} prefix="" suffix="%" />
        </div>
        <Slider label="How long you would stay" value={n} onChange={(v) => set({ years: v })} min={1} max={30} step={1} format={(v) => `${v} year${v === 1 ? '' : 's'}`} />
        <Slider label="Home value rises" value={scn.appreciation} onChange={(v) => set({ appreciation: v })} min={-2} max={8} step={0.5} format={(v) => `${v}% a year`} />
        <Slider label="Investments return" value={scn.invest_return} onChange={(v) => set({ invest_return: v })} min={0} max={12} step={0.5} format={(v) => `${v}% a year`} />
        <Slider label="Rent rises" value={scn.rent_growth} onChange={(v) => set({ rent_growth: v })} min={0} max={10} step={0.5} format={(v) => `${v}% a year`} />
        <Slider label="Cost to sell" value={scn.sell_pct} onChange={(v) => set({ sell_pct: v })} min={0} max={10} step={0.5} format={(v) => `${v}% of the price`} />
        <p className="text-xs leading-relaxed text-muted">Taxes, insurance, upkeep and loan term come from the Owning tab. Income tax effects are not included.</p>
      </Card>

      <div className="space-y-4 lg:col-span-8">
        <Card className="p-5">
          <Verdict label={edge >= 0 ? `Buying leaves you ahead after ${n} years by` : `Renting and investing leaves you ahead after ${n} years by`} value={usd(shown)}>
            {p.breakEvenYear != null ? (
              <>
                Buying pulls ahead in <strong className="font-semibold text-ink">year {p.breakEvenYear}</strong>; sell before then and renting would have been cheaper.
              </>
            ) : (
              <>Renting stays ahead for the whole {n} years on these assumptions.</>
            )}{' '}
            Both paths spend the same each month: whoever has the cheaper month invests the difference, and the renter invests the {usd(cash.total)} the buyer puts down.
          </Verdict>
          <div className="mt-5">
            <Rows
              head={['', 'Buy', 'Rent and invest']}
              rows={[
                ['Cash at the start', `${usd(cash.total)} into the home`, `${usd(cash.total)} invested`],
                ['Monthly cost now', usd(p.ownerMonthly[0]), usd(p.renterMonthly[0])],
                [`Monthly cost in year ${n}`, usd(p.ownerMonthly[n]), usd(p.renterMonthly[n])],
                [`Paid out over ${n} years`, usd(p.ownerSpent[n]), usd(p.renterSpent[n])],
                ['What you end with', usd(p.ownerNet[n]), usd(p.renterNet[n])],
              ]}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            The buyer ends with the home sold at {usd(p.homeValue[n])}, less {scn.sell_pct}% to sell and the {usd(p.loanBalance[n])} still owed, plus anything invested along the way. The renter ends with the portfolio.
          </p>
        </Card>

        <Card>
          <ChartFrame title="Wealth from each path" hint="What you would walk away with if you stopped in that year" legend={[{ label: 'Buy', color: 'var(--s1)' }, { label: 'Rent and invest', color: 'var(--s2)' }]} table={{ head: ['Year', 'Buy', 'Rent and invest'], rows: p.years.map((y) => [y === 0 ? 'Now' : y, usd(p.ownerNet[y]), usd(p.renterNet[y])]) }}>
            <LineChart ariaLabel="Wealth over time from buying against renting and investing" height={220} series={[{ name: 'Buy', color: 'var(--s1)', values: p.ownerNet }, { name: 'Rent and invest', color: 'var(--s2)', values: p.renterNet }]} labels={yearLabels} tickLabels={ticks} format={usdCompact} />
          </ChartFrame>
        </Card>

        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">Your mortgage interest, if it had been invested</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Over {n} years you would pay <strong className="font-semibold text-ink">{usd(p.interestPaid[n])}</strong> in interest. Put into investments month by month at {scn.invest_return}% instead, those same dollars would have grown to <strong className="font-semibold text-ink">{usd(p.interestInvested[n])}</strong>. Against that, the home would hold <strong className="font-semibold text-ink">{usd(p.equity[n])}</strong> of equity.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Interest side</p>
              <Facts
                rows={[
                  ['Interest paid', usd(p.interestPaid[n])],
                  ['Growth it would have earned', usd(p.interestInvested[n] - p.interestPaid[n])],
                  ['Worth if invested', usd(p.interestInvested[n])],
                ]}
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Equity side</p>
              <Facts
                rows={[
                  ['Down payment and principal paid', usd(p.paidIn[n])],
                  [`Price rise at ${scn.appreciation}% a year`, usd(p.appreciation[n])],
                  ['Home equity', usd(p.equity[n])],
                ]}
              />
            </div>
          </div>
          <div className="mt-4">
            <Note>
              {interestWins ? 'On these numbers the invested interest would outgrow the equity.' : 'On these numbers the equity outgrows what the interest would have become.'} But this isolates one piece: interest is the price of living in the home, the way rent is the price of renting, and you cannot skip both. The comparison above is the one to decide by, because it also counts the rent you would pay, taxes, upkeep, selling costs and the growth of the down payment.
            </Note>
          </div>
        </Card>

        <Card>
          <ChartFrame
            title="Invested interest against home equity"
            hint={`Home worth ${usd(p.homeValue[n])} in year ${n}, with ${usd(p.loanBalance[n])} still owed`}
            legend={[{ label: 'Home equity', color: 'var(--s1)' }, { label: 'Interest, if invested', color: 'var(--s2)' }, { label: 'Equity from price rise alone', color: 'var(--s3)' }]}
            table={{ head: ['Year', 'Interest paid', 'If invested', 'Equity', 'From price rise', 'Home value', 'Loan left'], rows: p.years.map((y) => [y === 0 ? 'Now' : y, usd(p.interestPaid[y]), usd(p.interestInvested[y]), usd(p.equity[y]), usd(p.appreciation[y]), usd(p.homeValue[y]), usd(p.loanBalance[y])]) }}
          >
            <LineChart
              ariaLabel="Mortgage interest if invested, compared with home equity and appreciation"
              height={220}
              zeroBased
              series={[
                { name: 'Home equity', color: 'var(--s1)', values: p.equity },
                { name: 'Interest, if invested', color: 'var(--s2)', values: p.interestInvested },
                { name: 'Equity from price rise alone', color: 'var(--s3)', values: p.appreciation },
              ]}
              labels={yearLabels}
              tickLabels={ticks}
              format={usdCompact}
            />
          </ChartFrame>
        </Card>
        <p className="px-1 text-xs leading-relaxed text-muted">An estimate on steady assumptions. Home prices and markets move unevenly, and the outcome is sensitive to how long you stay. {state.settings.match.rate > 0 ? 'None of this changes the order of your plan: employer match and high-rate debt first.' : ''}</p>
      </div>
    </div>
  );
}
