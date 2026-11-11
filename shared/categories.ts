export type CategoryGroup = 'income' | 'essentials' | 'lifestyle' | 'financial' | 'other';

export interface Category {
  id: string;
  label: string;
  group: CategoryGroup;
  /** Counts toward "spending" (transfers, savings moves and income do not). */
  spend: boolean;
}

export const CATEGORIES: Category[] = [
  { id: 'income', label: 'Income', group: 'income', spend: false },
  { id: 'housing', label: 'Housing', group: 'essentials', spend: true },
  { id: 'utilities', label: 'Utilities', group: 'essentials', spend: true },
  { id: 'groceries', label: 'Groceries', group: 'essentials', spend: true },
  { id: 'transport', label: 'Transport', group: 'essentials', spend: true },
  { id: 'insurance', label: 'Insurance', group: 'essentials', spend: true },
  { id: 'health', label: 'Health', group: 'essentials', spend: true },
  { id: 'debt_payment', label: 'Loan payments', group: 'essentials', spend: true },
  { id: 'dining', label: 'Dining out', group: 'lifestyle', spend: true },
  { id: 'shopping', label: 'Shopping', group: 'lifestyle', spend: true },
  { id: 'entertainment', label: 'Entertainment', group: 'lifestyle', spend: true },
  { id: 'subscriptions', label: 'Subscriptions', group: 'lifestyle', spend: true },
  { id: 'travel', label: 'Travel', group: 'lifestyle', spend: true },
  { id: 'personal', label: 'Personal care', group: 'lifestyle', spend: true },
  { id: 'fees', label: 'Fees & interest', group: 'financial', spend: true },
  { id: 'savings', label: 'Savings & investing', group: 'financial', spend: false },
  { id: 'transfer', label: 'Transfers', group: 'financial', spend: false },
  { id: 'other', label: 'Other', group: 'other', spend: true },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const category = (id: string): Category => BY_ID.get(id) ?? BY_ID.get('other')!;
export const categoryLabel = (id: string) => category(id).label;
export const isSpend = (id: string) => category(id).spend;
export const isEssential = (id: string) => category(id).group === 'essentials';

/** Keyword → category rules, checked in order against the lower-cased description. */
const RULES: [RegExp, string][] = [
  [/payroll|paycheck|direct dep|salary|\bdeposit\b.*(employer|inc)|gusto|adp\b|interest paid|dividend|refund from irs|tax refund/, 'income'],
  [/\brent\b|mortgage|landlord|property mgmt|apartments?|hoa\b/, 'housing'],
  [/electric|\bgas co|water (dept|util)|utility|utilities|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|pg&e|con ?ed|energy|sewer|trash/, 'utilities'],
  [/grocer|safeway|kroger|trader joe|whole foods|aldi|costco|publix|wegmans|h-e-b|heb\b|sprouts|food lion|instacart|market basket/, 'groceries'],
  [/netflix|spotify|hulu|disney\+?|hbo|max\.com|apple\.com\/bill|icloud|youtube premium|prime video|audible|patreon|substack|adobe|dropbox|google one|openai|chatgpt|claude\.ai|membership|subscription|gym|fitness|peloton/, 'subscriptions'],
  [/uber eats|doordash|grubhub|restaurant|cafe|coffee|starbucks|dunkin|mcdonald|chipotle|pizza|taco|burger|sushi|bar\b|brewery|diner|bakery|deli|grill|kitchen|bistro/, 'dining'],
  [/uber|lyft|shell|chevron|exxon|bp\b|gas station|fuel|parking|transit|metro|toll|dmv|auto (repair|service)|jiffy|car wash/, 'transport'],
  [/insurance|geico|state farm|progressive|allstate|usaa/, 'insurance'],
  [/pharmacy|cvs|walgreens|doctor|dental|dentist|medical|hospital|clinic|optom|therapy|labcorp|quest diag/, 'health'],
  [/student loan|navient|nelnet|mohela|sallie mae|auto loan|car payment|loan payment|loan pmt|sofi loan|great lakes/, 'debt_payment'],
  [/credit card payment|card payment|payment thank you|autopay|epayment|online payment/, 'transfer'],
  [/transfer to (savings|brokerage|invest)|vanguard|fidelity|schwab|robinhood|wealthfront|betterment|401k|roth|ira contribution|acorns/, 'savings'],
  [/transfer|zelle|venmo|cash app|paypal transfer|wire|xfer/, 'transfer'],
  [/airline|airbnb|hotel|delta air|united air|southwest|expedia|booking\.com|marriott|hilton|hertz|amtrak/, 'travel'],
  [/cinema|movie|theater|theatre|concert|ticketmaster|steam|playstation|xbox|nintendo|bowling|museum|golf/, 'entertainment'],
  [/salon|barber|spa\b|nails|sephora|ulta|haircut/, 'personal'],
  [/amazon|target|walmart|best buy|ikea|etsy|ebay|nike|apple store|home depot|lowe'?s|old navy|gap\b|zara|h&m|nordstrom|macy|store|shop/, 'shopping'],
  [/\bfee\b|interest charge|overdraft|late charge|finance charge|atm (fee|surcharge)/, 'fees'],
];

export interface UserRule {
  pattern: string;
  category: string;
}

export function categorize(name: string, amount: number, userRules: UserRule[] = []): string {
  const text = name.toLowerCase();
  for (const r of userRules) {
    if (r.pattern && text.includes(r.pattern.toLowerCase())) return r.category;
  }
  for (const [re, cat] of RULES) {
    if (re.test(text)) {
      // A matching keyword on an inflow is a refund or income, not spending.
      if (amount > 0 && isSpend(cat)) return cat === 'fees' ? 'income' : cat;
      return cat;
    }
  }
  return amount > 0 ? 'income' : 'other';
}

/** Plaid personal_finance_category (primary + detailed) → our category id. */
export function fromPlaidCategory(primary: string | undefined, detailed: string | undefined, amount: number): string | null {
  if (!primary) return null;
  const d = detailed ?? '';
  switch (primary) {
    case 'INCOME': return 'income';
    case 'TRANSFER_IN': return d.includes('INVESTMENT') ? 'savings' : 'transfer';
    case 'TRANSFER_OUT': return d.includes('INVESTMENT') || d.includes('SAVINGS') ? 'savings' : 'transfer';
    case 'LOAN_PAYMENTS': return d.includes('CREDIT_CARD') ? 'transfer' : d.includes('MORTGAGE') ? 'housing' : 'debt_payment';
    case 'BANK_FEES': return 'fees';
    case 'ENTERTAINMENT': return d.includes('TV_AND_MOVIES') || d.includes('MUSIC') ? 'subscriptions' : 'entertainment';
    case 'FOOD_AND_DRINK': return d.includes('GROCERIES') ? 'groceries' : 'dining';
    case 'GENERAL_MERCHANDISE': return 'shopping';
    case 'HOME_IMPROVEMENT': return 'shopping';
    case 'MEDICAL': return 'health';
    case 'PERSONAL_CARE': return d.includes('GYMS') ? 'subscriptions' : 'personal';
    case 'GENERAL_SERVICES': return d.includes('INSURANCE') ? 'insurance' : 'other';
    case 'GOVERNMENT_AND_NON_PROFIT': return 'other';
    case 'TRANSPORTATION': return 'transport';
    case 'TRAVEL': return 'travel';
    case 'RENT_AND_UTILITIES': return d.includes('RENT') ? 'housing' : 'utilities';
    default: return amount > 0 ? 'income' : null;
  }
}
