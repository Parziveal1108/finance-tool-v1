import { beforeAll, describe, expect, it } from 'vitest';

process.env.KEEL_DB = ':memory:';
const NOW = new Date(2026, 10, 11, 9, 0, 0); // 11 Nov 2026

type Mods = { state: typeof import('../server/lib/state'); insights: typeof import('../server/lib/insights'); db: typeof import('../server/db'); demo: typeof import('../server/lib/demo') };
let m: Mods;

beforeAll(async () => {
  m = { state: await import('../server/lib/state'), insights: await import('../server/lib/insights'), db: await import('../server/db'), demo: await import('../server/lib/demo') };
  m.demo.loadDemo(NOW);
});

describe('state', () => {
  it('adds up net worth from accounts and holdings', () => {
    const { state } = m.state.buildCore(NOW);
    const t = state.totals;
    expect(t.netWorth).toBeCloseTo(t.cash + t.investments + t.otherAssets - t.debt, 2);
    expect(t.debt).toBeCloseTo(4862.37 + 1148.9 + 18420.55 + 9730.12, 2);
    // Investment account balances come from their holdings.
    const roth = state.accounts.find((a) => a.name === 'Roth IRA')!;
    expect(roth.balance).toBeCloseTo(22 * 291.4 + 31 * 67.8 + 14 * 73.25, 2);
  });

  it('keeps card payments and savings transfers out of spending', () => {
    const { state, txns } = m.state.buildCore(NOW);
    const october = txns.filter((t) => t.date.startsWith('2026-10'));
    const transfers = october.filter((t) => ['transfer', 'savings'].includes(t.category)).reduce((s, t) => s - t.amount, 0);
    const allOut = october.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0);
    const flow = state.flows.find((f) => f.month === '2026-10')!;
    expect(transfers).toBeGreaterThan(600);
    expect(flow.spending).toBeCloseTo(allOut - transfers, 1);
    expect(flow.income).toBeCloseTo(4910.24, 2);
  });

  it('builds the cumulative pace line up to today only', () => {
    const { state } = m.state.buildCore(NOW);
    expect(state.month.paceThis).toHaveLength(11);
    expect(state.month.paceLast).toHaveLength(31);
    expect(state.month.paceThis.at(-1)).toBeCloseTo(state.month.spending, 1);
    expect([...state.month.paceThis].sort((a, b) => a - b)).toEqual(state.month.paceThis);
  });

  it('finds fixed monthly charges and a real price rise, not variable bills', () => {
    const { state } = m.state.buildCore(NOW);
    const names = state.recurring.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Parkview Apartments Rent', 'Netflix', 'Spotify']));
    expect(state.recurring.find((r) => r.name === 'Netflix')!.changed).toBe(5);
    expect(state.recurring.find((r) => r.name === 'City Electric & Gas')?.changed ?? null).toBeNull();
    expect(names).not.toContain("Trader Joe's");
  });

  it('points the next spare dollar at the most expensive debt once a cushion exists', () => {
    const { state } = m.state.buildCore(NOW);
    expect(state.nextDollar!.target).toBe('debt');
    expect(state.nextDollar!.title).toContain('Northwind Store Card');
    expect(state.nextDollar!.steps.filter((s) => s.current)).toHaveLength(1);
  });
});

