import { describe, expect, it } from 'vitest';
import { estimateMinPayment, simulatePayoff, payoffOrder, addMonths, type PayoffDebt } from '../shared/payoff';

const debts: PayoffDebt[] = [
  { id: 'card', name: 'Card', balance: 5000, apr: 24, minPayment: 150 },
  { id: 'store', name: 'Store', balance: 800, apr: 18, minPayment: 40 },
  { id: 'loan', name: 'Loan', balance: 12000, apr: 6, minPayment: 220 },
];

describe('simulatePayoff', () => {
  it('pays a single debt with zero interest in balance / payment months', () => {
    const r = simulatePayoff([{ id: 'a', name: 'A', balance: 1000, apr: 0, minPayment: 100 }], 'avalanche');
    expect(r.months).toBe(10);
    expect(r.totalInterest).toBe(0);
    expect(r.totalPaid).toBe(1000);
    expect(r.timeline[0]).toBe(1000);
    expect(r.timeline.at(-1)).toBe(0);
  });

  it('matches the closed-form amortisation for one loan', () => {
    // $10,000 at 12% APR amortises in 36 months at $332.1431/mo; a cent more avoids a stray 37th payment.
    const r = simulatePayoff([{ id: 'a', name: 'A', balance: 10000, apr: 12, minPayment: 332.15 }], 'avalanche');
    expect(r.months).toBe(36);
    expect(r.totalInterest).toBeGreaterThan(1950);
    expect(r.totalInterest).toBeLessThan(1960);
  });

  it('orders by rate for avalanche and by balance for snowball', () => {
    expect(payoffOrder(debts, 'avalanche').map((d) => d.id)).toEqual(['card', 'store', 'loan']);
    expect(payoffOrder(debts, 'snowball').map((d) => d.id)).toEqual(['store', 'card', 'loan']);
  });

  it('avalanche never costs more interest than snowball', () => {
    const a = simulatePayoff(debts, 'avalanche', 200);
    const s = simulatePayoff(debts, 'snowball', 200);
    expect(a.totalInterest).toBeLessThanOrEqual(s.totalInterest);
    expect(s.payoffMonth.store!).toBeLessThan(a.payoffMonth.store!);
  });

  it('extra payments shorten the plan and cut interest', () => {
    const base = simulatePayoff(debts, 'avalanche', 0);
    const more = simulatePayoff(debts, 'avalanche', 300);
    expect(more.months!).toBeLessThan(base.months!);
    expect(more.totalInterest).toBeLessThan(base.totalInterest);
  });

  it('rolls freed minimums into the next debt', () => {
    const r = simulatePayoff(debts, 'avalanche', 0);
    // Total paid each month stays at the sum of minimums until the end, so the plan
    // finishes well before the slowest debt would on its own minimum.
    const alone = simulatePayoff([debts[2]], 'avalanche', 0);
    expect(r.payoffMonth.loan!).toBeLessThan(alone.months!);
  });

  it('conserves money: paid = principal + interest', () => {
    const r = simulatePayoff(debts, 'snowball', 125, 500);
    const principal = debts.reduce((s, d) => s + d.balance, 0);
    expect(r.totalPaid).toBeCloseTo(principal + r.totalInterest, 1);
  });

  it('flags a minimum that does not cover interest and never finishes', () => {
    const r = simulatePayoff([{ id: 'x', name: 'X', balance: 10000, apr: 30, minPayment: 100 }], 'avalanche');
    expect(r.underwater).toEqual(['x']);
    expect(r.months).toBeNull();
  });

  it('applies a lump sum before the first month', () => {
    const r = simulatePayoff(debts, 'avalanche', 0, 5000);
    expect(r.timeline[0]).toBe(12800);
    expect(r.payoffMonth.card).toBe(1);
  });

  it('handles no debts', () => {
    const r = simulatePayoff([], 'avalanche', 100);
    expect(r.months).toBe(0);
    expect(r.timeline).toEqual([0]);
  });
});

describe('helpers', () => {
  it('estimates a card minimum as interest plus 1%, floored at $25', () => {
    expect(estimateMinPayment(5000, 24, 'credit')).toBe(150);
    expect(estimateMinPayment(300, 20, 'credit')).toBe(25);
    expect(estimateMinPayment(10, 20, 'credit')).toBe(10);
  });
  it('estimates a loan minimum that pays off in ten years', () => {
    const min = estimateMinPayment(10000, 6, 'loan');
    expect(simulatePayoff([{ id: 'l', name: 'L', balance: 10000, apr: 6, minPayment: min }], 'avalanche').months).toBe(120);
  });
  it('adds months across year ends', () => {
    expect(addMonths('2026-11-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02');
  });
});
