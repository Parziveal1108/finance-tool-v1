import { describe, expect, it } from 'vitest';
import { simulatePayoff, type PayoffDebt } from '../shared/payoff';
import { allocateWindfall, amortizedPayment, compareRefinance, dailyInterest, debtVsInvest, followPath, forecast, independenceNumber, monthReached, payDown, weightedApr } from '../shared/planning';

const card: PayoffDebt = { id: 'card', name: 'Card', balance: 5000, apr: 24, minPayment: 150 };
const store: PayoffDebt = { id: 'store', name: 'Store', balance: 1000, apr: 30, minPayment: 40 };
const loan: PayoffDebt = { id: 'loan', name: 'Student loan', balance: 12000, apr: 5, minPayment: 130 };
const debts = [card, store, loan];

describe('simulatePayoff payments', () => {
  it('reports what is paid each month, summing to the total', () => {
    const r = simulatePayoff(debts, 'avalanche', 100);
    expect(r.payments).toHaveLength(r.months!);
    expect(r.payments[0]).toBe(420);
    expect(r.payments.reduce((s, v) => s + v, 0)).toBeCloseTo(r.totalPaid, 0);
    expect(r.payments.at(-1)!).toBeLessThanOrEqual(420);
  });
});

describe('allocateWindfall', () => {
  const base = { cash: 1000, essentials: 3000, emergencyMonths: 3, debts, strategy: 'avalanche' as const, extra: 0 };

  it('fills the cushion first, then the most expensive debt', () => {
    const plan = allocateWindfall({ ...base, amount: 2500 });
    expect(plan.steps.map((s) => [s.target, s.amount])).toEqual([
      ['cushion', 2000],
      ['debt', 500],
    ]);
    expect(plan.steps[1].debtId).toBe('store');
  });

  it('walks the whole ladder and leaves low-rate debt alone', () => {
    const plan = allocateWindfall({ ...base, amount: 20000 });
    expect(plan.steps.map((s) => [s.target, s.amount])).toEqual([
      ['cushion', 2000],
      ['debt', 1000],
      ['debt', 5000],
      ['emergency', 6000],
      ['invest', 6000],
    ]);
    expect(plan.steps.some((s) => s.debtId === 'loan')).toBe(false);
    expect(plan.toDebt).toBe(6000);
    expect(plan.steps.reduce((s, x) => s + x.amount, 0)).toBe(20000);
  });

  it('reports the interest and time the debt portion saves', () => {
    const plan = allocateWindfall({ ...base, cash: 9000, amount: 3000 });
    expect(plan.toDebt).toBe(3000);
    expect(plan.interestSaved).toBeGreaterThan(500);
    expect(plan.monthsAfter!).toBeLessThan(plan.monthsBefore!);
  });

  it('handles nothing to allocate and no debts', () => {
    expect(allocateWindfall({ ...base, amount: 0 }).steps).toEqual([]);
    const plan = allocateWindfall({ ...base, cash: 20000, debts: [], amount: 500 });
    expect(plan.steps.map((s) => s.target)).toEqual(['invest']);
    expect(plan.interestSaved).toBe(0);
  });
});

describe('debtVsInvest', () => {
  it('spends the same total each month on both paths', () => {
    // With no return, the only difference between the paths is interest paid.
    const r = debtVsInvest([card], 'avalanche', 0, 200, 0, 5);
    expect(r.advantage).toBeCloseTo(r.investFirst.interestPaid - r.debtFirst.interestPaid, 0);
    expect(r.advantage).toBeGreaterThan(0);
  });

  it('favours debt when the rate is far above the expected return', () => {
    const r = debtVsInvest([card], 'avalanche', 0, 200, 7, 10);
    expect(r.advantage).toBeGreaterThan(0);
    expect(r.debtFirst.debtFreeMonth!).toBeLessThan(r.investFirst.debtFreeMonth!);
    expect(r.breakEvenReturn!).toBeGreaterThan(15);
  });

  it('favours investing when the debt is cheap', () => {
    const r = debtVsInvest([loan], 'avalanche', 0, 200, 8, 15);
    expect(r.advantage).toBeLessThan(0);
    expect(r.breakEvenReturn!).toBeGreaterThan(3);
    expect(r.breakEvenReturn!).toBeLessThan(7);
  });

  it('breaks even near the debt rate', () => {
    const r = debtVsInvest([{ ...loan, apr: 6 }], 'avalanche', 0, 300, 6, 10);
    expect(Math.abs(r.breakEvenReturn! - 6)).toBeLessThan(0.6);
  });

  it('invests freed payments once debt is gone', () => {
    const p = followPath([store], 'avalanche', 60, 0, 0, 24);
    const done = p.debtFreeMonth!;
    expect(p.invested[done - 1]).toBe(0);
    expect(p.invested[24]).toBeCloseTo((24 - done) * 100 + (100 - (simulatePayoff([store], 'avalanche', 60).payments.at(-1) ?? 0)), 1);
    expect(p.debt[24]).toBe(0);
  });
});

