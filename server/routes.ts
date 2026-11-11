import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { q, getSetting, patchSettings, setSetting, wipeAll } from './db';
import { CATEGORY_IDS } from '../shared/categories';
import { parseQuickEntry } from '../shared/quickadd';
import type { InsightAction, Settings } from '../shared/types';
import { buildState, toTransaction } from './lib/state';
import { applyAction, refreshInsights } from './lib/insights';
import { emit, subscribe } from './lib/events';
import { AccountInput, BudgetInput, GoalInput, HoldingInput, TxInput, addRule, addTransactions, setBudgets, upsertAccount, upsertGoal, upsertHolding, userRules } from './lib/store';
import { createLinkToken, exchangePublicToken, plaidConfigured, plaidMessage, removeItem, syncAll, syncItem } from './lib/plaid';
import { refreshQuotes } from './lib/quotes';
import { loadDemo } from './lib/demo';
import { aiConfigured } from './lib/ai-config';
import { chat, errorMessage, runBriefing, type Attachment } from './lib/agent';

export const api = Router();

const wrap = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
};

/** After any write: recompute the monitor and tell every open screen to refresh. */
export function changed(reason = 'update') {
  const fresh = refreshInsights();
  emit('state', { reason });
  for (const f of fresh) if (f.severity === 'critical' || f.severity === 'warn') emit('insight', { title: f.title, severity: f.severity });
  scheduleBriefing();
}

// --- AI briefing scheduling -------------------------------------------------------
let briefTimer: NodeJS.Timeout | null = null;
let briefRunning = false;
const BRIEF_EVERY_MS = 6 * 3600_000;

export async function briefing(force = false): Promise<void> {
  if (!aiConfigured() || briefRunning) return;
  const last = getSetting<{ at: string; source: string } | null>('brief', null);
  if (!force && last?.source === 'assistant' && Date.now() - Date.parse(last.at) < BRIEF_EVERY_MS) return;
  if (!buildState().hasData) return;
  briefRunning = true;
  try {
    await runBriefing();
    emit('state', { reason: 'briefing' });
  } finally {
    briefRunning = false;
  }
}

/** Data changes trigger a fresh AI check-in, debounced and at most every few hours. */
function scheduleBriefing() {
  if (!aiConfigured()) return;
  if (briefTimer) clearTimeout(briefTimer);
  briefTimer = setTimeout(() => {
    briefing().catch((err) => console.error('[briefing]', errorMessage(err)));
  }, 20_000);
  briefTimer.unref();
}

// --- State ------------------------------------------------------------------------
api.get('/state', wrap((_req, res) => res.json(buildState())));
api.get('/events', (_req, res) => subscribe(res));

api.patch('/settings', wrap((req, res) => {
  const body = z
    .object({
      strategy: z.enum(['avalanche', 'snowball']),
      extra_payment: z.number().min(0).max(1_000_000),
      target_allocation: z.record(z.string(), z.number().min(0).max(100)).nullable(),
      default_account_id: z.string().nullable(),
      emergency_months: z.number().min(1).max(24),
    })
    .partial()
    .parse(req.body);
  patchSettings(body as Partial<Settings>);
  changed('settings');
  res.json({ ok: true });
}));

// --- Accounts ---------------------------------------------------------------------
api.post('/accounts', wrap((req, res) => {
  const id = upsertAccount(AccountInput.parse(req.body));
  if (getSetting('demo', false) && !req.body.id) patchSettings({ demo: false });
  changed('account');
  res.json({ id });
}));

api.delete('/accounts/:id', wrap((req, res) => {
  q.run('DELETE FROM accounts WHERE id = ?', req.params.id);
  if (getSetting<string | null>('default_account_id', null) === req.params.id) patchSettings({ default_account_id: null });
  changed('account');
  res.json({ ok: true });
}));

// --- Transactions -----------------------------------------------------------------
api.get('/transactions', wrap((req, res) => {
  const p = z
    .object({ text: z.string().optional(), category: z.string().optional(), account: z.string().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) })
    .parse(req.query);
  const where: string[] = [];
  const args: unknown[] = [];
  if (p.text) (where.push("LOWER(COALESCE(merchant,'') || ' ' || name) LIKE ?"), args.push(`%${p.text.toLowerCase()}%`));
  if (p.category) (where.push('category = ?'), args.push(p.category));
  if (p.account) (where.push('account_id = ?'), args.push(p.account));
  if (p.month) (where.push('date LIKE ?'), args.push(`${p.month}-%`));
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = q.all(`SELECT * FROM transactions ${sql} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`, ...args, p.limit, p.offset);
  const total = q.get<{ n: number }>(`SELECT COUNT(*) n FROM transactions ${sql}`, ...args)!.n;
  res.json({ total, transactions: rows.map(toTransaction) });
}));

