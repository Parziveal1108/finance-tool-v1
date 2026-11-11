import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Home as HomeIcon, Landmark, PiggyBank, Plus, Sparkles, Target, TrendingDown, TrendingUp, Wallet, X } from 'lucide-react';
import type { Account, Goal, Holding, Transaction } from '../shared/types';
import { api, useAppState, useLiveUpdates, useRefresh } from './lib/api';
import { Assistant } from './components/Assistant';
import { CsvImport } from './components/CsvImport';
import { AccountForm, GoalForm, HoldingForm, TransactionForm } from './components/forms';
import { QuickAdd } from './components/QuickAdd';
import { Button, IconButton, Sheet, cx } from './components/ui';
import { Accounts } from './pages/Accounts';
import { Activity } from './pages/Activity';
import { Budget } from './pages/Budget';
import { Debt } from './pages/Debt';
import { Goals } from './pages/Goals';
import { Home } from './pages/Home';
import { Invest } from './pages/Invest';
import { Login } from './pages/Login';
import { Welcome } from './pages/Welcome';

const PAGES = [
  { id: 'home', label: 'Home', Icon: HomeIcon },
  { id: 'budget', label: 'Budget', Icon: Wallet },
  { id: 'debt', label: 'Debt', Icon: TrendingDown },
  { id: 'invest', label: 'Invest', Icon: TrendingUp },
  { id: 'goals', label: 'Goals', Icon: Target },
  { id: 'activity', label: 'Activity', Icon: ArrowLeftRight },
  { id: 'accounts', label: 'Accounts', Icon: Landmark },
] as const;
type PageId = (typeof PAGES)[number]['id'];
const MOBILE_TABS: PageId[] = ['home', 'budget', 'debt', 'invest', 'goals'];

const readHash = (): PageId => {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0];
  return (PAGES.find((p) => p.id === id)?.id ?? 'home') as PageId;
};

type Modal =
  | { kind: 'account'; account?: Account; defaultKind?: string }
  | { kind: 'goal'; goal?: Goal }
  | { kind: 'holding'; holding?: Holding }
  | { kind: 'tx'; tx: Transaction }
  | { kind: 'import' }
  | { kind: 'quick' }
  | null;

function useTheme() {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem('keel-theme') ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const setTheme = (t: string) => {
    setThemeState(t);
    try {
      if (t === 'auto') localStorage.removeItem('keel-theme');
      else localStorage.setItem('keel-theme', t);
    } catch {
      // private mode: the choice just will not persist
    }
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  return [theme, setTheme] as const;
}

export function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.get<{ required: boolean; authed: boolean }>('/session') });
  useEffect(() => {
    const out = () => qc.invalidateQueries({ queryKey: ['session'] });
    window.addEventListener('keel:signed-out', out);
    return () => window.removeEventListener('keel:signed-out', out);
  }, [qc]);

  if (session.isLoading) return null;
  if (session.data?.required && !session.data.authed) return <Login onDone={() => qc.invalidateQueries()} />;
  return <Shell passwordOn={!!session.data?.required} />;
}

