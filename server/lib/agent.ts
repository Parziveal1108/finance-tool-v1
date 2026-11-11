import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { q, nowIso, isoDate, patchSettings, setSetting } from '../db';
import { CATEGORIES, CATEGORY_IDS, categoryLabel } from '../../shared/categories';
import { simulatePayoff, addMonths, type PayoffDebt } from '../../shared/payoff';
import { allocateWindfall, compareRefinance, debtVsInvest, forecast, independenceNumber, monthReached } from '../../shared/planning';
import type { InsightAction } from '../../shared/types';
import { MODEL } from './ai-config';
import { buildCore, buildState } from './state';
import { addAssistantInsight, allocation, refreshInsights } from './insights';
import { AccountInput, BudgetInput, GoalInput, HoldingInput, TxInput, addRule, addTransactions, setBudgets, upsertAccount, upsertGoal, upsertHolding } from './store';
import { refreshQuotes } from './quotes';

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic());

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const SYSTEM = `You are the assistant inside Keel, a personal finance app that one person runs for their own money. The app tracks their accounts, spending, budgets, debts, investments and savings goals, and you are the part of it they talk to. Their main priorities are paying off debt efficiently, managing their investments, and building savings, and they want as little data entry as possible.

You work through tools that read and write this person's own data. Everything you see in tool results is theirs and already in the app; changes you make appear on their screen immediately.

How to be useful here:
- Ground every figure in a tool result. Call get_financial_overview before answering questions about their situation, and the search or breakdown tools when the question is about specific spending. If the data needed for an answer is not in the app, say what is missing and the quickest way to add it rather than estimating silently.
- When they tell you facts about their finances (an account, a balance, a debt and its rate, a purchase, a holding), record them straight away with the write tools, then say in a line or two what you saved. Do not ask for confirmation first; they told you so that you would enter it. If a detail that changes the math is missing (a debt's APR or minimum payment, a goal's target), record what you have and ask for the missing piece afterwards.
- When they paste or attach a statement, a list or a screenshot, extract every account, transaction or holding you can read from it and record them. Mention anything you could not read.
- When they ask you to change a budget, the debt plan or a goal, make the change. When you want to recommend a change they have not asked for, explain it with the numbers and either ask, or file it with create_suggestion so it appears as a card they can apply with one tap.
- Use the calculators instead of reasoning about interest or growth in your head: simulate_debt_payoff for payoff plans, plan_windfall for a lump sum, compare_debt_vs_invest for spare monthly money, evaluate_refinance for a balance transfer or consolidation loan, and forecast_net_worth for the long view. They run on this person's real balances and match what the Plan page of the app shows.
- Sign conventions: transaction amounts are negative for money out and positive for money in. Credit card and loan balances are the amount owed, stored as positive numbers.

How to write: this is a chat panel, often on a phone. Lead with the answer, keep replies short, use specific dollar amounts and dates, and write in plain language. Short paragraphs and the occasional brief list are fine; no tables or headings.

You give general financial education, not licensed advice. You can explain trade-offs, do the math on their real numbers and say what the usual approach is. Do not recommend buying or selling specific individual stocks or coins, and for tax or legal questions that depend on their jurisdiction say so once and suggest a professional, without repeating disclaimers in every message.

Budget categories you can use: ${CATEGORIES.map((c) => `${c.id} (${c.label})`).join(', ')}.`;

const BRIEF_PROMPT = `Do a routine check-in on this person's finances. Look at the overview, and dig into transactions or run payoff simulations where something looks worth understanding.

Then do two things:
1. If you find something worth acting on that is not already in the existing suggestions list from the overview, file it with create_suggestion: at most three, each with real numbers from their data, and with a one-tap action where one of the action types fits. File nothing if nothing is worth their attention; an empty list is a fine result.
2. Finish with the briefing itself as your final message: two to four sentences, under 80 words, plain text with no markdown. Say how the month is going, the one thing most worth their attention right now, and one thing that is going well if there is one. This text is shown at the top of their home screen, so write it to them directly and do not mention tools or the check-in itself.`;

const category = z.enum(CATEGORY_IDS as [string, ...string[]]);

