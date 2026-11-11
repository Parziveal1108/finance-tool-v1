import { describe, expect, it } from 'vitest';
import { detectColumns, guessPositiveIsSpending, mapRows, parseAmount, parseDate } from '../src/lib/csv';

describe('csv import', () => {
  it('detects a single amount column', () => {
    expect(detectColumns(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'])).toMatchObject({ date: 0, description: 2, amount: 5, debit: -1, credit: -1 });
  });
  it('detects separate debit and credit columns', () => {
    expect(detectColumns(['Date', 'Details', 'Debit', 'Credit', 'Balance'])).toMatchObject({ date: 0, description: 1, amount: -1, debit: 2, credit: 3 });
  });
  it('parses amounts in the formats banks use', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('(45.00)')).toBe(-45);
    expect(parseAmount('-12.3')).toBe(-12.3);
    expect(parseAmount('12.30-')).toBe(-12.3);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
  it('parses dates, reading day-first when the first number cannot be a month', () => {
    expect(parseDate('2026-11-03')).toBe('2026-11-03');
    expect(parseDate('11/03/2026')).toBe('2026-11-03');
    expect(parseDate('3/7/26')).toBe('2026-03-07');
    expect(parseDate('13/11/2026')).toBe('2026-11-13');
    expect(parseDate('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseDate('garbage')).toBeNull();
  });
  it('maps debit/credit rows to signed amounts and skips unusable rows', () => {
    const map = detectColumns(['Date', 'Details', 'Debit', 'Credit']);
    const { rows, skipped } = mapRows([['11/02/2026', 'Grocer', '54.20', ''], ['11/03/2026', 'Payroll', '', '2,100.00'], ['', 'Totals', '54.20', '2100'], ['11/04/2026', 'Zero', '0', '']], map, false);
    expect(rows).toEqual([
      { date: '2026-11-02', name: 'Grocer', amount: -54.2 },
      { date: '2026-11-03', name: 'Payroll', amount: 2100 },
    ]);
    expect(skipped).toBe(2);
  });
  it('recognises card exports where purchases are positive', () => {
    const map = detectColumns(['Date', 'Description', 'Amount']);
    const card = [['11/01/2026', 'A', '10'], ['11/02/2026', 'B', '20'], ['11/03/2026', 'C', '30'], ['11/04/2026', 'Payment', '-60']];
    expect(guessPositiveIsSpending(card, map)).toBe(true);
    expect(mapRows(card, map, true).rows.map((r) => r.amount)).toEqual([-10, -20, -30, 60]);
    const bank = [['11/01/2026', 'A', '-10'], ['11/02/2026', 'B', '-20'], ['11/03/2026', 'Pay', '900']];
    expect(guessPositiveIsSpending(bank, map)).toBe(false);
  });
});
