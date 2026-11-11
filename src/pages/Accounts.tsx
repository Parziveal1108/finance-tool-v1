import { useState } from 'react';
import { Building2, CircleAlert, LogOut, Moon, Plus, RefreshCw, Sun } from 'lucide-react';
import type { Account, AppState } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { timeAgo, usd2 } from '../lib/format';
import { PlaidLinkButton } from '../components/PlaidLink';
import { Button, Card, CardHeader, Empty, ErrorNote, Select } from '../components/ui';

const SECTIONS: { type: Account['type']; label: string }[] = [
  { type: 'depository', label: 'Cash' },
  { type: 'credit', label: 'Credit cards' },
  { type: 'loan', label: 'Loans' },
  { type: 'investment', label: 'Investments' },
  { type: 'asset', label: 'Other assets' },
];

export function Accounts({ state, addAccount, editAccount, onImport, passwordOn, theme, setTheme }: {
  state: AppState;
  addAccount: () => void;
  editAccount: (a: Account) => void;
  onImport: () => void;
  passwordOn: boolean;
  theme: string;
  setTheme: (t: string) => void;
}) {
  const refresh = useRefresh();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };
  const sync = async () => {
    setSyncing(true);
    await run(() => api.post('/plaid/sync'));
    setSyncing(false);
  };
  const { plaid, plaidEnv } = state.capabilities;

  return (
    <div className="space-y-4">
      <ErrorNote>{error}</ErrorNote>

      <Card>
        <CardHeader
          title="Linked institutions"
          hint={plaid ? `Balances, transactions, loan details and holdings sync on their own${plaidEnv === 'sandbox' ? ' · Plaid sandbox (test banks)' : ''}` : 'Automatic syncing through Plaid is not set up yet'}
          action={
            state.items.length ? (
              <Button size="sm" onClick={sync} disabled={syncing}>
                <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> Sync now
              </Button>
            ) : undefined
          }
        />
        <div className="px-5 pb-5 pt-3">
          {state.items.length > 0 && (
            <ul className="mb-4 divide-y divide-line rounded-xl border border-edge">
              {state.items.map((it) => (
                <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <Building2 size={18} className="shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{it.institution}</p>
                      {it.status === 'ok' ? (
                        <p className="text-xs text-muted">Synced {timeAgo(it.last_sync)}</p>
                      ) : (
                        <p className="flex items-center gap-1 text-xs text-critical">
                          <CircleAlert size={12} aria-hidden /> {it.status === 'login_required' ? 'Needs you to sign in again' : it.error ?? 'Sync problem'}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {it.status !== 'ok' && (
                      <PlaidLinkButton itemId={it.id} size="sm" variant="primary">
                        Reconnect
                      </PlaidLinkButton>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Disconnect ${it.institution}? Its accounts and transactions are removed from Keel.`) && run(() => api.del(`/plaid/items/${it.id}`))}>
                      Disconnect
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {plaid ? (
            <div className="grid gap-2 sm:grid-cols-3">
              <PlaidLinkButton mode="banking" variant="primary">
                Link bank or card
              </PlaidLinkButton>
              <PlaidLinkButton mode="investments">Link brokerage / retirement</PlaidLinkButton>
              <PlaidLinkButton mode="loans">Link a loan servicer</PlaidLinkButton>
            </div>
          ) : (
            <p className="rounded-xl bg-sunken px-3 py-2.5 text-[13px] leading-relaxed text-ink-2">
              To link accounts, create a free Plaid account, then put <code className="rounded bg-line px-1">PLAID_CLIENT_ID</code> and <code className="rounded bg-line px-1">PLAID_SECRET</code> in the <code className="rounded bg-line px-1">.env</code> file and restart. Until then, importing statements and typing balances works for everything.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Accounts"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onImport}>
                Import CSV
              </Button>
              <Button size="sm" onClick={addAccount}>
                <Plus size={14} /> Add
              </Button>
            </div>
          }
        />
        {state.accounts.length ? (
          <div className="px-5 pb-3 pt-1">
            {SECTIONS.map((s) => {
              const list = state.accounts.filter((a) => a.type === s.type);
              if (!list.length) return null;
              const owed = s.type === 'credit' || s.type === 'loan';
              return (
                <section key={s.type} className="border-t border-line pt-3 first:border-0">
                  <h3 className="flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-muted">
                    <span>{s.label}</span>
                    <span className="tabular font-medium normal-case tracking-normal">
                      {usd2(list.reduce((t, a) => t + a.balance, 0))}
                      {owed ? ' owed' : ''}
                    </span>
                  </h3>
                  <ul className="divide-y divide-line">
                    {list.map((a) => (
                      <li key={a.id}>
                        <button onClick={() => editAccount(a)} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 py-2.5 text-left">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{a.name}</span>
                            <span className="block truncate text-xs text-muted">
                              {[a.institution, a.mask ? `···${a.mask}` : null, a.manual ? (state.settings.demo ? 'demo' : 'entered by hand') : 'linked', a.apr != null ? `${a.apr}% APR` : null].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className="tabular text-sm font-semibold">{usd2(a.balance)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : (
          <Empty title="No accounts yet" body="Link an institution above or add an account by hand." />
        )}
      </Card>

      <Card>
        <CardHeader title="Preferences" />
        <div className="grid gap-4 px-5 pb-5 pt-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Quick-add goes to</span>
            <Select value={state.settings.default_account_id ?? ''} onChange={(e) => run(() => api.patch('/settings', { default_account_id: e.target.value || null }))}>
              <option value="">No account</option>
              {state.accounts.filter((a) => a.type === 'depository' || a.type === 'credit').map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Emergency fund target</span>
            <Select value={state.settings.emergency_months} onChange={(e) => run(() => api.patch('/settings', { emergency_months: Number(e.target.value) }))}>
              {[1, 2, 3, 4, 6, 9, 12].map((m) => (
                <option key={m} value={m}>
                  {m} month{m === 1 ? '' : 's'} of essentials
                </option>
              ))}
            </Select>
          </label>
          <div>
            <span className="mb-1 block text-[13px] font-medium text-ink-2">Appearance</span>
            <div className="flex gap-2">
              {[
                { v: 'auto', label: 'Auto', Icon: null },
                { v: 'light', label: 'Light', Icon: Sun },
                { v: 'dark', label: 'Dark', Icon: Moon },
              ].map(({ v, label, Icon }) => (
                <Button key={v} size="sm" variant={theme === v ? 'primary' : 'secondary'} aria-pressed={theme === v} onClick={() => setTheme(v)}>
                  {Icon && <Icon size={14} />} {label}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4">
          {!state.items.length && (
            <Button size="sm" onClick={() => (!state.hasData || state.settings.demo || confirm('Replace everything in Keel with sample data?')) && run(() => api.post('/demo'))}>
              {state.settings.demo ? 'Reload sample data' : 'Load sample data'}
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={() => confirm('Erase all accounts, transactions, goals and settings from Keel? This cannot be undone.') && run(() => api.post('/reset'))}>
            Erase everything
          </Button>
          {passwordOn && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => api.post('/logout').then(() => location.reload())}>
              <LogOut size={14} /> Sign out
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
