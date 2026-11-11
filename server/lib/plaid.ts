import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type AccountBase,
  type LinkTokenCreateRequest,
  type RemovedTransaction,
  type Transaction as PlaidTransaction,
} from 'plaid/legacy';
import { q, uid, nowIso } from '../db';
import { fromPlaidCategory, categorize, type UserRule } from '../../shared/categories';
import type { AccountType, AssetClass } from '../../shared/types';
import { guessAssetClass } from './quotes';

export const plaidEnv = () => (process.env.PLAID_ENV === 'production' ? 'production' : 'sandbox');
export const plaidConfigured = () => !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

let client: PlaidApi | null = null;
function plaid(): PlaidApi {
  if (!plaidConfigured()) throw new Error('Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env.');
  client ??= new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[plaidEnv()],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
          'PLAID-SECRET': process.env.PLAID_SECRET!,
        },
      },
    }),
  );
  return client;
}

/** Plaid errors carry the request (and therefore the secret) — surface only the message. */
export function plaidMessage(err: any): { code: string; message: string } {
  const data = err?.response?.data;
  if (data?.error_code) return { code: data.error_code, message: data.display_message || data.error_message || data.error_code };
  return { code: 'UNKNOWN', message: err?.message ?? 'Plaid request failed' };
}

// --- access-token storage ---------------------------------------------------------
const encKey = () => (process.env.DATA_ENCRYPTION_KEY ? createHash('sha256').update(process.env.DATA_ENCRYPTION_KEY).digest() : null);

