import { useState } from 'react';
import { Check, RefreshCw, Sparkles } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { simulatePayoff, addMonths } from '../../shared/payoff';
import { api, useRefresh } from '../lib/api';
import { dayLabel, monthLabel, monthYear, timeAgo, usd, usdCompact, useCountUp } from '../lib/format';
import { ChartFrame, ColumnChart, LineChart, Meter, Sparkline } from '../components/charts';
import { InsightList } from '../components/Insights';
import { Card, Delta, cx } from '../components/ui';

function Hero({ state }: { state: AppState }) {
  const net = useCountUp(state.totals.netWorth);
  const h = state.netWorthHistory;
  const step = Math.max(1, Math.floor(h.length / 5));
  const ticks: [number, string][] = [];
  for (let i = 0; i < h.length - step / 2; i += step) ticks.push([i, dayLabel(h[i].date)]);
  if (h.length > 1) ticks.push([h.length - 1, 'Today']);
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5">
        <p className="text-[13px] font-medium text-ink-2">Net worth</p>
        <p className="mt-1 text-[52px] font-semibold leading-none tracking-tight sm:text-6xl">{usd(net)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {state.totals.netWorthChange30d != null ? <Delta value={state.totals.netWorthChange30d} format={usd} suffix="in 30 days" /> : <span className="text-[13px] text-muted">History builds from today</span>}
          <span className="text-[13px] text-muted">
            {usd(state.totals.cash + state.totals.investments + state.totals.otherAssets)} owned · {usd(state.totals.debt)} owed
          </span>
        </div>
      </div>
      {h.length > 2 ? (
        <ChartFrame title="" table={{ head: ['Date', 'Net worth', 'Owned', 'Owed'], rows: [...h].reverse().filter((_, i) => i % 7 === 0).map((p) => [dayLabel(p.date), usd(p.net), usd(p.assets), usd(p.debt)]) }}>
          <LineChart
            ariaLabel="Net worth over time"
            height={190}
            series={[{ name: 'Net worth', color: 'var(--s1)', values: h.map((p) => p.net), area: true }]}
            labels={h.map((p) => dayLabel(p.date, { month: 'short', day: 'numeric', year: 'numeric' }))}
            tickLabels={ticks}
            format={usdCompact}
          />
        </ChartFrame>
      ) : (
        <p className="px-5 pb-5 pt-3 text-sm text-ink-2">Your net worth trend appears here as Keel records a snapshot each day.</p>
      )}
    </Card>
  );
}

function Brief({ state }: { state: AppState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRefresh();
  const again = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/assistant/brief');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not refresh');
    } finally {
      setBusy(false);
    }
  };
  const b = state.brief;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-on-accent">
            <Sparkles size={12} aria-hidden />
          </span>
          Today's read
        </h2>
        <button onClick={again} disabled={busy} aria-label="Refresh briefing" title="Refresh" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-sunken hover:text-ink disabled:opacity-50">
          <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className={cx('mt-2 text-[15px] leading-relaxed text-ink', busy && 'opacity-60')}>{b?.text ?? 'Your briefing appears here once there is some activity to look at.'}</p>
      {error && <p className="mt-2 text-[13px] text-critical">{error}</p>}
      {b && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
          {b.source === 'assistant' ? 'Written by your assistant' : 'From the built-in monitor'} · {timeAgo(b.at)}
        </p>
      )}
    </Card>
  );
}

