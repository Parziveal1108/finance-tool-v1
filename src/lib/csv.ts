export interface CsvMapping {
  date: number;
  description: number;
  /** Single signed amount column, or -1 when debit/credit columns are used. */
  amount: number;
  debit: number;
  credit: number;
}

export interface ParsedRow {
  date: string;
  name: string;
  amount: number;
}

const find = (headers: string[], re: RegExp, skip: number[] = []) => headers.findIndex((h, i) => !skip.includes(i) && re.test(h.toLowerCase()));

/** Guess which columns hold what from the header row of a bank or card export. */
export function detectColumns(headers: string[]): CsvMapping {
  const date = Math.max(0, find(headers, /^(transaction |trans\.? |posted |posting )?date$|date/));
  const description = find(headers, /desc|payee|merchant|name|memo|details|narrative/, [date]);
  const debit = find(headers, /debit|withdraw|money out|paid out/);
  const credit = find(headers, /credit|deposit|money in|paid in/, [debit]);
  const amount = find(headers, /^amount|amount|value|^amt/, [debit, credit]);
  return {
    date,
    description: description >= 0 ? description : Math.min(headers.length - 1, 1),
    amount: debit >= 0 && credit >= 0 ? -1 : amount,
    debit: debit >= 0 && credit >= 0 ? debit : -1,
    credit: debit >= 0 && credit >= 0 ? credit : -1,
  };
}

export function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bDR\b/i.test(s);
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return null;
  // "1.234,56" (European) vs "1,234.56"
  if (/,\d{2}$/.test(s) && !/\.\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    // Day-first when the first number cannot be a month.
    return +m[1] > 12 ? iso(y, +m[2], +m[1]) : iso(y, +m[1], +m[2]);
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Convert raw rows using a column mapping. `positiveIsSpending` flips the sign for card
 * exports that list purchases as positive numbers.
 */
export function mapRows(rows: string[][], map: CsvMapping, positiveIsSpending: boolean): { rows: ParsedRow[]; skipped: number } {
  const out: ParsedRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const date = parseDate(r[map.date]);
    const name = (r[map.description] ?? '').trim();
    let amount: number | null;
    if (map.amount >= 0) {
      amount = parseAmount(r[map.amount]);
      if (amount != null && positiveIsSpending) amount = -amount;
    } else {
      const debit = parseAmount(r[map.debit]);
      const credit = parseAmount(r[map.credit]);
      amount = debit ? -Math.abs(debit) : credit ? Math.abs(credit) : null;
    }
    if (!date || !name || amount == null || amount === 0) {
      skipped++;
      continue;
    }
    out.push({ date, name, amount: Math.round(amount * 100) / 100 });
  }
  return { rows: out, skipped };
}

/** Card exports usually show purchases as positive; bank exports show them as negative. */
export function guessPositiveIsSpending(rows: string[][], map: CsvMapping): boolean {
  if (map.amount < 0) return false;
  let pos = 0;
  let neg = 0;
  for (const r of rows.slice(0, 200)) {
    const a = parseAmount(r[map.amount]);
    if (a == null) continue;
    if (a > 0) pos++;
    else if (a < 0) neg++;
  }
  return pos > neg * 2 && pos >= 3;
}