function seal(token: string): string {
  const key = encKey();
  if (!key) return token;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `enc:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

function unseal(stored: string): string {
  if (!stored.startsWith('enc:')) return stored;
  const key = encKey();
  if (!key) throw new Error('This connection was saved with DATA_ENCRYPTION_KEY set. Restore that key to keep syncing.');
  const raw = Buffer.from(stored.slice(4), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// --- Link ---------------------------------------------------------------------------
export type LinkMode = 'banking' | 'investments' | 'loans';

/**
 * Each mode requires only one product so the widest set of institutions shows up in
 * Link, and asks for the others where the institution happens to support them.
 */
export async function createLinkToken(mode: LinkMode, itemId?: string): Promise<string> {
  const base: LinkTokenCreateRequest = {
    user: { client_user_id: 'keel-owner' },
    client_name: 'Keel',
    language: 'en',
    country_codes: [CountryCode.Us],
    ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
  };
  if (itemId) {
    // Update mode: repair a connection whose login expired.
    const item = q.get<{ access_token: string }>('SELECT access_token FROM items WHERE id = ?', itemId);
    if (!item) throw new Error('Connection not found');
    const res = await plaid().linkTokenCreate({ ...base, access_token: unseal(item.access_token) });
    return res.data.link_token;
  }
  const others = (primary: Products) => [Products.Transactions, Products.Liabilities, Products.Investments].filter((p) => p !== primary);
  const primary = mode === 'investments' ? Products.Investments : mode === 'loans' ? Products.Liabilities : Products.Transactions;
  const res = await plaid().linkTokenCreate({
    ...base,
    products: [primary],
    required_if_supported_products: others(primary),
    transactions: { days_requested: 365 },
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string, institution: string): Promise<string> {
  const res = await plaid().itemPublicTokenExchange({ public_token: publicToken });
  const existing = q.get<{ id: string }>('SELECT id FROM items WHERE plaid_item_id = ?', res.data.item_id);
  const id = existing?.id ?? uid();
  if (existing) q.run("UPDATE items SET access_token = ?, status = 'ok', error = NULL WHERE id = ?", seal(res.data.access_token), id);
  else q.run('INSERT INTO items (id, plaid_item_id, access_token, institution) VALUES (?,?,?,?)', id, res.data.item_id, seal(res.data.access_token), institution || 'Linked institution');
  return id;
}

export async function removeItem(id: string) {
  const item = q.get<{ access_token: string }>('SELECT access_token FROM items WHERE id = ?', id);
  if (!item) return;
  try {
    await plaid().itemRemove({ access_token: unseal(item.access_token) });
  } catch {
    // The connection may already be gone on Plaid's side; removing our copy is what matters.
  }
  q.run('DELETE FROM items WHERE id = ?', id); // accounts, transactions and holdings cascade
}

// --- Sync ---------------------------------------------------------------------------
const TYPE: Record<string, AccountType> = { depository: 'depository', credit: 'credit', loan: 'loan', investment: 'investment', brokerage: 'investment', other: 'asset' };

function upsertAccount(itemId: string, institution: string, a: AccountBase): string {
  const type = TYPE[a.type] ?? 'asset';
  const balance = a.balances.current ?? a.balances.available ?? 0;
  const row = q.get<{ id: string }>('SELECT id FROM accounts WHERE plaid_account_id = ?', a.account_id);
  const id = row?.id ?? uid();
  if (row) {
    q.run('UPDATE accounts SET name = ?, mask = ?, type = ?, subtype = ?, balance = ?, credit_limit = COALESCE(?, credit_limit), updated_at = ? WHERE id = ?',
      a.name, a.mask ?? null, type, a.subtype ?? null, balance, type === 'credit' ? a.balances.limit ?? null : null, nowIso(), id);
  } else {
    q.run('INSERT INTO accounts (id, item_id, plaid_account_id, name, institution, mask, type, subtype, balance, credit_limit, manual, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)',
      id, itemId, a.account_id, a.official_name && a.official_name.length < 40 ? a.official_name : a.name, institution, a.mask ?? null, type, a.subtype ?? null, balance, type === 'credit' ? a.balances.limit ?? null : null, 'plaid', nowIso());
  }
  return id;
}

const isUnsupported = (code: string) =>
  ['PRODUCTS_NOT_SUPPORTED', 'NO_ACCOUNTS', 'NO_LIABILITY_ACCOUNTS', 'NO_INVESTMENT_ACCOUNTS', 'INVALID_PRODUCT', 'ADDITIONAL_CONSENT_REQUIRED', 'PRODUCT_NOT_ENABLED', 'PRODUCTS_NOT_READY', 'PRODUCT_NOT_READY', 'INVALID_ACCOUNT_ID'].includes(code);

async function syncTransactions(token: string, itemId: string, accountIds: Map<string, string>, rules: UserRule[]) {
  const start = q.get<{ cursor: string | null }>('SELECT cursor FROM items WHERE id = ?', itemId)?.cursor ?? undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = start;
    const added: PlaidTransaction[] = [];
    const modified: PlaidTransaction[] = [];
    const removed: RemovedTransaction[] = [];
    try {
      for (let more = true; more; ) {
        const res = await plaid().transactionsSync({ access_token: token, cursor, count: 500 });
        added.push(...res.data.added);
        modified.push(...res.data.modified);
        removed.push(...res.data.removed);
        more = res.data.has_more;
        cursor = res.data.next_cursor;
      }
    } catch (err) {
      // Plaid asks for a restart from the original cursor if data changed mid-pagination.
      if (plaidMessage(err).code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') continue;
      throw err;
    }
    const upsert = (t: PlaidTransaction) => {
      const accountId = accountIds.get(t.account_id);
      if (!accountId) return;
      const amount = -t.amount; // Plaid: positive = money out. Keel: negative = money out.
      const name = t.merchant_name || t.name;
      const cat = fromPlaidCategory(t.personal_finance_category?.primary, t.personal_finance_category?.detailed, amount) ?? categorize(name, amount);
      const ruled = rules.find((r) => name.toLowerCase().includes(r.pattern.toLowerCase()))?.category;
      q.run(
        `INSERT INTO transactions (id, account_id, plaid_transaction_id, date, amount, name, merchant, category, pending, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'plaid',?)
         ON CONFLICT(plaid_transaction_id) DO UPDATE SET date = excluded.date, amount = excluded.amount, name = excluded.name, merchant = excluded.merchant, pending = excluded.pending,
           category = CASE WHEN transactions.category_locked = 1 THEN transactions.category ELSE excluded.category END`,
        uid(), accountId, t.transaction_id, t.date, amount, t.name, t.merchant_name ?? null, ruled ?? cat, t.pending ? 1 : 0, nowIso(),
      );
    };
    added.forEach(upsert);
    modified.forEach(upsert);
    for (const r of removed) q.run('DELETE FROM transactions WHERE plaid_transaction_id = ?', r.transaction_id);
    q.run('UPDATE items SET cursor = ? WHERE id = ?', cursor ?? null, itemId);
    return added.length + modified.length;
  }
  throw new Error('Transactions kept changing during sync; try again shortly.');
}

async function syncLiabilities(token: string, accountIds: Map<string, string>) {
  const res = await plaid().liabilitiesGet({ access_token: token });
  const l = res.data.liabilities;
  const set = (plaidId: string | null | undefined, apr: number | null | undefined, min: number | null | undefined, due: string | null | undefined) => {
    const id = plaidId ? accountIds.get(plaidId) : undefined;
    if (!id) return;
    q.run('UPDATE accounts SET apr = COALESCE(?, apr), min_payment = COALESCE(?, min_payment), due_day = COALESCE(?, due_day) WHERE id = ?',
      apr ?? null, min && min > 0 ? min : null, due ? Number(due.slice(8, 10)) : null, id);
  };
  for (const c of l.credit ?? []) {
    const apr = c.aprs.find((a) => a.apr_type === 'purchase_apr') ?? c.aprs[0];
    set(c.account_id, apr?.apr_percentage, c.minimum_payment_amount, c.next_payment_due_date);
  }
  for (const s of l.student ?? []) set(s.account_id, s.interest_rate_percentage, s.minimum_payment_amount, s.next_payment_due_date);
  for (const m of l.mortgage ?? []) set(m.account_id, m.interest_rate?.percentage, m.next_monthly_payment, m.next_payment_due_date);
}

async function syncHoldings(token: string, accountIds: Map<string, string>) {
  const res = await plaid().investmentsHoldingsGet({ access_token: token });
  const securities = new Map(res.data.securities.map((s) => [s.security_id, s]));
  const touched = new Set<string>();
  for (const h of res.data.holdings) {
    const accountId = accountIds.get(h.account_id);
    if (!accountId) continue;
    if (!touched.has(accountId)) {
      q.run('DELETE FROM holdings WHERE account_id = ? AND manual = 0', accountId);
      touched.add(accountId);
    }
    const s = securities.get(h.security_id);
    const name = s?.name ?? s?.ticker_symbol ?? 'Holding';
    const cls: AssetClass = s?.is_cash_equivalent || s?.type === 'cash' ? 'cash' : s?.type === 'cryptocurrency' ? 'crypto' : s?.type === 'fixed income' ? 'bond' : guessAssetClass(s?.ticker_symbol ?? null, name);
    q.run('INSERT INTO holdings (id, account_id, plaid_security_id, symbol, name, quantity, price, cost_basis, asset_class, price_updated_at, manual) VALUES (?,?,?,?,?,?,?,?,?,?,0)',
      uid(), accountId, h.security_id, s?.ticker_symbol ?? null, name, h.quantity, h.institution_price, h.cost_basis ?? null, cls, nowIso());
  }
}

/** Pull balances, transactions, liabilities and holdings for one connection. */
export async function syncItem(itemId: string): Promise<{ transactions: number }> {
  const item = q.get<{ access_token: string; institution: string }>('SELECT access_token, institution FROM items WHERE id = ?', itemId);
  if (!item) throw new Error('Connection not found');
  const token = unseal(item.access_token);
  try {
    const acc = await plaid().accountsGet({ access_token: token });
    const accountIds = new Map<string, string>();
    for (const a of acc.data.accounts) accountIds.set(a.account_id, upsertAccount(itemId, item.institution, a));
    const rules = q.all<UserRule>('SELECT pattern, category FROM rules');

    let transactions = 0;
    const optional = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        if (!isUnsupported(plaidMessage(err).code)) throw err;
      }
    };
    await optional(async () => {
      transactions = await syncTransactions(token, itemId, accountIds, rules);
    });
    await optional(() => syncLiabilities(token, accountIds));
    await optional(() => syncHoldings(token, accountIds));
    q.run("UPDATE items SET status = 'ok', error = NULL, last_sync = ? WHERE id = ?", nowIso(), itemId);
    return { transactions };
  } catch (err) {
    const { code, message } = plaidMessage(err);
    q.run('UPDATE items SET status = ?, error = ? WHERE id = ?', code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error', message, itemId);
    throw new Error(message);
  }
}

export async function syncAll(): Promise<number> {
  if (!plaidConfigured()) return 0;
  let n = 0;
  for (const { id } of q.all<{ id: string }>('SELECT id FROM items')) {
    try {
      await syncItem(id);
      n++;
    } catch {
      // Recorded on the item; the UI shows it and offers a re-link.
    }
  }
  return n;
}
