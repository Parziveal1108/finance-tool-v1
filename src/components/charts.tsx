import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Table2, LineChart as LineIcon } from 'lucide-react';
import { niceTicks } from '../lib/format';
import { cx } from './ui';

/*
  Small hand-built SVG charts. Shared rules: 2px lines, hairline solid grid, thin bars with a
  rounded data end, text in ink colours (never the series colour), a crosshair or per-mark
  tooltip, keyboard access, and a table view for every chart.
*/

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface TableData {
  head: string[];
  rows: (string | number)[][];
}

/** Wraps a chart with its title, legend and a switch to the same data as a table. */
export function ChartFrame({ title, hint, legend, table, children, action }: { title: string; hint?: ReactNode; legend?: { label: string; color: string; kind?: 'line' | 'bar' }[]; table: TableData; children: ReactNode; action?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div>
      <header className={cx('flex items-start justify-between gap-3 px-5', title ? 'pt-4' : 'pt-1')}>
        <div className="min-w-0">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <button
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
            aria-label={asTable ? 'Show chart' : 'Show as table'}
            title={asTable ? 'Show chart' : 'Show as table'}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-sunken hover:text-ink"
          >
            {asTable ? <LineIcon size={16} /> : <Table2 size={16} />}
          </button>
        </div>
      </header>
      {legend && legend.length > 1 && !asTable && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-5 pt-2 text-[13px] text-ink-2">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden className={l.kind === 'bar' ? 'h-2.5 w-2.5 rounded-[3px]' : 'h-0.5 w-4 rounded-full'} style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <div className="px-5 pb-4 pt-3">
        {asTable ? (
          <div className="scroll-quiet max-h-72 overflow-auto rounded-xl border border-edge">
            <table className="tabular w-full text-left text-[13px]">
              <thead className="sticky top-0 bg-sunken text-ink-2">
                <tr>
                  {table.head.map((h, i) => (
                    <th key={h} className={cx('px-3 py-2 font-medium', i > 0 && 'text-right')}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    {r.map((c, j) => (
                      <td key={j} className={cx('px-3 py-1.5', j > 0 && 'text-right')}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { label: string; value: string; color: string }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(140);
  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [title, rows.length]);
  const left = Math.max(0, Math.min(width - w, x + 12 + w > width ? x - w - 12 : x + 12));
  return (
    <div ref={ref} role="status" className="pointer-events-none absolute top-1 z-10 rounded-xl border border-edge bg-raised px-3 py-2 shadow-card" style={{ left }}>
      <p className="whitespace-nowrap text-xs text-muted">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="mt-1 flex items-center gap-2 whitespace-nowrap text-[13px]">
          <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: r.color }} />
          <span className="tabular font-semibold text-ink">{r.value}</span>
          <span className="text-ink-2">{r.label}</span>
        </p>
      ))}
    </div>
  );
}

export interface LineSeries {
  name: string;
  color: string;
  values: number[];
  /** Soft fill under the line; use for a single series. */
  area?: boolean;
  /** Supporting series drawn in the neutral context colour by the caller; kept thinner. */
  context?: boolean;
}

export function LineChart({ series, labels, tickLabels, height = 200, format, zeroBased = false, endLabels = false, ariaLabel }: {
  series: LineSeries[];
  /** One label per x position, used in the tooltip. */
  labels: string[];
  /** Positions to print on the x axis: [index, text]. */
  tickLabels: [number, string][];
  height?: number;
  format: (n: number) => string;
  zeroBased?: boolean;
  endLabels?: boolean;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId();
  const n = labels.length;
  const pad = { top: 10, right: endLabels ? 14 : 10, bottom: 24, left: 46 };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;

  const { ticks, y } = useMemo(() => {
    const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
    let lo = all.length ? Math.min(...all) : 0;
    let hi = all.length ? Math.max(...all) : 1;
    if (zeroBased) lo = Math.min(0, lo);
    if (hi === lo) hi = lo + 1;
    const t = niceTicks(lo, hi, 3);
    const min = t[0];
    const max = t[t.length - 1];
    return { ticks: t, y: (v: number) => pad.top + innerH - ((v - min) / (max - min)) * innerH };
  }, [series, zeroBased, innerH, pad.top]);

  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  // Thin the x labels on narrow screens so they never run into each other; keep both ends.
  const room = Math.max(2, Math.floor(innerW / 72));
  const shownTicks =
    tickLabels.length <= room
      ? tickLabels
      : Array.from({ length: room }, (_, k) => tickLabels[Math.round((k / (room - 1)) * (tickLabels.length - 1))]);
  const path = (values: number[]) => values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const onMove = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const rel = (clientX - rect.left - pad.left) / innerW;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  return (
    <div
      ref={ref}
      className="relative select-none"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={ariaLabel}
      onPointerMove={(e) => onMove(e.clientX)}
      onPointerDown={(e) => onMove(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
        if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
        if (e.key === 'Escape') setHover(null);
      }}
    >
      {width > 0 && (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={i} id={`${gid}-${i}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity="0.16" />
                <stop offset="1" stopColor={s.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-muted text-[11px]">
                {format(t)}
              </text>
            </g>
          ))}
          {shownTicks.map(([i, text], k) => (
            <text key={k} x={x(i)} y={height - 6} textAnchor={k === 0 ? 'start' : k === shownTicks.length - 1 ? 'end' : 'middle'} className="fill-muted text-[11px]">
              {text}
            </text>
          ))}
          {series.map((s, i) =>
            s.area && s.values.length > 1 ? (
              <path key={`a${i}`} d={`${path(s.values)}L${x(s.values.length - 1)},${pad.top + innerH}L${x(0)},${pad.top + innerH}Z`} fill={`url(#${gid}-${i})`} />
            ) : null,
          )}
          {series.map((s, i) => (
            <path key={`${i}-${s.values.length}`} d={path(s.values)} pathLength={1} fill="none" stroke={s.color} strokeWidth={s.context ? 1.5 : 2} strokeLinejoin="round" strokeLinecap="round" className="draw" />
          ))}
          {hover === null &&
            series.map((s, i) =>
              !s.context && s.values.length ? (
                <circle key={`e${i}`} cx={x(s.values.length - 1)} cy={y(s.values[s.values.length - 1])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />
              ) : null,
            )}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--axis)" strokeWidth="1" />
              {series.map((s, i) =>
                hover < s.values.length ? <circle key={i} cx={x(hover)} cy={y(s.values[hover])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" /> : null,
              )}
            </g>
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <Tooltip
          x={x(hover)}
          width={width}
          title={labels[hover]}
          rows={[...series].sort((a, b) => Number(!!a.context) - Number(!!b.context)).filter((s) => hover < s.values.length).map((s) => ({ label: s.name, value: format(s.values[hover]), color: s.color }))}
        />
      )}
    </div>
  );
}

/** Grouped columns: one group per category, one thin bar per series. */
export function ColumnChart({ groups, series, height = 200, format, ariaLabel }: {
  groups: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  format: (n: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 10, right: 6, bottom: 24, left: 46 };
  const innerW = Math.max(10, width - pad.left - pad.right);
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(0, max, 3);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => pad.top + innerH - (v / top) * innerH;
  const band = innerW / Math.max(1, groups.length);
  const gap = 2;
  const barW = Math.max(4, Math.min(24, (band * 0.6 - gap * (series.length - 1)) / series.length));
  const groupW = barW * series.length + gap * (series.length - 1);
  const base = pad.top + innerH;

  return (
    <div ref={ref} className="relative" style={{ height }} role="group" aria-label={ariaLabel} onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} className="block">
          {ticks.map((t) => (
            <g key={t} aria-hidden>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--line)'} strokeWidth="1" />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-muted text-[11px]">
                {format(t)}
              </text>
            </g>
          ))}
          {groups.map((g, gi) => {
            const x0 = pad.left + band * gi + (band - groupW) / 2;
            return (
              <g
                key={g}
                tabIndex={0}
                role="img"
                aria-label={`${g}: ${series.map((s) => `${s.name} ${format(s.values[gi] ?? 0)}`).join(', ')}`}
                onPointerEnter={() => setHover(gi)}
                onPointerDown={() => setHover(gi)}
                onFocus={() => setHover(gi)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                <rect x={pad.left + band * gi} y={pad.top} width={band} height={innerH + pad.bottom} fill={hover === gi ? 'var(--sunken)' : 'transparent'} rx="8" />
                {series.map((s, si) => {
                  const v = s.values[gi] ?? 0;
                  const h = Math.max(0, base - y(v));
                  const r = Math.min(4, h, barW / 2);
                  const bx = x0 + si * (barW + gap);
                  return h > 0 ? (
                    <path
                      key={s.name}
                      className="grow-y"
                      style={{ animationDelay: `${gi * 40}ms` }}
                      d={`M${bx},${base}V${base - h + r}Q${bx},${base - h} ${bx + r},${base - h}H${bx + barW - r}Q${bx + barW},${base - h} ${bx + barW},${base - h + r}V${base}Z`}
                      fill={s.color}
                    />
                  ) : null;
                })}
                <text x={pad.left + band * gi + band / 2} y={height - 6} textAnchor="middle" className="fill-muted text-[11px]" aria-hidden>
                  {g}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <Tooltip x={pad.left + band * hover + band / 2} width={width} title={groups[hover]} rows={series.map((s) => ({ label: s.name, value: format(s.values[hover] ?? 0), color: s.color }))} />
      )}
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string;
  /** Use near-black text on light fills (yellow). */
  darkText?: boolean;
}

/**
 * One whole split into parts. `tall` prints each share inside its block when it fits;
 * the thin form carries no text and sits beside figures that do.
 */
export function SegmentedBar({ segments, tall = false, format, ariaLabel }: { segments: Segment[]; tall?: boolean; format: (n: number) => string; ariaLabel: string }) {
  const total = segments.reduce((s, p) => s + Math.max(0, p.value), 0);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const live = segments.filter((s) => s.value > 0);
  if (total <= 0) return <div className={cx('rounded-full bg-sunken', tall ? 'h-7' : 'h-2')} />;
  return (
    <div className="relative">
      <div ref={ref} role="img" aria-label={`${ariaLabel}: ${live.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`} className={cx('flex w-full gap-0.5', tall ? 'h-7' : 'h-2')} onPointerLeave={() => setHover(null)}>
        {live.map((s, i) => {
          const share = s.value / total;
          const px = share * width;
          const text = `${Math.round(share * 100)}%`;
          return (
            <div
              key={s.label}
              tabIndex={tall ? 0 : -1}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className={cx('grow-x flex min-w-[3px] items-center outline-none transition-[filter] hover:brightness-110', tall ? 'rounded' : i === 0 ? 'rounded-l-full' : i === live.length - 1 ? 'rounded-r-full' : '')}
              style={{ flex: `${share} 1 0`, background: s.color, animationDelay: `${i * 50}ms` }}
            >
              {tall && px > text.length * 8 + 14 && <span className={cx('pl-2 text-xs font-semibold', s.darkText ? 'text-[#0b0b0b]' : 'text-white')}>{text}</span>}
            </div>
          );
        })}
      </div>
      {hover !== null && tall && live[hover] && (
        <div role="status" className="pointer-events-none absolute -top-9 left-0 z-10 whitespace-nowrap rounded-lg border border-edge bg-raised px-2.5 py-1 text-[13px] shadow-card">
          <span className="tabular font-semibold">{format(live[hover].value)}</span> <span className="text-ink-2">{live[hover].label} · {Math.round((live[hover].value / total) * 100)}%</span>
        </div>
      )}
    </div>
  );
}

/**
 * A ratio against a limit. The track is a lighter step of the fill's own hue, and an optional
 * tick marks where "on pace" would be today.
 */
export function Meter({ value, max, tone = 'accent', marker, label, height = 8 }: { value: number; max: number; tone?: 'accent' | 'good' | 'warning' | 'critical'; marker?: number; label: string; height?: number }) {
  const color = tone === 'accent' ? 'var(--accent)' : `var(--${tone})`;
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(share));
    return () => cancelAnimationFrame(id);
  }, [share]);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} className="relative w-full rounded-full" style={{ height, background: `color-mix(in oklab, ${color} 18%, var(--surface))` }}>
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${shown * 100}%`, background: color, minWidth: share > 0 ? height : 0 }} />
      {marker != null && marker > 0 && marker < 1 && <div aria-hidden className="absolute -top-1 w-0.5 rounded-full bg-ink" style={{ left: `${marker * 100}%`, height: height + 8 }} />}
    </div>
  );
}

/** Tiny trend line for stat tiles; no axes, last point marked. */
export function Sparkline({ values, color = 'var(--accent)', width = 96, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pt = (v: number, i: number) => [3 + (i / (values.length - 1)) * (width - 6), 3 + (1 - (v - lo) / span) * (height - 6)] as const;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${pt(v, i).map((n) => n.toFixed(1)).join(',')}`).join('');
  const [ex, ey] = pt(values[values.length - 1], values.length - 1);
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke="var(--context)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={ex} cy={ey} r="3" fill={color} stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  );
}
