import { useMemo, useState } from 'react';
import type { AppState, PayFrequency } from '../../../shared/types';
import { simulatePayoff, type PayoffDebt } from '../../../shared/payoff';
import { PAY_LABEL, addDays, extraPaycheckMonths, futureValue, matchSummary, nextPaydays, paychecksPerYear } from '../../../shared/paycheck';
import { api, useRefresh } from '../../lib/api';
import { dayLabel, monthLabel, monthsToWords, usd, usd2, useCountUp } from '../../lib/format';
import { SegmentedBar } from '../../components/charts';
import { Button, Card, Field, Input, Select } from '../../components/ui';
import { Facts, Note, Num, Rows, Verdict, useSaved, when } from './common';

// --- Employer match -----------------------------------------------------------------------------

export function Match({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const [m, set] = useSaved('match', state.settings.match, state.settings.match);
  const s = matchSummary(m);
  const perYear = state.pay.perYear;
  const hero = useCountUp(s.full ? s.employer : s.unclaimed, 350);
  const topApr = debts.length ? Math.max(...debts.map((d) => d.apr)) : 0;
  const monthlyMatch = s.employerMax / 12;

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-4 lg:self-start">
        <Num label="Gross pay per year" value={m.salary} onChange={(v) => set({ salary: v })} placeholder="Before tax" />
        <Num label="You contribute" value={m.contributing_pct} onChange={(v) => set({ contributing_pct: v })} prefix="" suffix="% of pay" placeholder="On your pay stub" />
        <div className="grid grid-cols-2 gap-3">
          <Num label="Employer matches" value={m.rate} onChange={(v) => set({ rate: v ?? 0 })} prefix="" suffix="%" />
          <Num label="Up to" value={m.limit_pct} onChange={(v) => set({ limit_pct: v })} prefix="" suffix="% of pay" placeholder="e.g. 6" />
        </div>
        <p className="text-xs leading-relaxed text-muted">A "{m.rate}% match up to 6%" means that for each dollar you put in, up to 6% of your pay, your employer adds {m.rate}¢. The limit is in your plan documents or benefits portal.</p>
      </Card>
      <div className="space-y-4 lg:col-span-8">
        {m.rate <= 0 ? (
          <Card className="p-5">
            <p className="text-[15px] font-semibold">No employer match set.</p>
            <p className="mt-1 text-sm text-ink-2">If your employer adds to your retirement contributions, enter the rate on the left.</p>
          </Card>
        ) : !s.configured ? (
          <Card className="p-5">
            <p className="text-[15px] font-semibold">Three numbers finish this: your pay, what you contribute, and the match limit.</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">
              A {m.rate}% match is the best return you have access to: every matched dollar is worth $1.{String(Math.round(m.rate)).padStart(2, '0')} the day it goes in{topApr > 0 ? `, well ahead of the ${topApr}% your most expensive debt costs` : ''}. Once these are filled in, Keel watches that none of it goes unclaimed.
            </p>
          </Card>
        ) : (
          <>
            <Card className="p-5">
              <Verdict label={s.full ? 'Your employer adds' : 'Match you are not collecting'} value={`${usd(hero)} a year`}>
                {s.full ? (
                  <>You contribute {m.contributing_pct}%, at or above the {m.limit_pct}% the match covers, so you are getting all of it.</>
                ) : (
                  <>
                    You contribute {m.contributing_pct}% and the match covers up to {m.limit_pct}%. Raising it costs about <strong className="font-semibold text-ink">{usd(s.costToMax / perYear)} per paycheck</strong> before tax — less in take-home if it is a traditional 401(k) — and brings in {usd(s.unclaimed / perYear)} per paycheck from your employer.
                  </>
                )}
              </Verdict>
              <div className="mt-5">
                <Rows
                  head={['', 'Now', 'At full match']}
                  rows={[
                    ['You put in, per year', usd(s.yours), usd(Math.max(s.yours, (m.salary! * m.limit_pct!) / 100))],
                    ['Employer adds, per year', usd(s.employer), usd(s.employerMax)],
                    ['You put in, per paycheck', usd2(s.yours / perYear), usd2(Math.max(s.yours, (m.salary! * m.limit_pct!) / 100) / perYear)],
                    ['Employer adds, per paycheck', usd2(s.employer / perYear), usd2(s.employerMax / perYear)],
                  ]}
                />
              </div>
              {!s.full && (
                <div className="mt-4">
                  <Note>
                    This comes before extra debt payments. A {m.rate}% return on day one beats paying down {topApr > 0 ? `${topApr}%` : 'any'} debt, and missed match cannot be collected later. You change the percentage with your payroll or retirement plan provider; then update it here.
                  </Note>
                </div>
              )}
            </Card>
            <Card className="p-5">
              <h2 className="text-[15px] font-semibold">What the match alone grows to</h2>
              <p className="mt-1 text-[13px] text-ink-2">The employer's {usd(s.employerMax)} a year, with none of your own money, at 7% a year.</p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {[10, 20, 30].map((y) => (
                  <div key={y} className="rounded-xl bg-sunken px-3 py-3">
                    <p className="text-xs text-muted">{y} years</p>
                    <p className="tabular mt-0.5 text-xl font-semibold">{usd(futureValue(monthlyMatch, 7, y))}</p>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

// --- Paychecks ----------------------------------------------------------------------------------

const COLORS = { spend: 'var(--s1)', debt: 'var(--s2)', goals: 'var(--s3)', free: 'var(--s4)' };

export function Paychecks({ state, debts }: { state: AppState; debts: PayoffDebt[] }) {
  const refresh = useRefresh();
  const [pay, set] = useSaved('pay', state.settings.pay, state.settings.pay);
  const [busy, setBusy] = useState(false);
  const frequency = pay.frequency;
  const perYear = paychecksPerYear(frequency);
  const amount = pay.amount ?? state.pay.amount;
  const anchor = pay.anchor ?? state.pay.anchor;
  const paydays = useMemo(() => (anchor ? nextPaydays(anchor, frequency, state.today, 4) : []), [anchor, frequency, state.today]);
  const extras = useMemo(() => (anchor ? extraPaycheckMonths(anchor, frequency, state.today, 12).filter((e) => e.extraPayday >= state.today) : []), [anchor, frequency, state.today]);

  // Monthly commitments, expressed per paycheck.
  const toCheck = (monthly: number) => (monthly * 12) / perYear;
  const budgetMonthly = state.budgets.filter((b) => b.category !== 'debt_payment').reduce((s, b) => s + (b.budget || b.average), 0);
  const mins = debts.reduce((s, d) => s + d.minPayment, 0);
  const debtMonthly = mins + state.settings.extra_payment;
  const goalsMonthly = state.goals.filter((g) => g.progress < g.target_amount).reduce((s, g) => s + g.monthly_contribution, 0);
  const committed = toCheck(budgetMonthly) + toCheck(debtMonthly) + toCheck(goalsMonthly);
  const free = amount != null ? amount - committed : 0;
  const parts = [
    { key: 'spend', label: state.month.budgeted > 0 ? 'Spending budget' : 'Typical spending', value: toCheck(budgetMonthly), note: `${usd(budgetMonthly)} a month across your categories` },
    { key: 'debt', label: 'Debt payments', value: toCheck(debtMonthly), note: `${usd(mins)} in minimums${state.settings.extra_payment ? ` plus ${usd(state.settings.extra_payment)} extra` : ''}` },
    { key: 'goals', label: 'Goals', value: toCheck(goalsMonthly), note: goalsMonthly ? `${usd(goalsMonthly)} a month set aside` : 'Nothing set aside yet' },
    { key: 'free', label: 'Unassigned', value: Math.max(0, free), note: 'Not yet given a job' },
  ] as const;

  // Paying half the monthly debt payment every payday makes 13 monthly payments a year.
  const biweeklyExtra = frequency === 'biweekly' ? Math.round(debtMonthly / 12) : 0;
  const base = useMemo(() => simulatePayoff(debts, state.settings.strategy, state.settings.extra_payment), [debts, state.settings]);
  const faster = useMemo(() => simulatePayoff(debts, state.settings.strategy, state.settings.extra_payment + biweeklyExtra), [debts, state.settings, biweeklyExtra]);
  const sooner = base.months != null && faster.months != null ? base.months - faster.months : 0;

  // Recurring charges falling in each of the next pay periods.
  const periods = useMemo(() => {
    if (!paydays.length) return [];
    const starts = [state.today, ...paydays.slice(0, 2)];
    const bills = state.recurring.flatMap((r) => [0, 1, 2].map((k) => ({ ...r, due: k === 0 ? r.nextDate : addDays(r.nextDate, Math.round(30.44 * k)) })));
    return starts.map((start, i) => {
      const end = paydays[i];
      const due = bills.filter((b) => b.due >= start && b.due < end).sort((a, b) => a.due.localeCompare(b.due));
      return { start, end, due, total: due.reduce((s, b) => s + b.amount, 0), isNow: i === 0 };
    });
  }, [paydays, state.recurring, state.today]);

  const applyBiweekly = async () => {
    setBusy(true);
    try {
      await api.patch('/settings', { extra_payment: state.settings.extra_payment + biweeklyExtra });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="space-y-4 p-5 lg:col-span-4 lg:self-start">
        <Field label="You are paid">
          <Select value={frequency} onChange={(e) => set({ frequency: e.target.value as PayFrequency })}>
            {(Object.keys(PAY_LABEL) as PayFrequency[]).map((f) => (
              <option key={f} value={f}>
                {PAY_LABEL[f].charAt(0).toUpperCase() + PAY_LABEL[f].slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Num label="Take-home per paycheck" value={pay.amount} onChange={(v) => set({ amount: v })} placeholder={state.pay.amount ? `${Math.round(state.pay.amount)} (from your deposits)` : 'After tax'} />
        <Field label="A payday" hint={pay.anchor ? 'Any one payday sets the whole schedule.' : state.pay.detected ? `Using your last deposit on ${dayLabel(state.pay.anchor!)}.` : 'Any one payday, past or future, sets the schedule.'}>
          <Input type="date" value={pay.anchor ?? ''} onChange={(e) => set({ anchor: e.target.value || null })} aria-label="A payday" />
        </Field>
      </Card>

      <div className="space-y-4 lg:col-span-8">
        {!anchor || amount == null ? (
          <Card className="p-5">
            <p className="text-[15px] font-semibold">Add a paycheck amount and one payday to build your schedule.</p>
            <p className="mt-1 text-sm text-ink-2">Once a few paychecks are in your transactions, Keel reads both from your deposits and you can leave these blank.</p>
          </Card>
        ) : (
          <>
            <Card className="p-5">
              <Verdict label="Next payday" value={dayLabel(paydays[0], { weekday: 'short', month: 'short', day: 'numeric' })}>
                {usd(amount)} {PAY_LABEL[frequency]}: {perYear} paychecks and {usd(amount * perYear)} a year. That averages {usd((amount * perYear) / 12)} a month{frequency === 'biweekly' ? <>, though most months bring only {usd(amount * 2)}</> : null}.
              </Verdict>
              <h2 className="mt-6 text-[15px] font-semibold">Each paycheck, by job</h2>
              <div className="mt-3">
                <SegmentedBar ariaLabel="How one paycheck is divided" segments={parts.map((p) => ({ label: p.label, value: p.value, color: COLORS[p.key], darkText: p.key === 'free' }))} format={usd} />
              </div>
              <ul className="tabular mt-2 divide-y divide-line">
                {parts.map((p) => (
                  <li key={p.key} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 py-2.5">
                    <span aria-hidden className="mt-1.5 h-2.5 w-2.5 rounded-[3px]" style={{ background: COLORS[p.key] }} />
                    <span>
                      <span className="block text-sm font-medium">{p.label}</span>
                      <span className="block text-xs text-muted">{p.note}</span>
                    </span>
                    <span className="text-sm font-semibold">{usd(p.value)}</span>
                  </li>
                ))}
              </ul>
              {free < 0 ? (
                <Note>
                  These add up to {usd(-free)} more than one paycheck. {frequency === 'biweekly' ? 'The two extra paychecks a year are covering the gap; ' : ''}trimming the budget or the goals would make each check balance on its own.
                </Note>
              ) : free > 25 ? (
                <Note>
                  {usd(free)} of each paycheck has no job yet — {usd((free * perYear) / 12)} a month. Your next spare dollar: <strong className="font-semibold text-ink">{state.nextDollar?.title ?? 'see the home screen'}</strong>.
                </Note>
              ) : null}
            </Card>

            {extras.length > 0 && (
              <Card className="p-5">
                <h2 className="text-[15px] font-semibold">Months with an extra paycheck</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  Bills are monthly but your pay is not, so {extras.length === 1 ? 'one month' : `${extras.length} months`} in the next year {extras.length === 1 ? 'brings' : 'bring'} {frequency === 'biweekly' ? 'three paychecks' : 'five paychecks'}. A budget built on the usual number leaves {usd(amount * extras.length)} unassigned.
                </p>
                <div className="mt-3">
                  <Facts rows={extras.map((e) => [monthLabel(e.month, { month: 'long', year: 'numeric' }), `Extra check on ${dayLabel(e.extraPayday)}`])} />
                </div>
                <Button size="sm" className="mt-3" onClick={() => (location.hash = `/plan?tool=windfall&amount=${Math.round(amount)}`)}>
                  Plan where one goes
                </Button>
              </Card>
            )}

            {frequency === 'biweekly' && debts.length > 0 && biweeklyExtra > 0 && sooner > 0 && (
              <Card className="p-5">
                <h2 className="text-[15px] font-semibold">Pay debt every payday instead of every month</h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">
                  Sending half of your {usd(debtMonthly)} monthly debt payment each payday makes 26 half-payments, which is 13 months' worth a year instead of 12. That extra {usd(biweeklyExtra)} a month clears your debt <strong className="font-semibold text-ink">{monthsToWords(sooner)} sooner</strong> ({when(state, faster.months)}) and saves <strong className="font-semibold text-ink">{usd(base.totalInterest - faster.totalInterest)}</strong> in interest.
                </p>
                <Button size="sm" variant="primary" className="mt-3" onClick={applyBiweekly} disabled={busy}>
                  Add {usd(biweeklyExtra)}/mo to my debt plan
                </Button>
                <p className="mt-2 text-xs text-muted">Check that each lender applies part-payments when received, or simply pay the larger monthly amount.</p>
              </Card>
            )}

            {periods.length > 0 && state.recurring.length > 0 && (
              <Card className="p-5">
                <h2 className="text-[15px] font-semibold">Bills by pay period</h2>
                <p className="mt-1 text-[13px] text-ink-2">Recurring charges detected from your history, grouped by the paycheck that has to cover them.</p>
                <div className="mt-3 space-y-4">
                  {periods.map((p) => (
                    <section key={p.start}>
                      <h3 className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 text-sm">
                        <span className="font-semibold">
                          {p.isNow ? 'Now' : `Paycheck ${dayLabel(p.start)}`} <span className="font-normal text-muted">until {dayLabel(p.end)}</span>
                        </span>
                        <span className="tabular text-ink-2">
                          {usd(p.total)} due{!p.isNow ? ` · ${usd(amount - p.total)} after bills` : ''}
                        </span>
                      </h3>
                      {p.due.length ? (
                        <ul className="tabular divide-y divide-line">
                          {p.due.map((b, i) => (
                            <li key={i} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
                              <span className="truncate text-ink-2">
                                {b.name} <span className="text-muted">· around {dayLabel(b.due)}</span>
                              </span>
                              <span>{usd2(b.amount)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="py-1.5 text-[13px] text-muted">No recurring charges expected.</p>
                      )}
                    </section>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
