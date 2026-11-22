import { ArrowRight, Building2, Check, Clock, Code2, Factory, Fingerprint, Loader2, Play, ShieldCheck, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ctx, type Benchmarks, type Incident, type NetworkSummary, type Referral } from './api';
import { CountUp, toast } from './components';

/**
 * What a city gets from being on a shared platform, that it cannot build alone:
 *  1. a fraud watchlist fed by every city (a hired crowd caught once is held everywhere, from its first report)
 *  2. benchmarks against similar towns (others anonymised)
 */
export function NetworkPanel({ cityId, cityName, canRun, onOpen }: { cityId: string; cityName?: string; canRun: boolean; onOpen: (id: string) => void }) {
  const [net, setNet] = useState<NetworkSummary>();
  const [bench, setBench] = useState<Benchmarks>();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ward: string; inc?: Incident }>();
  const [refs, setRefs] = useState<{ incoming: Referral[]; outgoing: Referral[]; fedBy?: { tenant: string; name: string; asset: string } }>();
  const load = () => { api.network().then(setNet).catch(() => undefined); api.benchmarks().then(setBench).catch(() => undefined); api.referrals().then(setRefs).catch(() => undefined); };
  useEffect(load, []);
  const demo = cityId === 'demo';

  async function simulate() {
    setBusy(true);
    try {
      const r = await api.simulateNetwork();
      setNet(r.network);
      setLast({ ward: r.ward, inc: r.incidents.sort((a, b) => b.complaintCount - a.complaintCount)[0] });
      api.benchmarks().then(setBench).catch(() => undefined);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }

  const hours = (h: number | null) => (h === null ? '–' : `${h}h`);
  const rows: { k: keyof Benchmarks['median']; label: string; fmt: (v: number | null) => string; better: 'low' | 'high' | 'none' }[] = [
    { k: 'avgHoursToResolve', label: 'Average time to fix', fmt: (v) => hours(v), better: 'low' },
    { k: 'open', label: 'Open incidents', fmt: (v) => String(v ?? '–'), better: 'low' },
    { k: 'heldShare', label: 'Share held as possibly fake', fmt: (v) => `${Math.round((v ?? 0) * 100)}%`, better: 'none' },
    { k: 'slaAtRisk', label: 'Deadlines at risk', fmt: (v) => String(v ?? '–'), better: 'low' },
  ];

  return (
    <div className="netpage">
      <section className="net-hero fade">
        <div>
          <p className="kicker">Only on a shared platform</p>
          <h2>A crowd caught once is held everywhere, from its first report.</h2>
          <p>Every city on BharatPulse adds the fake-report rings its graph finds to one watchlist. Accounts are shared only as one-way fingerprints (an HMAC of the phone made with the platform key), never as numbers, names, text or photos. A city building its own system starts with an empty list.</p>
        </div>
        <div className="net-stats">
          <div><b><CountUp value={net?.cities ?? 0} /></b><span>cities on the network</span></div>
          <div><b><CountUp value={net?.watchedAccounts ?? 0} /></b><span>accounts on the watchlist</span></div>
          <div><b><CountUp value={net?.crossCityAccounts ?? 0} /></b><span>seen in more than one city</span></div>
          <div className="hot"><b><CountUp value={net?.heldOnFirstReport ?? 0} /></b><span>reports held on the first try</span></div>
        </div>
      </section>

      <div className="net-grid">
        <section className="card fade d1">
          <h3><Fingerprint size={18} /> Crowds the network stopped</h3>
          {!net ? <p className="muted small">Loading…</p> : net.crowds.length === 0 ? <p className="muted small">None yet. When a ring caught in one city reports in another, it shows here.</p> : (
            <ul className="crowds">{net.crowds.map((c, i) => (
              <li key={i}><span className="cr-from"><Building2 size={15} /> {c.origin}</span><ArrowRight size={16} className="cr-arrow" /><span className="cr-to">{c.seenIn.join(', ')}</span><small>{c.size} linked accounts ({c.via.map((v) => v.toLowerCase().replace('_', '-')).join(', ')}) · {c.heldReports} reports held as one source</small></li>
            ))}</ul>
          )}
          {canRun && !demo && (
            <div className="sim">
              <p className="small"><b>Try it:</b> 10 accounts that faked outages in the demo town now report a water outage here. {cityName ?? 'This city'} has no evidence against them of its own.</p>
              <button className="btn orange" disabled={busy} onClick={simulate}>{busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />} Simulate the crowd arriving</button>
            </div>
          )}
          {demo && <p className="muted small" style={{ marginTop: 10 }}>The demo town is where this crowd was first caught. Sign in to a second city (Start a pilot on the home page) and run the simulation there.</p>}
          {last?.inc && (
            <button className="sim-out fade" onClick={() => onOpen(last.inc!.id)}>
              <ShieldCheck size={22} />
              <span><b>Held on the first report in {last.ward}</b><small>{last.inc.complaintCount} reports → {last.inc.trust.independentSources} independent source{last.inc.trust.independentSources === 1 ? '' : 's'} · {last.inc.trust.needsVerification ? 'sent for a site check, not to the crew' : 'not held'}</small></span>
              <ArrowRight size={18} />
            </button>
          )}
          {net && (
            <details className="cypher"><summary><Code2 size={14} /> The cross-city graph query ({net.engine === 'neo4j' ? 'runs on Neo4j' : 'runs when Neo4j is connected'})</summary><pre>{net.cypher}</pre>{net.graphCrossCity !== undefined && <p className="small muted">Neo4j found {net.graphCrossCity} account(s) reporting in more than one city.</p>}</details>
          )}
        </section>

        <section className="card fade d2">
          <h3><Users size={18} /> {bench?.you.name ?? 'Your city'} against other towns</h3>
          <p className="muted small">{bench?.note ?? ''} Live numbers from every city on the platform.</p>
          {bench && (
            <div className="bench">
              {rows.map((r) => {
                const you = bench.you[r.k] as number | null;
                const med = bench.median[r.k] as number | null;
                const all = [you ?? 0, med ?? 0, ...bench.peers.map((p) => (p[r.k] as number | null) ?? 0)];
                const max = Math.max(1e-9, ...all);
                const verdict = r.better === 'none' ? { cls: 'note', text: 'higher means more fake reports caught' } : you === null || med === null ? { cls: 'note', text: 'not enough data yet' } : (r.better === 'low' ? you <= med : you >= med) ? { cls: 'good', text: 'at or better than median' } : { cls: 'bad', text: 'behind the median' };
                return (
                  <div key={r.k} className="brow">
                    <span className="blabel">{r.label}</span>
                    <div className="bbars">
                      <div className="bbar you" style={{ ['--w' as string]: `${((you ?? 0) / max) * 100}%` }}><i /><b>{r.fmt(you)}</b><small>you</small></div>
                      <div className="bbar med" style={{ ['--w' as string]: `${((med ?? 0) / max) * 100}%` }}><i /><b>{r.fmt(med)}</b><small>median</small></div>
                    </div>
                    <span className={`bverdict ${verdict.cls}`}>{verdict.text}</span>
                  </div>
                );
              })}
              {bench.peers.length > 0 && <p className="muted small"><Clock size={13} style={{ verticalAlign: -2 }} /> Compared with {bench.peers.map((p) => p.label).join(', ')}.</p>}
            </div>
          )}
        </section>
      </div>
      <section className="card fade d3 partners">
        <h3><Factory size={18} /> Partner organisations</h3>
        <p className="muted small">Private operators (industrial parks, utilities, toll roads, campuses) run their own workspace. When a site takes its water from a city pipe and agrees to share, a confirmed outage there is referred here, at that pipe, as one report. Only the referral crosses, never the reports behind it.</p>
        {refs?.fedBy && <p className="fedby">Your water comes from <b>{refs.fedBy.name}</b>, {refs.fedBy.asset}. Confirmed outages here are referred to them.</p>}
        {!refs || (refs.incoming.length === 0 && refs.outgoing.length === 0) ? <p className="muted small">No referrals yet. {canRun ? 'Add the demo partners in Sample data to see one.' : ''}</p> : (
          <ul className="refs">
            {refs.incoming.map((r) => (
              <li key={r.id} className={r.status}>
                <span className="rtag in">Referred to you</span>
                <b>{r.fromName}: {r.what.toLowerCase()}</b>
                <small>Fed by {r.assetName} · {r.reports} reports from {r.people} people on site · {new Date(r.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                {r.status === 'open' ? <button className="btn sm primary" onClick={() => api.ackReferral(r.id).then(load).catch((e: Error) => toast(e.message, true))}><Check size={15} /> Acknowledge</button> : <span className="ok small"><Check size={14} /> Acknowledged</span>}
              </li>
            ))}
            {refs.outgoing.map((r) => (
              <li key={r.id} className={r.status}>
                <span className="rtag out">Referred by you</span>
                <b>To {r.toName}, at {r.assetName}</b>
                <small>{r.reports} reports from {r.people} people · {r.status === 'acknowledged' ? 'they have acknowledged it' : 'waiting for them to acknowledge'}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted small">Signed in to {ctx.city}. The watchlist never shares complaint text, photos, locations or phone numbers between cities.</p>
    </div>
  );
}
