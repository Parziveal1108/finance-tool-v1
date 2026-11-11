import { describe, expect, it } from 'vitest';
import { defaultScenario, maxPrice, monthlyPI, ownerMonthly, rentPath, rentVsBuy, upfront } from '../shared/housing';
import { addDays, detectPay, extraPaycheckMonths, futureValue, matchSummary, nextPaydays, paychecksPerYear } from '../shared/paycheck';

const base = { ...defaultScenario(1800), price: 400000, down_pct: 20, rate: 6, term_years: 30, tax_pct: 1.2, insurance_yr: 1800, hoa_mo: 0, maint_pct: 1, closing_pct: 3, sell_pct: 6, rent: 1800, rent_insurance_mo: 0, rent_growth: 3, appreciation: 3, invest_return: 6, inflation: 3, years: 10 };

describe('mortgage basics', () => {
  it('matches the standard payment formula', () => {
    expect(monthlyPI(320000, 6, 30)).toBeCloseTo(1918.56, 2);
    expect(monthlyPI(120000, 0, 10)).toBe(1000);
    expect(monthlyPI(0, 6, 30)).toBe(0);
  });

  it('itemises the monthly cost and the cash needed', () => {
    expect(upfront(base)).toEqual({ down: 80000, closing: 12000, total: 92000, loan: 320000 });
    const c = ownerMonthly(base);
    expect(c).toMatchObject({ pi: 1918.56, tax: 400, insurance: 150, hoa: 0, maintenance: 333.33, pmi: 0 });
    expect(c.total).toBeCloseTo(1918.56 + 400 + 150 + 333.33, 1);
  });

  it('charges PMI only under 20% down', () => {
    expect(ownerMonthly({ ...base, down_pct: 10, pmi_pct: 0.6 }).pmi).toBe(180);
    expect(ownerMonthly({ ...base, down_pct: 20 }).pmi).toBe(0);
  });

  it('finds the price that fits a monthly budget', () => {
    const price = maxPrice(base, 3000);
    expect(ownerMonthly({ ...base, price }).total).toBeLessThanOrEqual(3000);
    expect(ownerMonthly({ ...base, price: price + 2000 }).total).toBeGreaterThan(3000);
    expect(maxPrice(base, 50)).toBe(0);
  });
});

describe('rentVsBuy', () => {
  it('amortises the loan to zero over the full term', () => {
    const p = rentVsBuy(base, 30);
    expect(p.loanBalance[30]).toBeCloseTo(0, 0);
    expect(p.interestPaid[30]).toBeCloseTo(1918.56 * 360 - 320000, -1);
    expect(p.paidIn[30]).toBeCloseTo(400000, 0);
  });

  it('splits equity into what was paid in and what the market added', () => {
    const p = rentVsBuy(base, 10);
    expect(p.homeValue[10]).toBeCloseTo(400000 * Math.pow(1 + 0.03 / 12, 120), 0);
    for (const y of [0, 5, 10]) expect(p.paidIn[y] + p.appreciation[y]).toBeCloseTo(p.equity[y], 1);
    expect(p.equity[0]).toBe(80000);
  });

  it('starts the buyer behind by closing and selling costs', () => {
    const p = rentVsBuy(base, 10);
    expect(p.renterNet[0]).toBe(92000);
    expect(p.ownerNet[0]).toBe(80000 - 24000);
  });

  it('keeps both households spending the same each month', () => {
    // With no investment return, wealth differences come only from housing itself, and the
    // two portfolios together hold exactly the monthly differences.
    const p = rentVsBuy({ ...base, invest_return: 0 }, 10);
    const ownerSide = p.ownerNet[10] - (p.homeValue[10] * 0.94 - p.loanBalance[10]);
    const renterAdded = p.renterNet[10] - 92000;
    expect(renterAdded - ownerSide).toBeCloseTo(p.ownerSpent[10] - 92000 - p.renterSpent[10], 0);
  });

  it('compounds the interest stream when invested', () => {
    const flat = rentVsBuy({ ...base, invest_return: 0 }, 10);
    expect(flat.interestInvested[10]).toBeCloseTo(flat.interestPaid[10], 1);
    const grown = rentVsBuy(base, 10);
    expect(grown.interestInvested[10]).toBeGreaterThan(grown.interestPaid[10] * 1.2);
  });

  it('favours buying more as prices rise faster, and renting as returns rise', () => {
    const edge = (o: object) => {
      const p = rentVsBuy({ ...base, ...o }, 10);
      return p.ownerNet[10] - p.renterNet[10];
    };
    expect(edge({ appreciation: 5 })).toBeGreaterThan(edge({ appreciation: 1 }));
    expect(edge({ invest_return: 10 })).toBeLessThan(edge({ invest_return: 3 }));
    expect(edge({ rent: 2600 })).toBeGreaterThan(edge({ rent: 1400 }));
  });

  it('reports the first year buying is ahead', () => {
    const p = rentVsBuy({ ...base, rent: 2800, appreciation: 4 }, 15);
    expect(p.breakEvenYear).not.toBeNull();
    expect(p.ownerNet[p.breakEvenYear!]).toBeGreaterThanOrEqual(p.renterNet[p.breakEvenYear!]);
    expect(p.ownerNet[p.breakEvenYear! - 1]).toBeLessThan(p.renterNet[p.breakEvenYear! - 1]);
    expect(rentVsBuy({ ...base, rent: 900, appreciation: 0, invest_return: 9 }, 10).breakEvenYear).toBeNull();
  });

  it('drops PMI once the loan falls to 80% of the price', () => {
    const p = rentVsBuy({ ...base, down_pct: 10, pmi_pct: 0.6 }, 15);
    expect(p.pmiEndsMonth).toBeGreaterThan(60);
    expect(p.pmiEndsMonth).toBeLessThan(160);
    expect(rentVsBuy(base, 5).pmiEndsMonth).toBe(0);
  });
});

