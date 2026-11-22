import { ArrowLeft, Box, ChevronDown, Maximize2, Minimize2, Factory, Share2, Building2, Camera as CamIcon, ClipboardCheck, Clock, Construction, Database, Droplets, Eye, Globe, Inbox, Landmark, LayoutGrid, Languages, LogOut, Map as MapIcon, MapPin, Megaphone, Network, RotateCcw, Send, ShieldAlert, Sparkles, Stamp, Trash2, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ctx, type AssetImpact, type City, type Health, type Incident, type Notice, type Officer as OfficerT, type Report, type RiskZone, type Role, type Rules, type Voice } from './api';
import { CameraModal } from './Camera';
import { CityPicker, Logo, toast, Twin } from './components';
import { NetworkPanel } from './Network';
import { GraphCard } from './Showcase';
import { CityConsole } from './Console';
import { GraphView } from './Graph';
import { GraphPage } from './GraphPage';
import { makeT, nameOfBcp, type Key } from './i18n';
import { IncidentMap } from './MapView';
import { PhotoView } from './PhotoView';
import { photoToBase64 } from './photo';
import { speakText } from './voice';
import { actionsFor, ageText, dueText, forwardInfo, haversine, inTab, isDone, LEVEL_COLOR, levelRole, phaseOf, reasons, ROLE_LABEL, signalSummary, stepsDone, STAGE_WORDS, topIssue, VERIFY_COLOR, zoneIdOf, type Phase, type Tab } from './util';

const en = makeT('en');
const issue = (i: Incident) => en(topIssue(i) as Key);
const ROLES: { role: Role; id: string; icon: typeof Eye; blurb: string }[] = [
  { role: 'L1', id: 'field1', icon: ClipboardCheck, blurb: 'Check on site, upload proof' },
  { role: 'L2', id: 'zonal1', icon: Stamp, blurb: 'Approve and assign crews' },
  { role: 'L3', id: 'head1', icon: Landmark, blurb: 'Decide objections, oversee' },
  { role: 'L4', id: 'commissioner1', icon: Eye, blurb: 'View only' },
];
const PHASES: { key: Phase; title: string; hint: string; color: string }[] = [
  { key: 'new', title: 'New', hint: 'Check and approve', color: '#EA580C' },
  { key: 'working', title: 'Working', hint: 'Crew on the job', color: '#f5a524' },
  { key: 'check', title: 'Fix check', hint: 'Photo needs a senior check', color: '#BE123C' },
  { key: 'done', title: 'Done', hint: 'Fixed and closed', color: '#047857' },
];
const FILTERS: [Tab, string][] = [['all', 'All'], ['mine', 'Needs my action'], ['urgent', 'Urgent'], ['verify', 'Not confirmed'], ['forwarded', 'Forwarded to me']];
const STEP_NAMES = ['Reported', 'Site check', 'Approved', 'Crew assigned', 'Working', 'Fix photo', 'Photo checked', 'Confirmed'];
const LABEL: Record<string, string> = { verify: 'Site check done', approve: 'Approve', assign: 'Assign a crew', start: 'Start work', resolve: 'Send fix photo for checking', 'approve-proof': 'Photo is correct: approve', 'reject-proof': 'Photo is not correct: send back', reject: 'Reject as not valid', 'approve-rejection': 'Confirm the rejection', 'send-back': 'Send back', close: 'Close', reopen: 'Reopen' };
const CITIZEN_ONLY = ['confirm', 'dispute'];
const SIGNAL: Record<string, string> = { GPS_MATCH: 'Reported from the area', GPS_FAR: 'Reported from far away', PAST_CONFIRMED: 'Reporter has a confirmed past report', PAST_LOST_DISPUTE: 'Reporter lost a past dispute', DEVICE_SHARED: 'Same phone behind 3+ accounts', IP_SHARED: 'Same network behind 4+ accounts', PHOTO_REUSED: 'Photo reused by another account', PHOTO_REUSED_ELSEWHERE: 'Photo seen at another place', EXIF_MATCH: 'Photo time matches', EXIF_MISMATCH: 'Photo time does not match', TEXT_DUPLICATE: 'Near-identical wording', NEW_ACCOUNT_BURST: 'Burst of brand-new accounts', TOO_FAST: 'Submitted unusually fast', CORROBORATED: 'Backed by 3+ independent groups', GRAPH_RING: 'Account is in a ring of linked accounts (graph)', NETWORK_RING: 'Account was caught in a fake-report ring in another city (network)' };
/** Not confirmed AND most reports look fake, or the graph tied the accounts together: say it plainly. */
const likelyFake = (i: Incident) => i.trust.needsVerification && (i.trust.bands.LIKELY_FAKE * 2 >= i.trust.rawReports || i.trust.authenticity.some((a) => a.signals.some((x) => x.code === 'GRAPH_RING' || x.code === 'NETWORK_RING' || x.code === 'DEVICE_SHARED' || x.code.startsWith('PHOTO_REUSED'))));
const color = (i: Incident) => (likelyFake(i) ? '#b42318' : i.trust.needsVerification ? VERIFY_COLOR : LEVEL_COLOR[i.severity.level]);
const levelWord = (i: Incident) => (likelyFake(i) ? 'Likely fake' : i.trust.needsVerification ? 'Not confirmed' : i.severity.level[0] + i.severity.level.slice(1).toLowerCase());
const whereOf = (pt: { lat: number; lng: number }, city?: City) => (city ? [...city.localities].sort((a, b) => haversine(pt, a) - haversine(pt, b))[0]?.name : undefined);
const lastAction = (i: Incident) => Math.max(...(i.workflow?.audit ?? [{ at: i.lastReportedAt }]).map((a) => a.at));
const goHome = () => { location.hash = '#/'; };

export function Officer() {
  const [me, setMe] = useState<OfficerT | null>(ctx.officer);
  const logout = useCallback(() => { api.officerLogout(); setMe(null); goHome(); }, []);
  return me ? <Dashboard me={me} onLogout={logout} /> : <OfficerLogin onDone={() => setMe(ctx.officer)} />;
}

