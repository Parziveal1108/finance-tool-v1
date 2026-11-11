import type { PayoffStrategy } from './types';

export interface PayoffDebt {
  id: string;
  name: string;
  balance: number;
  /** Annual percentage rate, e.g. 24.99 */
  apr: number;
  minPayment: number;
}

export interface PayoffResult {
  /** Months until every debt is cleared; null if it never is within the horizon. */
  months: number | null;
  totalInterest: number;
  totalPaid: number;
  /** Total balance at the start of month 0, 1, 2 … */
  timeline: number[];
  /** Month index (1-based) when each debt reaches zero. */
  payoffMonth: Record<string, number | null>;
  interestByDebt: Record<string, number>;
  /** Order debts are attacked in. */
  order: string[];
  /** Debts whose minimum payment does not cover a month's interest. */
  underwater: string[];
  /** Total paid toward debt in month 1, 2, 3 … (excludes any lump sum). */
  payments: number[];
}

const HORIZON = 600; // 50 years

export function payoffOrder(debts: PayoffDebt[], strategy: PayoffStrategy): PayoffDebt[] {
  const live = debts.filter((d) => d.balance > 0.005);
  return [...live].sort((a, b) =>
    strategy === 'avalanche'
      ? b.apr - a.apr || a.balance - b.balance
      : a.balance - b.balance || b.apr - a.apr,
  );
}

/**
 * Month-by-month payoff simulation. Each month: interest accrues, every debt gets
 * its minimum, then the extra budget (plus minimums freed by debts already paid)
 * goes to the first debt in the strategy order — the "rollover" method.
 */
export function simulatePayoff(
  debts: PayoffDebt[],
  strategy: PayoffStrategy,
  extraMonthly = 0,
  lumpSum = 0,
): PayoffResult {
  const order = payoffOrder(debts, strategy);
  const bal = new Map(order.map((d) => [d.id, d.balance]));
  const interestByDebt: Record<string, number> = Object.fromEntries(order.map((d) => [d.id, 0]));
  const payoffMonth: Record<string, number | null> = Object.fromEntries(order.map((d) => [d.id, null]));
  const underwater = order
    .filter((d) => d.minPayment <= (d.balance * d.apr) / 1200 + 0.005)
    .map((d) => d.id);

  const total = () => {
    let t = 0;
    for (const v of bal.values()) t += v;
    return t;
  };
  const payDown = (pool: number): number => {
    for (const d of order) {
      if (pool <= 0.005) break;
      const b = bal.get(d.id)!;
      if (b <= 0.005) continue;
      const pay = Math.min(b, pool);
      bal.set(d.id, b - pay);
      pool -= pay;
    }
    return pool;
  };

  const committed = order.reduce((s, d) => s + d.minPayment, 0) + Math.max(0, extraMonthly);
  let totalInterest = 0;
  let totalPaid = 0;

  if (lumpSum > 0) totalPaid += lumpSum - payDown(lumpSum);

  const timeline = [round2(total())];
  const payments: number[] = [];
  let months: number | null = total() <= 0.005 ? 0 : null;

  for (let m = 1; m <= HORIZON && months === null; m++) {
    let pool = committed;
    for (const d of order) {
      let b = bal.get(d.id)!;
      if (b <= 0.005) continue;
      const interest = (b * d.apr) / 1200;
      b += interest;
      totalInterest += interest;
      interestByDebt[d.id] += interest;
      const pay = Math.min(b, d.minPayment, pool);
      b -= pay;
      pool -= pay;
      totalPaid += pay;
      bal.set(d.id, b);
    }
    const leftover = payDown(pool);
    totalPaid += pool - leftover;
    payments.push(round2(committed - leftover));
    for (const d of order) {
      if (payoffMonth[d.id] === null && bal.get(d.id)! <= 0.005) payoffMonth[d.id] = m;
    }
    const t = total();
    timeline.push(round2(t));
    if (t <= 0.005) months = m;
  }

  return {
    months,
    totalInterest: round2(totalInterest),
    totalPaid: round2(totalPaid),
    timeline,
    payoffMonth,
    interestByDebt: Object.fromEntries(Object.entries(interestByDebt).map(([k, v]) => [k, round2(v)])),
    order: order.map((d) => d.id),
    underwater,
    payments,
  };
}

/** When a lender's minimum is unknown: cards ≈ interest + 1% of balance (floor $25); loans ≈ 10-year amortisation. */
export function estimateMinPayment(balance: number, apr: number, kind: 'credit' | 'loan'): number {
  if (balance <= 0) return 0;
  if (kind === 'credit') return round2(Math.min(balance, Math.max(25, balance * 0.01 + (balance * apr) / 1200)));
  const r = apr / 1200;
  const n = 120;
  const pmt = r === 0 ? balance / n : (balance * r) / (1 - Math.pow(1 + r, -n));
  return Math.ceil(pmt * 100) / 100; // round up so the last month is not left with stray cents
}

export function addMonths(isoDate: string, months: number): string {
  const [y, m] = isoDate.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 7);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
