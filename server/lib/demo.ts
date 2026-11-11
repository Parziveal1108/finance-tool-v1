import { q, uid, nowIso, isoDate, wipeAll, patchSettings } from '../db';
import { categorize } from '../../shared/categories';

/** Small seeded PRNG so the demo looks the same on every load. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/**
 * A realistic sample household: two cards, two loans, savings, retirement and a brokerage,
 * with six months of activity. Everything is tagged as demo and can be cleared in one tap.
 */
export function loadDemo(now = new Date()) {
  wipeAll();
  const rand = rng(11);
  const between = (lo: number, hi: number) => Math.round((lo + rand() * (hi - lo)) * 100) / 100;
  const pickFrom = <T,>(list: T[]) => list[Math.floor(rand() * list.length)];
  const today = isoDate(now);
  const day = (offset: number) => isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset));

  const acct = (name: string, institution: string, type: string, subtype: string, balance: number, extra: Record<string, number | null> = {}) => {
    const id = uid();
    q.run('INSERT INTO accounts (id, name, institution, mask, type, subtype, balance, credit_limit, apr, min_payment, due_day, manual, source, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      id, name, institution, String(1000 + Math.floor(rand() * 9000)), type, subtype, balance, extra.limit ?? null, extra.apr ?? null, extra.min ?? null, extra.due ?? null, 'demo', nowIso());
    return id;
  };
  const checking = acct('Everyday Checking', 'First Harbor Bank', 'depository', 'checking', 3240.18);
  const savings = acct('High-Yield Savings', 'First Harbor Bank', 'depository', 'savings', 6815.4);
  const visa = acct('Sapphire Visa', 'Meridian Card', 'credit', 'credit card', 4862.37, { limit: 9000, apr: 24.99, min: 146, due: ((now.getDate() + 1) % 28) + 1 });
  const store = acct('Northwind Store Card', 'Northwind', 'credit', 'credit card', 1148.9, { limit: 1500, apr: 29.99, min: 40, due: 22 });
  acct('Federal Student Loan', 'EdServ', 'loan', 'student', 18420.55, { apr: 5.8, min: 212, due: 15 });
  acct('Auto Loan', 'Summit Auto Finance', 'loan', 'auto', 9730.12, { apr: 7.4, min: 318, due: 5 });
  const k401 = acct('Employer 401(k)', 'Pinecrest Retirement', 'investment', '401k', 0);
  const roth = acct('Roth IRA', 'Pinecrest Brokerage', 'investment', 'ira', 0);
  const brokerage = acct('Individual Brokerage', 'Pinecrest Brokerage', 'investment', 'brokerage', 0);

  const hold = (account: string, symbol: string | null, name: string, qty: number, price: number, cost: number, cls: string) =>
    q.run('INSERT INTO holdings (id, account_id, symbol, name, quantity, price, cost_basis, asset_class, price_updated_at, manual) VALUES (?,?,?,?,?,?,?,?,?,1)',
      uid(), account, symbol, name, qty, price, cost, cls, nowIso());
  hold(k401, null, 'Target Retirement 2060 Fund', 612.4, 38.12, 19800, 'us_stock');
  hold(k401, null, 'Stable Value Fund', 2140, 1, 2140, 'cash');
  hold(roth, 'VTI', 'Vanguard Total Stock Market ETF', 22, 291.4, 5210, 'us_stock');
  hold(roth, 'VXUS', 'Vanguard Total International Stock ETF', 31, 67.8, 1930, 'intl_stock');
  hold(roth, 'BND', 'Vanguard Total Bond Market ETF', 14, 73.25, 1060, 'bond');
  hold(brokerage, 'NVDA', 'NVIDIA Corp', 62, 142.6, 3120, 'us_stock');
  hold(brokerage, 'VOO', 'Vanguard S&P 500 ETF', 3, 548.2, 1490, 'us_stock');
  hold(brokerage, 'BTC', 'Bitcoin', 0.012, 96500, 780, 'crypto');
  hold(brokerage, 'CASH', 'Cash sweep', 1260, 1, 1260, 'cash');

  const tx = (offset: number, name: string, amount: number, account: string, category?: string) => {
    if (offset < 0) return;
    q.run('INSERT INTO transactions (id, account_id, date, amount, name, category, source, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid(), account, day(offset), amount, name, category ?? categorize(name, amount), 'demo', nowIso());
  };

  const grocers = ['Trader Joe\'s', 'Whole Foods Market', 'Safeway', 'Costco'];
  const dining = ['Chipotle', 'Blue Door Cafe', 'Starbucks', 'Sushi Kan', 'DoorDash', 'Pizzeria Luna', 'Taco Alley', 'The Corner Bistro'];
  const shops = ['Amazon', 'Target', 'IKEA', 'Nike', 'Best Buy', 'Etsy'];
  const fun = ['AMC Theaters', 'Steam', 'Ticketmaster', 'City Museum'];

  // Paid every other Friday, so some months carry three paychecks.
  const sinceFriday = (now.getDay() + 2) % 7;
  for (let off = sinceFriday; off < 215; off += 14) tx(off, 'Payroll Direct Deposit - Brightline Inc', 2455.12, checking, 'income');

  const monthsBack = 6;
  for (let m = monthsBack; m >= 0; m--) {
    // Day offsets for a given day-of-month in the month `m` months ago.
    const at = (dom: number) => {
      const d = new Date(now.getFullYear(), now.getMonth() - m, dom);
      return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - d.getTime()) / 86400000);
    };
    const dim = new Date(now.getFullYear(), now.getMonth() - m + 1, 0).getDate();
    const latest = m === 0;

    tx(at(1), 'Parkview Apartments Rent', -1450, checking, 'housing');
    tx(at(3), 'City Electric & Gas', -between(78, 132), checking, 'utilities');
    tx(at(6), 'Xfinity Internet', -65, checking, 'utilities');
    tx(at(9), 'T-Mobile', -55, checking, 'utilities');
    tx(at(12), 'Geico Auto Insurance', -118.4, checking, 'insurance');
    tx(at(5), 'Summit Auto Finance Loan Payment', -318, checking, 'debt_payment');
    tx(at(15), 'EdServ Student Loan Payment', -212, checking, 'debt_payment');
    tx(at(20), 'Meridian Card Payment Thank You', -260, checking, 'transfer');
    tx(at(22), 'Northwind Card Payment', -45, checking, 'transfer');
    tx(at(2), 'Transfer to High-Yield Savings', -200, checking, 'savings');
    tx(at(16), 'Pinecrest Roth IRA Contribution', -150, checking, 'savings');

    // Subscriptions, with one price increase in the most recent charge.
    tx(at(4), 'Netflix', m === (now.getDate() >= 4 ? 0 : 1) ? -22.99 : -17.99, visa, 'subscriptions'); // latest charge shows a price rise
    tx(at(7), 'Spotify', -11.99, visa, 'subscriptions');
    tx(at(10), 'Pulse Fitness Gym Membership', -49, visa, 'subscriptions');
    tx(at(13), 'iCloud Storage', -2.99, visa, 'subscriptions');
    tx(at(18), 'Hulu', -18.99, visa, 'subscriptions');

    for (let d = 1; d <= dim; d++) {
      const off = at(d);
      if (off < 0) break;
      const weekday = new Date(now.getFullYear(), now.getMonth() - m, d).getDay();
      if (weekday === 6 || (weekday === 3 && rand() < 0.4)) tx(off, pickFrom(grocers), -between(48, 128), visa, 'groceries');
      // Dining runs hot in the current month so the monitor has something to flag.
      if (rand() < (latest ? 0.62 : 0.36)) tx(off, pickFrom(dining), -between(9, latest ? 58 : 44), visa, 'dining');
      if (rand() < 0.13) tx(off, pickFrom(shops), -between(18, 140), rand() < 0.3 ? store : visa, 'shopping');
      if (weekday === 5 && rand() < 0.5) tx(off, pickFrom(fun), -between(12, 64), visa, 'entertainment');
      if (rand() < 0.14) tx(off, pickFrom(['Shell', 'Chevron']), -between(34, 58), visa, 'transport');
      if (rand() < 0.06) tx(off, pickFrom(['Uber', 'Lyft', 'City Parking']), -between(8, 31), visa, 'transport');
      if (rand() < 0.03) tx(off, 'CVS Pharmacy', -between(11, 46), visa, 'health');
    }
  }
  tx(4, 'Best Buy', -612.48, store, 'shopping'); // a recent outsized purchase
  tx(40, 'Delta Air Lines', -384.2, visa, 'travel');
  tx(72, 'IRS Tax Refund', 640, checking, 'income');

  const budgets: Record<string, number> = { housing: 1450, utilities: 260, groceries: 520, transport: 240, insurance: 120, debt_payment: 530, health: 60, dining: 320, shopping: 250, entertainment: 110, subscriptions: 110, travel: 100 };
  for (const [c, a] of Object.entries(budgets)) q.run('INSERT INTO budgets (category, amount) VALUES (?, ?)', c, a);

  const inMonths = (n: number) => isoDate(new Date(now.getFullYear(), now.getMonth() + n, 1));
  q.run('INSERT INTO goals (id, name, kind, target_amount, current_amount, linked_account_id, target_date, monthly_contribution, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid(), 'Emergency fund', 'emergency', 12000, 0, savings, null, 200, nowIso());
  q.run('INSERT INTO goals (id, name, kind, target_amount, current_amount, linked_account_id, target_date, monthly_contribution, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    uid(), 'Japan trip', 'purchase', 3600, 940, null, inMonths(9), 150, nowIso());

  // Half a year of history that arrives at today's totals: debt falling, investments drifting up.
  const assets = q.get<{ v: number }>("SELECT (SELECT COALESCE(SUM(balance),0) FROM accounts WHERE type = 'depository') + (SELECT COALESCE(SUM(quantity*price),0) FROM holdings) v")!.v;
  const debt = q.get<{ v: number }>("SELECT SUM(balance) v FROM accounts WHERE type IN ('credit','loan')")!.v;
  for (let d = 182; d >= 1; d--) {
    const wobble = Math.sin(d / 9) * 420 + Math.sin(d / 23) * 900 + (rand() - 0.5) * 260;
    q.run('INSERT OR REPLACE INTO snapshots (date, assets, debt) VALUES (?, ?, ?)', day(d), Math.round((assets - d * 31 + wobble * (d / 182 + 0.25)) * 100) / 100, Math.round((debt + d * 14.5 + Math.sin(d / 15) * 180) * 100) / 100);
  }
  patchSettings({ demo: true, default_account_id: checking, strategy: 'avalanche', extra_payment: 100, target_allocation: { us_stock: 55, intl_stock: 25, bond: 15, cash: 5 }, match: { rate: 50, limit_pct: 6, salary: 84000, contributing_pct: 4 } });
  return today;
}
