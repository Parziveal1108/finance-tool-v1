import { round2, simulatePayoff, type PayoffDebt } from './payoff';
import type { PayoffStrategy } from './types';

/**
 * What-if calculators. They are pure functions over the same debts, balances and averages the
 * rest of the app uses, so the web app can run them live as sliders move and the assistant can
 * call them with identical results.
 */

/** Debt at or above this rate is treated as "expensive": paying it beats what investing reliably returns. */
export const HIGH_APR = 8;

const sumMins = (debts: PayoffDebt[]) => debts.reduce((s, d) => s + (d.balance > 0.005 ? d.minPayment : 0), 0);

// ---------------------------------------------------------------------------------------------
// Windfall: where a lump sum does the most good
// ---------------------------------------------------------------------------------------------

export interface WindfallInput {
  amount: number;
  cash: number;
  /** One month of essential spending. */
  essentials: number;
  emergencyMonths: number;
  debts: PayoffDebt[];
  strategy: PayoffStrategy;
  extra: number;
}

export interface WindfallStep {
  target: 'cushion' | 'debt' | 'emergency' | 'invest';
  label: string;
  amount: number;
  note: string;
  debtId?: string;
}

export interface WindfallPlan {
  steps: WindfallStep[];
  toDebt: number;
  interestSaved: number;
  /** Months until debt-free before and after; null when the plan never finishes. */
  monthsBefore: number | null;
  monthsAfter: number | null;
}

/** Splits a lump sum in priority order: one-month cushion, expensive debt, full emergency fund, then investing. */
export function allocateWindfall(i: WindfallInput): WindfallPlan {
  const steps: WindfallStep[] = [];
  let left = Math.max(0, i.amount);
  const take = (want: number) => {
    const a = round2(Math.min(left, Math.max(0, want)));
    left = round2(left - a);
    return a;
  };
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

  let cash = i.cash;
  const cushion = take(i.essentials - cash);
  if (cushion > 0) {
    cash += cushion;
    steps.push({ target: 'cushion', label: 'One-month cushion', amount: cushion, note: cash >= i.essentials - 0.5 ? `Brings cash to a full month of essentials (${usd(i.essentials)})` : `Toward a month of essentials (${usd(i.essentials)})` });
  }

  const paid = new Map<string, number>();
  const expensive = i.debts.filter((d) => d.balance > 0.005 && d.apr >= HIGH_APR).sort((a, b) => b.apr - a.apr || a.balance - b.balance);
  for (const d of expensive) {
    const a = take(d.balance);
    if (a <= 0) break;
    paid.set(d.id, a);
    steps.push({ target: 'debt', debtId: d.id, label: d.name, amount: a, note: `${d.apr}% APR · ${a >= d.balance - 0.005 ? 'pays it off' : `leaves ${usd(d.balance - a)}`} · saves about ${usd((a * d.apr) / 100)} a year in interest` });
  }

  const fullFund = i.essentials * i.emergencyMonths;
  const emergency = take(fullFund - cash);
  if (emergency > 0) {
    cash += emergency;
    steps.push({ target: 'emergency', label: `${i.emergencyMonths}-month emergency fund`, amount: emergency, note: cash >= fullFund - 0.5 ? `Completes it at ${usd(fullFund)}` : `${usd(cash)} of ${usd(fullFund)} afterwards` });
  }

  if (left > 0) {
    const cheap = i.debts.some((d) => d.balance - (paid.get(d.id) ?? 0) > 0.005);
    steps.push({ target: 'invest', label: 'Invest or fund a goal', amount: left, note: cheap ? `Your remaining debt costs under ${HIGH_APR}%, less than long-run investing has tended to return` : 'Cushion and emergency fund are covered and no expensive debt is left' });
    left = 0;
  }

  const before = simulatePayoff(i.debts, i.strategy, i.extra);
  const after = simulatePayoff(i.debts.map((d) => ({ ...d, balance: round2(d.balance - (paid.get(d.id) ?? 0)) })), i.strategy, i.extra);
  const toDebt = round2([...paid.values()].reduce((s, v) => s + v, 0));
  return { steps, toDebt, interestSaved: round2(before.totalInterest - after.totalInterest), monthsBefore: before.months, monthsAfter: after.months };
}

// ---------------------------------------------------------------------------------------------
// Pay down debt or invest
// ---------------------------------------------------------------------------------------------

export interface Path {
  /** Month 0, 1, 2 … */
  invested: number[];
  debt: number[];
  net: number[];
  debtFreeMonth: number | null;
  interestPaid: number;
}

