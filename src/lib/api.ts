import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AppState, Transaction } from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      // keep the generic message
    }
    if (res.status === 401) window.dispatchEvent(new Event('keel:signed-out'));
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T = { ok: true }>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T = { ok: true }>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T = { ok: true }>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = { ok: true }>(path: string) => request<T>('DELETE', path),
};

export function useAppState() {
  return useQuery({ queryKey: ['state'], queryFn: () => api.get<AppState>('/state'), staleTime: 15_000 });
}

export interface TxQuery {
  text?: string;
  category?: string;
  account?: string;
  month?: string;
  limit?: number;
}

export function useTransactions(params: TxQuery) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return useQuery({
    queryKey: ['transactions', qs],
    queryFn: () => api.get<{ total: number; transactions: Transaction[] }>(`/transactions?${qs}`),
    placeholderData: (prev) => prev,
  });
}

/** Keeps every open screen in step with the server: data refetches the moment anything changes. */
export function useLiveUpdates(onInsight: (i: { title: string; severity: string }) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource('/api/events');
    const refresh = () => {
      qc.invalidateQueries({ queryKey: ['state'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    };
    es.addEventListener('state', refresh);
    es.addEventListener('insight', (e) => {
      try {
        onInsight(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frames
      }
    });
    es.onopen = refresh;
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}

export function useRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['state'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
  };
}
