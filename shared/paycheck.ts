import type { MatchSettings, PayFrequency } from './types';

/** Paycheck schedule and employer-match arithmetic. Dates are YYYY-MM-DD strings, handled in UTC. */

const DAY = 86400000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => toIso(toMs(iso) + n * DAY);

export const PAY_LABEL: Record<PayFrequency, string> = { weekly: 'every week', biweekly: 'every two weeks', semimonthly: 'twice a month', monthly: 'once a month' };
export const paychecksPerYear = (f: PayFrequency) => ({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 })[f];

function monthDay(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toIso(Date.UTC(year, month, Math.min(day, last)));
}

/** The next `count` paydays strictly after `after`, given any known payday as the anchor. */
export function nextPaydays(anchor: string, frequency: PayFrequency, after: string, count: number): string[] {
  const out: string[] = [];
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14;
    const behind = Math.floor((toMs(after) - toMs(anchor)) / (step * DAY)) + 1;
    for (let k = 0; k < count; k++) out.push(addDays(anchor, (behind + k) * step));
    return out;
  }
  const a = new Date(toMs(anchor));
  const d1 = a.getUTCDate();
  const days = frequency === 'monthly' ? [d1] : [d1 <= 15 ? d1 : d1 - 15, d1 <= 15 ? d1 + 15 : d1].sort((x, y) => x - y);
  const start = new Date(toMs(after));
  for (let m = 0; out.length < count && m < count + 3; m++) {
    for (const d of days) {
      const iso = monthDay(start.getUTCFullYear(), start.getUTCMonth() + m, d);
      if (iso > after && out.length < count) out.push(iso);
    }
  }
  return out;
}

/**
 * Months that contain an extra payday: three for biweekly pay, five for weekly. Budgets built on
 * "two paychecks a month" leave these checks unassigned. Returns YYYY-MM keys with that payday.
 */
export function extraPaycheckMonths(anchor: string, frequency: PayFrequency, after: string, monthsAhead = 12): { month: string; extraPayday: string }[] {
  if (frequency !== 'biweekly' && frequency !== 'weekly') return [];
  const usual = frequency === 'biweekly' ? 2 : 4;
  const limit = toIso(Date.UTC(Number(after.slice(0, 4)), Number(after.slice(5, 7)) - 1 + monthsAhead + 1, 1));
  const byMonth = new Map<string, string[]>();
  // Include paydays already past this month so the current month is counted correctly.
  const monthStart = `${after.slice(0, 7)}-01`;
  for (const d of nextPaydays(anchor, frequency, addDays(monthStart, -1), Math.ceil(((monthsAhead + 2) * 31) / (frequency === 'biweekly' ? 14 : 7)))) {
    if (d >= limit) break;
    const key = d.slice(0, 7);
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(d);
  }
  return [...byMonth.entries()].filter(([, list]) => list.length > usual).map(([month, list]) => ({ month, extraPayday: list[list.length - 1] }));
}

export interface PayDetection {
  frequency: PayFrequency;
  amount: number;
  lastDate: string;
}

/** Work out a pay schedule from income deposits: the most regular, largest source wins. */
export function detectPay(deposits: { date: string; amount: number; name: string }[]): PayDetection | null {
  const groups = new Map<string, { date: string; amount: number }[]>();
  for (const d of deposits) {
    if (d.amount < 200) continue;
    const key = d.name.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(d);
  }
  let best: { total: number; list: { date: string; amount: number }[] } | null = null;
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const total = list.reduce((s, d) => s + d.amount, 0);
    if (!best || total > best.total) best = { total, list };
  }
  if (!best) return null;
  const list = [...best.list].sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  const gaps = list.slice(1).map((d, i) => Math.round((toMs(d.date) - toMs(list[i].date)) / DAY));
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const every = (lo: number, hi: number) => gaps.every((g) => g >= lo && g <= hi);
  const frequency: PayFrequency | null = every(6, 8) ? 'weekly' : every(13, 15) ? 'biweekly' : median >= 13 && median <= 17 ? 'semimonthly' : median >= 27 && median <= 33 ? 'monthly' : null;
  if (!frequency) return null;
  const amounts = list.map((d) => d.amount).sort((a, b) => a - b);
  return { frequency, amount: amounts[Math.floor(amounts.length / 2)], lastDate: list[list.length - 1].date };
}

export interface MatchSummary {
  configured: boolean;
  /** What you put in and what the employer adds, per year. */
  yours: number;
  employer: number;
  employerMax: number;
  /** Match you are not collecting, per year. */
  unclaimed: number;
  /** Extra you would contribute per year (before tax) to collect all of it. */
  costToMax: number;
  full: boolean;
}

export function matchSummary(m: MatchSettings): MatchSummary {
  const configured = m.rate > 0 && m.salary != null && m.salary > 0 && m.limit_pct != null && m.contributing_pct != null;
  if (!configured) return { configured: false, yours: 0, employer: 0, employerMax: 0, unclaimed: 0, costToMax: 0, full: false };
  const salary = m.salary!;
  const limit = m.limit_pct!;
  const mine = m.contributing_pct!;
  const round = (n: number) => Math.round(n * 100) / 100;
  const matched = Math.min(mine, limit);
  const employer = round((salary * matched * m.rate) / 10000);
  const employerMax = round((salary * limit * m.rate) / 10000);
  return {
    configured: true,
    yours: round((salary * mine) / 100),
    employer,
    employerMax,
    unclaimed: round(employerMax - employer),
    costToMax: round((salary * Math.max(0, limit - mine)) / 100),
    full: mine >= limit,
  };
}

/** Future value of a level monthly contribution. */
export function futureValue(monthly: number, annualReturn: number, years: number): number {
  const r = annualReturn / 1200;
  const n = Math.round(years * 12);
  return Math.round((r === 0 ? monthly * n : (monthly * (Math.pow(1 + r, n) - 1)) / r) * 100) / 100;
}