/**
 * Follows one plan month by month: debts are paid with their minimums plus `debtExtra`; `investMonthly`
 * is invested; and whenever debt needs less than its budget (the final month, and every month after),
 * the difference is invested too. Total money out each month is therefore constant.
 */
export function followPath(debts: PayoffDebt[], strategy: PayoffStrategy, debtExtra: number, investMonthly: number, annualReturn: number, months: number, startInvested = 0): Path {
  const sim = simulatePayoff(debts, strategy, debtExtra);
  const budget = sumMins(debts) + Math.max(0, debtExtra);
  const r = annualReturn / 1200;
  let inv = startInvested;
  const invested = [round2(inv)];
  const debt = [sim.timeline[0]];
  const lastDebt = sim.timeline[sim.timeline.length - 1];
  for (let m = 1; m <= months; m++) {
    const paid = sim.payments[m - 1] ?? 0;
    inv = inv * (1 + r) + investMonthly + (budget - paid);
    invested.push(round2(inv));
    debt.push(sim.timeline[m] ?? (sim.months != null ? 0 : lastDebt));
  }
  return { invested, debt, net: invested.map((v, k) => round2(v - debt[k])), debtFreeMonth: sim.months, interestPaid: sim.totalInterest };
}

export interface DebtVsInvest {
  debtFirst: Path;
  investFirst: Path;
  /** Positive when paying debt first ends ahead. */
  advantage: number;
  /** Investment return at which the two come out even; null if investing never catches up below 40%. */
  breakEvenReturn: number | null;
}

/** The same spare `monthly` amount, sent to debt first or invested from day one, compared at the horizon. */
export function debtVsInvest(debts: PayoffDebt[], strategy: PayoffStrategy, baseExtra: number, monthly: number, annualReturn: number, years: number): DebtVsInvest {
  const months = Math.round(years * 12);
  const run = (ret: number) => ({
    debtFirst: followPath(debts, strategy, baseExtra + monthly, 0, ret, months),
    investFirst: followPath(debts, strategy, baseExtra, monthly, ret, months),
  });
  const { debtFirst, investFirst } = run(annualReturn);
  const gap = (ret: number) => {
    const x = run(ret);
    return x.investFirst.net[months] - x.debtFirst.net[months];
  };
  let breakEvenReturn: number | null = null;
  if (monthly > 0 && debts.some((d) => d.balance > 0.005)) {
    let lo = 0;
    let hi = 40;
    if (gap(lo) >= 0) breakEvenReturn = 0;
    else if (gap(hi) > 0) {
      for (let k = 0; k < 22; k++) {
        const mid = (lo + hi) / 2;
        if (gap(mid) > 0) hi = mid;
        else lo = mid;
      }
      breakEvenReturn = Math.round(hi * 10) / 10;
    }
  }
  return { debtFirst, investFirst, advantage: round2(debtFirst.net[months] - investFirst.net[months]), breakEvenReturn };
}

// ---------------------------------------------------------------------------------------------
// Refinance: 0% balance transfer or a consolidation loan
// ---------------------------------------------------------------------------------------------

export function amortizedPayment(principal: number, apr: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const r = apr / 1200;
  return Math.ceil((r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months))) * 100) / 100;
}

/** Pay a fixed amount against one balance whose rate changes over time. `months: null` means "from then on". */
export function payDown(balance: number, payment: number, phases: { months: number | null; apr: number }[]): { months: number | null; interest: number } {
  let b = balance;
  let interest = 0;
  let m = 0;
  for (const [k, phase] of phases.entries()) {
    const last = k === phases.length - 1;
    for (let n = 0; b > 0.005 && (phase.months == null || n < phase.months); n++) {
      if (m >= 600) return { months: null, interest: round2(interest) };
      const charge = (b * phase.apr) / 1200;
      if (last && payment <= charge + 0.005) return { months: null, interest: round2(interest) };
      b += charge;
      interest += charge;
      b -= Math.min(b, payment);
      m++;
    }
  }
  return { months: b > 0.005 ? null : m, interest: round2(interest) };
}

export type RefinanceOption =
  | { kind: 'transfer'; feePct: number; promoMonths: number; promoApr: number; afterApr: number }
  | { kind: 'loan'; apr: number; termMonths: number; feePct: number };

export interface RefinanceResult {
  balance: number;
  current: { payment: number; months: number | null; cost: number };
  option: { payment: number; months: number | null; fee: number; interest: number; cost: number };
  /** Positive when refinancing is cheaper. */
  savings: number;
  /** Transfers only: what to pay monthly so nothing is left when the promotional rate ends. */
  neededForPromo: number | null;
  clearsInPromo: boolean | null;
}

