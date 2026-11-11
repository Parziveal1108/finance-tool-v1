import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import type { AppState, BudgetLine } from '../../shared/types';
import { category, isEssential, type CategoryGroup } from '../../shared/categories';
import { api, useRefresh } from '../lib/api';
import { dayLabel, monthLabel, usd, usd2, useCountUp } from '../lib/format';
import { Meter } from '../components/charts';
import { InsightList } from '../components/Insights';
import { Button, Card, CardHeader, Empty, cx } from '../components/ui';

const FIXED = new Set(['housing', 'utilities', 'insurance', 'debt_payment', 'subscriptions', 'fees']);

const GROUPS: { id: CategoryGroup; label: string; hint: string }[] = [
  { id: 'essentials', label: 'Essentials', hint: 'Bills and needs' },
  { id: 'lifestyle', label: 'Lifestyle', hint: 'The flexible part' },
  { id: 'financial', label: 'Fees', hint: '' },
  { id: 'other', label: 'Everything else', hint: '' },
];

function Line({ line, pace, onOpen }: { line: BudgetLine; pace: number; onOpen: (c: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const refresh = useRefresh();
  const over = line.budget > 0 && line.spent > line.budget;
  // Bills land in one go, so "ahead of pace" only means something for day-to-day categories.
  const fixed = FIXED.has(line.category);
  const near = !fixed && line.budget > 0 && !over && line.spent / line.budget > Math.max(0.9, pace + 0.2);
  const save = async () => {
    setEditing(false);
    const amount = Number(draft);
    if (!Number.isFinite(amount) || amount < 0 || amount === line.budget) return;
    await api.put('/budgets', [{ category: line.category, amount }]);
    refresh();
  };
  return (
    <li className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[150px_1fr_auto]">
      <button onClick={() => onOpen(line.category)} className="truncate text-left text-sm font-medium hover:underline">
        {category(line.category).label}
      </button>
      <div className="order-3 col-span-2 sm:order-none sm:col-span-1">
        {line.budget > 0 ? (
          <Meter label={`${category(line.category).label} budget used`} value={line.spent} max={line.budget} tone={over ? 'critical' : near ? 'warning' : 'accent'} marker={fixed ? undefined : pace} />
        ) : (
          <div className="h-2 rounded-full bg-sunken" />
        )}
      </div>
      <div className="tabular flex items-center justify-end gap-1 text-sm">
        <span className={cx('font-semibold', over && 'text-critical')}>{usd(line.spent)}</span>
        <span className="text-muted">of</span>
        {editing ? (
          <input
            autoFocus
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label={`Monthly budget for ${category(line.category).label}`}
            className="h-7 w-20 rounded-lg border border-accent bg-raised px-2 text-right outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setDraft(line.budget ? String(line.budget) : '');
              setEditing(true);
            }}
            title="Change this budget"
            className={cx('h-7 min-w-[64px] rounded-lg border border-transparent px-2 text-right transition hover:border-edge hover:bg-raised', line.budget ? 'text-ink-2' : 'text-accent-ink')}
          >
            {line.budget ? usd(line.budget) : 'Set'}
          </button>
        )}
      </div>
      {(over || (!line.budget && line.average > 0)) && (
        <p className="order-4 col-span-2 text-xs text-muted sm:col-span-3 sm:pl-[162px]">{over ? `${usd(line.spent - line.budget)} over` : `You usually spend about ${usd(line.average)} a month here`}</p>
      )}
    </li>
  );
}

