import { useEffect, useRef, useState } from 'react';

const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** $1,284 — whole dollars, with a real minus sign. */
export const usd = (n: number) => whole.format(Math.round(n)).replace('-', '−');
/** $1,284.50 */
export const usd2 = (n: number) => cents.format(n).replace('-', '−');
/** Compact for axes and tight spots: $950, $12.9K, $1.2M */
export function usdCompact(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${trim(a / 1_000_000)}M`;
  if (a >= 10_000) return `${sign}$${trim(a / 1000)}K`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}
const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''));

export const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${whole.format(Math.abs(Math.round(n)))}`;
export const pct = (n: number, digits = 0) => `${n.toFixed(digits)}%`;

export const monthLabel = (key: string, opts: Intl.DateTimeFormatOptions = { month: 'short' }) => new Date(`${key}-15T12:00:00`).toLocaleDateString('en-US', opts);
export const monthYear = (key: string) => monthLabel(key, { month: 'short', year: 'numeric' });
export const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', opts);

export function relativeDay(iso: string, today: string): string {
  const diff = Math.round((Date.parse(today) - Date.parse(iso)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return dayLabel(iso, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

export function monthsToWords(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y) return `${m} mo`;
  return m ? `${y} yr ${m} mo` : `${y} yr`;
}

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animates a number toward its latest value so changes read as movement, not a jump. */
export function useCountUp(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduceMotion() || from.current === target) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = a + (target - a) * eased;
      from.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** Round tick values that bracket the data: 0 / 2,000 / 4,000 … */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
