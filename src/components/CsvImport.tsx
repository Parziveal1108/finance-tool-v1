import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { Upload } from 'lucide-react';
import type { Account } from '../../shared/types';
import { api, useRefresh } from '../lib/api';
import { detectColumns, guessPositiveIsSpending, mapRows, type CsvMapping } from '../lib/csv';
import { dayLabel, usd2 } from '../lib/format';
import { Button, ErrorNote, Field, Select, Sheet, cx } from './ui';

/** Drop in a bank or card export; columns and sign are detected and shown before anything is saved. */
export function CsvImport({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const [file, setFile] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [raw, setRaw] = useState<string[][]>([]);
  const [map, setMap] = useState<CsvMapping | null>(null);
  const [flip, setFlip] = useState(false);
  const [account, setAccount] = useState(accounts.find((a) => a.type === 'depository')?.id ?? accounts[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null);
  const [over, setOver] = useState(false);
  const refresh = useRefresh();

  const load = (f: File) => {
    setError('');
    setResult(null);
    Papa.parse<string[]>(f, {
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const rows = res.data.filter((r) => r.length > 1);
        // Some banks put a few summary lines above the real header row.
        const headerAt = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.length >= 3);
        if (headerAt < 0 || rows.length - headerAt < 2) {
          setError('Could not find a header row with a date column in this file.');
          return;
        }
        const head = rows[headerAt].map((h) => h.trim());
        const body = rows.slice(headerAt + 1);
        const m = detectColumns(head);
        setFile(f.name);
        setHeaders(head);
        setRaw(body);
        setMap(m);
        setFlip(guessPositiveIsSpending(body, m));
      },
      error: (e) => setError(e.message),
    });
  };

  const parsed = useMemo(() => (map ? mapRows(raw, map, flip) : { rows: [], skipped: 0 }), [raw, map, flip]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api.post<{ added: number; skipped: number }>('/import', { account_id: account || null, rows: parsed.rows }));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const col = (key: keyof CsvMapping, label: string, optional = false) => (
    <Field label={label}>
      <Select value={map![key]} onChange={(e) => setMap({ ...map!, [key]: Number(e.target.value) })}>
        {optional && <option value={-1}>—</option>}
        {headers.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Sheet title="Import a statement" onClose={onClose} wide>
      {result ? (
        <div className="py-6 text-center">
          <p className="text-lg font-semibold">{result.added.toLocaleString()} transactions imported</p>
          <p className="mt-1 text-sm text-ink-2">
            {result.skipped > 0 ? `${result.skipped.toLocaleString()} were already here and skipped. ` : ''}Categories were filled in automatically; fix any that look wrong and Keel remembers.
          </p>
          <Button variant="primary" className="mt-5" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : !map ? (
        <div className="space-y-3">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files[0];
              if (f) load(f);
            }}
            className={cx('flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center transition', over ? 'border-accent bg-sunken' : 'border-axis hover:bg-sunken')}
          >
            <Upload size={22} className="text-muted" aria-hidden />
            <span className="text-sm font-medium">Drop a CSV here, or tap to choose</span>
            <span className="max-w-sm text-[13px] text-ink-2">Every bank and card site has a "Download" or "Export" option on its transactions page. Any column layout works.</span>
            <input type="file" accept=".csv,text/csv,.txt" className="sr-only" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          </label>
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-ink-2">
            <strong className="text-ink">{file}</strong> · {parsed.rows.length.toLocaleString()} transactions ready{parsed.skipped ? `, ${parsed.skipped} rows without a date or amount left out` : ''}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {col('date', 'Date column')}
            {col('description', 'Description column')}
            {map.amount >= 0 ? col('amount', 'Amount column') : col('debit', 'Money out column')}
            {map.amount < 0 && col('credit', 'Money in column')}
            <Field label="Into account">
              <Select value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">No account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            {map.amount >= 0 && (
              <Field label="Positive numbers are">
                <Select value={flip ? 'out' : 'in'} onChange={(e) => setFlip(e.target.value === 'out')}>
                  <option value="in">Money in</option>
                  <option value="out">Purchases (card statement)</option>
                </Select>
              </Field>
            )}
          </div>
          <div className="overflow-hidden rounded-xl border border-edge">
            <table className="tabular w-full text-left text-[13px]">
              <thead className="bg-sunken text-ink-2">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 6).map((r, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink-2">{dayLabel(r.date)}</td>
                    <td className="max-w-0 truncate px-3 py-1.5">{r.name}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      {r.amount > 0 ? '+' : ''}
                      {usd2(r.amount)} <span className="text-muted">{r.amount > 0 ? 'in' : 'out'}</span>
                    </td>
                  </tr>
                ))}
                {!parsed.rows.length && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-ink-2">
                      No usable rows with these columns. Adjust the mapping above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-between gap-2">
            <Button
              onClick={() => {
                setMap(null);
                setRaw([]);
              }}
            >
              Choose another file
            </Button>
            <Button variant="primary" disabled={busy || !parsed.rows.length} onClick={submit}>
              {busy ? 'Importing…' : `Import ${parsed.rows.length.toLocaleString()}`}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
