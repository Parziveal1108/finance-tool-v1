import { createHash } from 'node:crypto';
import { q, uid, nowIso, getSetting, setSetting, patchSettings } from '../db';
import { categoryLabel, category, isEssential } from '../../shared/categories';
import { simulatePayoff, addMonths, round2, type PayoffDebt } from '../../shared/payoff';
import type { AssetClass, Insight, InsightAction, Severity } from '../../shared/types';
import { buildCore, HIGH_APR, type Core } from './state';

export type Draft = Pick<Insight, 'key' | 'area' | 'severity' | 'title' | 'body' | 'action'>;

const usd = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const usd2 = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const monthName = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const ASSET_LABEL: Record<AssetClass, string> = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  bond: 'Bonds',
  cash: 'Cash',
  crypto: 'Crypto',
  other: 'Other',
};

/** Pure rules: looks at the current picture and returns what is worth the user's attention. */
export function computeInsights({ state: s, txns }: Core): Draft[] {
  const out: Draft[] = [];
  if (!s.hasData) return out;
  const add = (key: string, area: Draft['area'], severity: Severity, title: string, body: string, action: InsightAction | null = null) =>
    out.push({ key, area, severity, title, body, action });
  const mk = s.month.key;
  const { dayOfMonth: day, daysInMonth: dim } = s.month;
  const daysLeft = dim - day;

  // ---- Budget ----------------------------------------------------------------
  const budgeted = s.budgets.filter((b) => b.budget > 0);
  if (!budgeted.length) {
    const basis = s.budgets.filter((b) => b.average >= 20);
    if (basis.length >= 3) {
      const proposal = basis.map((b) => ({
        category: b.category,
        amount: isEssential(b.category) ? Math.ceil(b.average / 10) * 10 : Math.max(10, roundTo(b.average * 0.9, 10)),
      }));
      const total = proposal.reduce((t, p) => t + p.amount, 0);
      add('budget:starter', 'budget', 'info', 'Start with a budget built from your own spending',
        `Based on your recent months: essentials at what they actually cost, everything else trimmed 10%. That is ${usd(total)} a month${s.monthlyIncomeAvg ? ` against about ${usd(s.monthlyIncomeAvg)} of income` : ''}.`,
        { type: 'set_budgets', budgets: proposal, label: 'Create this budget' });
    }
  }
  const slack = budgeted
    .filter((b) => category(b.category).group === 'lifestyle')
    .map((b) => ({ ...b, room: b.budget - Math.max(b.spent, (b.spent / Math.max(day, 1)) * dim) }))
    .filter((b) => b.room > 15)
    .sort((a, b) => b.room - a.room);
  const pacing: { label: string; gap: number; perDay: number; spent: number; budget: number }[] = [];
  for (const b of budgeted) {
    const label = categoryLabel(b.category);
    const over = b.spent - b.budget;
    if (over > Math.max(5, b.budget * 0.02)) {
      const donor = slack.find((x) => x.category !== b.category && x.room >= Math.min(over, 20));
      const amt = donor ? Math.ceil(Math.min(over, donor.room) / 5) * 5 : 0;
      add(`budget:over:${b.category}:${mk}`, 'budget', 'warn', `${label} is ${usd(over)} over budget`,
        `${usd(b.spent)} spent against ${usd(b.budget)} with ${plural(daysLeft, 'day')} left in ${monthName(mk).split(' ')[0]}.${donor ? ` ${categoryLabel(donor.category)} is running under, so you can cover it without raising the total.` : ''}`,
        donor && amt > 0 ? { type: 'shift_budget', from: donor.category, to: b.category, amount: amt, label: `Move ${usd(amt)} from ${categoryLabel(donor.category)}` } : null);
    } else if (day >= 5 && daysLeft >= 3 && !['housing', 'insurance', 'debt_payment', 'utilities', 'subscriptions'].includes(b.category)) {
      const gap = (b.spent / day) * dim - b.budget;
      if (gap > Math.max(25, b.budget * 0.2)) pacing.push({ label, gap, perDay: Math.max(0, (b.budget - b.spent) / daysLeft), spent: b.spent, budget: b.budget });
    }
  }
  if (pacing.length) {
    pacing.sort((a, b) => b.gap - a.gap);
    const top = pacing[0];
    const rest = pacing.slice(1, 3);
    add(`budget:pace:${mk}:${Math.floor(day / 7)}`, 'budget', 'info',
      pacing.length === 1 ? `${top.label} is on pace to run ${usd(top.gap)} over` : `${pacing.length} categories are on pace to overshoot`,
      `${top.label} has used ${usd(top.spent)} of ${usd(top.budget)} by day ${day}; about ${usd2(top.perDay)} a day from here lands it on budget.${rest.length ? ` Also running hot: ${rest.map((p) => `${p.label} (${usd2(p.perDay)}/day to stay on budget)`).join(', ')}.` : ''}`);
  }

  // ---- Subscriptions & recurring ------------------------------------------------
  for (const r of s.recurring) {
    if (r.changed && r.changed > 0) {
      add(`recurring:up:${slug(r.name)}:${r.lastDate}`, 'budget', 'info', `${r.name} went up ${usd2(r.changed)}`,
        `Your last charge was ${usd2(r.amount)}, up from ${usd2(r.amount - r.changed)} — ${usd(r.changed * 12)} more over a year. Worth a look if you are not using it much.`);
    }
  }
  const subs = s.recurring.filter((r) => r.category === 'subscriptions');
  const subTotal = subs.reduce((t, r) => t + r.amount, 0);
  if (subs.length >= 4 && subTotal > 60) {
    add(`recurring:subs:${subs.length}`, 'budget', 'info', `${subs.length} subscriptions cost you ${usd(subTotal)} a month`,
      `That is ${usd(subTotal * 12)} a year: ${subs.slice(0, 5).map((r) => `${r.name} ${usd2(r.amount)}`).join(', ')}${subs.length > 5 ? '…' : ''}. Cancelling the one you use least is the easiest money on this page.`);
  }

  // ---- Unusual transactions ---------------------------------------------------
  const weekAgo = new Date(Date.parse(s.today) - 7 * 86400000).toISOString().slice(0, 10);
  const typical = s.monthlySpendAvg || s.month.spending;
  for (const t of txns) {
    if (t.date < weekAgo || t.amount >= 0) continue;
    if (!['dining', 'shopping', 'entertainment', 'travel', 'personal', 'other'].includes(t.category)) continue;
    const size = -t.amount;
    if (size >= 250 && typical > 0 && size > typical * 0.08) {
      add(`tx:large:${t.id}`, 'budget', 'info', `Large purchase: ${usd(size)} at ${t.merchant || t.name}`,
        `That one charge is ${Math.round((size / typical) * 100)}% of a typical month's spending, filed under ${categoryLabel(t.category)}. If it was planned, nothing to do.`);
    }
  }

  // ---- Cash -----------------------------------------------------------------
  const checking = s.accounts.filter((a) => a.type === 'depository' && (a.subtype ?? 'checking') !== 'savings');
  const checkingBal = checking.reduce((t, a) => t + a.balance, 0);
  const soon = new Date(Date.parse(s.today) + 10 * 86400000).toISOString().slice(0, 10);
  const billsDue = s.recurring.filter((r) => r.nextDate >= s.today && r.nextDate <= soon);
  const dueTotal = billsDue.reduce((t, r) => t + r.amount, 0);
  if (checking.length && billsDue.length && checkingBal < dueTotal) {
    add(`cash:short:${mk}:${Math.floor(day / 10)}`, 'cash', 'critical', `Checking may not cover the next 10 days of bills`,
      `${usd(dueTotal)} in recurring charges is expected (${billsDue.slice(0, 3).map((r) => r.name).join(', ')}) and checking holds ${usd(checkingBal)}. Moving money over now avoids an overdraft or a missed payment.`);
  }

  // ---- Debt -----------------------------------------------------------------
  const debts: PayoffDebt[] = s.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment }));
  if (debts.length) {
    const { strategy, extra_payment: extra } = s.settings;
    const plan = simulatePayoff(debts, strategy, extra);
    for (const id of plan.underwater) {
      const d = s.debts.find((x) => x.id === id)!;
      add(`debt:underwater:${id}`, 'debt', 'critical', `${d.name}: the minimum does not cover the interest`,
        `About ${usd2((d.balance * d.apr) / 1200)} of interest is added each month and the minimum is ${usd2(d.min_payment)}, so the balance grows even when you pay on time. Any amount above the minimum starts turning it around.`);
    }
    for (const d of s.debts) {
      if (d.credit_limit && d.credit_limit > 0) {
        const util = d.balance / d.credit_limit;
        if (util >= 0.7) {
          const to30 = d.balance - d.credit_limit * 0.3;
          add(`debt:util:${d.id}`, 'debt', util >= 0.9 ? 'warn' : 'info', `${d.name} is ${Math.round(util * 100)}% used`,
            `Balances above roughly 30% of the limit weigh on a credit score. Paying ${usd(to30)} would bring this card under that line.`);
        }
      }
      if (d.due_day) {
        const until = (d.due_day - day + dim) % dim;
        if (until <= 3) {
          add(`debt:due:${d.id}:${mk}`, 'debt', 'info', `${d.name} payment is due ${until === 0 ? 'today' : `in ${plural(until, 'day')}`}`,
            `Minimum ${usd2(d.min_payment)}. A late payment usually costs a fee and can raise the rate.`);
        }
      }
    }

    const highApr = s.debts.filter((d) => d.apr >= HIGH_APR);
    const surplus = s.monthlyIncomeAvg - s.monthlySpendAvg;
    const goalMoney = s.goals.reduce((t, g) => t + g.monthly_contribution, 0);
    const room = surplus - extra - goalMoney;
    if (highApr.length && s.monthlyIncomeAvg > 0 && room >= 50) {
      const bump = Math.min(roundTo(room * 0.5, 25), 1000);
      if (bump >= 25) {
        const better = simulatePayoff(debts, strategy, extra + bump);
        if (plan.months && better.months) {
          add(`debt:accelerate:${roundTo(extra + bump, 50)}`, 'debt', 'info', `${usd(bump)} more a month clears your debt ${plural(plan.months - better.months, 'month')} sooner`,
            `Over the last few months you kept about ${usd(surplus)} a month after spending${extra + goalMoney > 0 ? `, and ${usd(extra + goalMoney)} of it already has a job` : ''}. Putting ${usd(bump)} of the rest toward ${highApr[0].name} saves ${usd(plan.totalInterest - better.totalInterest)} in interest and moves your debt-free date to ${fmtMonth(addMonths(s.today, better.months))}.`,
            { type: 'set_extra_payment', amount: extra + bump, label: `Set extra payment to ${usd(extra + bump)}/mo` });
        }
      }
    }
    if (strategy === 'snowball') {
      const alt = simulatePayoff(debts, 'avalanche', extra);
      const saved = plan.totalInterest - alt.totalInterest;
      if (saved >= 100) {
        add('debt:strategy:avalanche', 'debt', 'info', `Highest-rate-first would save ${usd(saved)}`,
          `Your plan pays the smallest balance first, which gives quicker wins. Paying the highest rate first costs ${usd(saved)} less in interest${alt.months && plan.months && plan.months > alt.months ? ` and finishes ${plural(plan.months - alt.months, 'month')} earlier` : ''}. Either works; this is the cheaper one.`,
          { type: 'set_strategy', strategy: 'avalanche', label: 'Switch to highest rate first' });
      }
    }
    // Idle cash against expensive debt.
    const cushion = Math.max(s.monthlyEssentials * 1.5, 1500);
    const spare = s.totals.cash - cushion;
    const worst = highApr[0];
    if (worst && worst.apr >= 15 && spare >= 500) {
      const lump = Math.min(roundTo(spare * 0.5, 100), worst.balance);
      add(`debt:lump:${worst.id}:${roundTo(lump, 500)}`, 'debt', 'info', `A ${usd(lump)} payment to ${worst.name} saves about ${usd((lump * worst.apr) / 100)} a year`,
        `You hold ${usd(s.totals.cash)} in cash, comfortably more than six weeks of essentials. Cash earns a few percent; this balance costs ${worst.apr}%. Half of the surplus would still leave ${usd(s.totals.cash - lump)} on hand.`);
    }
    if (s.totals.debtChange30d != null && s.totals.debtChange30d <= -100) {
      add(`debt:progress:${mk}`, 'debt', 'good', `Debt is down ${usd(s.totals.debtChange30d)} in 30 days`,
        `You owe ${usd(s.totals.debt)} now.${plan.months ? ` At this pace the plan has you debt-free in ${fmtMonth(addMonths(s.today, plan.months))}.` : ''}`);
    }
  }

  // ---- Savings -----------------------------------------------------------------
  const essentials = s.monthlyEssentials;
  const hasEmergencyGoal = s.goals.some((g) => g.kind === 'emergency');
  if (essentials > 0 && s.accounts.some((a) => a.type === 'depository')) {
    const months = s.totals.cash / essentials;
    const target = round2(essentials * s.settings.emergency_months);
    if (months < s.settings.emergency_months && !hasEmergencyGoal) {
      const savingsAcct = s.accounts.find((a) => a.type === 'depository' && a.subtype === 'savings');
      const monthly = Math.max(25, roundTo(Math.max(0, s.monthlyIncomeAvg - s.monthlySpendAvg) * 0.3, 25));
      add('save:emergency', 'save', months < 1 ? 'warn' : 'info', `Your cash covers ${months.toFixed(1)} months of essentials`,
        `Essentials run about ${usd(essentials)} a month. A ${s.settings.emergency_months}-month fund is ${usd(target)}; you have ${usd(s.totals.cash)} in cash. Tracking it as a goal keeps it visible next to your debt plan.`,
        { type: 'create_goal', goal: { name: 'Emergency fund', kind: 'emergency', target_amount: roundTo(target, 100), monthly_contribution: monthly, linked_account_id: savingsAcct?.id ?? null }, label: 'Track an emergency fund goal' });
    }
  }
  for (const g of s.goals) {
    const remaining = g.target_amount - g.progress;
    if (remaining <= 0) {
      add(`goal:done:${g.id}`, 'save', 'good', `${g.name} is fully funded`, `You reached ${usd(g.target_amount)}. The ${usd(g.monthly_contribution)} a month that was going here is free for the next priority.`);
    } else if (g.needed_monthly != null && g.needed_monthly > g.monthly_contribution * 1.1 + 5) {
      const need = Math.ceil(g.needed_monthly / 5) * 5;
      add(`goal:behind:${g.id}:${roundTo(need, 25)}`, 'save', 'info', `${g.name} needs ${usd(need)} a month to finish on time`,
        `${usd(remaining)} to go by ${fmtMonth(g.target_date!.slice(0, 7))}. You have ${g.monthly_contribution > 0 ? usd(g.monthly_contribution) : 'nothing'} a month set aside for it.`,
        { type: 'set_goal_contribution', goal_id: g.id, monthly: need, label: `Set aside ${usd(need)}/mo` });
    }
  }
  if (s.monthlyIncomeAvg > 0 && s.flows.length >= 3) {
    const rate = (s.monthlyIncomeAvg - s.monthlySpendAvg) / s.monthlyIncomeAvg;
    if (rate < 0) {
      add(`cash:negative:${mk}`, 'cash', 'warn', `You have been spending more than you earn`,
        `Over recent months spending averaged ${usd(s.monthlySpendAvg)} against ${usd(s.monthlyIncomeAvg)} of income — about ${usd(s.monthlySpendAvg - s.monthlyIncomeAvg)} a month coming from savings or credit.`);
    }
  }

  // ---- Investments ----------------------------------------------------------------
  const total = s.holdings.reduce((t, h) => t + h.quantity * h.price, 0);
  if (total > 0) {
    const mix = allocation(s.holdings);
    const target = s.settings.target_allocation;
    if (target && Object.keys(target).length) {
      const drift = (Object.keys(ASSET_LABEL) as AssetClass[])
        .map((k) => ({ k, diff: (mix[k] ?? 0) - (target[k] ?? 0) }))
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      if (Math.abs(drift[0].diff) >= 5) {
        const over = drift.filter((d) => d.diff >= 3);
        const under = drift.filter((d) => d.diff <= -3);
        add(`invest:drift:${drift[0].k}:${Math.round(drift[0].diff / 5)}`, 'invest', 'info', `Portfolio has drifted from your target`,
          `${over.length ? `Over target: ${over.map((d) => `${lower(ASSET_LABEL[d.k])} (+${Math.round(d.diff)} pts)`).join(', ')}. ` : ''}${under.length ? `Under: ${under.map((d) => `${lower(ASSET_LABEL[d.k])} (−${Math.round(-d.diff)})`).join(', ')}. ` : ''}The low-effort fix is to point new contributions at what is under target — about ${usd((Math.abs(under[0]?.diff ?? drift[0].diff) / 100) * total)} closes the largest gap — rather than selling.`);
      }
    } else if (total >= 1000) {
      const suggested: Partial<Record<AssetClass, number>> = { us_stock: 55, intl_stock: 25, bond: 15, cash: 5 };
      add('invest:no-target', 'invest', 'info', 'Set a target mix so drift is visible',
        `Your ${usd(total)} is ${(Object.keys(mix) as AssetClass[]).filter((k) => mix[k]! >= 1).map((k) => `${Math.round(mix[k]!)}% ${lower(ASSET_LABEL[k])}`).join(', ')}. With a target on file the monitor can tell you when to rebalance. A common long-horizon starting point is 55/25/15/5 — adjust it to your own timeline.`,
        { type: 'set_target_allocation', allocation: suggested, label: 'Use 55 / 25 / 15 / 5 as my target' });
    }
    const bySymbol = new Map<string, number>();
    for (const h of s.holdings) {
      if (h.asset_class === 'cash') continue;
      const k = h.symbol ?? h.name;
      bySymbol.set(k, (bySymbol.get(k) ?? 0) + h.quantity * h.price);
    }
    for (const h of s.holdings) {
      const k = h.symbol ?? h.name;
      const value = bySymbol.get(k) ?? 0;
      const single = !/fund|etf|index|trust|portfolio|target/i.test(h.name) && !BROAD.has((h.symbol ?? '').toUpperCase());
      if (single && value / total >= 0.2 && bySymbol.delete(k)) {
        add(`invest:concentration:${slug(k)}`, 'invest', 'warn', `${k} is ${Math.round((value / total) * 100)}% of your portfolio`,
          `${usd(value)} rides on one holding. A bad year for it would move your whole portfolio. Directing new money elsewhere brings the share down without triggering a taxable sale.`);
      }
    }
    if ((mix.cash ?? 0) >= 15 && total >= 2000) {
      add('invest:cash-drag', 'invest', 'info', `${Math.round(mix.cash!)}% of your investment accounts is sitting in cash`,
        `${usd((mix.cash! / 100) * total)} is uninvested. If that is deliberate, ignore this; otherwise it may be a contribution that never got invested.`);
    }
  }

  // ---- Milestones -----------------------------------------------------------------
  const change = s.totals.netWorthChange30d;
  if (change != null && change >= 250 && Math.abs(s.totals.netWorth) > 0) {
    add(`networth:up:${mk}`, 'general', 'good', `Net worth is up ${usd(change)} over 30 days`, `You are at ${s.totals.netWorth < 0 ? '−' : ''}${usd(s.totals.netWorth)}. Debt paydown and contributions both count toward this number.`);
  }
  return out;
}