function OfficerLogin({ onDone }: { onDone: () => void }) {
  const last = (() => { try { return JSON.parse(localStorage.getItem('bp_officer_last') ?? 'null') as { id: string; role: Role } | null; } catch { return null; } })();
  const [id, setId] = useState(last?.id ?? '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = (r: (typeof ROLES)[number]) => { setId(r.id); setErr(''); };
  async function submit() {
    setBusy(true); setErr('');
    try { await api.officerLogin(id.trim(), password); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="ologin">
      <div className="left">
        <div className="blob a" /><div className="blob b" />
        <div style={{ position: 'relative', display: 'grid', gap: 18 }}>
          <button className="backlink light" onClick={goHome}><ArrowLeft size={18} /> Back to home</button>
          <Logo dark />
          <h1 className="fade">Know which reports are real, and act on them first.</h1>
          <p className="fade d1">Every incident shows how many different people reported it, whether those reports can be trusted, where the water network failed, and who must act next.</p>
          <div className="ol-facts fade d2">
            <span><b className="ttag neo">Neo4j</b> Fake-report rings and the failed pipe, with the Cypher shown</span>
            <span><b className="ttag sarvam">Sarvam AI</b> Every complaint in English, the citizen's words beside it</span>
          </div>
          <div className="fade d2"><GraphCard compact /></div>
        </div>
      </div>
      <div className="right">
        <div className="box fade">
          <h2 style={{ fontSize: 26 }}>Officer sign in</h2>
          <p className="muted" style={{ margin: '6px 0 14px' }}>Choose your city. Your level comes with your account.</p>
          <div className="stack">
            <label className="field">City<span><CityPicker /></span></label>
            <label className="field">Officer ID<input value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" placeholder="e.g. zonal1" /></label>
            <label className="field">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
            {err && <p className="error small">{err}</p>}
            <button className="btn primary lg" disabled={busy || !password || !id.trim()} onClick={submit}>Sign in</button>
            <details className="small muted"><summary style={{ cursor: 'pointer' }}>Demo accounts (one per level)</summary>
              <div className="roles" style={{ marginTop: 10 }}>{ROLES.map((r) => <button key={r.role} className={`role ${id === r.id ? 'on' : ''}`} onClick={() => pick(r)}><r.icon size={20} color="var(--blue)" /><b>{ROLE_LABEL[r.role]}</b><span>{r.id} · {r.blurb}</span></button>)}</div>
              <p style={{ marginTop: 6 }}>The password is set by the server (OFFICER_PASSWORD); locally it is officer@123.</p>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}


type View = 'board' | 'twin' | 'network' | 'graph' | 'map' | 'reports' | 'notices' | 'account' | 'data';

function Dashboard({ me, onLogout }: { me: OfficerT; onLogout: () => void }) {
  const [view, setView] = useState<View>('board');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [risk, setRisk] = useState<RiskZone[]>([]);
  const [rules, setRules] = useState<Rules>({});
  const [city, setCity] = useState<City>();
  const [health, setHealth] = useState<Health>();
  const [filter, setFilter] = useState<Tab>(me.role === 'L1' ? 'mine' : 'all');
  const [avgH, setAvgH] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string>();
  const [zone, setZone] = useState<string>();
  const [focus, setFocus] = useState<{ lat: number; lng: number; zoom?: number }>();
  const [now, setNow] = useState(Date.now());
  const [loaded, setLoaded] = useState(false);
  const role = me.role;

  const refresh = useCallback(async () => {
    try {
      const [i, r, z] = await Promise.all([api.incidents(true), api.pending(), api.risk().catch(() => [] as RiskZone[])]);
      setIncidents(i); setReports(r); setRisk(z); setNow(Date.now()); setLoaded(true);
    } catch (e) { if ((e as { status?: number }).status === 401) onLogout(); }
  }, [onLogout]);
  useEffect(() => { api.rules().then(setRules).catch(() => undefined); api.city().then(setCity).catch(() => undefined); api.health().then(setHealth).catch(() => undefined); api.stats().then((s) => setAvgH(s.avgHoursToResolve ?? null)).catch(() => undefined); refresh(); const h = setInterval(refresh, 5000); const tick = setInterval(() => setNow(Date.now()), 30_000); return () => { clearInterval(h); clearInterval(tick); }; }, [refresh]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpenId(undefined); setZone(undefined); } }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);

  const count = (t: Tab) => incidents.filter((i) => inTab(i, t, role, rules)).length;
  const shown = useMemo(() => incidents.filter((i) => inTab(i, filter, role, rules)), [incidents, filter, role, rules]);
  const open = incidents.find((i) => i.id === openId);
  const empty = loaded && incidents.length === 0 && reports.length === 0;
  const urgent = count('urgent');
  const goMap = (pt: { lat: number; lng: number }) => { setFocus({ ...pt, zoom: 16 }); setOpenId(undefined); setZone(undefined); setView('map'); };

  const nav: [View, string, typeof Eye, number?][] = [['board', 'Board', LayoutGrid, count('mine')], ['twin', 'City twin (3D)', Box], ['graph', 'Graph & Ask', Network], ['network', 'Network', Share2], ['map', 'Map', MapIcon], ['reports', 'New reports', Inbox, reports.length], ['notices', 'Notices', Megaphone], ...((role === 'L3' || role === 'L4') ? [['account', 'City account', Building2] as [View, string, typeof Eye]] : []), ['data', 'Sample data', Database]];
  return (
    <div className="shell">
      <aside className="side">
        <Logo />
        <p className="side-city">{city?.name ?? ''}</p>
        {nav.filter(([v]) => v !== 'data' || health?.admin !== 'off').map(([v, label, Icon, n]) => <button key={v} className={`nav-i ${view === v ? 'on' : ''}`} onClick={() => setView(v)}><Icon size={19} />{label}{!!n && <span className="count">{n}</span>}</button>)}
        <div className="grow" />
        <a className="nav-i" href="#/community" onClick={() => sessionStorage.setItem('bp_back', '#/officer')} style={{ textDecoration: 'none' }}><Globe size={19} />Public page</a>
        <button className="nav-i" onClick={onLogout}><LogOut size={19} />Sign out</button>
      </aside>

      <main className="main">
        <div className="ohead">
          <div><h1>{{ board: 'Incidents', twin: 'City twin', network: 'Across the platform', graph: 'Graph insights', map: 'Map', reports: 'New reports', notices: 'Planned work notices', account: 'City account', data: 'Sample data' }[view]}</h1><p className="muted small"><span className="live" />Live · {new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div>
          <div className="row wrap">
            {view === 'board' && <><span className="stat" style={{ ['--c' as string]: '#e5484d' }}><b>{count('mine')}</b> need you</span><span className="stat" style={{ ['--c' as string]: '#f5a524' }}><b>{urgent}</b> urgent</span><span className="stat" style={{ ['--c' as string]: '#047857' }}><b>{reports.length}</b> new reports</span></>}
            <div className="who"><span className="av">{me.name[0]}</span><div><b style={{ fontSize: 14 }}>{me.name}</b><p className="muted small">{(me as { office?: string }).office && me.name !== ROLE_LABEL[role] && !/Nagar Palika/.test((me as { office?: string }).office ?? '') ? (me as { office?: string }).office : ROLE_LABEL[role]}</p></div></div>
          </div>
        </div>

        {empty && view !== 'data' && view !== 'account' && (
          <section className="card empty fade"><span className="big"><Sparkles /></span><h2>Nothing reported yet</h2><p className="muted">Citizen reports will appear here as they arrive. To see how it works right now, load the sample town.</p>{health?.admin !== 'off' && <button className="btn primary" onClick={() => setView('data')}>Open sample data</button>}</section>
        )}

        {view === 'board' && !empty && (
          <>
            <div className="kpis fade">
              <div className="kpi"><b>{avgH ?? '–'}{avgH !== null && 'h'}</b><span>Avg. resolution time</span></div>
              <div className="kpi"><b>{incidents.length ? Math.round((100 * incidents.filter((i) => !(i.workflow?.audit ?? []).some((a) => a.action === 'sla-breach')).length) / incidents.length) : 100}%</b><span>SLA compliance</span></div>
              <div className="kpi"><b>{incidents.filter((i) => (i.workflow?.audit ?? []).some((a) => a.action === 'reopen')).length}</b><span>Reopened</span></div>
              <div className="kpi accent"><b>{count('mine')}</b><span>{role === 'L1' ? 'Jobs for you' : 'Need your action'}</span></div>
            </div>
            {risk.length > 0 && (
              <div className="watchrow fade">
                <span className="small"><ShieldAlert size={16} style={{ verticalAlign: -3 }} /> <b>May need attention soon</b></span>
                {risk.map((z) => <button key={z.zone} className="zonechip" style={{ ['--c' as string]: z.level === 'HIGH' ? 'var(--red)' : 'var(--amber)' }} onClick={() => { setOpenId(undefined); setZone(z.zone); }}><i />{z.name}</button>)}
              </div>
            )}
            <div className="chips">{FILTERS.map(([k, label]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label} {count(k)}</button>)}</div>
            <div className={`board ${role === 'L1' ? 'queue' : ''}`}>
              {PHASES.map((ph) => {
                const col = shown.filter((i) => phaseOf(i.workflow?.stage ?? 'REPORTED') === ph.key).sort((a, b) => (ph.key === 'done' ? lastAction(b) - lastAction(a) : b.severity.score - a.severity.score));
                const rows = ph.key === 'done' ? col.slice(0, 6) : col;
                return (
                  <section key={ph.key} className="col" style={{ ['--c' as string]: ph.color }}>
                    <header><b>{ph.title}</b><span className="n">{col.length}</span></header>
                    <p className="muted small colhint">{ph.hint}</p>
                    {rows.map((i) => <BoardCard key={i.id} i={i} now={now} city={city} onClick={() => { setZone(undefined); setOpenId(i.id); }} />)}
                    {col.length === 0 && <p className="muted small emptycol">Nothing here</p>}
                    {col.length > rows.length && <p className="muted small">and {col.length - rows.length} older</p>}
                  </section>
                );
              })}
            </div>
          </>
        )}

        {view === 'map' && <section className="card"><IncidentMap incidents={incidents.filter((i) => !isDone(i))} selected={openId} onSelect={(id) => { setOpenId(id); }} city={city} reports={reports} tall focus={focus} /><div className="row wrap small" style={{ marginTop: 10 }}>{(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((l) => <span key={l} className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: 6, background: LEVEL_COLOR[l] }} />{l[0] + l.slice(1).toLowerCase()}</span>)}<span className="row" style={{ gap: 6 }}><i style={{ width: 12, height: 12, borderRadius: 6, background: VERIFY_COLOR }} />Not confirmed</span></div></section>}
        {view === 'twin' && <TwinView city={city} incidents={incidents} onOpen={(id) => { setZone(undefined); setOpenId(id); }} />}
        {view === 'network' && <NetworkPanel cityId={ctx.city} cityName={city?.name} canRun={role === 'L3' || role === 'L4'} onOpen={(id) => { setZone(undefined); setOpenId(id); }} />}
        {view === 'graph' && <GraphPage city={city} health={health} onOpen={(id) => { setZone(undefined); setOpenId(id); }} />}
        {view === 'account' && <CityConsole />}
        {view === 'reports' && <Reports reports={reports} city={city} now={now} />}
        {view === 'notices' && <NoticesPanel city={city} role={role} />}
        {view === 'data' && <SamplePanel health={health} onDone={refresh} />}
      </main>

      {(open || zone) && (
        <>
          <div className="drawer-bg" onClick={() => { setOpenId(undefined); setZone(undefined); }} />
          <aside className="drawer" role="dialog">
            <button className="drawer-x" onClick={() => { setOpenId(undefined); setZone(undefined); }} aria-label="Close"><X size={20} /></button>
            {open ? <IncidentPanel key={open.id} i={open} me={me} rules={rules} city={city} now={now} onDone={refresh} onMap={() => goMap(open.centroid)} />
              : <ZonePanel zoneId={zone!} risk={risk.find((z) => z.zone === zone)} incidents={incidents} city={city} now={now} onOpen={(id) => { setZone(undefined); setOpenId(id); }} onMap={(pt) => goMap(pt)} />}
          </aside>
        </>
      )}
    </div>
  );
}

function Progress({ done }: { done: number }) {
  return <div className="prog" aria-label={`Step ${done} of 8`}>{Array.from({ length: 8 }, (_, n) => <i key={n} className={n < done ? 'on' : n === done ? 'now' : ''} />)}</div>;
}

function BoardCard({ i, now, city, onClick }: { i: Incident; now: number; city?: City; onClick: () => void }) {
  const w = i.workflow;
  const stage = w?.stage ?? 'REPORTED';
  const fwd = isDone(i) ? undefined : forwardInfo(i);
  const late = !!w && !isDone(i) && w.slaDueAt < now;
  return (
    <button className="bcard" onClick={onClick}>
      <span className="row between"><span className="chip lvl" style={{ background: color(i) }}>{levelWord(i)}</span><span className="age"><Clock size={13} /> {ageText(i.firstReportedAt, now)}</span></span>
      <b className="title">{i.family === 'ROAD' ? <Construction size={16} /> : <Droplets size={16} />} {issue(i)}</b>
      <span className="muted small">{whereOf(i.centroid, city) ?? ''} · {likelyFake(i) ? `${i.trust.rawReports} reports, ${i.trust.independentSources} believable ${i.trust.independentSources === 1 ? 'person' : 'people'}` : `${i.trust.independentSources} ${i.trust.independentSources === 1 ? 'person' : 'people'}`}</span>
      {(() => { const codes = new Set(i.trust.authenticity.flatMap((a) => a.signals.map((x) => x.code))); return codes.has('NETWORK_RING') ? <span className="graphtag net"><Share2 size={11} /> Neo4j: ring caught in another city</span> : codes.has('GRAPH_RING') ? <span className="graphtag"><Network size={11} /> Neo4j: linked-account ring</span> : null; })()}
      <Progress done={stepsDone(stage)} />
      <span className="row between small">
        <span className={late ? 'late' : 'muted'}>{w && !isDone(i) ? dueText(w.slaDueAt, now) : STAGE_WORDS[stage]}</span>
        {i.repeat && <span className="fromtag" style={{ color: 'var(--red)', background: '#fdecea' }} title="The same problem was fixed here before"><RotateCcw size={11} /> {i.repeat.count > 1 ? `Fixed ${i.repeat.count} times before` : 'Came back'}</span>}
        {fwd && <span className="fromtag" title={fwd.note}><Send size={11} /> {fwd.auto ? 'Moved up' : fwd.from === 'CITIZEN' ? 'Objection' : `From ${ROLE_LABEL[fwd.from].toLowerCase()}`}</span>}
      </span>
    </button>
  );
}

function Reports({ reports, city, now }: { reports: Report[]; city?: City; now: number }) {
  return (
    <section>
      <div className="notice" style={{ marginBottom: 14 }}>Single reports waiting for neighbours to confirm. When 3 different people report the same kind of problem close together, it becomes an incident (2 for roads).</div>
      {reports.length === 0 && <section className="card empty"><span className="big"><Inbox /></span><p className="muted">No new reports waiting.</p></section>}
      <div className="reportgrid">{reports.map((r) => <div key={r.id} className="rep fade"><div className="row between"><b>{en(r.issueType as Key)}</b><span className="age"><Clock size={13} /> {ageText(r.createdAt, now)}</span></div><span className="small"><MapPin size={13} style={{ verticalAlign: -2 }} /> {whereOf(r, city) ?? `${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}`}{r.address ? ` · ${r.address}` : ''}</span>{r.text && <span className="muted small" lang={r.language}>“{r.text}”</span>}{r.textEn && <span className="small"><Languages size={12} style={{ verticalAlign: -2 }} /> {nameOfBcp(r.language)} → “{r.textEn}”</span>}</div>)}</div>
    </section>
  );
}

function ZonePanel({ zoneId, risk, incidents, city, now, onOpen, onMap }: { zoneId: string; risk?: RiskZone; incidents: Incident[]; city?: City; now: number; onOpen: (id: string) => void; onMap: (pt: { lat: number; lng: number }) => void }) {
  const z = city?.zones.find((x) => x.id === zoneId);
  const wards = city?.localities.filter((l) => l.zoneId === zoneId) ?? [];
  const here = incidents.filter((i) => !isDone(i) && zoneIdOf(i.centroid, city) === zoneId);
  const centre = wards.length ? { lat: wards.reduce((s, w) => s + w.lat, 0) / wards.length, lng: wards.reduce((s, w) => s + w.lng, 0) / wards.length } : undefined;
  const feeds = z?.feeds.map((f) => city?.zones.find((x) => x.id === f)?.name ?? f) ?? [];
  return (
    <div className="stack">
      <div><h2 style={{ fontSize: 24 }}>{z?.name ?? zoneId}</h2><p className="muted small">{wards.map((w) => w.name).join(', ')}</p></div>
      {risk && <div className="notice"><b>Why this area is on the list</b><ul className="why">{risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul><p className="muted small" style={{ marginTop: 6 }}>A guide, not a prediction.</p></div>}
      {feeds.length > 0 && <p className="small">Water from this zone also feeds: <b>{feeds.join(', ')}</b></p>}
      <h3 style={{ margin: 0 }}>Open problems here ({here.length})</h3>
      {here.length === 0 && <p className="muted small">No open incidents in this zone right now.</p>}
      {here.map((i) => <BoardCard key={i.id} i={i} now={now} city={city} onClick={() => onOpen(i.id)} />)}
      {centre && <button className="btn" onClick={() => onMap(centre)}><MapIcon size={16} /> Show on map</button>}
    </div>
  );
}

function IncidentPanel({ i, me, rules, city, now, onDone, onMap }: { i: Incident; me: OfficerT; rules: Rules; city?: City; now: number; onDone: () => void; onMap: () => void }) {
  const role = me.role;
  const [reason, setReason] = useState('');
  const [proof, setProof] = useState<string>();
  const [camera, setCamera] = useState(false);
  const [shown, setShown] = useState<{ photo: string; by: Role; at: number }>();
  const [fwd, setFwd] = useState<string>();
  const [down, setDown] = useState<{ zone: string; hops: number; localities: string[] }[]>([]);
  const stage = i.workflow?.stage ?? 'REPORTED';
  const level = i.workflow?.level ?? 1;
  const done = stepsDone(stage);
  const actions = actionsFor(rules, stage, role).filter((a) => !CITIZEN_ONLY.includes(a));
  const nextRole = level < 3 ? levelRole(level + 1) : undefined;
  const came = isDone(i) ? undefined : forwardInfo(i);
  const zone = zoneIdOf(i.centroid, city);
  const t = i.trust;
  useEffect(() => { if (zone && i.family !== 'ROAD') api.downstream(zone).then(setDown).catch(() => undefined); }, [zone, i.family]);
  useEffect(() => { if (i.hasProof && ['PROOF_REVIEW', 'RESOLVED', 'CONFIRMED', 'CLOSED'].includes(stage)) api.proofFor(i.id, 'officer').then(setShown).catch(() => undefined); }, [i.id, i.hasProof, stage]);

  async function run(action: string, extra: Record<string, unknown> = {}) {
    try { await api.actAsOfficer(i.id, action, { reason: reason || undefined, proofPhoto: proof, ...extra }); setReason(''); setFwd(undefined); setProof(undefined); toast('Done'); onDone(); } catch (e) { toast((e as Error).message, true); }
  }
  const others = actions.filter((a) => !['decide-dispute', 'forward'].includes(a));
  const late = !!i.workflow && !isDone(i) && i.workflow.slaDueAt < now;

  return (
    <div className="stack">
      <div>
        <div className="row wrap"><span className="chip lvl" style={{ background: color(i) }}>{levelWord(i)}</span><span className="muted small">{i.family === 'ROAD' ? 'Roads' : 'Water'}</span></div>
        <h2 style={{ fontSize: 26, margin: '8px 0 2px' }}>{issue(i)}</h2>
        <p className="muted"><MapPin size={14} style={{ verticalAlign: -2 }} /> {whereOf(i.centroid, city) ?? 'Unknown ward'} · {t.independentSources} {t.independentSources === 1 ? 'person' : 'people'} reported</p>
      </div>

      <div className="clocks">
        <div><Clock size={16} /><b>{ageText(i.firstReportedAt, now)}</b><span>first reported</span></div>
        <div className={late ? 'late' : ''}><Clock size={16} /><b>{i.workflow && !isDone(i) ? dueText(i.workflow.slaDueAt, now) : 'Finished'}</b><span>{i.workflow && !isDone(i) ? (nextRole ? `then it moves up to the ${ROLE_LABEL[nextRole].toLowerCase()}` : 'already with the department head') : ' '}</span></div>
      </div>

      <div>
        <Progress done={done} />
        <p className="small" style={{ marginTop: 6 }}>Step {Math.min(done + 1, 8)} of 8: <b>{done >= 8 ? 'All done' : STEP_NAMES[done]}</b></p>
      </div>

      {i.repeat && <div className="notice" style={{ background: '#fdecea', borderColor: '#f3c3c5' }}><b><RotateCcw size={15} style={{ verticalAlign: -2 }} /> This problem came back.</b><p className="small">The same kind of problem was fixed within 150 m {ageText(i.repeat.lastFixedAt, now)}{i.repeat.count > 1 ? `, and ${i.repeat.count} times in the last 6 months` : ''}. Check why the fix did not hold.</p></div>}
      {came && <div className="notice"><b>{came.auto ? `Moved up: the ${ROLE_LABEL[came.from].toLowerCase()} did not act in time.` : came.from === 'CITIZEN' ? 'The citizen objected to a rejection.' : `Forwarded to you by the ${ROLE_LABEL[came.from].toLowerCase()}.`}</b>{came.note && <p className="small" style={{ marginTop: 4 }}>“{came.note}”</p>}<p className="muted small">{ageText(came.at, now)}</p></div>}
      {shown && <div><h3 style={{ margin: '0 0 6px' }}>{stage === 'PROOF_REVIEW' ? `Fix photo from the ${ROLE_LABEL[shown.by].toLowerCase()}: please check it` : 'Photo of the fix'}</h3><PhotoView src={shown.photo} alt="Photo of the fix" /></div>}

      <div className="nextstep">
        <h3 style={{ margin: 0 }}>Next step</h3>
        <p>{i.recommendedAction}</p>
        {role === 'L4' && <p className="muted small">You have view-only access.</p>}
        {actions.length === 0 && role !== 'L4' && <p className="muted small">Nothing for a {ROLE_LABEL[role].toLowerCase()} to do right now.</p>}
        {actions.includes('resolve') && (
          <div className="row wrap">
            <button className="btn" onClick={() => setCamera(true)}><CamIcon size={16} /> Take photo</button>
            <label className="btn">Choose file<input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setProof(await photoToBase64(f, 1280, 600_000)); }} /></label>
            {proof && <span className="pill ok">Photo ready</span>}
          </div>
        )}
        {(actions.includes('reject') || actions.includes('reject-proof')) && <input className="input" placeholder="Reason (needed to reject)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <div className="row wrap">
          {others.map((a) => <button key={a} className={`btn ${a === 'reject' || a === 'reject-proof' ? 'danger' : 'primary'}`} disabled={a === 'resolve' && !proof} onClick={() => run(a)}>{LABEL[a] ?? a}</button>)}
          {actions.includes('decide-dispute') && <><button className="btn primary" onClick={() => run('decide-dispute', { decision: 'overturn' })}>Citizen is right: reopen it</button><button className="btn" onClick={() => run('decide-dispute', { decision: 'uphold' })}>Keep the rejection</button></>}
          {actions.includes('forward') && nextRole && <button className="btn" onClick={() => setFwd('')}><Send size={16} /> Forward to {ROLE_LABEL[nextRole].toLowerCase()}</button>}
        </div>
        {fwd !== undefined && nextRole && (
          <div className="fwd">
            <b>This goes to the {ROLE_LABEL[nextRole].toLowerCase()} at {me.office}.</b>
            <input className="input" placeholder="Add a note for them (optional)" value={fwd} onChange={(e) => setFwd(e.target.value)} />
            <div className="row"><button className="btn primary sm" onClick={() => run('forward', { note: fwd || undefined })}>Send</button><button className="btn sm" onClick={() => setFwd(undefined)}>Cancel</button></div>
          </div>
        )}
      </div>

      {likelyFake(i) && <div className="notice" style={{ background: '#fdecea', borderColor: '#f3c3c5' }}><b><ShieldAlert size={15} style={{ verticalAlign: -2 }} /> Likely fake campaign.</b><p className="small">{i.trust.rawReports} reports, but they come from {i.trust.independentSources} believable {i.trust.independentSources === 1 ? 'person' : 'people'}. Check the connections below before sending a crew.</p></div>}
      <Voices id={i.id} />
      <WhoGraph id={i.id} open={likelyFake(i)} />
      <details className="acc"><summary>Why it ranks here</summary><ul className="why">{reasons(i).map((r) => <li key={r}>{r}</li>)}</ul></details>
      <details className="acc"><summary>Who reported it</summary>
        <div className="bands" style={{ marginTop: 8 }}><i style={{ flex: t.bands.TRUSTED, background: 'var(--green)' }} /><i style={{ flex: t.bands.REVIEW, background: 'var(--amber)' }} /><i style={{ flex: t.bands.LIKELY_FAKE, background: 'var(--red)' }} /></div>
        <p className="small" style={{ marginTop: 6 }}>{t.independentSources} different {t.independentSources === 1 ? 'person' : 'people'}, {t.rawReports} reports. Green: believable. Amber: check. Red: looks fake, left out.</p>
      </details>
      {(i.possibleCause || down.length > 0) && <details className="acc"><summary>Related</summary>
        {i.possibleCause && <p className="small" style={{ marginTop: 8 }}><b>Possibly caused by a leak</b> {i.possibleCause.distanceM} m away. Both departments should know.</p>}
        {down.length > 0 && <p className="small" style={{ marginTop: 8 }}><b>If this zone loses water, next:</b> {down.map((d) => d.localities.join(', ')).join(', ')}.</p>}
      </details>}
      <details className="acc"><summary>History</summary><ul className="logl" style={{ marginTop: 8 }}>{[...(i.workflow?.audit ?? [])].reverse().slice(0, 8).map((a, n) => <li key={n}><b>{a.action.replace('-', ' ')}</b> <span className="muted small">{ROLE_LABEL[a.role]} · {ageText(a.at, now)}{a.note ? ` · ${a.note}` : ''}</span></li>)}</ul></details>
      <details className="acc"><summary>Technical details</summary><TechDetails i={i} /></details>
      <button className="btn" onClick={onMap}><MapIcon size={16} /> Show on map</button>
      {camera && <CameraModal t={en} onClose={() => setCamera(false)} onFail={() => { setCamera(false); toast('Camera not available here. Choose a file instead.', true); }} onCapture={async (f) => { setCamera(false); setProof(await photoToBase64(f, 1280, 600_000)); }} />}
    </div>
  );
}

/** The graph is drawn only when this section is open (it builds a canvas). */
function WhoGraph({ id, open }: { id: string; open: boolean }) {
  const [shown, setShown] = useState(open);
  return <details className="acc" open={open} onToggle={(e) => setShown((e.target as HTMLDetailsElement).open)}><summary>Who is behind these reports (graph)</summary>{shown && <div style={{ marginTop: 8 }}><GraphView id={id} /></div>}</details>;
}

/** What people said, in their own language and in English (Sarvam). Read aloud with Bulbul. */
function Voices({ id }: { id: string }) {
  const [list, setList] = useState<Voice[]>();
  useEffect(() => { api.voices(id).then(setList).catch(() => setList([])); }, [id]);
  if (!list?.length) return null;
  return (
    <details className="acc" open><summary>What people said ({list.length})</summary>
      <ul className="voices">
        {list.slice(0, 5).map((v, n) => (
          <li key={n}>
            <p lang={v.language}>“{v.text}”</p>
            {v.textEn && <p className="small"><span className="tagx">{nameOfBcp(v.language)} → English</span> {v.textEn}</p>}
            <button className="btn ghost sm" onClick={() => speakText(v.text, v.language ?? 'hi-IN', 'officer')} aria-label="Read aloud"><Volume2 size={14} /></button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TechDetails({ i }: { i: Incident }) {
  return (
    <div style={{ marginTop: 10 }}>
      {(
        <>
          {i.severity.factors.map((f) => <div key={f.name} className="bar-row"><span>{f.name}</span><div className="track"><div style={{ width: `${(f.points / f.max) * 100}%` }} /></div><b>{f.points} / {f.max}</b><small>{f.detail}</small></div>)}
          <p style={{ margin: '10px 0' }}><b>Base {i.severity.base} × trust {i.severity.credibility} = {Math.round(i.severity.score)}</b></p>
          <ul className="small" style={{ paddingLeft: 18 }}>{signalSummary(i).map((s) => <li key={s.code}><b>{s.points > 0 ? '+' : ''}{s.points}</b> {SIGNAL[s.code] ?? s.code} <span className="muted">×{s.count}</span></li>)}</ul>
        </>
      )}
    </div>
  );
}

function NoticesPanel({ city, role }: { city?: City; role: Role }) {
  const local = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [list, setList] = useState<Notice[]>();
  const [kind, setKind] = useState<Notice['kind']>('WATER_CUT');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [wards, setWards] = useState<string[]>([]);
  const [start, setStart] = useState(local(Date.now()));
  const [end, setEnd] = useState(local(Date.now() + 3 * 3_600_000));
  const canPost = role === 'L2' || role === 'L3';
  const load = () => api.notices().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  async function post() {
    try { await api.addNotice({ kind, title, note: note || undefined, wardIds: wards, startsAt: new Date(start).getTime(), endsAt: new Date(end).getTime() }); toast('Announced: citizens near these wards will see it'); setTitle(''); setNote(''); setWards([]); load(); } catch (e) { toast((e as Error).message, true); }
  }
  const fmt = (n: number) => new Date(n).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <section className="card">
        <h2>Announce planned work</h2>
        <p className="muted small" style={{ margin: '4px 0 12px' }}>Citizens near these wards see it before they complain, so a planned water cut does not look like a failure.</p>
        {!canPost ? <p className="muted">Only zonal officers and department heads can announce planned work.</p> : (
          <div className="stack">
            <div className="chips">{([['WATER_CUT', 'Water cut'], ['ROAD_WORK', 'Road work'], ['OTHER', 'Other']] as const).map(([k, l]) => <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{l}</button>)}</div>
            <input className="input" placeholder="What is happening? e.g. Valve repair on the main line" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            <div><p className="muted small" style={{ marginBottom: 6 }}>Which wards?</p><div className="chips">{city?.localities.map((l) => <button key={l.id} className={`chip ${wards.includes(l.id) ? 'on' : ''}`} onClick={() => setWards(wards.includes(l.id) ? wards.filter((w) => w !== l.id) : [...wards, l.id])}>{l.name}</button>)}</div></div>
            <div className="row wrap"><label className="field" style={{ flex: 1 }}>From<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label className="field" style={{ flex: 1 }}>Until<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label></div>
            <input className="input" placeholder="Note for citizens (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
            <button className="btn primary" disabled={title.trim().length < 3 || wards.length === 0} onClick={post}><Megaphone size={16} /> Announce</button>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Announced</h2>
        {!list ? null : list.length === 0 ? <p className="muted" style={{ marginTop: 8 }}>Nothing announced.</p> : list.map((n) => (
          <div key={n.id} className="row between wrap" style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
            <div><b>{n.title}</b><p className="muted small">{fmt(n.startsAt)} to {fmt(n.endsAt)} · {n.wardIds.map((w) => city?.localities.find((l) => l.id === w)?.name ?? w).join(', ')}</p></div>
            {canPost && <button className="btn sm danger" onClick={() => api.removeNotice(n.id).then(load).catch((e: Error) => toast(e.message, true))}><Trash2 size={14} /> Cancel</button>}
          </div>
        ))}
      </section>
    </>
  );
}

function SamplePanel({ health, onDone }: { health?: Health; onDone: () => void }) {
  const [key, setKey] = useState('');
  const [minute, setMinute] = useState(0);
  const [replay, setReplay] = useState<Awaited<ReturnType<typeof api.replay>>>();
  useEffect(() => { ctx.adminKey = key; }, [key]);
  useEffect(() => { api.replay(minute).then(setReplay).catch(() => undefined); }, [minute]);
  const run = (label: string, f: () => Promise<unknown>) => f().then(() => { toast(label); onDone(); }).catch((e: Error) => toast(e.message, true));
  return (
    <>
      <section className="card">
        <h2>Sample town</h2>
        <p className="muted" style={{ margin: '6px 0 14px' }}>A made-up town with a real outage, three kinds of fake campaigns, a leak next to a pothole, and a few single reports. Everything here is synthetic.</p>
        {health?.admin === 'key' && <label className="field" style={{ maxWidth: 320, marginBottom: 12 }}>Admin key<input type="password" value={key} onChange={(e) => setKey(e.target.value)} /></label>}
        <div className="row wrap"><button className="btn primary" onClick={() => run('Sample town loaded', api.seed)}><Sparkles size={17} /> Load sample town</button><button className="btn" onClick={() => run('Partner organisations added: an industrial park fed by the South feeder, and a toll road', api.seedPartners)}><Factory size={17} /> Add private partner organisations</button><button className="btn danger" onClick={() => run('All data cleared', api.reset)}><Trash2 size={17} /> Clear all data</button></div>
      </section>
      <section className="card">
        <h2>Add one scenario</h2>
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => run('Real outage added', () => api.scenario('outage', 30))}>Real outage (30)</button>
          <button className="btn danger" onClick={() => run('Fake attack added', () => api.scenario('attack', 50))}>Fake: 50 reports, 3 phones</button>
          <button className="btn danger" onClick={() => run('Script added', () => api.scenario('simfarm', 40))}>Fake: script from 40 SIMs</button>
          <button className="btn danger" onClick={() => run('Photo reuse added', () => api.scenario('photo', 30))}>Fake: one photo, many accounts</button>
          <button className="btn" onClick={() => run('Potholes added', () => api.scenario('road', 4))}>Pothole reports (4)</button>
        </div>
        <h3 style={{ marginTop: 16 }}>Graph demo: a hired crowd</h3>
        <p className="muted small">The same 10 accounts, every report looking human. Add them in Ward 5, then in Ward 7 (far away): the second time, the graph links them and the fake drops to "not confirmed".</p>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => run('Crowd reported in Ward 5', () => api.scenario('crowd', 10, 'L5'))}>1. Crowd in Ward 5</button>
          <button className="btn danger" onClick={() => run('Same crowd in Ward 7: check the Graph page', () => api.scenario('crowd', 10, 'L7'))}>2. Same crowd in Ward 7</button>
        </div>
      </section>
      <section className="card">
        <h2>Replay an outage</h2>
        <label className="field" style={{ marginTop: 10 }}>Minute {minute} of 120<input type="range" min={0} max={120} value={minute} onChange={(e) => setMinute(Number(e.target.value))} /></label>
        {replay && <p style={{ marginTop: 8 }}>{replay.reports} reports so far. {replay.incident ? <b>Flagged as {replay.incident.level.toLowerCase()}, {replay.incident.independentSources} different people{replay.incident.needsVerification ? ' (not confirmed yet)' : ''}</b> : 'No incident yet.'}</p>}
      </section>
    </>
  );
}

/** The 3D city twin with the live incidents: drag to turn, scroll to zoom, click a beam to open it. */
function TwinView({ city, incidents, onOpen }: { city?: City; incidents: Incident[]; onOpen: (id: string) => void }) {
  const [m, setM] = useState<import('./twinModel').TwinModel>();
  // memoised: a new array every render would rebuild the twin, which reports its model, which re-renders: a loop
  const open = useMemo(() => incidents.filter((i) => !isDone(i)), [incidents]);
  const [focus, setFocus] = useState<string[]>([]);
  const [menu, setMenu] = useState(false);
  const [whatIf, setWhatIf] = useState<AssetImpact & { loading?: boolean }>();
  const [showCypher, setShowCypher] = useState(false);
  const askImpact = (id: string) => {
    const known = city?.assets?.find((a) => a.id === id);
    setWhatIf({ asset: { id, name: known?.name ?? id, kind: known?.kind ?? 'PIPE' }, wards: [], zones: [], engine: 'memory', cypher: [], loading: true }); setShowCypher(false);
    api.assetImpact(id).then((r) => { setWhatIf(r); setFocus(r.wards.map((w) => w.localityId)); }).catch((e: Error) => { setWhatIf(undefined); toast(e.message); });
  };
  const closeWhatIf = () => { setWhatIf(undefined); setFocus([]); };
  const [full, setFull] = useState(false);
  const card = useRef<HTMLElement>(null);
  const pickRef = useRef<HTMLDivElement>(null);
  useEffect(() => { // close the ward menu on a click or tap anywhere outside it
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!pickRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [menu]);
  useEffect(() => { setFocus([]); setWhatIf(undefined); }, [city?.id]);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === card.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => { // the CSS fallback (no Fullscreen API, e.g. iPhone Safari) closes with Esc too
    if (!full || document.fullscreenElement) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc);
  }, [full]);
  const toggleFull = () => {
    const el = card.current; if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el.requestFullscreen && document.fullscreenEnabled) el.requestFullscreen().catch(() => setFull((f) => !f));
    else setFull((f) => !f);
  };
  const wards = m?.wards ?? [];
  const zoneName = (id: string) => city?.zones.find((z) => z.id === id)?.name ?? id;
  const zones = [...new Set(wards.map((w) => w.zone))];
  const toggle = (id: string) => setFocus((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));
  const chosen = wards.filter((w) => focus.includes(w.id));
  const label = chosen.length === 0 ? 'All wards' : chosen.length <= 2 ? chosen.map((w) => w.name).join(', ') : `${chosen[0].name}, ${chosen[1].name} +${chosen.length - 2}`;
  const fedBy = (zone: string) => {
    const assets = city?.assets ?? [];
    const direct = assets.filter((a) => a.supplies.includes(zone));
    const chain: string[] = [];
    let cur: (typeof assets)[number] | undefined = direct[0];
    for (let i = 0; cur && i < 5; i++) { const id: string = cur.id; chain.push(cur.name); cur = assets.find((a) => a.feeds.includes(id)); }
    return chain.reverse().join(' → ');
  };
  const STATE = { ok: 'Water normal', hit: 'No water', risk: 'At risk' } as const;
  return (
    <section ref={card} className={`twin-card fade ${full ? 'is-full' : ''}`}>
      {city ? <Twin city={city} incidents={open} mode="interactive" focus={focus} onPick={onOpen} onAsset={askImpact} onModel={setM} /> : <div className="twin interactive" />}
      <div className="twin-hud">
        <b>{city?.name ?? 'City'} · live</b>
        <div className="wardpick" ref={pickRef}>
          <button className={`wp-btn ${menu ? 'on' : ''}`} onClick={() => setMenu((x) => !x)} aria-expanded={menu} aria-haspopup="listbox"><MapPin size={15} /><span>{label}</span><ChevronDown size={16} className="wp-chev" /></button>
          {menu && <>
            <div className="wp-menu" role="listbox" aria-multiselectable="true">
              <button className={`wp-all ${focus.length === 0 ? 'on' : ''}`} onClick={() => { setFocus([]); setWhatIf(undefined); setMenu(false); }}>Whole town</button>
              {zones.map((z) => <div key={z} className="wp-zone"><small>{zoneName(z)}</small>
                {wards.filter((w) => w.zone === z).map((w) => { const n = m?.beacons.filter((b) => b.ward === w.name).length ?? 0; return (
                  <label key={w.id} className="wp-row"><input type="checkbox" checked={focus.includes(w.id)} onChange={() => toggle(w.id)} /><i className={`wp-dot ${w.state}`} /><span>{w.name}</span>{n > 0 && <em>{n}</em>}</label>); })}
              </div>)}
              <p className="wp-hint">Pick one ward to zoom in, or several to see them together.</p>
            </div>
          </>}
        </div>
        <span><i className="sw water" /> Water pipes (moving dots = water flowing)</span>
        <span><i className="sw crit" /> Open problem pin (taller = more severe)</span>
        <span><i className="sw held" /> Grey pin: held, reports from linked accounts</span>
        {m?.suspect ? <span className="alert"><i className="sw sus" /> Likely failure: <b>{m.suspect.name}</b>{m.atRisk.length ? ` · at risk: ${m.atRisk.join(', ')}` : ''}</span> : <span><i className="sw ok" /> No shared failure point right now</span>}
        <small>Drag to turn · scroll to zoom · click a pin to open it · <b className="whatif-hint">click a pipe, pump or tank: what if it fails?</b></small>
      </div>
      <div className="twin-tools">
        <div className="twin-count"><b>{open.length}</b> open · <b>{open.filter((i) => i.trust.needsVerification).length}</b> held</div>
        <button className="twin-full" onClick={toggleFull} title={full ? 'Exit full screen' : 'Full screen'} aria-label={full ? 'Exit full screen' : 'Full screen'}>{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}<span>{full ? 'Exit' : 'Full screen'}</span></button>
      </div>
      {whatIf && <div className="whatif-card" role="dialog" aria-label="What if this fails">
        <div className="wi-head"><span className="wi-icon"><Droplets size={18} /></span><div><small>What if this fails?</small><b>{whatIf.asset.name}</b></div><button className="wc-x" onClick={closeWhatIf} aria-label="Close"><X size={14} /></button></div>
        {whatIf.loading ? <p className="wi-body">Walking the water network…</p> : <>
          <p className="wi-body"><b>{whatIf.wards.length} ward{whatIf.wards.length === 1 ? '' : 's'}</b> in {whatIf.zones.map((z) => z.name).join(', ') || 'no zone'} would lose water{whatIf.wards.length ? ':' : '.'}</p>
          {whatIf.wards.length > 0 && <div className="wi-wards">{whatIf.wards.map((w) => <span key={w.localityId}>{w.name}</span>)}</div>}
          <div className="wi-foot"><span className={`wi-engine ${whatIf.engine === 'neo4j' ? 'live' : ''}`}><Network size={13} /> {whatIf.engine === 'neo4j' ? 'Answered by Neo4j' : 'Graph twin (same Cypher on Neo4j)'}</span><button className="wi-cy" onClick={() => setShowCypher((x) => !x)}>{showCypher ? 'Hide' : 'Show'} Cypher</button></div>
          {showCypher && <pre className="wi-code">{whatIf.cypher[0]}</pre>}
        </>}
      </div>}
      {!whatIf && chosen.length > 0 && <div className="ward-cards">
        {chosen.slice(0, 3).map((w) => { const here = m?.beacons.filter((b) => b.ward === w.name) ?? []; return (
          <div key={w.id} className={`ward-card ${w.state}`}>
            <div className="wc-head"><b>{w.name}</b><span className={`wc-state ${w.state}`}>{STATE[w.state]}</span><button className="wc-x" onClick={() => toggle(w.id)} aria-label={`Remove ${w.name}`}><X size={14} /></button></div>
            <small>{zoneName(w.zone)}{fedBy(w.zone) ? ` · fed by ${fedBy(w.zone)}` : ''}</small>
            {here.length === 0 ? <p className="wc-none">No open problems here.</p> : <ul>{here.slice(0, 3).map((b) => <li key={b.id}><button onClick={() => onOpen(b.id)}><i style={{ background: b.held ? VERIFY_COLOR : LEVEL_COLOR[b.level as keyof typeof LEVEL_COLOR] }} />{b.what}<span>{b.held ? 'held' : `${b.people} people`}</span></button></li>)}{here.length > 3 && <li className="more">+{here.length - 3} more</li>}</ul>}
          </div>); })}
        {chosen.length > 3 && <div className="ward-card more">+{chosen.length - 3} more wards selected</div>}
      </div>}
    </section>
  );
}
