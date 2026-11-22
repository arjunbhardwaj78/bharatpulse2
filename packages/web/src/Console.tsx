import { Activity, Copy, FileUp, KeyRound, Loader2, Map as MapIcon, Plug, Send, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Console as ConsoleT } from './api';
import { toast } from './components';

const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast('Copied')).catch(() => toast('Copy failed', true));
const ago = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');

/** Minimal CSV reader (quoted fields, commas inside quotes). Header row names the columns. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
const SAMPLE_CSV = 'externalId,reporter,text,lat,lng,createdAt,category\nCPG-1001,citizen-1,सुबह से पानी नहीं आया,LAT,LNG,,WATER\nCPG-1002,citizen-2,No water since morning in our lane,LAT,LNG,,WATER\nCPG-1003,citizen-3,Tap is dry for two days,LAT,LNG,,WATER\n';

/** The city's own account: plan and usage, API keys and webhooks for its existing portal, and CSV import. */
export function CityConsole() {
  const [c, setC] = useState<ConsoleT>();
  const [label, setLabel] = useState('');
  const [newKey, setNewKey] = useState<string>();
  const [hook, setHook] = useState('');
  const [newHook, setNewHook] = useState<{ url: string; secret: string }>();
  const [csv, setCsv] = useState<Record<string, string>[]>();
  const [source, setSource] = useState('cpgrams-export');
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<Awaited<ReturnType<typeof api.importComplaints>>>();
  const load = () => api.console().then(setC).catch((e: Error) => toast(e.message, true));
  useEffect(() => { load(); }, []);
  if (!c) return <section className="card"><div className="skeleton" style={{ height: 200 }} /></section>;

  const lim = c.usage.plan.limits;
  const meter = (key: string, label: string, max?: number) => {
    const n = c.usage.counts[key] ?? 0;
    return <div className="meter"><div className="row between small"><b>{label}</b><span>{n.toLocaleString('en-IN')}{max ? ` / ${max.toLocaleString('en-IN')}` : ''}</span></div>{max && <div className="track"><div style={{ width: `${Math.min(100, (100 * n) / max)}%` }} /></div>}</div>;
  };
  async function importCsv() {
    if (!csv?.length) return;
    setBusy(true);
    try {
      const complaints = csv.slice(0, 200).map((r) => ({ externalId: r.externalId || r.id, reporter: r.reporter, text: r.text, lat: Number(r.lat), lng: Number(r.lng), createdAt: r.createdAt || undefined, category: r.category || undefined, issueType: r.issueType || undefined }));
      setImported(await api.importComplaints(complaints, source));
      load();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const sample = SAMPLE_CSV.replace(/LAT/g, String(c.city.center.lat.toFixed(4))).replace(/LNG/g, String(c.city.center.lng.toFixed(4)));

  return (
    <div className="console">
      <section className="card con-head">
        <div><p className="kicker" style={{ color: 'var(--saffron-d)' }}>City account</p><h2>{c.city.name}</h2><p className="muted small">{c.city.state} · {c.map.wards} wards · {c.map.zones} zones · {c.map.assets} water assets · data in {c.graph === 'neo4j' ? 'Neo4j' : 'memory (demo)'} · id <code>{c.city.id}</code></p></div>
        <div className="plan-pill"><b>{c.usage.plan.name}</b><span>{c.usage.plan.price}</span></div>
      </section>

      <div className="con-grid">
        <section className="card">
          <h3><Activity size={18} /> Usage this month ({c.usage.month})</h3>
          {meter('reports', 'Citizen reports', lim.reports)}
          {meter('imported', 'Imported from your portal', lim.reports)}
          {meter('sarvamCalls', 'Sarvam language calls', lim.sarvamCalls)}
          {meter('graphQueries', 'Graph questions (Neo4j)')}
          {meter('asks', 'Ask BharatPulse')}
          {meter('webhooks', 'Webhook deliveries')}
          <p className="muted small" style={{ marginTop: 8 }}>{c.stats.open} open problems · {c.stats.needsVerification} held as possibly fake · {c.stats.avgHoursToResolve ?? '–'} h average fix time.</p>
          <div className="chips" style={{ marginTop: 10 }}>{c.plans.map((p) => <button key={p.id} className={`chip ${p.id === c.city.plan ? 'on' : ''}`} disabled={c.map.wards > p.maxWards} onClick={() => api.setPlan(p.id).then(() => { toast(`Plan: ${p.name}`); load(); }).catch((e: Error) => toast(e.message, true))}>{p.name}</button>)}</div>
        </section>

        <section className="card">
          <h3><KeyRound size={18} /> API keys for your portal</h3>
          <p className="muted small">Send complaints from CPGRAMS, your state portal or a call centre to <code>POST /v1/complaints</code>. We translate, de-duplicate and link them in the graph; results come back by webhook or <code>GET /v1/incidents</code>.</p>
          {newKey && <div className="secret"><KeyRound size={18} /><div className="grow"><b>New key (shown once)</b><code style={{ fontSize: 13, wordBreak: 'break-all' }}>{newKey}</code></div><button className="btn sm" onClick={() => copy(newKey)}><Copy size={15} /></button></div>}
          <div className="row" style={{ margin: '10px 0' }}><input className="input" placeholder="Label, e.g. CPGRAMS export" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /><button className="btn primary" onClick={() => api.createKey(label || 'Portal import').then((r) => { setNewKey(r.key); setLabel(''); load(); }).catch((e: Error) => toast(e.message, true))}>Create</button></div>
          {c.apiKeys.length === 0 ? <p className="muted small">No keys yet.</p> : <ul className="keylist">{c.apiKeys.map((k) => <li key={k.id}><Plug size={15} /><div className="grow"><b>{k.label}</b><small>{k.prefix}… · created {ago(k.createdAt)} · last used {ago(k.lastUsedAt)}</small></div><button className="btn sm danger" onClick={() => api.revokeKey(k.id).then(load)}><Trash2 size={14} /></button></li>)}</ul>}
        </section>

        <section className="card">
          <h3><Webhook size={18} /> Webhooks</h3>
          <p className="muted small">We POST <code>incident.created</code> to your system the moment a real problem is detected, signed with HMAC-SHA256 (<code>x-bharatpulse-signature</code>).</p>
          {newHook && <div className="secret"><Webhook size={18} /><div className="grow"><b>Signing secret (shown once)</b><code style={{ fontSize: 13, wordBreak: 'break-all' }}>{newHook.secret}</code></div><button className="btn sm" onClick={() => copy(newHook.secret)}><Copy size={15} /></button></div>}
          <div className="row" style={{ margin: '10px 0' }}><input className="input" placeholder="https://your-portal.gov.in/hooks/bharatpulse" value={hook} onChange={(e) => setHook(e.target.value)} /><button className="btn primary" onClick={() => api.addWebhook(hook).then((w) => { setNewHook(w); setHook(''); load(); }).catch((e: Error) => toast(e.message, true))}>Add</button></div>
          {c.webhooks.length === 0 ? <p className="muted small">No webhooks yet.</p> : <ul className="keylist">{c.webhooks.map((w) => <li key={w.id}><Send size={15} /><div className="grow"><b style={{ wordBreak: 'break-all' }}>{w.url}</b><small>{w.last ? `last delivery ${ago(w.last.at)}: ${w.last.status}` : 'not called yet'}</small></div><button className="btn sm" onClick={() => api.testWebhook(w.id).then((r) => { toast(`Test: ${r.results[0]?.status}`); load(); })}>Test</button><button className="btn sm danger" onClick={() => api.removeWebhook(w.id).then(load)}><Trash2 size={14} /></button></li>)}</ul>}
        </section>

        <section className="card">
          <h3><FileUp size={18} /> Import a CSV export</h3>
          <p className="muted small">No API on your side yet? Export complaints from your portal as CSV (columns: externalId, reporter, text, lat, lng, createdAt, category). Up to 200 rows at a time; re-importing the same rows is safe.</p>
          <div className="row wrap" style={{ margin: '10px 0' }}>
            <label className="btn"><FileUp size={16} /> Choose CSV<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(parseCsv(await f.text())); setImported(undefined); }} /></label>
            <button className="btn ghost sm" onClick={() => { setCsv(parseCsv(sample)); setImported(undefined); }}>Use a sample (3 rows, Hindi + English)</button>
            <input className="input" style={{ maxWidth: 200 }} value={source} onChange={(e) => setSource(e.target.value.replace(/[^\w .-]/g, '').slice(0, 40))} aria-label="Source name" />
          </div>
          {csv && <p className="small">{csv.length} rows ready{csv.length > 200 ? ' (first 200 will be sent)' : ''}. <button className="btn primary sm" disabled={busy} onClick={importCsv}>{busy ? <Loader2 size={14} className="spin" /> : null} Import</button></p>}
          {imported && <div className="notice" style={{ marginTop: 8 }}><b>{imported.accepted} imported</b>, {imported.duplicates} already there, {imported.rejected.length} rejected{imported.rejected.length ? `: ${imported.rejected.slice(0, 3).map((r) => `row ${r.index + 1} (${r.reason})`).join('; ')}` : ''}. {imported.activeIncidents} open problems now.</div>}
        </section>
      </div>
      <p className="muted small"><MapIcon size={14} style={{ verticalAlign: -2 }} /> Officer accounts for this city: {c.officers.join(', ')}. Only the department head and the commissioner see this page.</p>
    </div>
  );
}