const BROAD = new Set(['VTI', 'VOO', 'SPY', 'IVV', 'QQQ', 'VXUS', 'VEA', 'VWO', 'BND', 'AGG', 'VT', 'SCHB', 'SCHD', 'ITOT', 'IXUS', 'BNDX', 'VTSAX', 'VFIAX', 'FXAIX', 'FZROX', 'SWTSX', 'VTIAX', 'VBTLX']);

export function allocation(holdings: { quantity: number; price: number; asset_class: AssetClass }[]): Partial<Record<AssetClass, number>> {
  const total = holdings.reduce((t, h) => t + h.quantity * h.price, 0);
  const out: Partial<Record<AssetClass, number>> = {};
  if (total <= 0) return out;
  for (const h of holdings) out[h.asset_class] = (out[h.asset_class] ?? 0) + ((h.quantity * h.price) / total) * 100;
  return out;
}

/** Lower-case a label for mid-sentence use, leaving "US" alone. */
const lower = (s: string) => (s.startsWith('US') ? s : s.charAt(0).toLowerCase() + s.slice(1));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
export const fmtMonth = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

/** Recompute monitor insights and reconcile them with what is stored. Returns newly raised ones. */
export function refreshInsights(): Draft[] {
  const core = buildCore();
  const drafts = computeInsights(core);
  const existing = new Map(q.all<{ key: string; status: string }>("SELECT key, status FROM insights WHERE source = 'monitor'").map((r) => [r.key, r.status]));
  const fresh: Draft[] = [];
  const keep = new Set<string>();
  for (const d of drafts) {
    keep.add(d.key);
    const status = existing.get(d.key);
    if (!status) {
      q.run('INSERT INTO insights (id, key, area, severity, title, body, action, source, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        uid(), d.key, d.area, d.severity, d.title, d.body, d.action ? JSON.stringify(d.action) : null, 'monitor', 'new', nowIso());
      fresh.push(d);
    } else if (status === 'new') {
      q.run('UPDATE insights SET severity = ?, title = ?, body = ?, action = ? WHERE key = ?', d.severity, d.title, d.body, d.action ? JSON.stringify(d.action) : null, d.key);
    }
  }
  // Conditions that no longer hold drop off on their own; dismissed ones are remembered so they do not come back.
  for (const [key, status] of existing) {
    if (!keep.has(key) && status === 'new') q.run('DELETE FROM insights WHERE key = ?', key);
  }
  if (!getSetting<any>('brief', null) || getSetting<any>('brief', null)?.source === 'monitor') writeMonitorBrief(core, drafts);
  return fresh;
}

/** A plain-language summary used when the Claude assistant is not configured. */
function writeMonitorBrief({ state: s }: Core, drafts: Draft[]) {
  if (!s.hasData) return;
  const parts: string[] = [];
  const left = s.month.budgeted - s.month.spending;
  if (s.month.budgeted > 0) parts.push(left >= 0 ? `${usd(left)} of this month's ${usd(s.month.budgeted)} budget is left with ${plural(s.month.daysInMonth - s.month.dayOfMonth, 'day')} to go.` : `You are ${usd(left)} over this month's ${usd(s.month.budgeted)} budget.`);
  else parts.push(`You have spent ${usd(s.month.spending)} so far this month.`);
  if (s.debts.length) {
    const plan = simulatePayoff(s.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), s.settings.strategy, s.settings.extra_payment);
    parts.push(plan.months ? `Debt stands at ${usd(s.totals.debt)}, on track to be gone by ${fmtMonth(addMonths(s.today, plan.months))}.` : `Debt stands at ${usd(s.totals.debt)}.`);
  }
  const urgent = drafts.filter((d) => d.severity === 'critical' || d.severity === 'warn');
  if (urgent.length) parts.push(`Needs attention: ${urgent[0].title.replace(/\.$/, '')}.`);
  else if (s.nextDollar) parts.push(`Best use of spare money right now: ${s.nextDollar.title.toLowerCase()}.`);
  setSetting('brief', { text: parts.join(' '), at: nowIso(), source: 'monitor' });
}