describe('rentPath', () => {
  it('raises rent each year and totals it', () => {
    const r = rentPath(1000, 0, 10, 0, 3);
    expect(r.map((y) => y.monthly)).toEqual([1000, 1100, 1210]);
    expect(r[2].total).toBe(12000 + 13200 + 14520);
  });
});

describe('paychecks', () => {
  it('steps a biweekly schedule from any known payday', () => {
    expect(nextPaydays('2026-11-06', 'biweekly', '2026-11-11', 3)).toEqual(['2026-11-20', '2026-12-04', '2026-12-18']);
    expect(nextPaydays('2026-11-06', 'biweekly', '2026-11-06', 1)).toEqual(['2026-11-20']);
    expect(nextPaydays('2027-03-12', 'biweekly', '2026-11-11', 1)).toEqual(['2026-11-20']); // anchor in the future
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });

  it('handles monthly and twice-monthly pay', () => {
    expect(nextPaydays('2026-10-31', 'monthly', '2026-11-11', 4)).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
    expect(nextPaydays('2026-11-01', 'semimonthly', '2026-11-11', 3)).toEqual(['2026-11-16', '2026-12-01', '2026-12-16']);
    expect(paychecksPerYear('biweekly')).toBe(26);
  });

  it('finds the two three-paycheck months in a year of biweekly pay', () => {
    const extra = extraPaycheckMonths('2026-11-06', 'biweekly', '2026-11-11', 12);
    expect(extra).toEqual([
      { month: '2027-01', extraPayday: '2027-01-29' }, // paydays on the 1st, 15th and 29th
      { month: '2027-07', extraPayday: '2027-07-30' },
    ]);
    expect(extraPaycheckMonths('2026-11-01', 'semimonthly', '2026-11-11')).toEqual([]);
  });

  it('counts the current month from its first payday', () => {
    // July 2026 has paydays on the 3rd, 17th and 31st.
    expect(extraPaycheckMonths('2026-11-06', 'biweekly', '2026-07-20', 2)[0]).toEqual({ month: '2026-07', extraPayday: '2026-07-31' });
  });

  it('detects cadence and amount from deposits', () => {
    const pay = (dates: string[], amount = 2455.12) => dates.map((date) => ({ date, amount, name: 'Payroll Direct Deposit - Brightline' }));
    expect(detectPay(pay(['2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23', '2026-11-06']))).toEqual({ frequency: 'biweekly', amount: 2455.12, lastDate: '2026-11-06' });
    expect(detectPay(pay(['2026-09-01', '2026-09-15', '2026-10-01', '2026-10-15', '2026-11-01']))!.frequency).toBe('semimonthly');
    expect(detectPay(pay(['2026-08-31', '2026-09-30', '2026-10-30']))!.frequency).toBe('monthly');
    expect(detectPay(pay(['2026-10-09', '2026-10-23']))).toBeNull();
    expect(detectPay([...pay(['2026-09-11', '2026-09-25', '2026-10-09']), { date: '2026-10-01', amount: 640, name: 'IRS refund' }])!.amount).toBe(2455.12);
  });
});

describe('employer match', () => {
  it('prices what is collected and what is left unclaimed', () => {
    const m = matchSummary({ rate: 50, limit_pct: 6, salary: 80000, contributing_pct: 4 });
    expect(m).toEqual({ configured: true, yours: 3200, employer: 1600, employerMax: 2400, unclaimed: 800, costToMax: 1600, full: false });
  });
  it('caps the match at the limit', () => {
    const m = matchSummary({ rate: 50, limit_pct: 6, salary: 80000, contributing_pct: 10 });
    expect(m.employer).toBe(2400);
    expect(m.unclaimed).toBe(0);
    expect(m.full).toBe(true);
  });
  it('is unconfigured until salary, limit and contribution are known', () => {
    expect(matchSummary({ rate: 50, limit_pct: null, salary: null, contributing_pct: null }).configured).toBe(false);
    expect(matchSummary({ rate: 0, limit_pct: 6, salary: 80000, contributing_pct: 6 }).configured).toBe(false);
  });
  it('grows a monthly contribution', () => {
    expect(futureValue(100, 0, 10)).toBe(12000);
    expect(futureValue(200, 6, 30)).toBeCloseTo(200903, -1);
  });
});
