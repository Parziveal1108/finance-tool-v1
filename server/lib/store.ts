import { z } from 'zod';
import { q, uid, nowIso, getSettings, patchSettings } from '../db';
import { CATEGORY_IDS, categorize, type UserRule } from '../../shared/categories';
import { guessAssetClass } from './quotes';

/** Writes shared by the HTTP routes and the assistant's tools, so both follow the same rules. */

const money = z.number().finite();
const category = z.enum(CATEGORY_IDS as [string, ...string[]]);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const AccountInput = z.object({
  id: z.string().optional().describe('Pass to update an existing account; omit to create one'),
  name: z.string().min(1).max(80),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'asset']).describe('depository = checking/savings; credit = credit card; loan = student/auto/mortgage/personal; investment = brokerage/retirement/crypto; asset = property, vehicle'),
  subtype: z.string().max(40).nullish().describe('e.g. checking, savings, student, auto, mortgage, personal, 401k, ira, brokerage, crypto'),
  institution: z.string().max(80).nullish(),
  balance: money.describe('What the account holds, or for credit/loan the amount owed as a positive number'),
  apr: z.number().min(0).max(100).nullish().describe('Interest rate in percent, for credit and loans'),
  min_payment: z.number().min(0).nullish().describe('Minimum monthly payment, for credit and loans'),
  credit_limit: z.number().min(0).nullish(),
  due_day: z.number().int().min(1).max(31).nullish().describe('Day of month the payment is due'),
});
export type AccountInput = z.infer<typeof AccountInput>;

export function upsertAccount(input: AccountInput, source = 'manual'): string {
  const a = AccountInput.parse(input);
  const exists = a.id ? q.get<{ id: string }>('SELECT id FROM accounts WHERE id = ?', a.id) : undefined;
  if (exists) {
    q.run('UPDATE accounts SET name = ?, type = ?, subtype = ?, institution = COALESCE(?, institution), balance = ?, apr = ?, min_payment = ?, credit_limit = ?, due_day = ?, updated_at = ? WHERE id = ?',
      a.name, a.type, a.subtype ?? null, a.institution ?? null, a.balance, a.apr ?? null, a.min_payment ?? null, a.credit_limit ?? null, a.due_day ?? null, nowIso(), exists.id);
    return exists.id;
  }
  const id = uid();
  q.run('INSERT INTO accounts (id, name, institution, type, subtype, balance, apr, min_payment, credit_limit, due_day, manual, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)',
    id, a.name, a.institution ?? null, a.type, a.subtype ?? null, a.balance, a.apr ?? null, a.min_payment ?? null, a.credit_limit ?? null, a.due_day ?? null, source, nowIso());
  if (a.type === 'depository' && !getSettings().default_account_id) patchSettings({ default_account_id: id });
  return id;
}

export const TxInput = z.object({
  date: isoDay,
  name: z.string().min(1).max(200),
  amount: money.describe('Signed: negative for money out, positive for money in'),
  category: category.nullish().describe('Leave out to categorise automatically'),
  account_id: z.string().nullish(),
  notes: z.string().max(500).nullish(),
});
export type TxInput = z.infer<typeof TxInput>;

export const userRules = () => q.all<UserRule>('SELECT pattern, category FROM rules');

/**
 * Insert transactions, skipping exact repeats (same account, day, amount, name) so that
 * re-importing an overlapping statement does not double count.
 */
export function addTransactions(rows: TxInput[], source: string, opts: { adjustBalance?: boolean } = {}): { added: number; skipped: number } {
  const rules = userRules();
  const fallback = getSettings().default_account_id;
  let added = 0;
  let skipped = 0;
  for (const raw of rows) {
    const t = TxInput.parse(raw);
    const accountId = t.account_id ?? fallback ?? null;
    const account = accountId ? q.get<{ id: string; type: string; manual: number }>('SELECT id, type, manual FROM accounts WHERE id = ?', accountId) : undefined;
    const dup = q.get('SELECT 1 FROM transactions WHERE date = ? AND ABS(amount - ?) < 0.005 AND name = ? AND account_id IS ?', t.date, t.amount, t.name, account?.id ?? null);
    if (dup) {
      skipped++;
      continue;
    }
    q.run('INSERT INTO transactions (id, account_id, date, amount, name, category, category_locked, source, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      uid(), account?.id ?? null, t.date, Math.round(t.amount * 100) / 100, t.name, t.category ?? categorize(t.name, t.amount, rules), t.category ? 1 : 0, source, t.notes ?? null, nowIso());
    // Hand-entered accounts have no feed, so a new entry moves the balance itself.
    if (opts.adjustBalance && account?.manual) {
      const delta = account.type === 'credit' || account.type === 'loan' ? -t.amount : t.amount;
      q.run('UPDATE accounts SET balance = ROUND(balance + ?, 2), updated_at = ? WHERE id = ?', delta, nowIso(), account.id);
    }
    added++;
  }
  return { added, skipped };
}

export const BudgetInput = z.object({ category, amount: z.number().min(0).max(1_000_000) });

export function setBudgets(list: z.infer<typeof BudgetInput>[]) {
  for (const b of list) {
    const { category: c, amount } = BudgetInput.parse(b);
    if (amount === 0) q.run('DELETE FROM budgets WHERE category = ?', c);
    else q.run('INSERT INTO budgets (category, amount) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET amount = excluded.amount', c, amount);
  }
}

export const GoalInput = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  kind: z.enum(['savings', 'emergency', 'purchase', 'invest']).default('savings'),
  target_amount: z.number().positive(),
  current_amount: z.number().min(0).default(0).describe('Saved so far; ignored when the goal is linked to an account'),
  linked_account_id: z.string().nullish().describe('Track progress from this account balance'),
  target_date: isoDay.nullish(),
  monthly_contribution: z.number().min(0).default(0),
});

