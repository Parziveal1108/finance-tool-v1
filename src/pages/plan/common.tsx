import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppState, Settings } from '../../../shared/types';
import { addMonths } from '../../../shared/payoff';
import { api } from '../../lib/api';
import { monthYear } from '../../lib/format';
import { Amount, Field } from '../../components/ui';

export const num = (s: string) => Math.max(0, Number(s) || 0);
export const when = (state: AppState, months: number | null) => (months == null ? 'Never at this pace' : months === 0 ? 'Now' : monthYear(addMonths(state.today, months)));

export function Rows({ head, rows }: { head: [string, string, string]; rows: [string, ReactNode, ReactNode][] }) {
  return (
    <table className="tabular w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="pb-1.5 font-medium">{head[0]}</th>
          <th className="pb-1.5 text-right font-medium">{head[1]}</th>
          <th className="pb-1.5 text-right font-medium">{head[2]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b]) => (
          <tr key={label} className="border-t border-line">
            <td className="py-2 pr-2 text-ink-2">{label}</td>
            <td className="py-2 text-right font-medium">{a}</td>
            <td className="py-2 text-right font-medium">{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Label/value pairs, one per line. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="tabular divide-y divide-line border-t border-line text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="text-ink-2">{k}</dt>
          <dd className="shrink-0 text-right font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Verdict({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-ink-2">{label}</p>
      <p className="mt-1 text-[40px] font-semibold leading-none tracking-tight sm:text-5xl">{value}</p>
      {children && <div className="mt-2 text-sm leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-sunken px-3 py-2 text-[13px] leading-relaxed text-ink-2">{children}</p>;
}

/** Number box that keeps what you typed while typing, and reports a number (or null when blank). */
export function Num({ label, value, onChange, prefix = '$', suffix, hint, placeholder }: { label: string; value: number | null; onChange: (v: number | null) => void; prefix?: string; suffix?: string; hint?: string; placeholder?: string }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const last = useRef(value);
  useEffect(() => {
    // Adopt outside changes (another device, the assistant) without fighting the keyboard.
    if (value !== last.current) {
      last.current = value;
      setText(value == null ? '' : String(value));
    }
  }, [value]);
  return (
    <Field label={label} hint={hint}>
      <Amount
        value={text}
        prefix={prefix}
        suffix={suffix}
        placeholder={placeholder}
        aria-label={label}
        onChange={(t) => {
          setText(t);
          const v = t.trim() === '' || t === '-' || t === '.' ? null : Number(t);
          const next = v != null && Number.isFinite(v) ? v : null;
          last.current = next;
          onChange(next);
        }}
      />
    </Field>
  );
}

/**
 * A slice of settings edited in place: changes apply at once on screen and are saved shortly
 * after, so every calculator stays live while the monitor and assistant see the same inputs.
 */
export function useSaved<K extends keyof Settings>(key: K, server: Settings[K], initial: NonNullable<Settings[K]>) {
  const [value, setValue] = useState<NonNullable<Settings[K]>>(() => (server ?? initial) as NonNullable<Settings[K]>);
  const savedJson = useRef(JSON.stringify(server));
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const incoming = JSON.stringify(server);
    if (server != null && incoming !== savedJson.current) {
      savedJson.current = incoming;
      setValue(server as NonNullable<Settings[K]>);
    }
  }, [server]);
  const update = (patch: Partial<NonNullable<Settings[K]>>) => {
    setValue((cur) => {
      const next = { ...(cur as object), ...patch } as NonNullable<Settings[K]>;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        savedJson.current = JSON.stringify(next);
        api.patch('/settings', { [key]: next }).catch(() => undefined);
      }, 700);
      return next;
    });
  };
  return [value, update] as const;
}
