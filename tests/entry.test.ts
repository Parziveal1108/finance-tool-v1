import { describe, expect, it } from 'vitest';
import { parseQuickEntry } from '../shared/quickadd';
import { categorize, fromPlaidCategory } from '../shared/categories';

const today = new Date(2026, 10, 11); // 11 Nov 2026

describe('parseQuickEntry', () => {
  it('reads a name and an amount as spending today', () => {
    expect(parseQuickEntry('coffee 4.50', today)).toEqual({ name: 'Coffee', amount: -4.5, date: '2026-11-11', category: 'dining' });
  });
  it('understands relative days', () => {
    expect(parseQuickEntry('rent 1450 yesterday', today)).toMatchObject({ name: 'Rent', amount: -1450, date: '2026-11-10', category: 'housing' });
    expect(parseQuickEntry('lunch 14 3 days ago', today)).toMatchObject({ amount: -14, date: '2026-11-08' });
  });
  it('treats a plus sign or income words as money in', () => {
    expect(parseQuickEntry('+2400 paycheck', today)).toMatchObject({ amount: 2400, category: 'income' });
    expect(parseQuickEntry('refund from amazon 31.20', today)).toMatchObject({ amount: 31.2 });
  });
  it('does not mistake a date for the amount', () => {
    expect(parseQuickEntry('netflix 15.49 11/3', today)).toMatchObject({ name: 'Netflix', amount: -15.49, date: '2026-11-03', category: 'subscriptions' });
    expect(parseQuickEntry('groceries $82.13 on nov 3', today)).toMatchObject({ name: 'Groceries', amount: -82.13, date: '2026-11-03' });
    expect(parseQuickEntry('flight 2026-10-02 384.20', today)).toMatchObject({ amount: -384.2, date: '2026-10-02' });
  });
  it('puts a month/day that would be in the future into last year', () => {
    expect(parseQuickEntry('gift 60 12/20', today)).toMatchObject({ date: '2025-12-20' });
  });
  it('handles thousands separators and k', () => {
    expect(parseQuickEntry('laptop $1,299.00', today)).toMatchObject({ amount: -1299 });
    expect(parseQuickEntry('bonus 2k', today)).toMatchObject({ amount: 2000 });
  });
  it('returns null without an amount', () => {
    expect(parseQuickEntry('coffee', today)).toBeNull();
    expect(parseQuickEntry('   ', today)).toBeNull();
  });
});

describe('categorize', () => {
  it('prefers user rules', () => {
    expect(categorize('BLUE DOOR CAFE', -12, [{ pattern: 'blue door', category: 'entertainment' }])).toBe('entertainment');
  });
  it('recognises common merchants', () => {
    expect(categorize('TRADER JOE\'S #552', -64)).toBe('groceries');
    expect(categorize('Uber Eats', -23)).toBe('dining');
    expect(categorize('UBER *TRIP', -18)).toBe('transport');
    expect(categorize('Payment Thank You - Web', 400)).toBe('transfer');
    expect(categorize('Payroll Direct Deposit', 2400)).toBe('income');
  });
  it('falls back by direction', () => {
    expect(categorize('ZZZ unknown', -5)).toBe('other');
    expect(categorize('ZZZ unknown', 5)).toBe('income');
  });
  it('maps Plaid categories, keeping card payments out of spending', () => {
    expect(fromPlaidCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', -200)).toBe('transfer');
    expect(fromPlaidCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT', -200)).toBe('debt_payment');
    expect(fromPlaidCategory('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', -50)).toBe('groceries');
    expect(fromPlaidCategory('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', -1400)).toBe('housing');
    expect(fromPlaidCategory(undefined, undefined, -1)).toBeNull();
  });
});