export function upsertGoal(input: z.input<typeof GoalInput>): string {
  const g = GoalInput.parse(input);
  const exists = g.id ? q.get<{ id: string }>('SELECT id FROM goals WHERE id = ?', g.id) : undefined;
  if (exists) {
    q.run('UPDATE goals SET name = ?, kind = ?, target_amount = ?, current_amount = ?, linked_account_id = ?, target_date = ?, monthly_contribution = ? WHERE id = ?',
      g.name, g.kind, g.target_amount, g.current_amount, g.linked_account_id ?? null, g.target_date ?? null, g.monthly_contribution, exists.id);
    return exists.id;
  }
  const id = uid();
  q.run('INSERT INTO goals (id, name, kind, target_amount, current_amount, linked_account_id, target_date, monthly_contribution, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, g.name, g.kind, g.target_amount, g.current_amount, g.linked_account_id ?? null, g.target_date ?? null, g.monthly_contribution, nowIso());
  return id;
}

export const HoldingInput = z.object({
  id: z.string().optional(),
  account_id: z.string(),
  symbol: z.string().max(12).nullish().describe('Ticker, e.g. VTI or BTC. Leave out for funds without one'),
  name: z.string().max(120).nullish(),
  quantity: z.number().positive(),
  price: z.number().min(0).nullish().describe('Price per share; looked up automatically for known tickers when omitted'),
  cost_basis: z.number().min(0).nullish().describe('Total amount paid for the position'),
  asset_class: z.enum(['us_stock', 'intl_stock', 'bond', 'cash', 'crypto', 'other']).nullish(),
});

export function upsertHolding(input: z.input<typeof HoldingInput>): string {
  const h = HoldingInput.parse(input);
  const account = q.get<{ type: string }>('SELECT type FROM accounts WHERE id = ?', h.account_id);
  if (!account) throw new Error('Account not found');
  if (account.type !== 'investment') throw new Error('Holdings belong in an investment account');
  const symbol = h.symbol ? h.symbol.toUpperCase().trim() : null;
  const name = h.name?.trim() || symbol || 'Holding';
  const cls = h.asset_class ?? guessAssetClass(symbol, name);
  const exists = h.id
    ? q.get<{ id: string; price: number }>('SELECT id, price FROM holdings WHERE id = ?', h.id)
    : symbol
      ? q.get<{ id: string; price: number }>('SELECT id, price FROM holdings WHERE account_id = ? AND symbol = ? AND manual = 1', h.account_id, symbol)
      : undefined;
  if (exists) {
    q.run('UPDATE holdings SET symbol = ?, name = ?, quantity = ?, price = ?, cost_basis = ?, asset_class = ? WHERE id = ?',
      symbol, name, h.quantity, h.price ?? exists.price, h.cost_basis ?? null, cls, exists.id);
    return exists.id;
  }
  const id = uid();
  q.run('INSERT INTO holdings (id, account_id, symbol, name, quantity, price, cost_basis, asset_class, price_updated_at, manual) VALUES (?,?,?,?,?,?,?,?,?,1)',
    id, h.account_id, symbol, name, h.quantity, h.price ?? 0, h.cost_basis ?? null, cls, h.price != null ? nowIso() : null);
  return id;
}

/** "Always file X under Y": remembers the rule and re-files matching history. */
export function addRule(pattern: string, cat: string): number {
  const p = pattern.trim().toLowerCase();
  if (p.length < 2) throw new Error('Pattern is too short');
  category.parse(cat);
  q.run('INSERT INTO rules (pattern, category) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET category = excluded.category', p, cat);
  return q.run("UPDATE transactions SET category = ? WHERE LOWER(COALESCE(merchant, '') || ' ' || name) LIKE ? ESCAPE '\\'", cat, `%${p.replace(/[\\%_]/g, '\\$&')}%`).changes;
}
