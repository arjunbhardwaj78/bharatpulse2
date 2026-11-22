import { ArrowRight, BadgeCheck, Building2, Check, CheckCircle2, Cpu, Database, FileUp, Fingerprint, Globe2, Landmark, Mic, Minus, Network, PhoneCall, PlugZap, ShieldCheck, Sparkles, Timer, Users, Webhook, Wrench, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { api, type CityInfo, type NetworkSummary, type Plan } from './api';
import { CityPicker, CountUp, IndiaMark, LangPicker, Swoosh } from './components';
import { BharatMap, GraphCard, VoiceCard } from './Showcase';
import { makeT, type Lang } from './i18n';


const Ico = ({ children }: { children: ReactNode }) => <svg className="lp-ico" viewBox="0 0 48 48" aria-hidden="true">{children}</svg>;
const STEPS = [
  <Ico key="1"><rect x="5" y="14" width="30" height="24" rx="6" fill="#f97316" /><circle cx="20" cy="26" r="7" fill="#fff" /><path d="M38 6c-5 0-9 4-9 9 0 7 9 16 9 16s9-9 9-16c0-5-4-9-9-9z" fill="#156246" /><circle cx="38" cy="15" r="3.5" fill="#fff" /></Ico>,
  <Ico key="2"><path d="M4 22L44 6 30 42 22 28z" fill="#156246" /><path d="M22 28L44 6" stroke="#fff" strokeWidth="2" /></Ico>,
  <Ico key="3"><rect x="4" y="20" width="26" height="16" rx="3" fill="#f97316" /><path d="M30 24h10l5 7v5H30z" fill="#156246" /><circle cx="14" cy="38" r="5" fill="#156246" /><circle cx="38" cy="38" r="5" fill="#156246" /><circle cx="14" cy="38" r="2" fill="#fff" /><circle cx="38" cy="38" r="2" fill="#fff" /></Ico>,
  <Ico key="4"><path d="M24 3l17 6v13c0 11-8 19-17 23C15 41 7 33 7 22V9z" fill="#138808" /><path d="M16 24l6 6 11-12" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></Ico>,
] as const;
const STEP_KEYS = ['hw1', 'hw2', 'hw3', 'hw4'] as const;

const WHY = [
  { icon: PlugZap, t: 'Your portal stays', p: 'Complaints from CPGRAMS, 1916 or a call centre come in by API or CSV; results go back by webhook.' },
  { icon: ShieldCheck, t: 'Fake complaints stop jumping the queue', p: 'Accounts linked by a phone, a photo or reporting together count as one person.' },
  { icon: Wrench, t: 'Finds the failed pipe, not just the complaint', p: 'Outages are traced up the pipe network to the feeder they share; the next wards are warned.' },
  { icon: Mic, t: 'Every citizen, in their own language', p: 'Speak in any of 22 languages; the officer reads English, the citizen hears updates in theirs.' },
  { icon: BadgeCheck, t: 'Proof before closure', p: 'A checked photo and the citizen confirming it close a job. Missed deadlines escalate.' },
  { icon: Timer, t: 'Live in a day', p: 'Own wards, pipe map, officers and data space. Free 90-day pilot, nothing to install.' },
];

/** Build it yourself vs subscribe. 'no' = cannot be done by one city alone. */
const COMPARE: { what: string; build: string; buildKind: 'yes' | 'cost' | 'no'; us: string }[] = [
  { what: 'Complaint form, tracking, officer workflow', build: 'Doable: a vendor builds it in a few months', buildKind: 'yes', us: 'Live on day one, free 90-day pilot' },
  { what: 'Speech and translation in 22 languages', build: 'AI contracts, model updates and testing, every year', buildKind: 'cost', us: 'Included (Sarvam), shared by every city' },
  { what: 'Fake-report detection on a graph', build: 'Graph database, data scientists, tuning', buildKind: 'cost', us: 'Included (Neo4j), improves with every city' },
  { what: 'Crowds already caught in other towns', build: 'Impossible: one town only sees itself', buildKind: 'no', us: 'Held on their first report here' },
  { what: 'Benchmarks against similar towns', build: 'Impossible without other towns’ data', buildKind: 'no', us: 'Live, others anonymised' },
  { what: 'Security audits, updates, uptime', build: 'Your IT cell, if you have one', buildKind: 'cost', us: 'Ours, for every city at once' },
];

/** India with every city on the platform, and the routes the network has stopped crowds on. */
function NetworkMap({ cities, net }: { cities: CityInfo[]; net?: NetworkSummary }) {
  const p = (c: { lat: number; lng: number }) => ({ x: ((c.lng - 68) / 30) * 100, y: ((37 - c.lat) / 31) * 104 });
  const at = new Map(cities.map((c) => [c.name, p(c.center)]));
  const routes = (net?.crowds ?? []).flatMap((c) => c.seenIn.map((to) => [at.get(c.origin), at.get(to)] as const)).filter((r): r is readonly [{ x: number; y: number }, { x: number; y: number }] => !!r[0] && !!r[1]);
  return (
    <svg className="netmap" viewBox="0 0 100 104" role="img" aria-label="Cities on the BharatPulse network">
      <defs><radialGradient id="nm-dot"><stop offset="0" stopColor="#ffd2b0" /><stop offset="1" stopColor="#f97316" stopOpacity="0" /></radialGradient></defs>
      <path d="M40 2L47 4 52 10 50 17 57 22 64 24 66 29 74 31 82 30 90 33 96 32 97 37 90 40 85 38 80 41 74 40 68 43 66 48 62 53 62 60 58 68 55 78 52 90 50 98 47 90 43 79 38 69 33 62 28 55 22 53 16 50 8 48 6 43 12 40 20 40 18 36 22 31 29 28 30 22 36 17 36 9Z" className="nm-land" />
      {routes.map(([a, b], i) => { const mx = (a.x + b.x) / 2; const my = Math.min(a.y, b.y) - 8; return <path key={i} className="nm-route" d={`M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`} />; })}
      {cities.map((c) => { const q = p(c.center); return <g key={c.id}><circle cx={q.x} cy={q.y} r="4" fill="url(#nm-dot)" className="nm-pulse" /><circle cx={q.x} cy={q.y} r="1.1" className={`nm-city ${c.kind}`} /><text x={q.x + 2} y={q.y - 1.6} className="nm-label">{c.name.replace(/ Nagar Palika| Municipal.*$/i, '')}</text></g>; })}
    </svg>
  );
}

function FlowDiagram() {
  const src = [[FileUp, 'CPGRAMS / state portal export'], [PhoneCall, 'Call centre & 1916 helpline'], [Globe2, 'Existing city website'], [Users, 'BharatPulse citizen app']] as const;
  const out = [[Landmark, 'Officer board with SLAs'], [Webhook, 'Results back to your portal'], [Network, 'Ward warnings before they call'], [Database, 'Commissioner reports']] as const;
  return (
    <div className="flow">
      <div className="flow-col">{src.map(([I, t]) => <div key={t} className="flow-item"><I size={18} />{t}</div>)}</div>
      <div className="flow-arrows" aria-hidden="true"><i /><i /><i /></div>
      <div className="flow-core">
        <b>BharatPulse intelligence layer</b>
        <div className="core-row"><span className="tech neo"><Network size={16} /> Neo4j graph</span><span>rings · root cause · downstream · cross-city</span></div>
        <div className="core-row"><span className="tech sarvam"><Sparkles size={16} /> Sarvam AI</span><span>22 languages · English for officers · voice</span></div>
        <div className="core-row"><span className="tech eng"><Cpu size={16} /> Trust engine</span><span>independent sources · severity · SLA</span></div>
      </div>
      <div className="flow-arrows" aria-hidden="true"><i /><i /><i /></div>
      <div className="flow-col">{out.map(([I, t]) => <div key={t} className="flow-item out"><I size={18} />{t}</div>)}</div>
    </div>
  );
}

const scrollTo = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); };

