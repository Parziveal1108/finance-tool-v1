import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Paperclip, Sparkles, Trash2, X } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { IconButton, cx } from './ui';

interface Msg {
  id: number | string;
  role: 'user' | 'assistant';
  text: string;
}

interface Attachment {
  name: string;
  media_type: string;
  data: string;
}

type ChatEvent = { type: 'text'; delta: string } | { type: 'tool'; name: string } | { type: 'done'; changed: boolean } | { type: 'error'; message: string };

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,.csv,.txt,text/plain,text/csv';
const MAX_FILE = 8 * 1024 * 1024;

function readFile(f: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.onload = () => {
      const url = String(r.result);
      const type = f.type || (/\.csv$/i.test(f.name) ? 'text/csv' : 'text/plain');
      resolve({ name: f.name, media_type: type, data: url.slice(url.indexOf(',') + 1) });
    };
    r.readAsDataURL(f);
  });
}

/** Renders the small subset of markdown the assistant uses: paragraphs, lists and bold. */
function Rich({ text }: { text: string }) {
  const inline = (s: string, key: number): ReactNode => {
    const parts = s.split(/(\*\*[^*]+\*\*)/g);
    return <span key={key}>{parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong> : p))}</span>;
  };
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <L key={blocks.length} className={cx('my-1.5 space-y-1 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it, i)}</li>
        ))}
      </L>,
    );
    list = null;
  };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length} className="my-1.5 first:mt-0 last:mb-0">{inline(line.replace(/^#+\s*/, ''), 0)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

const STARTERS_WITH_DATA = ['How am I doing this month?', 'What is the fastest way out of debt?', 'Where can I cut $200 a month?', 'Is my portfolio balanced?'];
const STARTERS_EMPTY = [
  'I have a Visa with $4,200 at 24.99% APR, minimum $95, and a car loan of $9,700 at 7.4%, $318 a month',
  'Checking has $3,100 and savings $6,800 at First Harbor',
  'My Roth IRA holds 22 VTI and 31 VXUS',
];

export function Assistant({ state, onClose }: { state: AppState; onClose?: () => void }) {
  const qc = useQueryClient();
  const refresh = useRefresh();
  const history = useQuery({ queryKey: ['chat'], queryFn: () => api.get<Msg[]>('/assistant/history'), staleTime: Infinity });
  const [pending, setPending] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const ai = state.capabilities.ai;
  const messages = [...(history.data ?? []), ...pending];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, pending[pending.length - 1]?.text, activity]);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    setError('');
    try {
      const next: Attachment[] = [];
      for (const f of Array.from(list).slice(0, 5 - files.length)) {
        if (f.size > MAX_FILE) throw new Error(`${f.name} is over 8 MB. For large exports use Import on the Activity page.`);
        next.push(await readFile(f));
      }
      setFiles((cur) => [...cur, ...next]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not attach that file');
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if ((!message && !files.length) || busy) return;
    const attachments = files;
    setDraft('');
    setFiles([]);
    setError('');
    setBusy(true);
    setActivity('Thinking');
    const label = message || 'Please read the attached file and record what you find.';
    setPending([
      { id: 'u', role: 'user', text: label + (attachments.length ? ` (attached: ${attachments.map((a) => a.name).join(', ')})` : '') },
      { id: 'a', role: 'assistant', text: '' },
    ]);
    try {
      const res = await fetch('/api/assistant/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: label, attachments }) });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `The assistant is unavailable (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as ChatEvent;
          if (event.type === 'text') {
            setActivity('');
            setPending((p) => p.map((m) => (m.id === 'a' ? { ...m, text: m.text + event.delta } : m)));
          } else if (event.type === 'tool') setActivity(event.name);
          else if (event.type === 'error') setError(event.message);
          else if (event.type === 'done' && event.changed) refresh();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      await qc.invalidateQueries({ queryKey: ['chat'] });
      setPending([]);
      setBusy(false);
      setActivity('');
      input.current?.focus();
    }
  };

  const clear = async () => {
    if (!messages.length || !confirm('Clear this conversation? Your financial data is not affected.')) return;
    await api.del('/assistant/history');
    qc.setQueryData(['chat'], []);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-on-accent">
            <Sparkles size={14} aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold leading-tight">Assistant</p>
            <p className="text-xs leading-tight text-muted">{ai ? 'Sees your accounts · can make changes' : 'Not connected'}</p>
          </div>
        </div>
        <div className="flex items-center">
          {messages.length > 0 && (
            <IconButton label="Clear conversation" onClick={clear}>
              <Trash2 size={16} />
            </IconButton>
          )}
          {onClose && (
            <IconButton label="Close assistant" onClick={onClose}>
              <X size={18} />
            </IconButton>
          )}
        </div>
      </header>

      <div ref={scroller} className="scroll-quiet min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {!ai ? (
          <div className="rounded-2xl border border-edge bg-raised p-4 text-sm leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">Turn on the conversational assistant</p>
            <p className="mt-1">
              Add an Anthropic API key as <code className="rounded bg-sunken px-1 py-0.5 text-[13px]">ANTHROPIC_API_KEY</code> in the <code className="rounded bg-sunken px-1 py-0.5 text-[13px]">.env</code> file and restart Keel. You can then talk through your finances, have it enter accounts and transactions from a sentence or a statement, and get written check-ins.
            </p>
            <p className="mt-2">The built-in monitor does not need a key: it is already watching your budget, debts and portfolio and posting suggestions on the home screen.</p>
          </div>
        ) : !messages.length ? (
          <div className="pt-2">
            <p className="text-[15px] font-semibold">{state.hasData ? 'Ask about your money, or tell me what changed.' : 'Tell me about your finances and I will set everything up.'}</p>
            <p className="mt-1 text-sm text-ink-2">
              {state.hasData
                ? 'I can read everything in Keel, run the numbers, and update budgets, goals and your debt plan when you ask.'
                : 'Describe your accounts in plain sentences, or attach a statement, a screenshot or a spreadsheet. I will create the accounts, debts and holdings for you.'}
            </p>
            <div className="mt-4 grid gap-2">
              {(state.hasData ? STARTERS_WITH_DATA : STARTERS_EMPTY).map((s) => (
                <button key={s} onClick={() => (state.hasData ? send(s) : (setDraft(s), input.current?.focus()))} className="rounded-xl border border-edge bg-raised px-3 py-2 text-left text-sm text-ink-2 transition hover:border-accent hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-8 flex justify-end">
                <p className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm leading-relaxed text-on-accent">{m.text}</p>
              </div>
            ) : m.text ? (
              <div key={m.id} className="mr-4 text-sm leading-relaxed text-ink">
                <Rich text={m.text} />
              </div>
            ) : null,
          )
        )}
        {busy && activity && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
            <span className="live-dot h-2 w-2 rounded-full bg-accent" aria-hidden />
            {activity}…
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-xl border border-edge bg-sunken px-3 py-2 text-[13px] text-critical">
            {error}
          </p>
        )}
      </div>

      {ai && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
          className="border-t border-line px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5"
        >
          {files.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-1 rounded-lg bg-sunken py-1 pl-2 pr-1 text-xs text-ink-2">
                  <span className="max-w-[160px] truncate">{f.name}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} className="flex h-5 w-5 items-center justify-center rounded hover:bg-line">
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-1.5 rounded-2xl border border-edge bg-raised p-1.5 focus-within:border-accent">
            <label className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition hover:bg-sunken hover:text-ink" title="Attach a statement, screenshot or spreadsheet">
              <Paperclip size={17} />
              <span className="sr-only">Attach a file</span>
              <input
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
            <textarea
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              aria-label="Message the assistant"
              placeholder={state.hasData ? 'Ask, or tell me what changed…' : 'Describe your accounts…'}
              className="max-h-36 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted"
              style={{ fieldSizing: 'content' } as React.CSSProperties}
            />
            <button type="submit" disabled={busy || (!draft.trim() && !files.length)} aria-label="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent transition disabled:opacity-40">
              <ArrowUp size={17} />
            </button>
          </div>
          <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted">General guidance from an AI, not professional financial advice. Your messages and the data it looks up are sent to Anthropic.</p>
        </form>
      )}
    </div>
  );
}
