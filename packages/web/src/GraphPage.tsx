import { AlertTriangle, Code2, Maximize, Database, Loader2, Mic, Network, Search, ShieldAlert, Sparkles, Square, Volume2, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type Answer, type City, type Health, type Overview, type Ring, type RootCause } from './api';
import { toast } from './components';
import { LANGS, nameOfBcp } from './i18n';
import { speakText, useVoiceInput } from './voice';

const VIA: Record<string, string> = { DEVICE: 'shared phones', PHOTO: 'one photo in many accounts', CO_REPORTING: 'same accounts, far-apart places (hired crowd)' };
const EXAMPLES: { q: string; lang: string; sarvam?: boolean }[] = [
  { q: 'Why is water failing in several wards?', lang: 'en-IN' },
  { q: 'कौन फ़र्ज़ी शिकायतें कर रहा है?', lang: 'hi-IN' },
  { q: 'What happens downstream if Zone 2 fails?', lang: 'en-IN' },
  { q: 'வார்டு 3 இல் என்ன நடக்கிறது?', lang: 'ta-IN', sarvam: true },
];

/** The Cypher behind an answer, shown as-is: this is exactly what ran on Neo4j. */
export function CypherBox({ cypher, engine }: { cypher?: string[]; engine?: string }) {
  if (!cypher?.length) return null;
  return (
    <details className="cypher">
      <summary><Code2 size={14} /> Cypher {engine === 'neo4j' ? 'that ran on Neo4j' : '(runs on Neo4j; this demo is using the in-memory twin)'}</summary>
      {cypher.map((c, i) => <pre key={i}>{c}</pre>)}
    </details>
  );
}