/** little four-point sparkles around the India emblem: x%, y%, size px, delay s */
const SPARKS: [number, number, number, number][] = [[4, 10, 18, 0], [88, 4, 14, 0.8], [96, 52, 20, 1.6], [12, 78, 12, 2.2], [60, -4, 10, 1.1], [-2, 44, 10, 2.8], [78, 86, 12, 0.4]];

export function Home({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = makeT(lang);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>>>();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [cities, setCities] = useState<CityInfo[]>([]);
  const [net, setNet] = useState<NetworkSummary>();
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>>>();
  const load = () => {
    api.stats().then(setStats).catch(() => undefined); api.cities().then(setCities).catch(() => undefined); api.network().then(setNet).catch(() => undefined);
    api.health().then(setHealth).catch(() => undefined);
  };
  useEffect(() => { load(); api.plans().then(setPlans).catch(() => undefined); }, []);


  return (
    <div className="site lp-theme">
      <section className="lp">
        <div className="lp-top">
          <a href="#build" onClick={scrollTo('build')}>Why us</a><a href="#network" onClick={scrollTo('network')}>Network</a><a href="#pricing" onClick={scrollTo('pricing')}>Pricing</a>
          <CityPicker onChange={load} /><LangPicker lang={lang} setLang={setLang} className="lp-lang-btn" /><a className="btn orange sm" href="#/onboard">Start a pilot</a>
        </div>
        <div className="lp-left">
          <div className="lp-brand fade">
            <div className="lp-emblem-wrap" aria-hidden="true">
              <span className="lp-glow" />
              {SPARKS.map(([x, y, sz, d], i) => <svg key={i} className="spark" style={{ left: `${x}%`, top: `${y}%`, width: sz, height: sz, animationDelay: `${d}s` }} viewBox="0 0 24 24"><path d="M12 0C13 7 17 11 24 12C17 13 13 17 12 24C11 17 7 13 0 12C7 11 11 7 12 0Z" /></svg>)}
              <BharatMap className="lp-emblem" />
            </div>
            <div className="lp-word">
              <p className="welcome">{t('welcome')}</p>
              <h1 className="brand"><span className="b1">Bharat</span><span className="b2">Pulse</span></h1>
              <Swoosh />
            </div>
          </div>
          <div className="lp-copy fade d1">
            <h2>{t('heroT1')}<br /><span>{t('heroT2')}</span></h2>
            <p>{t('heroSub')}</p>
          </div>
          <div className="lp-entries fade d2">
            <a className="lp-entry" href="#/citizen"><span className="pico"><Users size={32} /></span><span className="ptxt"><b>{t('citizenWord')}</b><small>{t('subCitizen')}</small></span><span className="parrow"><ArrowRight size={22} /></span></a>
            <a className="lp-entry officer" href="#/officer"><span className="pico"><Landmark size={32} /></span><span className="ptxt"><b>{t('officerWord')}</b><small>{t('subOfficer')}</small></span><span className="parrow"><ArrowRight size={22} /></span></a>
          </div>
          <a className="lp-area fade d2" href="#/community">{t('communityLink')} <ArrowRight size={15} /></a>
          <div className="lp-how fade d3">
            <h3>{t('hiw')}</h3>
            <div className="lp-steps">{STEP_KEYS.map((k, n) => <div key={k} className="lp-step">{STEPS[n]}<span>{t(k)}</span></div>)}</div>
          </div>
        </div>
        <div className="lp-right">
          <div className="fade d1"><GraphCard live={health?.graph === 'neo4j'} t={t} /></div>
          <div className="fade d2"><VoiceCard lang={lang} setLang={setLang} sarvam={!!health?.sarvam?.enabled} t={t} /></div>
          <div className="lp-card lp-live fade d3">
            <div className="grow"><b>{t('liveStatus')}</b><small>{t('liveSub')}</small></div>
            <div><b><CountUp value={stats?.open ?? 0} /></b><small>{t('nOpen')}</small></div>
            <div><b><CountUp value={stats?.needsVerification ?? 0} /></b><small>{t('nWaiting')}</small></div>
            <div><b>{stats?.avgHoursToResolve ? `${stats.avgHoursToResolve}h` : '–'}</b><small>{t('nAvg')}</small></div>
            {net && net.heldOnFirstReport > 0
              ? <div><b><CountUp value={net.heldOnFirstReport} /></b><small>{t('nHeld')}</small></div>
              : <div><b><CountUp value={net?.cities ?? 0} /></b><small>{t('nTowns')}</small></div>}
          </div>
        </div>
      </section>

      <section className="band" id="build">
        <div className="bwrap">
          <p className="kicker">"Why not build our own?"</p>
          <h2>A city can build a form. Not the network behind it.</h2>
          <div className="compare">
            <div className="cmp-head"><span /><span><Building2 size={16} /> Build it yourself</span><span className="us"><IndiaMark size={16} /> On BharatPulse</span></div>
            {COMPARE.map((r) => (
              <div key={r.what} className="cmp-row">
                <b>{r.what}</b>
                <span className={`cmp-build ${r.buildKind}`}>{r.buildKind === 'yes' ? <Check size={16} /> : r.buildKind === 'no' ? <X size={16} /> : <Minus size={16} />}{r.build}</span>
                <span className="cmp-us"><CheckCircle2 size={16} />{r.us}</span>
              </div>
            ))}
          </div>
          <p className="cmp-note">Built for the 4,000+ Nagar Palikas and Panchayats with no software team. Bought on GeM; they keep their portal.</p>
        </div>
      </section>

      <section className="band net-band" id="network">
        <div className="bwrap net-wrap">
          <div>
            <p className="kicker">The network effect</p>
            <h2>Caught once, held everywhere.</h2>
            <p className="lead">A hired crowd caught in one town is held on its first report in every other town. Only one-way fingerprints are shared: no numbers, text, photos or locations.</p>
            <div className="net-figs">
              <div><b><CountUp value={net?.cities ?? cities.length} /></b><span>cities on the network</span></div>
              <div><b><CountUp value={net?.watchedAccounts ?? 0} /></b><span>accounts on the watchlist</span></div>
              <div className="hot"><b><CountUp value={net?.heldOnFirstReport ?? 0} /></b><span>reports held on first try in a new city</span></div>
            </div>
            {net?.crowds[0] ? <p className="net-last"><Fingerprint size={16} /> Latest: a crowd of {net.crowds[0].size} accounts first caught in <b>{net.crowds[0].origin}</b> was held in <b>{net.crowds[0].seenIn.join(', ')}</b>.</p> : <p className="net-last muted"><Fingerprint size={16} /> Try it: sign in to a second city as its head of department and open <b>Network</b>.</p>}
          </div>
          <NetworkMap cities={cities} net={net} />
        </div>
      </section>

      <section className="band" id="plug">
        <div className="bwrap">
          <p className="kicker">Why a city with a portal still needs this</p>
          <h2>Your portal collects complaints. We tell you which are real and where the fault is.</h2>
          <FlowDiagram />
        </div>
      </section>

      <section className="band light" id="why">
        <div className="bwrap">
          <p className="kicker">For governments and private operators</p>
          <h2>Municipalities, utilities, toll roads, industrial parks and campuses. One platform.</h2>
          <div className="whygrid">{WHY.map(({ icon: I, t: title, p }) => <div key={title} className="why-card"><span className="why-ico"><I size={22} /></span><b>{title}</b><p>{p}</p></div>)}</div>
        </div>
      </section>

      <section className="band" id="tech">
        <div className="bwrap techgrid">
          <div className="tech-card neo">
            <span className="tag"><Network size={15} /> Neo4j</span>
            <h3>The graph decides what is real and where to send the crew</h3>
            <ul>
              <li><CheckCircle2 size={16} /> Fake-report rings from shared phones, photos and <b>accounts that travel together</b>; a ring counts as one person</li>
              <li><CheckCircle2 size={16} /> Root cause: outages traced <b>up the pipe network</b>, at-risk wards warned</li>
              <li><CheckCircle2 size={16} /> One database, many cities, and <b>one query across all of them</b> for crowds that move between towns</li>
            </ul>
            <div className="metric"><b>0/5 → 5/5</b><span>hired crowds caught, without → with the graph</span></div>
          </div>
          <div className="tech-card sarvam">
            <span className="tag"><Sparkles size={15} /> Sarvam AI</span>
            <h3>Anyone can report; every officer can read it</h3>
            <ul>
              <li><CheckCircle2 size={16} /> Speech in <b>22 Indian languages</b> (Saaras) fills the form</li>
              <li><CheckCircle2 size={16} /> English for every complaint (Sarvam-Translate); the app itself in 11 languages</li>
              <li><CheckCircle2 size={16} /> <b>Ask BharatPulse</b> in any language: Sarvam-105B picks a graph question, Neo4j answers, Bulbul reads it aloud</li>
            </ul>
            <div className="metric"><b>22</b><span>languages a complaint can be spoken in</span></div>
          </div>
        </div>
      </section>

      <section className="band light" id="pricing">
        <div className="bwrap">
          <p className="kicker">Pricing (pilot hypothesis)</p>
          <h2>Start free. Pay per ward when it works.</h2>
          <div className="plans">{plans.map((p) => (
            <div key={p.id} className={`plan ${p.id === 'town' ? 'pop' : ''}`}>
              {p.id === 'town' && <span className="pop-tag">Most towns</span>}
              <b>{p.name}</b><span className="price">{p.price}</span><p>{p.blurb}</p>
              <ul>{p.includes.map((x) => <li key={x}><CheckCircle2 size={15} /> {x}</li>)}</ul>
              <a className={`btn ${p.id === 'town' ? 'orange' : ''}`} href={`#/onboard?plan=${p.id}`}>{p.id === 'connect' ? 'Connect your portal' : 'Start with this'}</a>
            </div>
          ))}</div>
        </div>
      </section>

      <section className="cta-band">
        <div className="bwrap cta-in">
          <Building2 size={36} />
          <h2>Bring your town on in a minute</h2>
          <p>Pick your town, choose wards, get officer accounts and an API key. Free for 90 days.</p>
          <a className="btn orange lg" href="#/onboard">Start a free 90-day pilot <ArrowRight size={18} /></a>
        </div>
      </section>
      <footer className="sfoot"><span>BharatPulse · civic intelligence for Indian cities</span><span>Built on Neo4j and Sarvam AI · All demo data is synthetic</span></footer>
    </div>
  );
}