function Shell({ passwordOn }: { passwordOn: boolean }) {
  const { data: state, error } = useAppState();
  const refresh = useRefresh();
  const [page, setPage] = useState<PageId>(readHash);
  const [assistant, setAssistant] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [toasts, setToasts] = useState<{ id: number; title: string }[]>([]);
  const [activityCategory, setActivityCategory] = useState<string | undefined>();
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const on = () => setPage(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((id: string) => {
    if (id !== 'activity') setActivityCategory(undefined);
    location.hash = `/${id}`;
    window.scrollTo({ top: 0 });
  }, []);

  useLiveUpdates((i) => {
    const id = Date.now();
    setToasts((t) => [...t.slice(-2), { id, title: i.title }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  });

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-ink-2">
        {error ? (
          <div>
            <p className="font-semibold text-ink">Keel's server is not responding</p>
            <p className="mt-1">Start it with <code className="rounded bg-sunken px-1">npm run dev</code> or <code className="rounded bg-sunken px-1">npm start</code>, then reload.</p>
          </div>
        ) : (
          <span className="live-dot h-2 w-2 rounded-full bg-accent" aria-label="Loading" />
        )}
      </div>
    );
  }

  const close = () => setModal(null);
  const current = PAGES.find((p) => p.id === page)!;
  const openAssistant = () => setAssistant(true);
  const urgent = state.insights.filter((i) => i.severity === 'critical' || i.severity === 'warn').length;

  const body = !state.hasData ? (
    <Welcome state={state} openAssistant={openAssistant} addAccount={() => setModal({ kind: 'account' })} onImport={() => setModal({ kind: 'import' })} />
  ) : page === 'home' ? (
    <Home state={state} go={go} />
  ) : page === 'budget' ? (
    <Budget
      state={state}
      openActivity={(c) => {
        setActivityCategory(c);
        location.hash = '/activity';
        window.scrollTo({ top: 0 });
      }}
    />
  ) : page === 'debt' ? (
    <Debt state={state} addDebt={() => setModal({ kind: 'account', defaultKind: 'card' })} editAccount={(account) => setModal({ kind: 'account', account })} />
  ) : page === 'invest' ? (
    <Invest state={state} addAccount={() => setModal({ kind: 'account', defaultKind: 'brokerage' })} addHolding={() => setModal({ kind: 'holding' })} editHolding={(holding) => setModal({ kind: 'holding', holding })} />
  ) : page === 'goals' ? (
    <Goals state={state} addGoal={() => setModal({ kind: 'goal' })} editGoal={(goal) => setModal({ kind: 'goal', goal })} />
  ) : page === 'activity' ? (
    <Activity key={activityCategory ?? 'all'} state={state} initialCategory={activityCategory} onImport={() => setModal({ kind: 'import' })} onOpen={(tx) => setModal({ kind: 'tx', tx })} />
  ) : (
    <Accounts state={state} addAccount={() => setModal({ kind: 'account' })} editAccount={(account) => setModal({ kind: 'account', account })} onImport={() => setModal({ kind: 'import' })} passwordOn={passwordOn} theme={theme} setTheme={setTheme} />
  );

  return (
    <div className="flex h-full">
      {/* Desktop navigation */}
      <nav aria-label="Main" className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface px-3 py-4 lg:flex">
        <a href="#/home" className="mb-5 flex items-center gap-2.5 px-2">
          <img src="/icon.svg" alt="" className="h-8 w-8 rounded-lg" />
          <span className="text-lg font-semibold tracking-tight">Keel</span>
        </a>
        <ul className="space-y-0.5">
          {PAGES.map(({ id, label, Icon }) => (
            <li key={id}>
              <button onClick={() => go(id)} aria-current={page === id ? 'page' : undefined} className={cx('flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition', page === id ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink')}>
                <Icon size={17} aria-hidden />
                {label}
                {id === 'home' && urgent > 0 && <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-serious px-1 text-[11px] font-semibold text-[#0b0b0b]" aria-label={`${urgent} items need attention`}>{urgent}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-auto space-y-2">
          <p className="flex items-center gap-2 px-3 text-xs text-muted">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-good" aria-hidden />
            Monitoring {state.insights.length ? `· ${state.insights.length} suggestion${state.insights.length === 1 ? '' : 's'}` : '· all clear'}
          </p>
          <Button variant={assistant ? 'secondary' : 'primary'} className="w-full" onClick={() => setAssistant((v) => !v)}>
            <Sparkles size={15} /> {assistant ? 'Hide assistant' : 'Ask the assistant'}
          </Button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-page/90 px-4 backdrop-blur lg:static lg:h-16 lg:px-8">
          <img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg lg:hidden" />
          <h1 className="text-lg font-semibold tracking-tight lg:text-xl">{state.hasData ? current.label : 'Welcome'}</h1>
          {state.hasData && <QuickAdd className="ml-auto hidden w-[420px] translate-y-[9px] lg:block" />}
          <div className="ml-auto flex items-center lg:hidden">
            {state.hasData && (
              <IconButton label="Quick add a transaction" onClick={() => setModal({ kind: 'quick' })}>
                <Plus size={20} />
              </IconButton>
            )}
            <IconButton label="Activity" onClick={() => go('activity')} aria-current={page === 'activity' ? 'page' : undefined}>
              <ArrowLeftRight size={18} />
            </IconButton>
            <IconButton label="Accounts and settings" onClick={() => go('accounts')} aria-current={page === 'accounts' ? 'page' : undefined}>
              <Landmark size={18} />
            </IconButton>
          </div>
        </header>

        {state.settings.demo && state.hasData && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken px-4 py-2 text-[13px] text-ink-2 lg:px-8">
            <span>
              <PiggyBank size={14} className="mr-1.5 inline -translate-y-px" aria-hidden />
              You are looking at sample data.
            </span>
            <button className="font-medium text-accent-ink hover:underline" onClick={() => confirm('Clear the sample data and start with your own?') && api.post('/reset').then(refresh)}>
              Clear it and start with mine
            </button>
          </div>
        )}

        <main className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 pb-28 pt-4 lg:px-8 lg:pb-10 lg:pt-6">
          <div className="mx-auto max-w-6xl">{body}</div>
        </main>

        {/* Phone navigation */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
          <ul className="grid grid-cols-5">
            {MOBILE_TABS.map((id) => {
              const { label, Icon } = PAGES.find((p) => p.id === id)!;
              const active = page === id && state.hasData;
              return (
                <li key={id}>
                  <button onClick={() => go(id)} aria-current={active ? 'page' : undefined} className={cx('flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-accent-ink' : 'text-muted')}>
                    <Icon size={20} aria-hidden />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Phone: the assistant is one tap away on every screen */}
        {!assistant && (
          <button aria-label="Open the assistant" onClick={openAssistant} className="fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-card lg:hidden">
            <Sparkles size={20} />
          </button>
        )}
      </div>

      {/* Assistant: docked on desktop, full screen on phones */}
      {assistant && (
        <aside aria-label="Assistant" className="fixed inset-0 z-40 lg:static lg:z-auto lg:w-[380px] lg:shrink-0 lg:border-l lg:border-line">
          <Assistant state={state} onClose={() => setAssistant(false)} />
        </aside>
      )}

      {/* Live alerts from the monitor */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className="sheet-up pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl border border-edge bg-raised px-4 py-3 shadow-card">
            <span className="live-dot h-2 w-2 shrink-0 rounded-full bg-serious" aria-hidden />
            <button className="text-left text-sm font-medium" onClick={() => go('home')}>
              {t.title}
            </button>
            <button aria-label="Dismiss" className="text-muted hover:text-ink" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={15} />
            </button>
          </div>
        ))}
      </div>

      {modal?.kind === 'account' && <AccountForm account={modal.account} defaultKind={modal.defaultKind} onClose={() => (close(), refresh())} />}
      {modal?.kind === 'goal' && <GoalForm goal={modal.goal} accounts={state.accounts} onClose={() => (close(), refresh())} />}
      {modal?.kind === 'holding' && <HoldingForm holding={modal.holding} accounts={state.accounts} onClose={() => (close(), refresh())} />}
      {modal?.kind === 'tx' && <TransactionForm tx={modal.tx} state={state} onClose={() => (close(), refresh())} />}
      {modal?.kind === 'import' && <CsvImport accounts={state.accounts} onClose={close} />}
      {modal?.kind === 'quick' && (
        <Sheet title="Quick add" onClose={close}>
          <QuickAdd autoFocus onAdded={close} />
          <p className="pb-2 text-xs text-muted">Type what happened in a few words. Dates like "yesterday" or "11/3" work, and a leading + means money in.</p>
        </Sheet>
      )}
    </div>
  );
}
