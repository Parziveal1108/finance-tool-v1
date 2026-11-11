import { Plus } from 'lucide-react';
import type { AppState, Goal } from '../../shared/types';
import { monthYear, usd } from '../lib/format';
import { Meter } from '../components/charts';
import { InsightList } from '../components/Insights';
import { Button, Card, Empty } from '../components/ui';

const KIND: Record<Goal['kind'], string> = { savings: 'Savings', emergency: 'Emergency fund', purchase: 'Planned purchase', invest: 'Investing' };

export function Goals({ state, addGoal, editGoal }: { state: AppState; addGoal: () => void; editGoal: (g: Goal) => void }) {
  const total = state.goals.reduce((s, g) => s + g.monthly_contribution, 0);
  const kept = state.monthlyIncomeAvg - state.monthlySpendAvg;
  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-2">
          {state.goals.length
            ? `You are setting aside ${usd(total)} a month across ${state.goals.length} goal${state.goals.length === 1 ? '' : 's'}${state.settings.extra_payment ? `, plus ${usd(state.settings.extra_payment)} extra toward debt` : ''}${kept > 0 ? `. A typical month leaves you about ${usd(kept)}.` : '.'}`
            : 'Goals turn "I should save more" into a number, a date and a monthly amount.'}
        </p>
        <Button variant="primary" onClick={addGoal} className="shrink-0">
          <Plus size={15} /> New goal
        </Button>
      </div>

      {state.goals.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {state.goals.map((g) => {
            const done = g.progress >= g.target_amount;
            const share = Math.min(1, g.progress / g.target_amount);
            const behind = g.needed_monthly != null && g.needed_monthly > g.monthly_contribution * 1.1 + 5;
            const linked = state.accounts.find((a) => a.id === g.linked_account_id);
            return (
              <button key={g.id} onClick={() => editGoal(g)} className="rise rounded-2xl border border-edge bg-surface p-5 text-left shadow-card transition hover:border-axis">
                <p className="text-xs text-muted">{KIND[g.kind]}</p>
                <div className="mt-0.5 flex items-baseline justify-between gap-3">
                  <h2 className="truncate text-lg font-semibold">{g.name}</h2>
                  <span className="tabular shrink-0 text-sm text-ink-2">{Math.round(share * 100)}%</span>
                </div>
                <p className="tabular mt-3 text-2xl font-semibold tracking-tight">
                  {usd(g.progress)} <span className="text-base font-normal text-muted">of {usd(g.target_amount)}</span>
                </p>
                <div className="mt-3">
                  <Meter label={`${g.name} progress`} value={g.progress} max={g.target_amount} tone={done ? 'good' : 'accent'} height={10} />
                </div>
                <p className="mt-3 text-[13px] text-ink-2">
                  {done
                    ? 'Fully funded.'
                    : g.monthly_contribution > 0
                      ? `${usd(g.monthly_contribution)} a month gets you there in ${g.projected_date ? monthYear(g.projected_date) : '—'}.`
                      : 'No monthly amount set yet.'}
                  {!done && g.target_date && ` Target: ${monthYear(g.target_date.slice(0, 7))}.`}
                </p>
                {behind && !done && <p className="mt-1 text-[13px] font-medium text-ink">Needs {usd(g.needed_monthly!)} a month to finish on time.</p>}
                {linked && <p className="mt-2 text-xs text-muted">Follows the balance of {linked.name}</p>}
              </button>
            );
          })}
        </div>
      ) : (
        <Card>
          <Empty
            title="No goals yet"
            body="Start with an emergency fund, a trip, a deposit — anything with a price. Link a goal to a savings account and it tracks itself."
            action={
              <Button variant="primary" onClick={addGoal}>
                <Plus size={15} /> Create your first goal
              </Button>
            }
          />
        </Card>
      )}

      <InsightList insights={state.insights} area={['save']} limit={3} title="Savings suggestions" />

      {state.nextDollar && (
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold">Where goals fit</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-2">
            Goals compete with everything else for spare money. Right now the best use of your next spare dollar is: <strong className="font-semibold text-ink">{state.nextDollar.title}</strong>. {state.nextDollar.reason}
          </p>
        </Card>
      )}
    </div>
  );
}
