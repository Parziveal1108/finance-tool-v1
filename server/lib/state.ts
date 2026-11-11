import { q, getSettings, getSetting, isoDate } from '../db';
import { CATEGORIES, isSpend, isEssential } from '../../shared/categories';
import { estimateMinPayment, round2 } from '../../shared/payoff';
import { HIGH_APR } from '../../shared/planning';
import type { Account, AppState, BudgetLine, DebtView, Goal, Holding, Insight, MonthFlow, NextDollar, Transaction } from '../../shared/types';
import { plaidConfigured, plaidEnv } from './plaid';
import { aiConfigured, MODEL } from './ai-config';

/** Categories that are bills rather than day-to-day choices; left out of "safe to spend". */
const FIXED = new Set(['housing', 'utilities', 'insurance', 'debt_payment', 'subscriptions', 'fees']);
export { HIGH_APR };

export interface TxRow {
  id: string;
  account_id: string | null;
  date: string;
  amount: number;
  name: string;
  merchant: string | null;
  category: string;
}

export function listAccounts(): Account[] {
  const rows = q.all<any>('SELECT * FROM accounts ORDER BY type, name');
  const held = new Map(
    q.all<{ account_id: string; v: number }>('SELECT account_id, SUM(quantity * price) v FROM holdings GROUP BY account_id').map((r) => [r.account_id, r.v]),
  );
  return rows.map((r) => ({
    id: r.id,
    item_id: r.item_id,
    name: r.name,
    institution: r.institution,
    mask: r.mask,
    type: r.type,
    subtype: r.subtype,
    balance: r.type === 'investment' && held.has(r.id) ? round2(held.get(r.id)!) : r.balance,
    credit_limit: r.credit_limit,
    apr: r.apr,
    min_payment: r.min_payment,
    due_day: r.due_day,
    manual: !!r.manual,
    updated_at: r.updated_at,
  }));
}

export function listHoldings(): Holding[] {
  return q.all<any>('SELECT * FROM holdings ORDER BY quantity * price DESC').map((h) => ({ ...h, manual: !!h.manual }));
}

export function toTransaction(r: any): Transaction {
  return { id: r.id, account_id: r.account_id, date: r.date, amount: r.amount, name: r.name, merchant: r.merchant, category: r.category, pending: !!r.pending, source: r.source, notes: r.notes };
}

