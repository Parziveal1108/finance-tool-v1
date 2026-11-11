import { useState } from 'react';
import { api } from '../lib/api';
import { Button, ErrorNote, Input } from '../components/ui';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        className="w-full max-w-xs space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await api.post('/login', { password });
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not sign in');
          } finally {
            setBusy(false);
          }
        }}
      >
        <img src="/icon.svg" alt="" className="h-12 w-12 rounded-xl" />
        <h1 className="text-2xl font-semibold tracking-tight">Keel</h1>
        <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" aria-label="Password" />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" variant="primary" className="w-full" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
