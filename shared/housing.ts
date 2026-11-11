import type { HousingScenario } from './types';

/**
 * Renting, owning, and the comparison between them. Everything is simulated month by month so
 * that amortisation, PMI dropping off, rent rises and compounding all interact the way they do in
 * life. Taxes (mortgage-interest deduction, capital gains) are deliberately left out.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Starting assumptions. The mortgage rate is a placeholder: use one you have actually been quoted. */
export function defaultScenario(rent = 1500, grossIncome: number | null = null): HousingScenario {
  return {
    price: 350000,
    down_pct: 10,
    rate: 6.5,
    term_years: 30,
    tax_pct: 1.1,
    insurance_yr: 1800,
    hoa_mo: 0,
    maint_pct: 1,
    pmi_pct: 0.6,
    closing_pct: 3,
    sell_pct: 6,
    rent: Math.max(300, Math.round(rent / 25) * 25),
    rent_insurance_mo: 15,
    rent_growth: 3.5,
    appreciation: 3.5,
    invest_return: 7,
    inflation: 3,
    years: 10,
    gross_income: grossIncome,
  };
}

export function monthlyPI(loan: number, rate: number, termYears: number): number {
  const n = Math.round(termYears * 12);
  if (loan <= 0 || n <= 0) return 0;
  const r = rate / 1200;
  return r === 0 ? loan / n : (loan * r) / (1 - Math.pow(1 + r, -n));
}

export function upfront(s: HousingScenario) {
  const down = round2((s.price * s.down_pct) / 100);
  const closing = round2((s.price * s.closing_pct) / 100);
  return { down, closing, total: round2(down + closing), loan: round2(s.price - down) };
}

export interface OwnerCost {
  pi: number;
  tax: number;
  insurance: number;
  hoa: number;
  maintenance: number;
  pmi: number;
  total: number;
}

/** First-month cost of owning, itemised. PMI applies while the loan is above 80% of the price. */
export function ownerMonthly(s: HousingScenario): OwnerCost {
  const { loan } = upfront(s);
  const c = {
    pi: monthlyPI(loan, s.rate, s.term_years),
    tax: (s.price * s.tax_pct) / 1200,
    insurance: s.insurance_yr / 12,
    hoa: s.hoa_mo,
    maintenance: (s.price * s.maint_pct) / 1200,
    pmi: loan > s.price * 0.8 + 0.005 ? (loan * s.pmi_pct) / 1200 : 0,
  };
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { pi: round2(c.pi), tax: round2(c.tax), insurance: round2(c.insurance), hoa: round2(c.hoa), maintenance: round2(c.maintenance), pmi: round2(c.pmi), total: round2(total) };
}

/** The largest price whose first-month cost of owning fits a monthly budget, other inputs unchanged. */
export function maxPrice(s: HousingScenario, monthlyBudget: number): number {
  if (monthlyBudget <= ownerMonthly({ ...s, price: 1000 }).total) return 0;
  let lo = 1000;
  let hi = 20_000_000;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (ownerMonthly({ ...s, price: mid }).total <= monthlyBudget) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / 1000) * 1000;
}

export interface HousingPath {
  /** Index 0 is today; index k is after k years. */
  years: number[];
  homeValue: number[];
  loanBalance: number[];
  /** Value minus loan, before selling costs. */
  equity: number[];
  /** Equity from the down payment and principal paid, and from the price rising. */
  paidIn: number[];
  appreciation: number[];
  interestPaid: number[];
  /** What the interest payments would have grown to if invested as they were paid. */
  interestInvested: number[];
  /** Net worth from housing: owner = sale proceeds + side savings; renter = portfolio. */
  ownerNet: number[];
  renterNet: number[];
  /** Typical month in each year. */
  ownerMonthly: number[];
  renterMonthly: number[];
  ownerSpent: number[];
  renterSpent: number[];
  pmiEndsMonth: number | null;
  /** First year buying is ahead, if any within the horizon. */
  breakEvenYear: number | null;
}

/**
 * Rent versus buy on equal terms. Both households spend the same each month: whoever has the
 * cheaper month invests the difference. The renter also invests the down payment and closing
 * costs on day one. The owner's wealth is what a sale would leave after costs and the loan.
 */