/** Store a suggestion raised by the assistant. */
export function addAssistantInsight(input: { title: string; body: string; area: Insight['area']; severity: Severity; action: InsightAction | null }) {
  const key = `ai:${createHash('sha1').update(input.title.toLowerCase()).digest('hex').slice(0, 12)}`;
  const seen = q.get<{ status: string }>('SELECT status FROM insights WHERE key = ?', key);
  if (seen) return seen.status === 'new' ? 'already listed' : 'the user already handled this one';
  q.run('INSERT INTO insights (id, key, area, severity, title, body, action, source, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    uid(), key, input.area, input.severity, input.title, input.body, input.action ? JSON.stringify(input.action) : null, 'assistant', 'new', nowIso());
  return 'added';
}

/** Carry out a one-tap action. */
export function applyAction(a: InsightAction): void {
  const setBudget = (cat: string, amount: number) =>
    q.run('INSERT INTO budgets (category, amount) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET amount = excluded.amount', cat, Math.max(0, round2(amount)));
  const current = (cat: string) => q.get<{ amount: number }>('SELECT amount FROM budgets WHERE category = ?', cat)?.amount ?? 0;
  switch (a.type) {
    case 'set_budgets':
      for (const b of a.budgets) setBudget(b.category, b.amount);
      break;
    case 'shift_budget': {
      const amt = Math.min(a.amount, current(a.from));
      setBudget(a.from, current(a.from) - amt);
      setBudget(a.to, current(a.to) + amt);
      break;
    }
    case 'set_extra_payment':
      patchSettings({ extra_payment: Math.max(0, a.amount) });
      break;
    case 'set_strategy':
      patchSettings({ strategy: a.strategy });
      break;
    case 'create_goal':
      q.run('INSERT INTO goals (id, name, kind, target_amount, current_amount, linked_account_id, target_date, monthly_contribution, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        uid(), a.goal.name, a.goal.kind, a.goal.target_amount, 0, a.goal.linked_account_id ?? null, a.goal.target_date ?? null, a.goal.monthly_contribution, nowIso());
      break;
    case 'set_goal_contribution':
      q.run('UPDATE goals SET monthly_contribution = ? WHERE id = ?', a.monthly, a.goal_id);
      break;
    case 'set_target_allocation':
      patchSettings({ target_allocation: a.allocation });
      break;
  }
}
