import { useEffect, useState, type ReactNode } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { api, useRefresh } from '../lib/api';
import { Button, ErrorNote } from './ui';

type Mode = 'banking' | 'investments' | 'loans';

/** Opens Plaid Link once a token is ready, then hands the result to the server. */
function Launcher({ token, onDone, onError }: { token: string; onDone: () => void; onError: (m: string) => void }) {
  const refresh = useRefresh();
  const { open, ready } = usePlaidLink({
    token,
    onSuccess: async (public_token, metadata) => {
      try {
        await api.post('/plaid/exchange', { public_token, institution: metadata.institution?.name ?? '' });
        refresh();
      } catch (e) {
        onError(e instanceof Error ? e.message : 'Could not finish linking');
      }
      onDone();
    },
    onExit: (err) => {
      if (err) onError(err.display_message || err.error_message || 'Linking was interrupted');
      onDone();
    },
  });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}

export function PlaidLinkButton({ mode = 'banking', itemId, children, variant = 'secondary', size = 'md', className }: { mode?: Mode; itemId?: string; children: ReactNode; variant?: 'primary' | 'secondary'; size?: 'sm' | 'md'; className?: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ link_token: string }>('/plaid/link-token', { mode, item_id: itemId });
      setToken(res.link_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start linking');
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <Button variant={variant} size={size} onClick={start} disabled={busy} className="w-full">
        {busy ? 'Opening…' : children}
      </Button>
      {error && (
        <div className="mt-2">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {token && (
        <Launcher
          token={token}
          onError={setError}
          onDone={() => {
            setToken(null);
            setBusy(false);
          }}
        />
      )}
    </div>
  );
}
