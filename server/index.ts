import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ROOT } from './db';
import { api, briefing, changed } from './routes';
import { refreshInsights } from './lib/insights';
import { plaidConfigured, syncAll } from './lib/plaid';
import { refreshQuotes } from './lib/quotes';
import { aiConfigured, MODEL } from './lib/ai-config';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const PASSWORD = process.env.APP_PASSWORD ?? '';
const LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

if (!LOCAL && !PASSWORD) {
  console.error(`\nKeel will not listen on ${HOST} without a password, because anyone on that network could read your finances.\nSet APP_PASSWORD in .env, or remove HOST to keep Keel on this machine only.\n`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// --- Optional password gate -----------------------------------------------------------
const COOKIE = 'keel_session';
const sessionToken = () => createHmac('sha256', PASSWORD).update('keel-session-v1').digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req: Request) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1] ?? '';
const authed = (req: Request) => !PASSWORD || same(cookieOf(req), sessionToken());

const attempts = new Map<string, { n: number; until: number }>();

app.get('/api/session', (req, res) => {
  res.json({ required: !!PASSWORD, authed: authed(req) });
});

app.post('/api/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const a = attempts.get(ip);
  if (a && a.n >= 8 && a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const given = typeof req.body?.password === 'string' ? req.body.password : '';
  const ok = !!PASSWORD && same(createHmac('sha256', 'cmp').update(given).digest('hex'), createHmac('sha256', 'cmp').update(PASSWORD).digest('hex'));
  if (!ok) {
    attempts.set(ip, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 10 * 60_000 });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!authed(req)) return res.status(401).json({ error: 'Sign in required.' });
  // State-changing requests must come from the app itself, not from another site in the browser.
  if (req.method !== 'GET' && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
    return res.status(403).json({ error: 'Cross-site request refused.' });
  }
  next();
});
app.use('/api', api);

// --- Web app --------------------------------------------------------------------------
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// --- Background monitor ---------------------------------------------------------------
const HOUR = 3600_000;
async function tick(kind: 'sync' | 'quotes' | 'daily') {
  try {
    if (kind === 'sync' && plaidConfigured() && (await syncAll()) > 0) changed('sync');
    if (kind === 'quotes' && (await refreshQuotes()) > 0) changed('quotes');
    if (kind === 'daily') {
      changed('daily'); // date-dependent checks (pace, due dates) move even when no data does
      await briefing();
    }
  } catch (err) {
    console.error(`[monitor:${kind}]`, err instanceof Error ? err.message : err);
  }
}
setInterval(() => tick('sync'), 4 * HOUR).unref();
setInterval(() => tick('quotes'), 15 * 60_000).unref();
setInterval(() => tick('daily'), 6 * HOUR).unref();

app.listen(PORT, HOST, () => {
  refreshInsights();
  setTimeout(() => tick('quotes'), 3000).unref();
  setTimeout(() => tick('sync'), 8000).unref();
  const url = `http://${LOCAL ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  Keel is running at ${url}`);
  console.log(`  Bank linking (Plaid): ${plaidConfigured() ? `on (${process.env.PLAID_ENV ?? 'sandbox'})` : 'off — add PLAID_CLIENT_ID / PLAID_SECRET to .env'}`);
  console.log(`  Assistant (Claude):   ${aiConfigured() ? `on (${MODEL})` : 'off — add ANTHROPIC_API_KEY to .env'}`);
  console.log(`  Password:             ${PASSWORD ? 'required' : 'none (this machine only)'}\n`);
});