describe('monitor', () => {
  it('raises grounded suggestions with one-tap actions', () => {
    const drafts = m.insights.computeInsights(m.state.buildCore(NOW));
    const byKey = (prefix: string) => drafts.find((d) => d.key.startsWith(prefix));
    const over = byKey('budget:over:shopping')!;
    expect(over.severity).toBe('warn');
    expect(over.action).toMatchObject({ type: 'shift_budget', to: 'shopping' });
    expect(byKey('recurring:up:netflix')).toBeTruthy();
    expect(byKey('debt:accelerate')!.action).toMatchObject({ type: 'set_extra_payment' });
    expect(byKey('goal:behind')!.action).toMatchObject({ type: 'set_goal_contribution' });
    expect(byKey('invest:drift')).toBeTruthy();
    expect(byKey('invest:concentration')).toBeUndefined(); // NVDA is 18% of holdings, under the 20% line
    // Every key is unique so suggestions can be tracked and dismissed individually.
    expect(new Set(drafts.map((d) => d.key)).size).toBe(drafts.length);
  });

  it('applies a budget shift without changing the total', () => {
    const before = m.db.q.all<{ category: string; amount: number }>('SELECT * FROM budgets');
    const total = before.reduce((s, b) => s + b.amount, 0);
    m.insights.applyAction({ type: 'shift_budget', from: 'travel', to: 'shopping', amount: 60, label: '' });
    const after = new Map(m.db.q.all<{ category: string; amount: number }>('SELECT * FROM budgets').map((b) => [b.category, b.amount]));
    expect(after.get('travel')).toBe(40);
    expect(after.get('shopping')).toBe(310);
    expect([...after.values()].reduce((s, v) => s + v, 0)).toBe(total);
    // It never moves more than the donor has.
    m.insights.applyAction({ type: 'shift_budget', from: 'travel', to: 'shopping', amount: 500, label: '' });
    expect(m.db.q.get<{ amount: number }>("SELECT amount FROM budgets WHERE category = 'travel'")!.amount).toBe(0);
  });

  it('does not re-raise what is already listed, and remembers dismissals', () => {
    m.insights.refreshInsights();
    expect(m.insights.refreshInsights()).toHaveLength(0);
    const one = m.db.q.get<{ key: string }>("SELECT key FROM insights WHERE status = 'new' LIMIT 1")!;
    m.db.q.run("UPDATE insights SET status = 'dismissed' WHERE key = ?", one.key);
    m.insights.refreshInsights();
    expect(m.db.q.get<{ status: string }>('SELECT status FROM insights WHERE key = ?', one.key)!.status).toBe('dismissed');
  });

  it('drops a suggestion once its cause is gone', () => {
    m.db.q.run("UPDATE budgets SET amount = 5000 WHERE category = 'shopping'");
    m.insights.refreshInsights();
    expect(m.db.q.get("SELECT 1 FROM insights WHERE key LIKE 'budget:over:shopping%' AND status = 'new'")).toBeUndefined();
  });

  it('says nothing when there is no data', () => {
    m.db.wipeAll();
    expect(m.insights.computeInsights(m.state.buildCore(NOW))).toEqual([]);
    expect(m.state.buildCore(NOW).state.nextDollar).toBeNull();
  });
});

describe('store', () => {
  it('skips repeats on re-import and moves hand-entered balances on new entries', async () => {
    const store = await import('../server/lib/store');
    const id = store.upsertAccount({ name: 'Cash card', type: 'credit', balance: 100 });
    const rows = [
      { date: '2026-11-01', name: 'Coffee', amount: -4.5, account_id: id },
      { date: '2026-11-02', name: 'Lunch', amount: -12, account_id: id },
    ];
    expect(store.addTransactions(rows, 'csv')).toEqual({ added: 2, skipped: 0 });
    expect(store.addTransactions(rows, 'csv')).toEqual({ added: 0, skipped: 2 });
    expect(m.db.q.get<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', id)!.balance).toBe(100); // history import leaves the balance alone
    store.addTransactions([{ date: '2026-11-03', name: 'Dinner', amount: -30, account_id: id }], 'manual', { adjustBalance: true });
    expect(m.db.q.get<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', id)!.balance).toBe(130); // spending on a card raises what is owed
  });

  it('remembers a category rule and re-files history', async () => {
    const store = await import('../server/lib/store');
    expect(store.addRule('coffee', 'entertainment')).toBe(1);
    store.addTransactions([{ date: '2026-11-05', name: 'Coffee Roasters', amount: -6 }], 'manual');
    expect(m.db.q.get<{ category: string }>("SELECT category FROM transactions WHERE name = 'Coffee Roasters'")!.category).toBe('entertainment');
    expect(() => store.addRule('x', 'dining')).toThrow();
    expect(() => store.addRule('coffee', 'not-a-category')).toThrow();
  });
});