/**
 * Compares carrying on with the chosen debts at `monthlyPayment` against moving them to a 0%-style
 * balance transfer or a fixed-term loan. Fees are added to the balance, as lenders usually do.
 */
export function compareRefinance(debts: PayoffDebt[], monthlyPayment: number, opt: RefinanceOption): RefinanceResult {
  const live = debts.filter((d) => d.balance > 0.005);
  const balance = round2(live.reduce((s, d) => s + d.balance, 0));
  const mins = sumMins(live);
  const payment = round2(Math.max(monthlyPayment, mins));
  const now = simulatePayoff(live, 'avalanche', payment - mins);
  const current = { payment, months: now.months, cost: now.totalInterest };

  const fee = round2((balance * opt.feePct) / 100);
  const principal = balance + fee;
  let option: RefinanceResult['option'];
  let neededForPromo: number | null = null;
  let clearsInPromo: boolean | null = null;
  if (opt.kind === 'transfer') {
    const r = payDown(principal, payment, [
      { months: opt.promoMonths, apr: opt.promoApr },
      { months: null, apr: opt.afterApr },
    ]);
    option = { payment, months: r.months, fee, interest: r.interest, cost: round2(fee + r.interest) };
    neededForPromo = amortizedPayment(principal, opt.promoApr, opt.promoMonths);
    clearsInPromo = r.months != null && r.months <= opt.promoMonths;
  } else {
    const p = amortizedPayment(principal, opt.apr, opt.termMonths);
    const interest = round2(Math.max(0, p * opt.termMonths - principal));
    option = { payment: p, months: opt.termMonths, fee, interest, cost: round2(fee + interest) };
  }
  return { balance, current, option, savings: round2(current.cost - option.cost), neededForPromo, clearsInPromo };
}

// ---------------------------------------------------------------------------------------------
// Forecast: where the current plan leads
// ---------------------------------------------------------------------------------------------

export interface ForecastInput {
  debts: PayoffDebt[];
  strategy: PayoffStrategy;
  extra: number;
  cash: number;
  investments: number;
  otherAssets: number;
  /** Added to cash savings each month. */
  monthlySave: number;
  monthlyInvest: number;
  /** Annual return after inflation, in percent, so results read in today's dollars. */
  annualReturn: number;
  years: number;
  /** Once a debt is gone, keep paying the same amount — into investments. */
  rollover: boolean;
}

export interface Forecast {
  net: number[];
  invested: number[];
  debt: number[];
  cash: number[];
  debtFreeMonth: number | null;
}

export function forecast(i: ForecastInput): Forecast {
  const months = Math.round(i.years * 12);
  const sim = simulatePayoff(i.debts, i.strategy, i.extra);
  // The extra payment is a debt setting: with nothing owed there is no payment to redirect.
  const budget = i.debts.some((d) => d.balance > 0.005) ? sumMins(i.debts) + Math.max(0, i.extra) : 0;
  const r = i.annualReturn / 1200;
  let inv = i.investments;
  let cash = i.cash;
  const out: Forecast = { net: [], invested: [], debt: [], cash: [], debtFreeMonth: sim.months };
  const lastDebt = sim.timeline[sim.timeline.length - 1];
  for (let m = 0; m <= months; m++) {
    if (m > 0) {
      const freed = budget - (sim.payments[m - 1] ?? 0);
      inv = inv * (1 + r) + i.monthlyInvest + (i.rollover ? freed : 0);
      cash += i.monthlySave;
    }
    const debt = sim.timeline[m] ?? (sim.months != null ? 0 : lastDebt);
    out.invested.push(round2(inv));
    out.cash.push(round2(cash));
    out.debt.push(debt);
    out.net.push(round2(cash + inv + i.otherAssets - debt));
  }
  return out;
}

/** First month a series reaches a target, or null if it does not within the series. */
export function monthReached(series: number[], target: number): number | null {
  const k = series.findIndex((v) => v >= target);
  return k < 0 ? null : k;
}

/** The "25× annual spending" rule of thumb for a portfolio that can cover your spending indefinitely. */
export const independenceNumber = (monthlySpending: number) => round2(monthlySpending * 12 * 25);

/** Interest accruing across all debts per day. */
export const dailyInterest = (debts: PayoffDebt[]) => round2(debts.reduce((s, d) => s + (d.balance * d.apr) / 36500, 0));

export function weightedApr(debts: PayoffDebt[]): number {
  const total = debts.reduce((s, d) => s + d.balance, 0);
  return total > 0 ? Math.round((debts.reduce((s, d) => s + d.balance * d.apr, 0) / total) * 100) / 100 : 0;
}
