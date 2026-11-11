import { categorize, type UserRule } from './categories';

export interface QuickEntry {
  name: string;
  amount: number; // signed: negative = spent
  date: string;
  category: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const INCOME_WORDS = /\b(paycheck|paid me|salary|income|refund|reimburse\w*|deposit|bonus|got paid|received|sold)\b/i;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Turns a short line such as "coffee 4.50", "rent 1450 yesterday", "+2400 paycheck 11/1"
 * or "groceries $82.13 on nov 3" into a transaction. Returns null if there is no amount.
 */
export function parseQuickEntry(input: string, today = new Date(), rules: UserRule[] = []): QuickEntry | null {
  let text = ` ${input.trim()} `;
  if (!text.trim()) return null;
  let date = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // Dates first so their digits are not mistaken for the amount.
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = text.match(re);
    if (m) {
      fn(m);
      text = text.replace(m[0], ' ');
    }
  };
  take(/\s(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?=\s)/i, (m) => {
    date = new Date(+m[1], +m[2] - 1, +m[3]);
  });
  take(/\s(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/i, (m) => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
    date = new Date(y, +m[1] - 1, +m[2]);
    if (!m[3] && date.getTime() > today.getTime() + 86400000 * 7) date.setFullYear(y - 1);
  });
  take(new RegExp(`\\s(?:on\\s+)?(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=\\s)`, 'i'), (m) => {
    date = new Date(today.getFullYear(), MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
    if (date.getTime() > today.getTime() + 86400000 * 7) date.setFullYear(today.getFullYear() - 1);
  });
  take(/\s(today|yesterday|(\d+)\s+days?\s+ago)(?=\s)/i, (m) => {
    const w = m[1].toLowerCase();
    const back = w === 'today' ? 0 : w === 'yesterday' ? 1 : +m[2];
    date.setDate(date.getDate() - back);
  });

  const am = text.match(/\s([+-])?\s?\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(k)?(?=\s)/i);
  if (!am) return null;
  let value = parseFloat(am[2].replace(/,/g, ''));
  if (am[3]) value *= 1000;
  if (!isFinite(value) || value === 0) return null;
  text = text.replace(am[0], ' ');

  const name = text.replace(/\s+(for|at|on|to)\s*$/i, ' ').replace(/^\s*(spent|paid|bought)\s+/i, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
  const inflow = am[1] === '+' || (am[1] !== '-' && INCOME_WORDS.test(input));
  const amount = Math.round((inflow ? value : -value) * 100) / 100;
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  return { name: label, amount, date: iso(date), category: categorize(label, amount, rules) };
}
