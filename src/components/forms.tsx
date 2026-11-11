import { useState, type FormEvent } from 'react';
import type { Account, AccountType, AppState, Goal, Holding, Transaction } from '../../shared/types';
import { CATEGORIES } from '../../shared/categories';
import { api } from '../lib/api';
import { Amount, Button, ErrorNote, Field, Input, Select, Sheet } from './ui';

const num = (s: string) => (s.trim() === '' ? null : Number(s));

function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const KINDS: { value: string; label: string; type: AccountType; subtype: string }[] = [
  { value: 'checking', label: 'Checking', type: 'depository', subtype: 'checking' },
  { value: 'savings', label: 'Savings', type: 'depository', subtype: 'savings' },
  { value: 'card', label: 'Credit card', type: 'credit', subtype: 'credit card' },
  { value: 'student', label: 'Student loan', type: 'loan', subtype: 'student' },
  { value: 'auto', label: 'Auto loan', type: 'loan', subtype: 'auto' },
  { value: 'mortgage', label: 'Mortgage', type: 'loan', subtype: 'mortgage' },
  { value: 'personal', label: 'Personal loan / other debt', type: 'loan', subtype: 'personal' },
  { value: 'brokerage', label: 'Brokerage', type: 'investment', subtype: 'brokerage' },
  { value: 'retirement', label: 'Retirement (401k, IRA)', type: 'investment', subtype: 'retirement' },
  { value: 'crypto', label: 'Crypto', type: 'investment', subtype: 'crypto' },
  { value: 'property', label: 'Home, vehicle or other asset', type: 'asset', subtype: 'property' },
];

const kindOf = (a?: Account | null) => KINDS.find((k) => k.type === a?.type && k.subtype === a?.subtype)?.value ?? KINDS.find((k) => k.type === a?.type)?.value ?? 'checking';