export function GraphPage({ city, health, onOpen }: { city?: City; health?: Health; onOpen: (id: string) => void }) {
  const [overview, setOverview] = useState<Overview>();
  const [root, setRoot] = useState<RootCause>();
  const [rings, setRings] = useState<{ rings: Ring[]; targets: { ring: string; incident: string }[]; cypher: string[] }>();
  const [picked, setPicked] = useState<{ id: string; type: string; label: string; kind?: string }>();
  const load = () => {
    api.overview().then(setOverview).catch((e: Error) => toast(e.message, true));
    api.rootCause().then(setRoot).catch(() => undefined);
    api.rings().then(setRings).catch(() => undefined);
  };
  useEffect(load, []);
  const engine = overview?.engine ?? health?.graph;
  /** "no water in Ward 7", from the overview graph (Incident -AFFECTS-> Locality). */
  const incidentName = (id: string) => {
    const n = overview?.nodes.find((x) => x.id === id);
    const w = overview?.edges.find((e) => e.from === id && e.type === 'AFFECTS')?.to;
    return `${(n?.label ?? id.split(':')[0]).toLowerCase().replace(/_/g, ' ')}${w ? ` in ${city?.localities.find((l) => l.id === w)?.name ?? w}` : ''}`;
  };
  const wardName = (id: string) => city?.localities.find((l) => l.id === id)?.name ?? id;
  const zoneName = (id: string) => city?.zones.find((z) => z.id === id)?.name ?? id;

  return (
    <div className="gpage">
      <div className={`engine-banner ${engine === 'neo4j' ? 'live' : ''}`}>
        <Database size={18} />
        {engine === 'neo4j' ? <span><b>Live on Neo4j.</b> Every answer on this page is a Cypher query on the graph database.</span>
          : <span><b>Demo mode (in-memory twin).</b> The same Cypher runs on Neo4j Aura when <code>NEO4J_URI</code> is set; answers are identical (checked by <code>npm run neo4j:smoke</code>).</span>}
      </div>

      <AskBox health={health} />

      <div className="gsplit">
        <section className="card gcanvas-card">
          <div className="row between wrap"><h2><Network size={20} style={{ verticalAlign: -3 }} /> The town as a graph</h2><button className="btn sm" onClick={load}>Refresh</button></div>
          <p className="muted small">Tank → pump → pipes → zones → wards, the open problems in each ward, and the rings of linked accounts that reported into them. Click anything.</p>
          {overview ? <GraphCanvas data={overview} suspect={root?.suspects[0]?.assetId} atRisk={root?.atRisk.map((w) => w.localityId) ?? []} onPick={(n) => (n.type === 'Incident' ? onOpen(n.id) : setPicked(n))} /> : <div className="skeleton" style={{ height: 460 }} />}
          <div className="legend small">
            <span><i style={{ background: '#10B981' }} />(:Asset) pipe / pump / tank</span><span><i style={{ background: '#f97316' }} />Likely failure point</span><span><i style={{ background: '#C990C0' }} />(:Zone)</span><span><i style={{ background: '#FCD34D' }} />(:Locality) ward</span>
            <span><i style={{ background: '#F16667' }} />(:Incident) open</span><span><i style={{ background: '#A5ABB6' }} />not confirmed</span><span><i style={{ background: '#7f1d1d' }} />fake-report ring</span>
          </div>
          {(() => { const lost = overview?.nodes.filter((n) => n.type === 'Incident' && !overview.edges.some((e) => e.from === n.id && e.type === 'AFFECTS')).length ?? 0; return lost > 0 && <p className="small muted" style={{ marginTop: 6 }}>{lost} open problem(s) are more than 3 km from every ward of this town, so they float unlinked. Set <code>CITY_CENTER</code> on the server to your area to map them.</p>; })()}
          {picked && <p className="small picked"><b>{picked.type}:</b> {picked.label}{picked.kind ? ` · ${picked.type === 'Ring' ? picked.kind.split(', ').map((v) => VIA[v] ?? v).join(', ') : picked.kind.toLowerCase()}` : ''}</p>}
        </section>

        <div className="stack">
          <section className="card insight">
            <h2><Wrench size={19} style={{ verticalAlign: -3 }} /> Where to send the crew</h2>
            {!root ? <div className="skeleton" style={{ height: 80 }} /> : root.suspects.length === 0 ? <p className="muted">No trusted open water-supply problem to trace right now.</p> : (
              <>
                <p>{root.incidents.length} trusted water problems in <b>{root.zonesHit.map(zoneName).join(' and ')}</b> all trace back to:</p>
                <div className="suspect"><b>{root.suspects[0].name}</b><span>{root.suspects[0].kind.toLowerCase()} {root.suspects[0].assetId} · explains {root.suspects[0].covers.length} of {root.zonesHit.length} zones</span></div>
                {root.suspects.length > 1 && <p className="muted small">Next most likely: {root.suspects.slice(1).map((s) => s.name).join(', ')} (further upstream).</p>}
                {root.atRisk.length > 0 && <div className="notice warn"><AlertTriangle size={15} style={{ verticalAlign: -3 }} /> <b>Warn before they call:</b> {root.atRisk.map((w) => wardName(w.localityId)).join(', ')} are fed by the same pipe and have not reported yet.</div>}
              </>
            )}
            <CypherBox cypher={root?.cypher} engine={root?.engine} />
          </section>

          <section className="card insight">
            <h2><ShieldAlert size={19} style={{ verticalAlign: -3 }} /> Fake-report rings</h2>
            {!rings ? <div className="skeleton" style={{ height: 80 }} /> : rings.rings.length === 0 ? <p className="muted">No group of 3+ linked accounts.</p> : (
              <ul className="ringlist">
                {groupRings(rings.rings, rings.targets).map((g) => (
                  <li key={g.key} className={g.via.includes('CO_REPORTING') ? 'crowd' : ''}>
                    <b>{g.count > 1 ? `${g.count} rings, ${g.accounts} accounts` : `${g.accounts} accounts`}</b> <span className="muted small">linked by {g.via.map((v) => VIA[v]).join(' + ')}</span>
                    {g.incidents.length > 0 && <span className="small"> · reported into {g.incidents.map((id) => <button key={id} className="linkbtn" onClick={() => onOpen(id)}>{incidentName(id)}</button>)}</span>}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Each ring counts as <b>one person</b> in the priority score, so it cannot push a fake problem up the list. A ring of hired accounts that reports again somewhere else is caught even when every single report looks real.</p>
            <CypherBox cypher={rings?.cypher} engine={engine} />
          </section>
        </div>
      </div>
    </div>
  );
}

function AskBox({ health }: { health?: Health }) {
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('en-IN');
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<Answer>();
  const sarvam = !!health?.sarvam?.enabled;
  const voice = useVoiceInput({
    who: 'officer', browserLang: lang,
    onResult: (h, via) => { setQ(h.text); if (h.language && via === 'sarvam') setLang(h.language); },
    onError: () => toast('Could not use the microphone here. Please type.', true),
  });
  async function go(question = q, language = lang) {
    if (!question.trim()) return;
    setBusy(true);
    try { setA(await api.ask(question.trim(), language)); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  return (
    <section className="card askbox">
      <div className="row between wrap">
        <h2><Sparkles size={20} style={{ verticalAlign: -3 }} /> Ask BharatPulse</h2>
        <span className="small muted">{sarvam ? 'Sarvam AI understands and answers in 11 languages · Neo4j finds the facts' : 'Keyword mode (English/Hindi). Add SARVAM_API_KEY for 11 languages and voice.'}</span>
      </div>
      <div className="askrow">
        <button className={`mic ${voice.state === 'listening' ? 'on' : ''}`} onClick={voice.toggle} aria-label="Ask by voice">{voice.state === 'thinking' ? <Loader2 className="spin" /> : voice.state === 'listening' ? <Square size={18} /> : <Mic />}</button>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="Ask in any language: why is water failing? who is faking reports? what is happening in Ward 5?" maxLength={500} />
        <select className="input langsel" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Answer language">{LANGS.filter((l) => sarvam || l.code === 'en' || l.code === 'hi').map((l) => <option key={l.bcp} value={l.bcp}>{l.name}</option>)}</select>
        <button className="btn primary" disabled={busy || !q.trim()} onClick={() => go()}>{busy ? <Loader2 size={17} className="spin" /> : <Search size={17} />} Ask</button>
      </div>
      <div className="chips" style={{ marginTop: 8 }}>{EXAMPLES.filter((x) => !x.sarvam || sarvam).map((x) => <button key={x.q} className="chip" onClick={() => { setQ(x.q); setLang(x.lang); void go(x.q, x.lang); }}>{x.q}</button>)}</div>
      {a && (
        <div className="answer fade">
          <p className="ans" lang={a.language}>{a.answer}</p>
          {a.answer !== a.answerEn && <p className="muted small">English: {a.answerEn}</p>}
          <div className="row wrap small" style={{ gap: 6, marginTop: 8 }}>
            <span className="tagx">{a.via.understood === 'sarvam' ? 'Understood by Sarvam-105B' : 'Understood by keywords'}</span>
            {a.questionEn !== a.question && <span className="tagx">Question translated from {nameOfBcp(a.language)}</span>}
            <span className="tagx neo">Facts: {a.engine === 'neo4j' ? 'Neo4j' : 'graph twin'} · {a.tool.replace(/_/g, ' ')}</span>
            {a.via.worded === 'sarvam' && <span className="tagx">Worded by Sarvam</span>}
            <button className="btn ghost sm" onClick={() => speakText(a.answer, a.language, 'officer').then((v) => v === 'none' && toast('No voice available here', true))}><Volume2 size={15} /> Read aloud{sarvam ? ' (Bulbul)' : ''}</button>
          </div>
          <CypherBox cypher={a.cypher} engine={a.engine} />
        </div>
      )}
    </section>
  );
}

type Cy = import('cytoscape').Core;
/** Neo4j Browser-like palette per label (and per severity for incidents). */
const NEO: Record<string, { fill: string; border: string }> = {
  Asset: { fill: '#10B981', border: '#047857' }, Zone: { fill: '#C990C0', border: '#b261a5' }, Locality: { fill: '#FCD34D', border: '#D97706' },
  Ring: { fill: '#7f1d1d', border: '#450a0a' }, Unverified: { fill: '#A5ABB6', border: '#8f9e98' },
  CRITICAL: { fill: '#b42318', border: '#7a1610' }, HIGH: { fill: '#F16667', border: '#eb2728' }, MEDIUM: { fill: '#F79767', border: '#f36924' }, LOW: { fill: '#D6D3D1', border: '#A8A29E' },
};

function GraphCanvas({ data, suspect, atRisk, onPick }: { data: Overview; suspect?: string; atRisk: string[]; onPick: (n: { id: string; type: string; label: string; kind?: string }) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy>();
  const pick = useRef(onPick); pick.current = onPick;
  useEffect(() => {
    let alive = true;
    import('cytoscape').then(({ default: cytoscape }) => {
      if (!alive || !box.current) return;
      const ids = new Set(data.nodes.map((n) => n.id));
      cy.current?.destroy();
      cy.current = cytoscape({
        container: box.current,
        elements: [
          ...data.nodes.map((n) => ({ data: { ...n, name: n.type === 'Incident' ? n.label.toLowerCase().replace(/_/g, ' ') : n.label.replace(/ \(.*\)$/, ''), ...NEO[n.type === 'Incident' ? (n.flag ? 'Unverified' : n.level ?? 'LOW') : n.type] }, classes: [n.type, n.id === suspect ? 'suspect' : '', atRisk.includes(n.id) ? 'risk' : ''].join(' ') })),
          ...data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e, i) => ({ data: { id: `e${i}`, source: e.from, target: e.to, type: e.type }, classes: e.type })),
        ],
        style: [
          { selector: 'node', style: { label: 'data(name)', 'font-size': 10, 'font-weight': 700, color: '#fff', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': '70px', 'text-outline-width': 1.5, 'text-outline-color': 'data(border)', width: 58, height: 58, 'border-width': 2, 'border-color': 'data(border)', 'background-color': 'data(fill)' } },
          { selector: '.Asset', style: { width: 64, height: 64 } },
          { selector: '.Asset.suspect', style: { 'border-width': 7, 'border-color': '#f97316', 'background-color': '#f97316', 'text-outline-color': '#c2410c', width: 82, height: 82, 'font-size': 12 } },
          { selector: '.Zone', style: { width: 52, height: 52 } },
          { selector: '.Locality', style: { width: 46, height: 46, 'font-size': 9 } },
          { selector: '.Locality.risk', style: { 'border-color': '#f5a524', 'border-width': 6 } },
          { selector: '.Incident', style: { width: 50, height: 50, 'font-size': 8.5 } },
          { selector: '.Ring', style: { width: 56, height: 56, 'font-size': 8.5 } },
          { selector: 'edge', style: { width: 1.6, 'line-color': '#a5abb6', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#a5abb6', 'arrow-scale': 0.9, 'curve-style': 'bezier', label: 'data(type)', 'font-size': 7, color: '#78716c', 'text-rotation': 'autorotate', 'text-background-color': '#fff', 'text-background-opacity': 1, 'text-background-padding': '1px' } },
          { selector: 'edge.FEEDS, edge.SUPPLIES', style: { width: 3, 'line-color': '#10b981', 'target-arrow-color': '#10b981' } },
          { selector: 'edge.TARGETS', style: { width: 2.4, 'line-color': '#b42318', 'line-style': 'dashed', 'target-arrow-color': '#b42318', color: '#b42318' } },
          { selector: 'node:selected', style: { 'overlay-color': '#047857', 'overlay-opacity': 0.2, 'overlay-padding': 8 } },
        ],
        layout: { name: 'cose', animate: false, padding: 20, idealEdgeLength: () => 34, nodeRepulsion: () => 3200, componentSpacing: 30, nodeOverlap: 6, gravity: 0.9, randomize: false } as never,
        wheelSensitivity: 0.25,
        autoungrabify: true, // nodes stay where the layout put them; drag the background to pan
      });
      cy.current.on('tap', 'node', (e) => { const d = e.target.data(); pick.current({ id: d.id, type: d.type, label: d.label, kind: d.kind }); });
    });
    return () => { alive = false; cy.current?.destroy(); cy.current = undefined; };
  }, [data, suspect, atRisk.join()]);
  return <div className="gwrap"><div ref={box} className="gcanvas" aria-label="Interactive graph of the town" /><button className="gfit" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 20 } }, { duration: 300 })} title="Fit the whole graph"><Maximize size={14} /> Fit</button></div>;
}

/** Rings with the same kind of link and the same targets are shown as one row ("3 rings, 45 accounts"). */
function groupRings(rings: Ring[], targets: { ring: string; incident: string }[]) {
  const groups = new Map<string, { key: string; via: Ring['via']; count: number; accounts: number; incidents: string[] }>();
  for (const r of rings) {
    const incidents = [...new Set(targets.filter((t) => t.ring === r.id).map((t) => t.incident))].sort();
    const key = `${r.via.join('+')}|${incidents.join(',')}`;
    const g = groups.get(key) ?? { key, via: r.via, count: 0, accounts: 0, incidents };
    g.count++; g.accounts += r.accounts.length;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => Number(b.via.includes('CO_REPORTING')) - Number(a.via.includes('CO_REPORTING')) || b.accounts - a.accounts);
}