export function Budget({ state, openActivity }: { state: AppState; openActivity: (category: string) => void }) {
  const { month } = state;
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const left = useCountUp(month.budgeted - month.spending);
  const pace = month.dayOfMonth / month.daysInMonth;
  const hasBudget = month.budgeted > 0;
  const basis = state.budgets.filter((b) => b.average >= 20);

  const autoBuild = async () => {
    setBusy(true);
    try {
      await api.put(
        '/budgets',
        basis.map((b) => ({ category: b.category, amount: isEssential(b.category) ? Math.ceil(b.average / 10) * 10 : Math.max(10, Math.round((b.average * 0.9) / 10) * 10) })),
      );
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const upcoming = state.recurring.filter((r) => r.nextDate >= state.today).sort((a, b) => a.nextDate.localeCompare(b.nextDate));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-5 lg:col-span-7">
          <p className="text-[13px] font-medium text-ink-2">{monthLabel(month.key, { month: 'long', year: 'numeric' })}</p>
          {hasBudget ? (
            <>
              <p className="mt-1 text-[44px] font-semibold leading-none tracking-tight sm:text-5xl">{usd(Math.abs(left))}</p>
              <p className="mt-2 text-sm text-ink-2">
                {left >= 0 ? 'left' : 'over'} of your {usd(month.budgeted)} budget · {month.daysInMonth - month.dayOfMonth} days to go
              </p>
              <div className="mt-4">
                <Meter label="Budget used this month" value={month.spending} max={month.budgeted} tone={left < 0 ? 'critical' : 'accent'} marker={pace} height={12} />
                <p className="mt-2 flex justify-between text-xs text-muted">
                  <span>{usd(month.spending)} spent</span>
                  <span>The tick marks today</span>
                </p>
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-[44px] font-semibold leading-none tracking-tight sm:text-5xl">{usd(month.spending)}</p>
              <p className="mt-2 text-sm text-ink-2">spent so far this month, with no budget set yet</p>
              {basis.length >= 3 && (
                <Button variant="primary" className="mt-4" onClick={autoBuild} disabled={busy}>
                  <Wand2 size={15} /> Build a budget from my spending
                </Button>
              )}
            </>
          )}
        </Card>
        <div className="grid grid-cols-2 gap-3 lg:col-span-5">
          <Card className="p-4">
            <p className="text-[13px] text-ink-2">Safe to spend today</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{month.safeToSpendToday != null ? usd(month.safeToSpendToday) : '—'}</p>
            <p className="mt-2 text-xs text-muted">What is left in flexible categories, spread over the rest of the month</p>
          </Card>
          <Card className="p-4">
            <p className="text-[13px] text-ink-2">Income this month</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight">{usd(month.income)}</p>
            <p className="mt-2 text-xs text-muted">{state.monthlyIncomeAvg ? `${usd(state.monthlyIncomeAvg)} in a typical month` : 'No income recorded yet'}</p>
          </Card>
          <Card className="col-span-2 p-4">
            <p className="text-[13px] text-ink-2">Typical month</p>
            <p className="mt-1 text-sm text-ink">
              {state.monthlyIncomeAvg > 0 ? (
                <>
                  You keep about <strong className="font-semibold">{usd(state.monthlyIncomeAvg - state.monthlySpendAvg)}</strong> of {usd(state.monthlyIncomeAvg)} — {Math.round(((state.monthlyIncomeAvg - state.monthlySpendAvg) / state.monthlyIncomeAvg) * 100)}% — after {usd(state.monthlySpendAvg)} of spending.
                </>
              ) : (
                'Once a full month of activity is in, your averages show here.'
              )}
            </p>
          </Card>
        </div>
      </div>

      <InsightList insights={state.insights} area={['budget', 'cash']} limit={3} title="Budget suggestions" />

      <Card>
        <CardHeader
          title="Categories"
          hint="Tap an amount to change it. On day-to-day categories the tick shows where today falls in the month."
          action={
            hasBudget && basis.length >= 3 ? (
              <Button size="sm" variant="ghost" onClick={() => confirm('Replace your budget amounts with ones based on your recent spending?') && autoBuild()} disabled={busy}>
                <Wand2 size={14} /> Rebuild
              </Button>
            ) : undefined
          }
        />
        {state.budgets.length ? (
          <div className="px-5 pb-3 pt-1">
            {GROUPS.map((g) => {
              const lines = state.budgets.filter((b) => category(b.category).group === g.id);
              if (!lines.length) return null;
              const spent = lines.reduce((s, b) => s + b.spent, 0);
              const budget = lines.reduce((s, b) => s + b.budget, 0);
              return (
                <section key={g.id} className="border-t border-line pt-3 first:border-0">
                  <h3 className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-muted">
                    <span>{g.label}</span>
                    <span className="tabular font-medium normal-case tracking-normal">
                      {usd(spent)}
                      {budget > 0 && ` of ${usd(budget)}`}
                    </span>
                  </h3>
                  <ul className="divide-y divide-line">
                    {lines.map((b) => (
                      <Line key={b.category} line={b} pace={pace} onOpen={openActivity} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <Empty title="No spending recorded yet" body="Link an account, import a statement or add a transaction and your categories fill in on their own." />
        )}
      </Card>

      {upcoming.length > 0 && (
        <Card>
          <CardHeader title="Recurring charges" hint={`${usd(state.recurring.reduce((s, r) => s + r.amount, 0))} a month, detected from your history`} />
          <ul className="divide-y divide-line px-5 pb-2 pt-1">
            {upcoming.map((r) => (
              <li key={r.name} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.name}</p>
                  <p className="text-xs text-muted">
                    {category(r.category).label} · next around {dayLabel(r.nextDate)}
                    {r.changed ? ` · ${r.changed > 0 ? 'up' : 'down'} ${usd2(Math.abs(r.changed))}` : ''}
                  </p>
                </div>
                <span className="tabular font-semibold">{usd2(r.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