api.post('/transactions', wrap((req, res) => {
  const result = addTransactions([TxInput.parse(req.body)], 'manual', { adjustBalance: true });
  changed('transaction');
  res.json(result);
}));

/** "coffee 4.50", "rent 1450 yesterday", "+2400 paycheck". */
api.post('/quick-add', wrap((req, res) => {
  const { text, account_id } = z.object({ text: z.string().min(1).max(200), account_id: z.string().nullish() }).parse(req.body);
  const entry = parseQuickEntry(text, new Date(), userRules());
  if (!entry) return res.status(422).json({ error: 'Add an amount, for example "coffee 4.50".' });
  addTransactions([{ ...entry, account_id: account_id ?? null }], 'manual', { adjustBalance: true });
  changed('transaction');
  res.json({ entry });
}));

api.patch('/transactions/:id', wrap((req, res) => {
  const body = z
    .object({ category: z.enum(CATEGORY_IDS as [string, ...string[]]), name: z.string().min(1).max(200), amount: z.number().finite(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().max(500).nullable(), remember: z.boolean() })
    .partial()
    .parse(req.body);
  const tx = q.get<{ name: string; merchant: string | null }>('SELECT name, merchant FROM transactions WHERE id = ?', req.params.id);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  if (body.category) q.run('UPDATE transactions SET category = ?, category_locked = 1 WHERE id = ?', body.category, req.params.id);
  if (body.name) q.run('UPDATE transactions SET name = ? WHERE id = ?', body.name, req.params.id);
  if (body.amount != null) q.run('UPDATE transactions SET amount = ? WHERE id = ?', body.amount, req.params.id);
  if (body.date) q.run('UPDATE transactions SET date = ? WHERE id = ?', body.date, req.params.id);
  if (body.notes !== undefined) q.run('UPDATE transactions SET notes = ? WHERE id = ?', body.notes, req.params.id);
  let refiled = 0;
  if (body.category && body.remember) refiled = addRule((tx.merchant || tx.name).replace(/[0-9#*]+/g, ' ').trim().slice(0, 30), body.category);
  changed('transaction');
  res.json({ ok: true, refiled });
}));

api.delete('/transactions/:id', wrap((req, res) => {
  q.run('DELETE FROM transactions WHERE id = ?', req.params.id);
  changed('transaction');
  res.json({ ok: true });
}));

api.post('/import', wrap((req, res) => {
  const { account_id, rows } = z.object({ account_id: z.string().nullable(), rows: z.array(TxInput.pick({ date: true, name: true, amount: true })).min(1).max(20000) }).parse(req.body);
  const result = addTransactions(rows.map((r) => ({ ...r, account_id })), 'csv');
  if (getSetting('demo', false)) patchSettings({ demo: false });
  changed('import');
  res.json(result);
}));

// --- Budgets, goals, holdings -----------------------------------------------------
api.put('/budgets', wrap((req, res) => {
  setBudgets(z.array(BudgetInput).parse(req.body));
  changed('budget');
  res.json({ ok: true });
}));

api.post('/goals', wrap((req, res) => {
  const id = upsertGoal(GoalInput.parse(req.body));
  changed('goal');
  res.json({ id });
}));

api.delete('/goals/:id', wrap((req, res) => {
  q.run('DELETE FROM goals WHERE id = ?', req.params.id);
  changed('goal');
  res.json({ ok: true });
}));

api.post('/holdings', wrap(async (req, res) => {
  const id = upsertHolding(HoldingInput.parse(req.body));
  await refreshQuotes().catch(() => 0);
  changed('holding');
  res.json({ id });
}));

api.delete('/holdings/:id', wrap((req, res) => {
  q.run('DELETE FROM holdings WHERE id = ?', req.params.id);
  changed('holding');
  res.json({ ok: true });
}));

api.post('/quotes/refresh', wrap(async (_req, res) => {
  const updated = await refreshQuotes();
  if (updated) changed('quotes');
  res.json({ updated });
}));

// --- Insights ---------------------------------------------------------------------
api.post('/insights/:id/apply', wrap((req, res) => {
  const row = q.get<{ action: string | null }>('SELECT action FROM insights WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Suggestion not found' });
  if (row.action) applyAction(JSON.parse(row.action) as InsightAction);
  q.run("UPDATE insights SET status = 'applied' WHERE id = ?", req.params.id);
  changed('insight');
  res.json({ ok: true });
}));

api.post('/insights/:id/dismiss', wrap((req, res) => {
  q.run("UPDATE insights SET status = 'dismissed' WHERE id = ?", req.params.id);
  emit('state', { reason: 'insight' });
  res.json({ ok: true });
}));

// --- Demo & reset -----------------------------------------------------------------
api.post('/demo', wrap((_req, res) => {
  if (q.get("SELECT 1 FROM items LIMIT 1")) return res.status(409).json({ error: 'Disconnect linked institutions before loading demo data.' });
  loadDemo();
  changed('demo');
  res.json({ ok: true });
}));

api.post('/reset', wrap(async (_req, res) => {
  for (const { id } of q.all<{ id: string }>('SELECT id FROM items')) await removeItem(id).catch(() => undefined);
  wipeAll();
  emit('state', { reason: 'reset' });
  res.json({ ok: true });
}));

// --- Plaid ------------------------------------------------------------------------
api.post('/plaid/link-token', wrap(async (req, res) => {
  if (!plaidConfigured()) return res.status(503).json({ error: 'Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to .env and restart.' });
  const { mode, item_id } = z.object({ mode: z.enum(['banking', 'investments', 'loans']).default('banking'), item_id: z.string().optional() }).parse(req.body ?? {});
  try {
    res.json({ link_token: await createLinkToken(mode, item_id) });
  } catch (err) {
    res.status(502).json({ error: plaidMessage(err).message });
  }
}));

api.post('/plaid/exchange', wrap(async (req, res) => {
  const { public_token, institution } = z.object({ public_token: z.string(), institution: z.string().default('') }).parse(req.body);
  let itemId: string;
  try {
    itemId = await exchangePublicToken(public_token, institution);
  } catch (err) {
    return res.status(502).json({ error: plaidMessage(err).message });
  }
  if (getSetting('demo', false)) {
    wipeDemo();
  }
  const result = await syncItem(itemId).catch((err: Error) => ({ error: err.message }));
  const def = getSetting<string | null>('default_account_id', null);
  if (!def) {
    const first = q.get<{ id: string }>("SELECT id FROM accounts WHERE type = 'depository' ORDER BY subtype = 'checking' DESC LIMIT 1");
    if (first) patchSettings({ default_account_id: first.id });
  }
  changed('link');
  res.json({ item_id: itemId, ...result });
  // Plaid often needs a little time to prepare history after a first link; pick it up shortly.
  setTimeout(() => syncItem(itemId).then(() => changed('sync')).catch(() => undefined), 30_000).unref();
}));

api.post('/plaid/sync', wrap(async (_req, res) => {
  const items = await syncAll();
  await refreshQuotes().catch(() => 0);
  changed('sync');
  res.json({ items });
}));

api.delete('/plaid/items/:id', wrap(async (req, res) => {
  await removeItem(String(req.params.id));
  changed('unlink');
  res.json({ ok: true });
}));

/** Demo rows are replaced by real data the moment the first real connection is made. */
function wipeDemo() {
  q.run("DELETE FROM accounts WHERE source = 'demo'");
  q.run("DELETE FROM transactions WHERE source = 'demo'");
  q.run('DELETE FROM goals');
  q.run('DELETE FROM budgets');
  q.run('DELETE FROM snapshots');
  q.run('DELETE FROM insights');
  setSetting('brief', null);
  patchSettings({ demo: false, default_account_id: null, extra_payment: 0, target_allocation: null });
}

// --- Assistant --------------------------------------------------------------------
api.get('/assistant/history', wrap((_req, res) => {
  res.json(q.all('SELECT id, role, text, created_at FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 60) ORDER BY id'));
}));

api.delete('/assistant/history', wrap((_req, res) => {
  q.run('DELETE FROM chat');
  res.json({ ok: true });
}));

api.post('/assistant/chat', wrap(async (req, res) => {
  if (!aiConfigured()) return res.status(503).json({ error: 'Add ANTHROPIC_API_KEY to .env and restart to turn on the assistant.' });
  const { message, attachments } = z
    .object({
      message: z.string().min(1).max(20000),
      attachments: z.array(z.object({ name: z.string().max(200), media_type: z.string().max(100), data: z.string() })).max(5).default([]),
    })
    .parse(req.body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  await chat(message, attachments as Attachment[], (e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === 'done' && e.changed) emit('state', { reason: 'assistant' });
    if (e.type === 'error') emit('state', { reason: 'assistant' });
  });
  res.end();
}));

api.post('/assistant/brief', wrap(async (_req, res) => {
  if (!aiConfigured()) {
    refreshInsights();
    emit('state', { reason: 'briefing' });
    return res.json({ ok: true });
  }
  try {
    await briefing(true);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
}));

// --- Errors -----------------------------------------------------------------------
api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return res.end();
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    return res.status(400).json({ error: `${first.path.join('.') || 'input'}: ${first.message}` });
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  console.error('[api]', message);
  res.status(500).json({ error: message });
});