const ActionInput = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('set_budgets'), budgets: z.array(BudgetInput).min(1) }),
    z.object({ type: z.literal('shift_budget'), from: category, to: category, amount: z.number().positive() }),
    z.object({ type: z.literal('set_extra_payment'), amount: z.number().min(0).describe('New total extra monthly debt payment') }),
    z.object({ type: z.literal('set_strategy'), strategy: z.enum(['avalanche', 'snowball']) }),
    z.object({ type: z.literal('create_goal'), goal: z.object({ name: z.string(), kind: z.enum(['savings', 'emergency', 'purchase', 'invest']), target_amount: z.number().positive(), monthly_contribution: z.number().min(0), linked_account_id: z.string().nullish(), target_date: z.string().nullish() }) }),
    z.object({ type: z.literal('set_goal_contribution'), goal_id: z.string(), monthly: z.number().min(0) }),
    z.object({ type: z.literal('set_target_allocation'), allocation: z.object({ us_stock: z.number(), intl_stock: z.number(), bond: z.number(), cash: z.number(), crypto: z.number(), other: z.number() }).partial() }),
  ])
  .and(z.object({ label: z.string().min(2).max(48).describe('Text for the button, e.g. "Raise extra payment to $250/mo"') }));

function overview() {
  const s = buildState();
  const plan = s.debts.length
    ? simulatePayoff(s.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), s.settings.strategy, s.settings.extra_payment)
    : null;
  return {
    today: s.today,
    totals: s.totals,
    accounts: s.accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, subtype: a.subtype, balance: a.balance, credit_limit: a.credit_limit, apr: a.apr, min_payment: a.min_payment, due_day: a.due_day, linked: !a.manual })),
    this_month: { month: s.month.key, day: s.month.dayOfMonth, days_in_month: s.month.daysInMonth, income: s.month.income, spending: s.month.spending, budgeted: s.month.budgeted, safe_to_spend_per_day: s.month.safeToSpendToday },
    averages_last_3_months: { income: s.monthlyIncomeAvg, spending: s.monthlySpendAvg, essentials: s.monthlyEssentials },
    monthly_cash_flow: s.flows,
    budget_lines: s.budgets.map((b) => ({ ...b, label: categoryLabel(b.category) })),
    debts: s.debts,
    debt_plan: { strategy: s.settings.strategy, extra_monthly: s.settings.extra_payment, months_to_debt_free: plan?.months ?? null, debt_free_month: plan?.months ? addMonths(s.today, plan.months) : null, total_interest_remaining: plan?.totalInterest ?? null },
    goals: s.goals,
    investments: { total: s.totals.investments, allocation_pct: allocation(s.holdings), target_allocation_pct: s.settings.target_allocation, holdings: s.holdings.map((h) => ({ id: h.id, account_id: h.account_id, symbol: h.symbol, name: h.name, quantity: h.quantity, price: h.price, value: Math.round(h.quantity * h.price * 100) / 100, cost_basis: h.cost_basis, asset_class: h.asset_class })) },
    recurring_charges: s.recurring,
    next_dollar: s.nextDollar ? { title: s.nextDollar.title, reason: s.nextDollar.reason } : null,
    existing_suggestions: s.insights.map((i) => ({ title: i.title, severity: i.severity, area: i.area, has_action: !!i.action })),
    emergency_fund_target_months: s.settings.emergency_months,
    using_demo_data: s.settings.demo,
  };
}

const payoffDebts = (debts: { id: string; name: string; balance: number; apr: number; min_payment: number }[]): PayoffDebt[] =>
  debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment }));

interface RunContext {
  changed: boolean;
}