function NextDollar({ state, go }: { state: AppState; go: (page: string) => void }) {
  const nd = state.nextDollar;
  if (!nd) return null;
  return (
    <Card className="p-5">
      <p className="text-[13px] font-medium text-ink-2">Your next spare dollar</p>
      <h2 className="mt-1 text-lg font-semibold leading-snug">{nd.title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-2">{nd.reason}</p>
      <ol className="mt-4 space-y-2.5">
        {nd.steps.map((s, i) => (
          <li key={s.label} className="flex items-start gap-3">
            <span
              className={cx(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                s.done ? 'bg-good text-white' : s.current ? 'bg-accent text-on-accent' : 'border border-axis text-muted',
              )}
            >
              {s.done ? <Check size={12} aria-label="Done" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cx('block text-sm', s.current ? 'font-semibold text-ink' : s.done ? 'text-ink-2' : 'text-muted')}>
                {s.label}
                {s.current && <span className="ml-2 rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-accent-ink">You are here</span>}
              </span>
              <span className="block text-xs text-muted">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <button onClick={() => go('plan?tool=windfall')} className="mt-4 text-[13px] font-medium text-accent-ink hover:underline">
        Got a lump sum? See exactly where it should go
      </button>
    </Card>
  );
}

function Tile({ label, value, children, onClick }: { label: string; value: string; children?: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col rounded-2xl border border-edge bg-surface p-4 text-left shadow-card transition hover:border-axis">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      <div className="mt-2 w-full">{children}</div>
    </button>
  );
}

export function Home({ state, go }: { state: AppState; go: (page: string) => void }) {
  const { month, totals } = state;
  const plan = state.debts.length
    ? simulatePayoff(state.debts.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr, minPayment: d.min_payment })), state.settings.strategy, state.settings.extra_payment)
    : null;
  const overBudget = month.budgeted > 0 && month.spending > month.budgeted;
  const lastMonth = state.flows[state.flows.length - 2];
  const days = Math.max(month.paceLast.length, month.daysInMonth);
  const debtTrend = state.netWorthHistory.slice(-60).map((p) => p.debt);
  const investedCost = state.holdings.reduce((s, h) => s + (h.cost_basis ?? 0), 0);
  const allHaveCost = state.holdings.length > 0 && state.holdings.every((h) => h.cost_basis != null);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <Hero state={state} />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Tile label="Safe to spend today" value={month.safeToSpendToday != null ? usd(month.safeToSpendToday) : '—'} onClick={() => go('budget')}>
              <p className="text-xs text-muted">{month.safeToSpendToday != null ? `per day for the next ${month.daysInMonth - month.dayOfMonth + 1} days` : 'Set a budget to see this'}</p>
            </Tile>
            <Tile label={`Spent in ${monthLabel(month.key, { month: 'long' })}`} value={usd(month.spending)} onClick={() => go('budget')}>
              {month.budgeted > 0 ? (
                <>
                  <Meter label="Budget used" value={month.spending} max={month.budgeted} tone={overBudget ? 'critical' : 'accent'} marker={month.dayOfMonth / month.daysInMonth} height={6} />
                  <p className="mt-1.5 text-xs text-muted">{overBudget ? `${usd(month.spending - month.budgeted)} over ${usd(month.budgeted)}` : `${usd(month.budgeted - month.spending)} left of ${usd(month.budgeted)}`}</p>
                </>
              ) : (
                <p className="text-xs text-muted">{lastMonth ? `${usd(lastMonth.spending)} last month` : 'No budget yet'}</p>
              )}
            </Tile>
            <Tile label="Debt" value={usd(totals.debt)} onClick={() => go('debt')}>
              <div className="flex items-end justify-between gap-2">
                <p className="text-xs text-muted">{plan?.months ? `Debt-free ${monthYear(addMonths(state.today, plan.months))}` : totals.debt ? 'Add rates to see a date' : 'Nothing owed'}</p>
                {debtTrend.length > 5 && totals.debt > 0 && <Sparkline values={debtTrend} width={72} height={22} />}
              </div>
            </Tile>
            <Tile label="Invested" value={usd(totals.investments)} onClick={() => go('invest')}>
              <p className="text-xs text-muted">{allHaveCost && investedCost > 0 ? `${totals.investments >= investedCost ? '▲' : '▼'} ${usd(Math.abs(totals.investments - investedCost))} ${totals.investments >= investedCost ? 'gain' : 'loss'} on cost` : `${usd(totals.cash)} in cash`}</p>
            </Tile>
          </div>
        </div>
        <div className="space-y-4 lg:col-span-4">
          <Brief state={state} />
          <NextDollar state={state} go={go} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <InsightList insights={state.insights} limit={5} title="What to do next" emptyNote="Nothing needs your attention right now. The monitor keeps checking as new activity comes in." />
        </div>
        <div className="space-y-4 lg:col-span-5">
          <Card>
            <ChartFrame
              title="Spending pace"
              hint={`Running total by day of month · day ${month.dayOfMonth} of ${month.daysInMonth}`}
              legend={[
                { label: monthLabel(month.key, { month: 'long' }), color: 'var(--s1)' },
                ...(month.paceLast.length ? [{ label: monthLabel(state.flows[state.flows.length - 2]?.month ?? month.key, { month: 'long' }), color: 'var(--context)' }] : []),
              ]}
              table={{ head: ['Day', 'This month', 'Last month'], rows: Array.from({ length: days }, (_, i) => [i + 1, i < month.paceThis.length ? usd(month.paceThis[i]) : '', i < month.paceLast.length ? usd(month.paceLast[i]) : '']) }}
            >
              <LineChart
                ariaLabel="Cumulative spending this month compared with last month"
                height={180}
                zeroBased
                series={[
                  ...(month.paceLast.length ? [{ name: 'Last month', color: 'var(--context)', values: month.paceLast, context: true }] : []),
                  { name: 'This month', color: 'var(--s1)', values: month.paceThis },
                ]}
                labels={Array.from({ length: days }, (_, i) => `Day ${i + 1}`)}
                tickLabels={[[0, '1'], [Math.floor(days / 2), String(Math.floor(days / 2) + 1)], [days - 1, String(days)]]}
                format={usdCompact}
              />
            </ChartFrame>
          </Card>
          {state.flows.length > 1 && (
            <Card>
              <ChartFrame
                title="Money in and out"
                hint="By month; this month is still filling in"
                legend={[
                  { label: 'Income', color: 'var(--s1)', kind: 'bar' },
                  { label: 'Spending', color: 'var(--s2)', kind: 'bar' },
                ]}
                table={{ head: ['Month', 'Income', 'Spending', 'Kept'], rows: state.flows.map((f) => [monthYear(f.month), usd(f.income), usd(f.spending), usd(f.income - f.spending)]) }}
              >
                <ColumnChart
                  ariaLabel="Income and spending by month"
                  height={180}
                  groups={state.flows.map((f) => monthLabel(f.month))}
                  series={[
                    { name: 'Income', color: 'var(--s1)', values: state.flows.map((f) => f.income) },
                    { name: 'Spending', color: 'var(--s2)', values: state.flows.map((f) => f.spending) },
                  ]}
                  format={usdCompact}
                />
              </ChartFrame>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
