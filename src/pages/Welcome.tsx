import { useState } from 'react';
import { FileUp, Landmark, MessageSquareText, PencilLine, Play } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { PlaidLinkButton } from '../components/PlaidLink';
import { Button, ErrorNote } from '../components/ui';

/** First run: four ways in, ordered from least typing to most. */
export function Welcome({ state, openAssistant, addAccount, onImport }: { state: AppState; openAssistant: () => void; addAccount: () => void; onImport: () => void }) {
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { plaid, ai, plaidEnv } = state.capabilities;
  const demo = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/demo');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the sample');
      setBusy(false);
    }
  };

  const Option = ({ Icon, title, body, children, muted }: { Icon: typeof Landmark; title: string; body: string; children: React.ReactNode; muted?: boolean }) => (
    <div className="rise flex flex-col rounded-2xl border border-edge bg-surface p-5 shadow-card">
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${muted ? 'bg-sunken text-ink-2' : 'bg-accent text-on-accent'}`}>
        <Icon size={18} aria-hidden />
      </span>
      <h2 className="mt-3 text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-ink-2">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl py-6 sm:py-12">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Let's get your whole picture in one place.</h1>
      <p className="mt-3 max-w-xl text-base leading-relaxed text-ink-2">Keel tracks your budget, debts, investments and savings together, and keeps watch so you get a nudge when something is worth changing. Pick whichever way in is least work for you. You can mix them.</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        <Option Icon={Landmark} title="Link your accounts" body={plaid ? `Connect banks, cards, loans and brokerages through Plaid. Balances, transactions, rates and holdings then stay current on their own.${plaidEnv === 'sandbox' ? ' You are in sandbox mode, which uses test banks.' : ''}` : 'Connect banks, cards, loans and brokerages through Plaid so everything stays current on its own. Needs Plaid keys in your .env file first.'} muted={!plaid}>
          {plaid ? (
            <PlaidLinkButton mode="banking" variant="primary">
              Link a bank or card
            </PlaidLinkButton>
          ) : (
            <p className="text-xs text-muted">Not set up yet — see the README, about five minutes.</p>
          )}
        </Option>
        <Option Icon={MessageSquareText} title="Tell the assistant" body={ai ? 'Describe your accounts in a few sentences, or drop in a statement or a screenshot. The assistant creates the accounts, debts and holdings for you.' : 'Describe your accounts in plain sentences and have them entered for you. Needs an Anthropic API key in your .env file first.'} muted={!ai}>
          {ai ? (
            <Button variant="primary" className="w-full" onClick={openAssistant}>
              Start talking
            </Button>
          ) : (
            <p className="text-xs text-muted">Not set up yet — see the README.</p>
          )}
        </Option>
        <Option Icon={FileUp} title="Import a statement" body="Download a CSV from your bank or card site and drop it in. Columns are detected, categories are filled in, and overlapping files never double count." muted>
          <Button className="w-full" onClick={onImport}>
            Import a CSV
          </Button>
        </Option>
        <Option Icon={PencilLine} title="Enter it by hand" body="Add an account with its balance — and for debts, the rate and minimum. That alone is enough for a payoff plan and your net worth." muted>
          <Button className="w-full" onClick={addAccount}>
            Add an account
          </Button>
        </Option>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-edge bg-sunken px-5 py-4">
        <p className="flex-1 text-sm text-ink-2">Want to look around first? Load a sample household and clear it with one tap later.</p>
        <Button onClick={demo} disabled={busy}>
          <Play size={14} /> {busy ? 'Loading…' : 'Explore with sample data'}
        </Button>
      </div>
      <div className="mt-3">
        <ErrorNote>{error}</ErrorNote>
      </div>
    </div>
  );
}