export function AccountForm({ account, defaultKind, onClose }: { account?: Account | null; defaultKind?: string; onClose: () => void }) {
  const [kind, setKind] = useState(account ? kindOf(account) : defaultKind ?? 'checking');
  const [name, setName] = useState(account?.name ?? '');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [balance, setBalance] = useState(account ? String(account.balance) : '');
  const [apr, setApr] = useState(account?.apr != null ? String(account.apr) : '');
  const [min, setMin] = useState(account?.min_payment != null ? String(account.min_payment) : '');
  const [limit, setLimit] = useState(account?.credit_limit != null ? String(account.credit_limit) : '');
  const [due, setDue] = useState(account?.due_day != null ? String(account.due_day) : '');
  const { busy, error, run } = useSubmit(onClose);
  const k = KINDS.find((x) => x.value === kind)!;
  const isDebt = k.type === 'credit' || k.type === 'loan';
  const linked = !!account && !account.manual;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      api.post('/accounts', {
        id: account?.id,
        name: name.trim() || k.label,
        type: k.type,
        subtype: k.subtype,
        institution: institution.trim() || null,
        balance: num(balance) ?? 0,
        apr: isDebt ? num(apr) : null,
        min_payment: isDebt ? num(min) : null,
        credit_limit: k.type === 'credit' ? num(limit) : null,
        due_day: isDebt ? num(due) : null,
      }),
    );
  };

  return (
    <Sheet title={account ? 'Edit account' : 'Add an account'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={linked}>
            {KINDS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={k.label} autoFocus={!account} />
          </Field>
          <Field label="Institution">
            <Input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <Field label={isDebt ? 'Balance owed' : k.type === 'investment' ? 'Current value' : 'Balance'} hint={linked ? 'Updated automatically from your institution.' : k.type === 'investment' ? 'Or leave at 0 and add individual holdings on the Invest page.' : undefined}>
          <Amount value={balance} onChange={setBalance} placeholder="0.00" disabled={linked} />
        </Field>
        {isDebt && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Interest rate (APR)">
                <Amount value={apr} onChange={setApr} prefix="" suffix="%" placeholder="e.g. 24.99" />
              </Field>
              <Field label="Minimum payment">
                <Amount value={min} onChange={setMin} placeholder="per month" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {k.type === 'credit' && (
                <Field label="Credit limit">
                  <Amount value={limit} onChange={setLimit} placeholder="Optional" />
                </Field>
              )}
              <Field label="Due day of month">
                <Amount value={due} onChange={setDue} prefix="" placeholder="1–31" />
              </Field>
            </div>
            <p className="text-xs text-muted">Rate and minimum drive the payoff plan. If you leave them blank Keel uses a typical estimate and marks it as such.</p>
          </>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center justify-between gap-2 pt-2">
          {account ? (
            <Button
              type="button"
              variant="danger"
              disabled={busy || linked}
              title={linked ? 'Remove linked accounts by disconnecting the institution' : undefined}
              onClick={() => confirm(`Remove ${account.name} and its transactions?`) && run(() => api.del(`/accounts/${account.id}`))}
            >
              Remove
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export function GoalForm({ goal, accounts, onClose }: { goal?: Goal | null; accounts: Account[]; onClose: () => void }) {
  const [name, setName] = useState(goal?.name ?? '');
  const [kind, setKind] = useState<Goal['kind']>(goal?.kind ?? 'savings');
  const [target, setTarget] = useState(goal ? String(goal.target_amount) : '');
  const [current, setCurrent] = useState(goal ? String(goal.current_amount) : '');
  const [linked, setLinked] = useState(goal?.linked_account_id ?? '');
  const [date, setDate] = useState(goal?.target_date ?? '');
  const [monthly, setMonthly] = useState(goal ? String(goal.monthly_contribution) : '');
  const { busy, error, run } = useSubmit(onClose);
  const candidates = accounts.filter((a) => a.type === 'depository' || a.type === 'investment');

  return (
    <Sheet title={goal ? 'Edit goal' : 'New goal'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() =>
            api.post('/goals', {
              id: goal?.id,
              name: name.trim() || 'Savings goal',
              kind,
              target_amount: num(target) ?? 0,
              current_amount: num(current) ?? 0,
              linked_account_id: linked || null,
              target_date: date || null,
              monthly_contribution: num(monthly) ?? 0,
            }),
          );
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. House deposit" autoFocus={!goal} />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Goal['kind'])}>
              <option value="savings">Savings</option>
              <option value="emergency">Emergency fund</option>
              <option value="purchase">Planned purchase</option>
              <option value="invest">Investing</option>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target">
            <Amount value={target} onChange={setTarget} placeholder="0" required />
          </Field>
          <Field label="Setting aside monthly">
            <Amount value={monthly} onChange={setMonthly} placeholder="0" />
          </Field>
        </div>
        <Field label="Track progress from" hint="Link an account and the goal follows its balance, with nothing to update by hand.">
          <Select value={linked} onChange={(e) => setLinked(e.target.value)}>
            <option value="">I'll enter the amount myself</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {!linked && (
            <Field label="Saved so far">
              <Amount value={current} onChange={setCurrent} placeholder="0" />
            </Field>
          )}
          <Field label="Target date (optional)">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center justify-between gap-2 pt-2">
          {goal ? (
            <Button type="button" variant="danger" disabled={busy} onClick={() => confirm(`Delete the goal "${goal.name}"?`) && run(() => api.del(`/goals/${goal.id}`))}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export const ASSET_LABEL: Record<Holding['asset_class'], string> = { us_stock: 'US stocks', intl_stock: 'International stocks', bond: 'Bonds', cash: 'Cash', crypto: 'Crypto', other: 'Other' };

export function HoldingForm({ holding, accounts, onClose }: { holding?: Holding | null; accounts: Account[]; onClose: () => void }) {
  const invest = accounts.filter((a) => a.type === 'investment');
  const [account, setAccount] = useState(holding?.account_id ?? invest[0]?.id ?? '');
  const [symbol, setSymbol] = useState(holding?.symbol ?? '');
  const [name, setName] = useState(holding?.name ?? '');
  const [qty, setQty] = useState(holding ? String(holding.quantity) : '');
  const [price, setPrice] = useState(holding ? String(holding.price) : '');
  const [cost, setCost] = useState(holding?.cost_basis != null ? String(holding.cost_basis) : '');
  const [cls, setCls] = useState<string>(holding?.asset_class ?? '');
  const { busy, error, run } = useSubmit(onClose);

  return (
    <Sheet title={holding ? 'Edit holding' : 'Add a holding'} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api.post('/holdings', { id: holding?.id, account_id: account, symbol: symbol.trim() || null, name: name.trim() || null, quantity: num(qty) ?? 0, price: num(price), cost_basis: num(cost), asset_class: cls || null }));
        }}
      >
        <Field label="Account">
          <Select value={account} onChange={(e) => setAccount(e.target.value)} required>
            {invest.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ticker" hint="e.g. VTI, AAPL, BTC">
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="Optional" autoFocus={!holding} />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shares / units">
            <Amount value={qty} onChange={setQty} prefix="" placeholder="0" required />
          </Field>
          <Field label="Price each" hint="Looked up for known tickers">
            <Amount value={price} onChange={setPrice} placeholder="Auto" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Total paid (optional)">
            <Amount value={cost} onChange={setCost} placeholder="Cost basis" />
          </Field>
          <Field label="Asset class">
            <Select value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">Detect automatically</option>
              {Object.entries(ASSET_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center justify-between gap-2 pt-2">
          {holding ? (
            <Button type="button" variant="danger" disabled={busy} onClick={() => run(() => api.del(`/holdings/${holding.id}`))}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={busy || !account}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

export function TransactionForm({ tx, state, onClose }: { tx: Transaction; state: AppState; onClose: () => void }) {
  const [name, setName] = useState(tx.name);
  const [amount, setAmount] = useState(String(tx.amount));
  const [date, setDate] = useState(tx.date);
  const [category, setCategory] = useState(tx.category);
  const [remember, setRemember] = useState(false);
  const { busy, error, run } = useSubmit(onClose);
  const account = state.accounts.find((a) => a.id === tx.account_id);
  const merchant = tx.merchant || tx.name;

  return (
    <Sheet title="Transaction" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api.patch(`/transactions/${tx.id}`, { name: name.trim() || tx.name, amount: Number(amount), date, category, remember: remember && category !== tx.category }));
        }}
      >
        <Field label="Description">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" hint="Negative is money out">
            <Amount value={amount} onChange={setAmount} />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        {category !== tx.category && (
          <label className="flex items-start gap-2 rounded-xl bg-sunken px-3 py-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>
              Always file <strong className="text-ink">{merchant}</strong> this way, including past transactions
            </span>
          </label>
        )}
        <p className="text-xs text-muted">
          {account ? account.name : 'No account'} · {tx.source === 'plaid' ? 'from your bank' : tx.source === 'csv' ? 'imported' : tx.source === 'demo' ? 'demo data' : 'entered by hand'}
          {tx.pending ? ' · pending' : ''}
        </p>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button type="button" variant="danger" disabled={busy} onClick={() => run(() => api.del(`/transactions/${tx.id}`))}>
            Delete
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