function tools(ctx: RunContext) {
  const wrote = <T,>(v: T) => {
    ctx.changed = true;
    return JSON.stringify(v);
  };
  const safe = <A,>(fn: (a: A) => string | Promise<string>) => async (a: A) => {
    try {
      return await fn(a);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const eager = { eager_input_streaming: true } as const;

  return [
    betaZodTool({
      name: 'get_financial_overview',
      description: 'The full current picture: net worth, every account, this month vs budget, cash flow by month, debts and the payoff plan, goals, holdings and allocation, recurring charges, and suggestions already on screen. Call this first for any question about their situation.',
      inputSchema: z.object({}),
      run: safe(() => JSON.stringify(overview())),
      ...eager,
    }),
    betaZodTool({
      name: 'search_transactions',
      description: 'Find individual transactions. All filters are optional and combine. Returns newest first.',
      inputSchema: z.object({
        text: z.string().nullish().describe('Matches merchant or description'),
        category: category.nullish(),
        account_id: z.string().nullish(),
        from: z.string().nullish().describe('YYYY-MM-DD inclusive'),
        to: z.string().nullish().describe('YYYY-MM-DD inclusive'),
        min_abs_amount: z.number().nullish(),
        limit: z.number().int().min(1).max(200).nullish(),
      }),
      run: safe((a) => {
        const where: string[] = [];
        const p: unknown[] = [];
        if (a.text) (where.push("LOWER(COALESCE(merchant,'') || ' ' || name) LIKE ?"), p.push(`%${a.text.toLowerCase()}%`));
        if (a.category) (where.push('category = ?'), p.push(a.category));
        if (a.account_id) (where.push('account_id = ?'), p.push(a.account_id));
        if (a.from) (where.push('date >= ?'), p.push(a.from));
        if (a.to) (where.push('date <= ?'), p.push(a.to));
        if (a.min_abs_amount) (where.push('ABS(amount) >= ?'), p.push(a.min_abs_amount));
        const sql = `FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
        const rows = q.all(`SELECT id, date, amount, COALESCE(merchant, name) AS name, category, account_id, pending ${sql} ORDER BY date DESC LIMIT ?`, ...p, a.limit ?? 50);
        const agg = q.get<{ n: number; total: number }>(`SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total ${sql}`, ...p)!;
        return JSON.stringify({ matching: agg.n, net_total: Math.round(agg.total * 100) / 100, shown: rows.length, transactions: rows });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'get_spending_breakdown',
      description: 'Total money out over a date range, grouped by category, merchant or month. Excludes transfers and savings moves.',
      inputSchema: z.object({ from: z.string().describe('YYYY-MM-DD'), to: z.string().describe('YYYY-MM-DD'), group_by: z.enum(['category', 'merchant', 'month']) }),
      run: safe((a) => {
        const col = a.group_by === 'category' ? 'category' : a.group_by === 'merchant' ? 'COALESCE(merchant, name)' : 'SUBSTR(date, 1, 7)';
        const rows = q.all(
          `SELECT ${col} AS key, ROUND(-SUM(amount), 2) AS spent, COUNT(*) AS count FROM transactions
           WHERE date >= ? AND date <= ? AND category NOT IN ('income', 'transfer', 'savings') GROUP BY 1 HAVING spent > 0 ORDER BY ${a.group_by === 'month' ? 'key' : 'spent DESC'} LIMIT 40`,
          a.from, a.to,
        );
        return JSON.stringify(rows);
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'simulate_debt_payoff',
      description: 'Run the month-by-month payoff simulation on their current debts. Use it to compare strategies, extra payments or a lump sum. Does not change anything.',
      inputSchema: z.object({
        strategy: z.enum(['avalanche', 'snowball']).describe('avalanche = highest rate first, snowball = smallest balance first'),
        extra_monthly: z.number().min(0).describe('Paid on top of all minimums each month'),
        lump_sum: z.number().min(0).nullish().describe('One-off payment made now'),
      }),
      run: safe((a) => {
        const { state: s } = buildCore();
        if (!s.debts.length) return 'No debts are recorded.';
        const r = simulatePayoff(s.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), a.strategy, a.extra_monthly, a.lump_sum ?? 0);
        return JSON.stringify({
          months: r.months,
          debt_free_month: r.months ? addMonths(s.today, r.months) : 'not within 50 years',
          total_interest: r.totalInterest,
          total_paid: r.totalPaid,
          payoff_order: r.order.map((id) => ({ name: s.debts.find((d) => d.id === id)!.name, paid_off_month: r.payoffMonth[id] ? addMonths(s.today, r.payoffMonth[id]!) : null, interest: r.interestByDebt[id] })),
          minimum_does_not_cover_interest: r.underwater.map((id) => s.debts.find((d) => d.id === id)!.name),
        });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'plan_windfall',
      description: 'Split a lump sum (bonus, tax refund, gift) in priority order: one-month cash cushion, debt at 8% APR or more by rate, full emergency fund, then investing. Returns each step and the interest and time it saves. Does not change anything.',
      inputSchema: z.object({ amount: z.number().positive() }),
      run: safe((a) => {
        const { state: s } = buildCore();
        const plan = allocateWindfall({ amount: a.amount, cash: s.totals.cash, essentials: s.monthlyEssentials || 1000, emergencyMonths: s.settings.emergency_months, debts: payoffDebts(s.debts), strategy: s.settings.strategy, extra: s.settings.extra_payment });
        return JSON.stringify({
          steps: plan.steps.map(({ target, label, amount, note }) => ({ target, label, amount, note })),
          to_debt: plan.toDebt,
          interest_saved: plan.interestSaved,
          debt_free_before: plan.monthsBefore != null ? addMonths(s.today, plan.monthsBefore) : null,
          debt_free_after: plan.monthsAfter != null ? addMonths(s.today, plan.monthsAfter) : null,
        });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'compare_debt_vs_invest',
      description: 'Compare sending the same spare monthly amount to debt first versus investing it from day one, with equal total spending on both paths and freed payments invested once debt is gone. Returns where each path ends and the investment return at which they break even. Does not change anything.',
      inputSchema: z.object({ monthly: z.number().positive(), annual_return_pct: z.number().min(0).max(20).describe('Expected investment return, e.g. 7'), years: z.number().int().min(1).max(40) }),
      run: safe((a) => {
        const { state: s } = buildCore();
        if (!s.debts.length) return 'No debts are recorded, so there is nothing to compare: spare money goes to the emergency fund and then investing.';
        const r = debtVsInvest(payoffDebts(s.debts), s.settings.strategy, s.settings.extra_payment, a.monthly, a.annual_return_pct, a.years);
        const m = a.years * 12;
        const side = (p: typeof r.debtFirst) => ({ debt_free_month: p.debtFreeMonth != null ? addMonths(s.today, p.debtFreeMonth) : null, interest_paid: p.interestPaid, invested_at_end: p.invested[m], owed_at_end: p.debt[m], net_at_end: p.net[m] });
        return JSON.stringify({ debt_first: side(r.debtFirst), invest_first: side(r.investFirst), debt_first_advantage: r.advantage, break_even_return_pct: r.breakEvenReturn });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'evaluate_refinance',
      description: 'Compare carrying on with chosen debts against a 0% balance transfer or a fixed-term consolidation loan, counting interest and fees. Use the terms of the real offer when the user has one; otherwise say which typical terms you assumed. Does not change anything.',
      inputSchema: z.object({
        account_ids: z.array(z.string()).min(1).describe('Debt account ids from the overview'),
        monthly_payment: z.number().positive().nullish().describe('What they pay toward these debts each month; defaults to minimums plus the plan extra'),
        kind: z.enum(['transfer', 'loan']),
        fee_pct: z.number().min(0).max(10).describe('Transfer fee or loan origination fee, e.g. 3'),
        promo_months: z.number().int().min(1).max(36).nullish().describe('Transfer only: length of the 0% period'),
        rate_after_pct: z.number().min(0).max(40).nullish().describe('Transfer only: APR once the promotion ends'),
        loan_apr_pct: z.number().min(0).max(40).nullish().describe('Loan only'),
        loan_term_months: z.number().int().min(6).max(120).nullish().describe('Loan only'),
      }),
      run: safe((a) => {
        const { state: s } = buildCore();
        const chosen = payoffDebts(s.debts.filter((d) => a.account_ids.includes(d.id)));
        if (!chosen.length) return 'None of those ids is a debt account. Use the ids listed under debts in the overview.';
        const pay = a.monthly_payment ?? chosen.reduce((t, d) => t + d.minPayment, 0) + s.settings.extra_payment;
        const r = compareRefinance(chosen, pay, a.kind === 'transfer'
          ? { kind: 'transfer', feePct: a.fee_pct, promoMonths: a.promo_months ?? 15, promoApr: 0, afterApr: a.rate_after_pct ?? 25 }
          : { kind: 'loan', apr: a.loan_apr_pct ?? 12, termMonths: a.loan_term_months ?? 36, feePct: a.fee_pct });
        return JSON.stringify({ balance: r.balance, keep_as_is: r.current, refinanced: r.option, savings: r.savings, monthly_needed_to_clear_in_promo: r.neededForPromo, clears_in_promo: r.clearsInPromo });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'forecast_net_worth',
      description: "Project net worth, investments and debt forward under the current debt plan. Use an after-inflation return so figures are in today's dollars. Returns yearly checkpoints and when investments would reach 25 times annual spending. Does not change anything.",
      inputSchema: z.object({ monthly_invest: z.number().min(0), annual_return_pct: z.number().min(0).max(15).describe('After inflation, e.g. 5'), years: z.number().int().min(1).max(50), reinvest_freed_payments: z.boolean().nullish().describe('Keep paying the same amount into investments once debts are gone; default true') }),
      run: safe((a) => {
        const { state: s } = buildCore();
        const goalMoney = s.goals.filter((g) => g.progress < g.target_amount).reduce((t, g) => t + g.monthly_contribution, 0);
        const f = forecast({ debts: payoffDebts(s.debts), strategy: s.settings.strategy, extra: s.settings.extra_payment, cash: s.totals.cash, investments: s.totals.investments, otherAssets: s.totals.otherAssets, monthlySave: goalMoney, monthlyInvest: a.monthly_invest, annualReturn: a.annual_return_pct, years: a.years, rollover: a.reinvest_freed_payments ?? true });
        const target = independenceNumber(s.monthlySpendAvg);
        const hit = target > 0 ? monthReached(f.invested, target) : null;
        const step = a.years <= 10 ? 1 : 5;
        const checkpoints = [];
        for (let y = 0; y <= a.years; y += step) checkpoints.push({ year: addMonths(s.today, y * 12).slice(0, 4), net_worth: f.net[y * 12], invested: f.invested[y * 12], debt: f.debt[y * 12] });
        return JSON.stringify({ assumes_monthly_to_goals: goalMoney, debt_free_month: f.debtFreeMonth != null ? addMonths(s.today, f.debtFreeMonth) : null, checkpoints, final_net_worth: f.net[a.years * 12], independence_target: target, independence_reached: hit != null ? addMonths(s.today, hit) : `not within ${a.years} years` });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'save_accounts',
      description: 'Create or update accounts: bank accounts, credit cards, loans, investment accounts, or assets such as a home or car. Pass id to update an existing one (for example to correct a balance).',
      inputSchema: z.object({ accounts: z.array(AccountInput).min(1) }),
      run: safe((a) => wrote({ saved: a.accounts.map((x) => ({ id: upsertAccount(x, 'assistant'), name: x.name })) })),
      ...eager,
    }),
    betaZodTool({
      name: 'add_transactions',
      description: 'Record transactions the user tells you about or that you read from a statement. Exact repeats are skipped. Category is filled in automatically when omitted.',
      inputSchema: z.object({ transactions: z.array(TxInput).min(1), update_balance: z.boolean().nullish().describe('True when this is a new purchase or payment on a hand-entered account and its balance should move; false when importing history') }),
      run: safe((a) => wrote(addTransactions(a.transactions, 'assistant', { adjustBalance: !!a.update_balance }))),
      ...eager,
    }),
    betaZodTool({
      name: 'set_budgets',
      description: 'Set the monthly budget for one or more categories. An amount of 0 removes that budget line.',
      inputSchema: z.object({ budgets: z.array(BudgetInput).min(1) }),
      run: safe((a) => (setBudgets(a.budgets), wrote({ ok: true }))),
      ...eager,
    }),
    betaZodTool({
      name: 'save_goal',
      description: 'Create or update a savings goal. Link it to an account to track progress from that balance automatically.',
      inputSchema: GoalInput,
      run: safe((a) => wrote({ id: upsertGoal(a) })),
      ...eager,
    }),
    betaZodTool({
      name: 'save_holdings',
      description: 'Add or update investment positions inside an investment account (create the account first with save_accounts). Prices for common tickers are looked up automatically.',
      inputSchema: z.object({ holdings: z.array(HoldingInput).min(1) }),
      run: safe(async (a) => {
        const ids = a.holdings.map((h) => upsertHolding(h));
        await refreshQuotes().catch(() => 0);
        return wrote({ saved: ids.length });
      }),
      ...eager,
    }),
    betaZodTool({
      name: 'set_debt_plan',
      description: 'Change the payoff strategy and/or the extra amount paid toward debt each month.',
      inputSchema: z.object({ strategy: z.enum(['avalanche', 'snowball']).nullish(), extra_monthly: z.number().min(0).nullish() }),
      run: safe((a) => (patchSettings({ ...(a.strategy ? { strategy: a.strategy } : {}), ...(a.extra_monthly != null ? { extra_payment: a.extra_monthly } : {}) }), wrote({ ok: true }))),
      ...eager,
    }),
    betaZodTool({
      name: 'set_investment_targets',
      description: 'Set the target portfolio mix in percent (should total 100) and/or how many months of essentials the emergency fund should cover.',
      inputSchema: z.object({
        allocation: z.object({ us_stock: z.number(), intl_stock: z.number(), bond: z.number(), cash: z.number(), crypto: z.number(), other: z.number() }).partial().nullish(),
        emergency_months: z.number().min(1).max(24).nullish(),
      }),
      run: safe((a) => (patchSettings({ ...(a.allocation ? { target_allocation: a.allocation } : {}), ...(a.emergency_months ? { emergency_months: a.emergency_months } : {}) }), wrote({ ok: true }))),
      ...eager,
    }),
    betaZodTool({
      name: 'categorize_merchant',
      description: 'Always file transactions whose description contains this text under a category. Re-files matching history and applies to future imports.',
      inputSchema: z.object({ contains: z.string().min(2), category }),
      run: safe((a) => wrote({ refiled: addRule(a.contains, a.category) })),
      ...eager,
    }),
    betaZodTool({
      name: 'create_suggestion',
      description: 'File a suggestion that appears as a card on the home screen, optionally with a one-tap action. Use for recommendations the user has not asked for; when they ask you directly to make a change, make it instead.',
      inputSchema: z.object({
        title: z.string().min(4).max(90).describe('The finding, with its key number'),
        body: z.string().min(10).max(420).describe('Why it matters and what the change does, in one to three sentences'),
        area: z.enum(['budget', 'debt', 'invest', 'save', 'cash', 'general']),
        severity: z.enum(['critical', 'warn', 'info', 'good']),
        action: ActionInput.nullish(),
      }),
      run: safe((a) => wrote({ result: addAssistantInsight({ title: a.title, body: a.body, area: a.area, severity: a.severity, action: (a.action as InsightAction | null | undefined) ?? null }) })),
      ...eager,
    }),
  ];
}

export interface Attachment {
  name: string;
  media_type: string;
  /** base64 */
  data: string;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_TEXT_ATTACHMENT = 400_000;

function attachmentBlocks(files: Attachment[]): Anthropic.Beta.BetaContentBlockParam[] {
  return files.map((f): Anthropic.Beta.BetaContentBlockParam => {
    if (IMAGE_TYPES.has(f.media_type)) return { type: 'image', source: { type: 'base64', media_type: f.media_type as 'image/png', data: f.data } };
    if (f.media_type === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } };
    const text = Buffer.from(f.data, 'base64').toString('utf8');
    if (text.length > MAX_TEXT_ATTACHMENT) throw new Error(`${f.name} is too large to read in one message. Use the CSV import on the Activity page for big exports.`);
    return { type: 'text', text: `Attached file "${f.name}":\n${text}` };
  });
}

function request(messages: Anthropic.Beta.BetaMessageParam[], ctx: RunContext) {
  return {
    model: MODEL,
    max_tokens: 32000,
    system: [{ type: 'text' as const, text: SYSTEM, cache_control: { type: 'ephemeral' as const } }],
    tools: tools(ctx),
    messages,
    output_config: { effort: 'medium' as const },
    max_iterations: 16,
    // If the model declines a request on policy grounds, let the API retry it on its default fallback.
    ...(FALLBACK_MODELS.has(MODEL) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
}

function history(): Anthropic.Beta.BetaMessageParam[] {
  const rows = q.all<{ role: 'user' | 'assistant'; text: string }>('SELECT role, text FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 30) ORDER BY id');
  while (rows.length && rows[0].role !== 'user') rows.shift();
  return rows.map((r) => ({ role: r.role, content: r.text }));
}

const stamp = () => {
  const d = new Date();
  return `[${d.toLocaleDateString('en-US', { weekday: 'long' })} ${isoDate(d)}]`;
};

export type ChatEvent = { type: 'text'; delta: string } | { type: 'tool'; name: string } | { type: 'done'; changed: boolean } | { type: 'error'; message: string };

const TOOL_LABEL: Record<string, string> = {
  get_financial_overview: 'Looking at your finances',
  search_transactions: 'Searching transactions',
  get_spending_breakdown: 'Adding up spending',
  simulate_debt_payoff: 'Running payoff scenarios',
  plan_windfall: 'Planning the lump sum',
  compare_debt_vs_invest: 'Comparing debt and investing',
  evaluate_refinance: 'Pricing the refinance',
  forecast_net_worth: 'Projecting your net worth',
  save_accounts: 'Saving accounts',
  add_transactions: 'Recording transactions',
  set_budgets: 'Updating budget',
  save_goal: 'Saving goal',
  save_holdings: 'Saving holdings',
  set_debt_plan: 'Updating debt plan',
  set_investment_targets: 'Updating targets',
  categorize_merchant: 'Re-filing transactions',
  create_suggestion: 'Filing a suggestion',
};

class TruncatedToolInput extends Error {}

export function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.';
  if (err instanceof Anthropic.PermissionDeniedError) return `This API key cannot use ${MODEL}. Set ANTHROPIC_MODEL in .env to a model your account has.`;
  if (err instanceof Anthropic.NotFoundError) return `Model ${MODEL} was not found. Check ANTHROPIC_MODEL in .env.`;
  if (err instanceof Anthropic.RateLimitError) return 'The assistant is rate limited right now. Give it a minute and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `The assistant ran into an API error (${err.status ?? 'unknown'}): ${err.message}`;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** One chat turn: streams text and tool activity to `send`, and stores both sides when done. */
export async function chat(text: string, attachments: Attachment[], send: (e: ChatEvent) => void): Promise<void> {
  const ctx: RunContext = { changed: false };
  const content: Anthropic.Beta.BetaContentBlockParam[] = [...attachmentBlocks(attachments), { type: 'text', text: `${stamp()} ${text}` }];
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history(), { role: 'user', content }];
  const note = attachments.length ? ` (attached: ${attachments.map((a) => a.name).join(', ')})` : '';
  q.run('INSERT INTO chat (role, text, created_at) VALUES (?, ?, ?)', 'user', text + note, nowIso());

  let reply = '';
  let runner = anthropic().beta.messages.toolRunner({ ...request(messages, ctx), stream: true });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const stream of runner) {
          let turn = '';
          for await (const event of stream) {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              send({ type: 'tool', name: TOOL_LABEL[event.content_block.name] ?? 'Working' });
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              if (!turn && reply) {
                reply += '\n\n';
                send({ type: 'text', delta: '\n\n' });
              }
              turn += event.delta.text;
              send({ type: 'text', delta: event.delta.text });
            }
          }
          reply += turn;
          const message = await stream.finalMessage();
          attempt = 0;
          if (message.stop_reason === 'refusal') {
            const line = 'I am not able to help with that request.';
            if (!reply) send({ type: 'text', delta: line });
            reply ||= line;
            break;
          }
          if (message.stop_reason === 'max_tokens' && message.content.some((b) => b.type === 'tool_use')) {
            throw new TruncatedToolInput('The reply was cut off before a change could be saved. Try asking for it in smaller pieces.');
          }
        }
        break;
      } catch (err) {
        // A tool input that could not be parsed rejects the turn; re-issue it a couple of times.
        if (err instanceof Anthropic.APIError || err instanceof TruncatedToolInput || attempt >= 2) throw err;
        runner = anthropic().beta.messages.toolRunner({ ...runner.params, stream: true });
      }
    }
    if (reply.trim()) q.run('INSERT INTO chat (role, text, created_at) VALUES (?, ?, ?)', 'assistant', reply.trim(), nowIso());
    if (ctx.changed) refreshInsights();
    send({ type: 'done', changed: ctx.changed });
  } catch (err) {
    if (reply.trim()) q.run('INSERT INTO chat (role, text, created_at) VALUES (?, ?, ?)', 'assistant', reply.trim(), nowIso());
    else q.run("DELETE FROM chat WHERE id = (SELECT MAX(id) FROM chat) AND role = 'user'");
    if (ctx.changed) refreshInsights();
    send({ type: 'error', message: errorMessage(err) });
  }
}

/** The assistant's own check-in: files suggestions and writes the home-screen briefing. */
export async function runBriefing(): Promise<string> {
  const ctx: RunContext = { changed: false };
  q.run("DELETE FROM insights WHERE source = 'assistant' AND status = 'new'");
  const final = await anthropic().beta.messages.toolRunner({
    ...request([{ role: 'user', content: `${stamp()} ${BRIEF_PROMPT}` }], ctx),
    max_tokens: 16000,
  });
  if (final.stop_reason === 'refusal') throw new Error('The assistant declined to write a briefing.');
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (text) setSetting('brief', { text, at: nowIso(), source: 'assistant' });
  return text;
}