export function rentVsBuy(s: HousingScenario, horizonYears = s.years): HousingPath {
  const months = Math.max(1, Math.round(horizonYears * 12));
  const { down, total: cashIn, loan } = upfront(s);
  const pi = monthlyPI(loan, s.rate, s.term_years);
  const r = s.rate / 1200;
  const g = s.appreciation / 1200;
  const inv = s.invest_return / 1200;
  const hasPmi = loan > s.price * 0.8 + 0.005;

  let value = s.price;
  let balance = loan;
  let rent = s.rent;
  let insurance = s.insurance_yr / 12;
  let hoa = s.hoa_mo;
  let rentIns = s.rent_insurance_mo;
  let ownerSide = 0;
  let renterPortfolio = cashIn;
  let interest = 0;
  let interestInvested = 0;
  let ownerSpent = cashIn;
  let renterSpent = 0;
  let pmiEndsMonth: number | null = hasPmi ? null : 0;

  const p: HousingPath = { years: [], homeValue: [], loanBalance: [], equity: [], paidIn: [], appreciation: [], interestPaid: [], interestInvested: [], ownerNet: [], renterNet: [], ownerMonthly: [], renterMonthly: [], ownerSpent: [], renterSpent: [], pmiEndsMonth: 0, breakEvenYear: null };
  const record = (year: number, ownerCost: number, renterCost: number) => {
    p.years.push(year);
    p.homeValue.push(round2(value));
    p.loanBalance.push(round2(balance));
    p.equity.push(round2(value - balance));
    p.paidIn.push(round2(down + (loan - balance)));
    p.appreciation.push(round2(value - s.price));
    p.interestPaid.push(round2(interest));
    p.interestInvested.push(round2(interestInvested));
    p.ownerNet.push(round2(value * (1 - s.sell_pct / 100) - balance + ownerSide));
    p.renterNet.push(round2(renterPortfolio));
    p.ownerMonthly.push(round2(ownerCost));
    p.renterMonthly.push(round2(renterCost));
    p.ownerSpent.push(round2(ownerSpent));
    p.renterSpent.push(round2(renterSpent));
  };
  record(0, ownerMonthly(s).total, s.rent + s.rent_insurance_mo);

  for (let m = 1; m <= months; m++) {
    const charge = balance * r;
    const payment = balance > 0.005 ? Math.min(pi, balance + charge) : 0;
    const pmi = hasPmi && balance > s.price * 0.8 + 0.005 ? (loan * s.pmi_pct) / 1200 : 0;
    if (hasPmi && pmi === 0 && pmiEndsMonth === null) pmiEndsMonth = m - 1;
    const ownerCost = payment + (value * s.tax_pct) / 1200 + (value * s.maint_pct) / 1200 + insurance + hoa + pmi;
    const renterCost = rent + rentIns;

    interest += charge;
    interestInvested = interestInvested * (1 + inv) + charge;
    balance = Math.max(0, balance + charge - payment);
    ownerSpent += ownerCost;
    renterSpent += renterCost;

    ownerSide *= 1 + inv;
    renterPortfolio *= 1 + inv;
    if (ownerCost > renterCost) renterPortfolio += ownerCost - renterCost;
    else ownerSide += renterCost - ownerCost;

    value *= 1 + g;
    if (m % 12 === 0) {
      record(m / 12, ownerCost, renterCost);
      rent *= 1 + s.rent_growth / 100;
      rentIns *= 1 + s.inflation / 100;
      insurance *= 1 + s.inflation / 100;
      hoa *= 1 + s.inflation / 100;
    }
  }
  p.pmiEndsMonth = pmiEndsMonth;
  const k = p.ownerNet.findIndex((v, i) => i > 0 && v >= p.renterNet[i]);
  p.breakEvenYear = k > 0 ? k : null;
  return p;
}

/** Rent on its own: what each year costs as it rises, and the running total. */
export function rentPath(rent: number, insuranceMo: number, growthPct: number, inflationPct: number, years: number) {
  const out: { year: number; monthly: number; annual: number; total: number }[] = [];
  let r = rent;
  let ins = insuranceMo;
  let total = 0;
  for (let y = 1; y <= years; y++) {
    const annual = (r + ins) * 12;
    total += annual;
    out.push({ year: y, monthly: round2(r), annual: round2(annual), total: round2(total) });
    r *= 1 + growthPct / 100;
    ins *= 1 + inflationPct / 100;
  }
  return out;
}
