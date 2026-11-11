// Types shared by the server and the web app.

export type AccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'asset';

export interface Account {
  id: string;
  item_id: string | null;
  name: string;
  institution: string | null;
  mask: string | null;
  type: AccountType;
  subtype: string | null;
  /** Depository/investment/asset: what you have. Credit/loan: what you owe (positive). */
  balance: number;
  credit_limit: number | null;
  apr: number | null;
  min_payment: number | null;
  due_day: number | null;
  manual: boolean;
  updated_at: string;
}

export interface Transaction {
  id: string;
  account_id: string | null;
  date: string; // YYYY-MM-DD
  /** Negative = money out, positive = money in. */
  amount: number;
  name: string;
  merchant: string | null;
  category: string;
  pending: boolean;
  source: 'plaid' | 'manual' | 'csv' | 'demo' | 'assistant';
  notes: string | null;
}

export type AssetClass = 'us_stock' | 'intl_stock' | 'bond' | 'cash' | 'crypto' | 'other';

export interface Holding {
  id: string;
  account_id: string;
  symbol: string | null;
  name: string;
  quantity: number;
  price: number;
  cost_basis: number | null;
  asset_class: AssetClass;
  price_updated_at: string | null;
  manual: boolean;
}

export interface Goal {
  id: string;
  name: string;
  kind: 'savings' | 'emergency' | 'purchase' | 'invest';
  target_amount: number;
  /** Used when the goal is not linked to an account. */
  current_amount: number;
  linked_account_id: string | null;
  target_date: string | null;
  monthly_contribution: number;
  created_at: string;
}

export type PayoffStrategy = 'avalanche' | 'snowball';

export interface Settings {
  strategy: PayoffStrategy;
  extra_payment: number;
  target_allocation: Partial<Record<AssetClass, number>> | null;
  default_account_id: string | null;
  emergency_months: number;
  demo: boolean;
}

export type Severity = 'critical' | 'warn' | 'info' | 'good';

/** A one-tap change the monitor or the assistant can propose. */
export type InsightAction =
  | { type: 'set_budgets'; budgets: { category: string; amount: number }[]; label: string }
  | { type: 'shift_budget'; from: string; to: string; amount: number; label: string }
  | { type: 'set_extra_payment'; amount: number; label: string }
  | { type: 'set_strategy'; strategy: PayoffStrategy; label: string }
  | { type: 'create_goal'; goal: { name: string; kind: Goal['kind']; target_amount: number; monthly_contribution: number; linked_account_id?: string | null; target_date?: string | null }; label: string }
  | { type: 'set_goal_contribution'; goal_id: string; monthly: number; label: string }
  | { type: 'set_target_allocation'; allocation: Partial<Record<AssetClass, number>>; label: string };

export interface Insight {
  id: string;
  key: string;
  area: 'budget' | 'debt' | 'invest' | 'save' | 'cash' | 'general';
  severity: Severity;
  title: string;
  body: string;
  action: InsightAction | null;
  source: 'monitor' | 'assistant';
  status: 'new' | 'applied' | 'dismissed';
  created_at: string;
}

export interface BudgetLine {
  category: string;
  budget: number;
  spent: number;
  /** Average monthly spend over the previous three full months. */
  average: number;
}

export interface DebtView {
  id: string;
  name: string;
  kind: string;
  balance: number;
  apr: number;
  min_payment: number;
  min_estimated: boolean;
  credit_limit: number | null;
  due_day: number | null;
}

export interface MonthFlow {
  month: string; // YYYY-MM
  income: number;
  spending: number;
}

export interface NextDollar {
  target: 'buffer' | 'debt' | 'emergency' | 'invest' | 'goal';
  title: string;
  reason: string;
  steps: { label: string; done: boolean; current: boolean; detail: string }[];
}

export interface AppState {
  today: string;
  capabilities: { plaid: boolean; plaidEnv: string; ai: boolean; model: string };
  settings: Settings;
  accounts: Account[];
  items: { id: string; institution: string; status: string; error: string | null; last_sync: string | null }[];
  holdings: Holding[];
  goals: (Goal & { progress: number; projected_date: string | null; needed_monthly: number | null })[];
  debts: DebtView[];
  budgets: BudgetLine[];
  insights: Insight[];
  brief: { text: string; at: string; source: 'assistant' | 'monitor' } | null;
  totals: {
    cash: number;
    investments: number;
    otherAssets: number;
    debt: number;
    netWorth: number;
    netWorthChange30d: number | null;
    debtChange30d: number | null;
  };
  month: {
    key: string;
    income: number;
    spending: number;
    budgeted: number;
    dayOfMonth: number;
    daysInMonth: number;
    safeToSpendToday: number | null;
    paceThis: number[]; // cumulative spend per day, this month (up to today)
    paceLast: number[]; // cumulative spend per day, last month (full)
  };
  flows: MonthFlow[];
  netWorthHistory: { date: string; net: number; assets: number; debt: number }[];
  monthlyEssentials: number;
  monthlySpendAvg: number;
  monthlyIncomeAvg: number;
  nextDollar: NextDollar | null;
  recurring: { name: string; amount: number; category: string; lastDate: string; nextDate: string; changed: number | null }[];
  hasData: boolean;
}
