import { q, nowIso } from '../db';
import type { AssetClass } from '../../shared/types';

const INTL = new Set(['VXUS', 'VEA', 'VWO', 'IXUS', 'IEFA', 'IEMG', 'VTIAX', 'VEU', 'SCHF', 'EFA', 'EEM', 'FTIHX', 'FZILX', 'SWISX']);
const BOND = new Set(['BND', 'AGG', 'BNDX', 'VBTLX', 'TLT', 'IEF', 'SHY', 'TIP', 'VTIP', 'LQD', 'HYG', 'MUB', 'SCHZ', 'FXNAX', 'VGIT', 'VGSH', 'BIV', 'BSV', 'SGOV', 'BIL']);
const CASH = new Set(['CASH', 'USD', 'SPAXX', 'VMFXX', 'SWVXX', 'FDRXX', 'SPRXX', 'VMRXX']);
const CRYPTO: Record<string, string> = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano', DOGE: 'dogecoin', XRP: 'ripple', LTC: 'litecoin', DOT: 'polkadot', AVAX: 'avalanche-2', LINK: 'chainlink' };

/** Best-effort asset class from a ticker and name; the user can override it. */
export function guessAssetClass(symbol: string | null, name: string): AssetClass {
  const s = (symbol ?? '').toUpperCase().replace(/-USD$/, '');
  const n = name.toLowerCase();
  if (CASH.has(s) || /money market|cash|sweep/.test(n)) return 'cash';
  if (CRYPTO[s] || /bitcoin|ethereum|crypto/.test(n)) return 'crypto';
  if (BOND.has(s) || /bond|treasur|fixed income|aggregate|tips\b|muni/.test(n)) return 'bond';
  if (INTL.has(s) || /international|intl|ex-us|ex us|emerging|developed markets|global ex|foreign|world ex/.test(n)) return 'intl_stock';
  if (/reit|real estate|gold|commodit/.test(n)) return 'other';
  return 'us_stock';
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'keel-personal-finance' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

/** Stooq's CSV endpoint needs no key. Symbols are lower-case with a market suffix, e.g. vti.us */
async function stooq(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length) return out;
  const csv = await getText(`https://stooq.com/q/l/?s=${symbols.map((s) => `${s.toLowerCase().replace('.', '-')}.us`).join('+')}&f=sd2t2ohlcv&h&e=csv`);
  for (const line of csv.trim().split('\n').slice(1)) {
    const cols = line.split(',');
    const close = Number(cols[6]);
    if (cols[0] && isFinite(close) && close > 0) out.set(cols[0].replace(/\.US$/i, '').replace('-', '.').toUpperCase(), close);
  }
  return out;
}

async function finnhub(symbols: string[], key: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of symbols) {
    try {
      const data = JSON.parse(await getText(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${key}`));
      if (typeof data.c === 'number' && data.c > 0) out.set(s, data.c);
    } catch {
      // skip this symbol
    }
  }
  return out;
}

async function coingecko(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = symbols.map((s) => CRYPTO[s]).filter(Boolean);
  if (!ids.length) return out;
  const data = JSON.parse(await getText(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`));
  for (const s of symbols) {
    const p = data[CRYPTO[s]]?.usd;
    if (typeof p === 'number') out.set(s, p);
  }
  return out;
}

export async function fetchQuotes(symbols: string[]): Promise<Map<string, number>> {
  const clean = [...new Set(symbols.map((s) => s.toUpperCase().replace(/-USD$/, '')))].filter((s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s) && !CASH.has(s));
  const crypto = clean.filter((s) => CRYPTO[s]);
  const stocks = clean.filter((s) => !CRYPTO[s]);
  const key = process.env.FINNHUB_API_KEY;
  const [a, b] = await Promise.allSettled([key ? finnhub(stocks, key) : stooq(stocks), coingecko(crypto)]);
  return new Map([...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])]);
}

/** Refresh prices for holdings that have a ticker. Returns how many changed. */
export async function refreshQuotes(): Promise<number> {
  const symbols = q.all<{ symbol: string }>("SELECT DISTINCT symbol FROM holdings WHERE symbol IS NOT NULL AND symbol != ''").map((r) => r.symbol);
  if (!symbols.length) return 0;
  const quotes = await fetchQuotes(symbols);
  let changed = 0;
  for (const [symbol, price] of quotes) {
    changed += q.run('UPDATE holdings SET price = ?, price_updated_at = ? WHERE UPPER(REPLACE(symbol, \'-USD\', \'\')) = ? AND ABS(price - ?) > 0.0001', price, nowIso(), symbol, price).changes;
    q.run("UPDATE holdings SET price_updated_at = ? WHERE UPPER(REPLACE(symbol, '-USD', '')) = ?", nowIso(), symbol);
  }
  return changed;
}