describe('compareRefinance', () => {
  it('prices a 0% transfer as fee only when cleared inside the promo', () => {
    const r = compareRefinance([card], 400, { kind: 'transfer', feePct: 3, promoMonths: 15, promoApr: 0, afterApr: 26 });
    expect(r.option.fee).toBe(150);
    expect(r.option.interest).toBe(0);
    expect(r.option.months).toBe(13);
    expect(r.clearsInPromo).toBe(true);
    expect(r.neededForPromo).toBeCloseTo(5150 / 15, 1);
    expect(r.savings).toBeCloseTo(r.current.cost - 150, 2);
    expect(r.savings).toBeGreaterThan(400);
  });

  it('charges the later rate on what is left after the promo', () => {
    const r = compareRefinance([card], 150, { kind: 'transfer', feePct: 3, promoMonths: 12, promoApr: 0, afterApr: 26 });
    expect(r.clearsInPromo).toBe(false);
    expect(r.option.interest).toBeGreaterThan(0);
    expect(r.option.months!).toBeGreaterThan(12);
  });

  it('never uses a payment below the minimums', () => {
    expect(compareRefinance([card, store], 50, { kind: 'loan', apr: 12, termMonths: 36, feePct: 0 }).current.payment).toBe(190);
  });

  it('amortises a consolidation loan with its fee financed', () => {
    const r = compareRefinance([card, store], 300, { kind: 'loan', apr: 12, termMonths: 36, feePct: 5 });
    expect(r.balance).toBe(6000);
    expect(r.option.fee).toBe(300);
    expect(r.option.payment).toBeCloseTo(amortizedPayment(6300, 12, 36), 2);
    expect(r.option.months).toBe(36);
    expect(r.option.cost).toBeCloseTo(300 + r.option.payment * 36 - 6300, 1);
  });

  it('can show that refinancing costs more', () => {
    const r = compareRefinance([loan], 400, { kind: 'loan', apr: 14, termMonths: 60, feePct: 5 });
    expect(r.savings).toBeLessThan(0);
  });
});

describe('payDown', () => {
  it('matches simple division at 0%', () => {
    expect(payDown(1200, 100, [{ months: null, apr: 0 }])).toEqual({ months: 12, interest: 0 });
  });
  it('never finishes when the payment only covers interest', () => {
    expect(payDown(10000, 100, [{ months: null, apr: 24 }]).months).toBeNull();
  });
});

describe('forecast', () => {
  const input = { debts, strategy: 'avalanche' as const, extra: 100, cash: 5000, investments: 20000, otherAssets: 0, monthlySave: 100, monthlyInvest: 300, annualReturn: 5, years: 10, rollover: true };

  it('starts at today and grows', () => {
    const f = forecast(input);
    expect(f.net).toHaveLength(121);
    expect(f.net[0]).toBe(5000 + 20000 - 18000);
    expect(f.cash[120]).toBe(5000 + 120 * 100);
    expect(f.debt[120]).toBe(0);
    expect(f.net[120]).toBeGreaterThan(f.net[0]);
  });

  it('matches compound growth when there is no debt', () => {
    const f = forecast({ ...input, debts: [], monthlyInvest: 0, monthlySave: 0, years: 1 });
    expect(f.invested[12]).toBeCloseTo(20000 * Math.pow(1 + 0.05 / 12, 12), 1);
  });

  it('rolling freed payments into investing ends ahead of not doing so', () => {
    const on = forecast(input);
    const off = forecast({ ...input, rollover: false });
    expect(on.invested[120]).toBeGreaterThan(off.invested[120]);
    const m = on.debtFreeMonth!;
    expect(on.invested[m - 1]).toBeCloseTo(off.invested[m - 1], 2);
  });

  it('finds when a target is reached', () => {
    expect(monthReached([1, 2, 3, 4], 3)).toBe(2);
    expect(monthReached([1, 2], 5)).toBeNull();
    expect(independenceNumber(4000)).toBe(1_200_000);
  });
});

describe('summary figures', () => {
  it('computes daily interest and the balance-weighted rate', () => {
    expect(dailyInterest([card])).toBeCloseTo((5000 * 0.24) / 365, 2);
    expect(weightedApr([card, loan])).toBeCloseTo((5000 * 24 + 12000 * 5) / 17000, 2);
    expect(weightedApr([])).toBe(0);
  });
});