export function debtsOf(accounts: Account[]): DebtView[] {
  return accounts
    .filter((a) => (a.type === 'credit' || a.type === 'loan') && a.balance > 0.005)
    .map((a) => {
      const apr = a.apr ?? (a.type === 'credit' ? 22 : 7);
      const known = a.min_payment != null && a.min_payment > 0;
      return {
        id: a.id,
        name: a.name,
        kind: a.type === 'credit' ? 'Credit card' : a.subtype ? `${cap(a.subtype)} loan` : 'Loan',
        balance: a.balance,
        apr,
        min_payment: known ? a.min_payment! : estimateMinPayment(a.balance, apr, a.type as 'credit' | 'loan'),
        min_estimated: !known || a.apr == null,
        credit_limit: a.credit_limit,
        due_day: a.due_day,
      };
    })
    .sort((a, b) => b.apr - a.apr);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthOf = (d: string) => d.slice(0, 7);

export function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

export function daysIn(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

const normalise = (s: string) =>
  s.toLowerCase().replace(/[0-9#*]+/g, ' ').replace(/\b(pos|debit|purchase|payment|autopay|ach|www|com|inc|llc)\b/g, ' ').replace(/[^a-z& ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);

export function detectRecurring(txns: TxRow[], today: string): AppState['recurring'] {
  const groups = new Map<string, TxRow[]>();
  for (const t of txns) {
    if (t.amount >= 0 || ['transfer', 'savings'].includes(t.category)) continue;
    const key = normalise(t.merchant || t.name);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }
  const out: AppState['recurring'] = [];
  const dayMs = 86400000;
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = list.slice(1).map((t, i) => (Date.parse(t.date) - Date.parse(list[i].date)) / dayMs);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < 26 || median > 35) continue;
    const amounts = list.map((t) => -t.amount);
    const base = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)];
    if (amounts.some((a) => Math.abs(a - base) / base > 0.35)) continue;
    const last = list[list.length - 1];
    if ((Date.parse(today) - Date.parse(last.date)) / dayMs > 45) continue;
    const prev = -list[list.length - 2].amount;
    const cur = -last.amount;
    const diff = round2(cur - prev);
    const earlier = amounts.slice(0, -1);
    const steady = earlier.length >= 2 && earlier.every((a) => Math.abs(a - prev) <= Math.max(0.02, prev * 0.005));
    const next = new Date(Date.parse(last.date) + Math.round(median) * dayMs).toISOString().slice(0, 10);
    out.push({
      name: last.merchant || last.name,
      amount: cur,
      category: last.category,
      lastDate: last.date,
      nextDate: next,
      // Only a fixed-price charge can have a "price change"; variable bills move every month.
      changed: steady && Math.abs(diff) > Math.max(0.5, prev * 0.02) ? diff : null,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export interface Core {
  state: Omit<AppState, 'insights' | 'brief'>;
  txns: TxRow[];
}

export function buildCore(now = new Date()): Core {
  const today = isoDate(now);
  const monthKey = monthOf(today);
  const settings = getSettings();
  const accounts = listAccounts();
  const holdings = listHoldings();
  const debts = debtsOf(accounts);

  const since = `${shiftMonth(monthKey, -12)}-01`;
  const txns = q.all<TxRow>(
    'SELECT id, account_id, date, amount, name, merchant, category FROM transactions WHERE date >= ? ORDER BY date',
    since,
  );

  // --- month aggregates -----------------------------------------------------
  const income = new Map<string, number>();
  const spend = new Map<string, number>();
  const essentials = new Map<string, number>();
  const byCat = new Map<string, Map<string, number>>();
  const activeMonths = new Set<string>();
  for (const t of txns) {
    const m = monthOf(t.date);
    activeMonths.add(m);
    if (t.category === 'income' && t.amount > 0) income.set(m, (income.get(m) ?? 0) + t.amount);
    if (isSpend(t.category)) {
      spend.set(m, (spend.get(m) ?? 0) - t.amount);
      if (isEssential(t.category)) essentials.set(m, (essentials.get(m) ?? 0) - t.amount);
      const c = byCat.get(t.category) ?? byCat.set(t.category, new Map()).get(t.category)!;
      c.set(m, (c.get(m) ?? 0) - t.amount);
    }
  }
  const prior = [1, 2, 3].map((i) => shiftMonth(monthKey, -i)).filter((m) => activeMonths.has(m));
  const avg = (m: Map<string, number>) => (prior.length ? prior.reduce((s, k) => s + Math.max(0, m.get(k) ?? 0), 0) / prior.length : 0);

  const flows: MonthFlow[] = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(monthKey, -i);
    if (!activeMonths.has(m) && i > 0 && !flows.length) continue;
    flows.push({ month: m, income: round2(income.get(m) ?? 0), spending: round2(Math.max(0, spend.get(m) ?? 0)) });
  }

  // --- budgets ----------------------------------------------------------------
  const budgetRows = new Map(q.all<{ category: string; amount: number }>('SELECT * FROM budgets').map((b) => [b.category, b.amount]));
  const budgets: BudgetLine[] = [];
  for (const c of CATEGORIES) {
    if (!c.spend) continue;
    const m = byCat.get(c.id);
    const line: BudgetLine = {
      category: c.id,
      budget: budgetRows.get(c.id) ?? 0,
      spent: round2(Math.max(0, m?.get(monthKey) ?? 0)),
      average: round2(m ? avg(m) : 0),
    };
    if (line.budget > 0 || line.spent > 0 || line.average > 0) budgets.push(line);
  }

  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = daysIn(monthKey);
  const flexible = budgets.filter((b) => b.budget > 0 && !FIXED.has(b.category));
  const safeToSpendToday = flexible.length
    ? round2(Math.max(0, flexible.reduce((s, b) => s + (b.budget - b.spent), 0)) / (daysInMonth - dayOfMonth + 1))
    : null;

  const pace = (key: string, upTo: number) => {
    const days = new Array(upTo).fill(0);
    for (const t of txns) {
      if (monthOf(t.date) !== key || !isSpend(t.category)) continue;
      const d = Number(t.date.slice(8, 10));
      if (d <= upTo) days[d - 1] -= t.amount;
    }
    let run = 0;
    return days.map((v) => round2((run += v)));
  };
  const lastKey = shiftMonth(monthKey, -1);

  // --- totals & history -------------------------------------------------------
  const sum = (type: Account['type'][]) => round2(accounts.filter((a) => type.includes(a.type)).reduce((s, a) => s + a.balance, 0));
  const cash = sum(['depository']);
  const investments = sum(['investment']);
  const otherAssets = sum(['asset']);
  const debt = sum(['credit', 'loan']);
  const assets = round2(cash + investments + otherAssets);
  const hasData = accounts.length > 0 || txns.length > 0;
  if (hasData) {
    q.run('INSERT INTO snapshots (date, assets, debt) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET assets = excluded.assets, debt = excluded.debt', today, assets, debt);
  }
  const snaps = q.all<{ date: string; assets: number; debt: number }>('SELECT * FROM snapshots ORDER BY date DESC LIMIT 400').reverse();
  const cutoff = isoDate(new Date(now.getTime() - 30 * 86400000));
  const floor = isoDate(new Date(now.getTime() - 45 * 86400000));
  const ref = [...snaps].reverse().find((s) => s.date <= cutoff && s.date >= floor);

  // --- goals ------------------------------------------------------------------
  const balanceOf = new Map(accounts.map((a) => [a.id, a.balance]));
  const goals = q.all<Goal>('SELECT * FROM goals ORDER BY created_at').map((g) => {
    const progress = g.linked_account_id && balanceOf.has(g.linked_account_id) ? balanceOf.get(g.linked_account_id)! : g.current_amount;
    const remaining = Math.max(0, g.target_amount - progress);
    let needed: number | null = null;
    if (g.target_date && remaining > 0) {
      const [y, m] = g.target_date.split('-').map(Number);
      const months = Math.max(1, (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth()));
      needed = round2(remaining / months);
    }
    const projected = remaining <= 0 ? today.slice(0, 7) : g.monthly_contribution > 0 ? shiftMonth(monthKey, Math.ceil(remaining / g.monthly_contribution)) : null;
    return { ...g, progress: round2(progress), projected_date: projected, needed_monthly: needed };
  });

  const monthlyEssentials = round2(avg(essentials) || essentials.get(monthKey) || budgets.filter((b) => isEssential(b.category)).reduce((s, b) => s + b.budget, 0));
  const monthlySpendAvg = round2(avg(spend) || Math.max(0, spend.get(monthKey) ?? 0));
  const monthlyIncomeAvg = round2(avg(income) || (income.get(monthKey) ?? 0));

  const state: Core['state'] = {
    today,
    capabilities: { plaid: plaidConfigured(), plaidEnv: plaidEnv(), ai: aiConfigured(), model: MODEL },
    settings,
    accounts,
    items: q.all('SELECT id, institution, status, error, last_sync FROM items ORDER BY institution'),
    holdings,
    goals,
    debts,
    budgets,
    totals: {
      cash,
      investments,
      otherAssets,
      debt,
      netWorth: round2(assets - debt),
      netWorthChange30d: ref ? round2(assets - debt - (ref.assets - ref.debt)) : null,
      debtChange30d: ref ? round2(debt - ref.debt) : null,
    },
    month: {
      key: monthKey,
      income: round2(income.get(monthKey) ?? 0),
      spending: round2(Math.max(0, spend.get(monthKey) ?? 0)),
      budgeted: round2(budgets.reduce((s, b) => s + b.budget, 0)),
      dayOfMonth,
      daysInMonth,
      safeToSpendToday,
      paceThis: pace(monthKey, dayOfMonth),
      paceLast: activeMonths.has(lastKey) ? pace(lastKey, daysIn(lastKey)) : [],
    },
    flows,
    netWorthHistory: snaps.map((s) => ({ date: s.date, net: round2(s.assets - s.debt), assets: s.assets, debt: s.debt })),
    monthlyEssentials,
    monthlySpendAvg,
    monthlyIncomeAvg,
    nextDollar: null,
    recurring: detectRecurring(txns.filter((t) => t.date >= isoDate(new Date(now.getTime() - 130 * 86400000))), today),
    hasData,
  };
  state.nextDollar = nextDollar(state);
  return { state, txns };
}

/** Where the next spare dollar does the most good — a simple, widely used ordering. */
function nextDollar(s: Core['state']): NextDollar | null {
  if (!s.hasData || (s.totals.cash === 0 && s.totals.debt === 0)) return null;
  const essentials = s.monthlyEssentials || 1000;
  const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const high = s.debts.filter((d) => d.apr >= HIGH_APR);
  const fullTarget = essentials * s.settings.emergency_months;
  const done = [s.totals.cash >= essentials, high.length === 0, s.totals.cash >= fullTarget, false];
  const current = done.indexOf(false);
  const top = high[0];
  const steps = [
    { label: 'One-month cushion', detail: `${fmt(Math.min(s.totals.cash, essentials))} of ${fmt(essentials)} in cash` },
    { label: 'High-interest debt', detail: high.length ? `${high.length} balance${high.length > 1 ? 's' : ''} at ${HIGH_APR}%+ APR · ${fmt(high.reduce((t, d) => t + d.balance, 0))}` : `Nothing above ${HIGH_APR}% APR` },
    { label: `${s.settings.emergency_months}-month emergency fund`, detail: `${fmt(Math.min(s.totals.cash, fullTarget))} of ${fmt(fullTarget)}` },
    { label: 'Invest and fund goals', detail: s.totals.investments ? `${fmt(s.totals.investments)} invested` : 'Not started' },
  ].map((st, i) => ({ ...st, done: done[i], current: i === current }));

  const pick: Pick<NextDollar, 'target' | 'title' | 'reason'>[] = [
    { target: 'buffer', title: 'Build a one-month cushion', reason: `About ${fmt(Math.max(0, essentials - s.totals.cash))} more in cash covers a month of essentials, so a surprise bill does not land on a card.` },
    { target: 'debt', title: top ? `Pay down ${top.name}` : '', reason: top ? `At ${top.apr}% APR, every extra $100 here saves about ${fmt(top.apr)} a year — a guaranteed return that beats what savings or the market reliably pay.` : '' },
    { target: 'emergency', title: `Grow your emergency fund`, reason: `${fmt(Math.max(0, fullTarget - s.totals.cash))} to go for ${s.settings.emergency_months} months of essentials. Your remaining debt is cheap enough to pay on schedule.` },
    { target: 'invest', title: 'Invest it', reason: 'Cushion and emergency fund are in place and no debt is expensive. Extra money is best put to work in your long-term investments or goals.' },
  ];
  return { ...pick[current], steps };
}

const ORDER: Record<string, number> = { critical: 0, warn: 1, info: 2, good: 3 };

export function buildState(): AppState {
  const { state } = buildCore();
  const insights = q
    .all<any>("SELECT * FROM insights WHERE status = 'new'")
    .map((r): Insight => ({ ...r, action: r.action ? JSON.parse(r.action) : null }))
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.created_at.localeCompare(a.created_at));
  return { ...state, insights, brief: getSetting('brief', null) };
}
