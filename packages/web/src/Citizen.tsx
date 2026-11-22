import { ArrowLeft, Home, Bell, MessageSquare, Building2, CalendarClock, Clock, Camera as CamIcon, Check, ClipboardCheck, Construction, Droplets, FileText, HeartHandshake, LifeBuoy, LocateFixed, LogOut, MapPin, Pencil, Phone, Send, Share2, ShieldCheck, Stamp, ThumbsUp, Users, Wrench } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, ctx, type City, type Health, type Incident, type MyComplaint, type Place, type Role } from './api';
import { CityPicker, LangPicker, Logo, Skeleton, toast } from './components';
import { GraphCard, VoiceCard } from './Showcase';
import { localeOf, makeT, type Key, type Lang } from './i18n';
import { useLocation } from './geo';
import { ReadAloud } from './Diary';
import { PhotoView } from './PhotoView';
import { ReportTab } from './Report';
import { toHindiName, isDevanagari } from './translit';
import { categoryOf, levelRole, stepsDone } from './util';

type T = (k: Key, v?: Record<string, string | number>) => string;
const STEPS: [Key, string | null, typeof Send][] = [['c0', null, Send], ['c1', 'verify', ClipboardCheck], ['c2', 'approve', Stamp], ['c3', 'assign', Users], ['c4', 'start', Wrench], ['c5', 'resolve', CamIcon], ['c6', 'approve-proof', ShieldCheck], ['c7', 'confirm', ThumbsUp]];
const roleName = (t: T, r: Role): string => t(({ L1: 'level1', L2: 'level2', L3: 'level3', L4: 'level4', CITIZEN: 'level1' } as const)[r]);
const goHome = () => { location.hash = '#/'; };

export function Citizen({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = makeT(lang);
  const [authed, setAuthed] = useState(!!ctx.token);
  const [name, setName] = useState(localStorage.getItem('bp_name') ?? '');
  const [skipped, setSkipped] = useState(!!localStorage.getItem('bp_name_skip'));
  const logout = () => { api.logout(); setAuthed(false); goHome(); };
  if (!authed) return <PhoneLogin t={t} lang={lang} setLang={setLang} onDone={() => setAuthed(true)} />;
  if (!name && !skipped) return <NameStep t={t} lang={lang} setLang={setLang} onDone={(n) => { if (n) { localStorage.setItem('bp_name', n); setName(n); } else { localStorage.setItem('bp_name_skip', '1'); setSkipped(true); } }} />;
  return <CitizenApp lang={lang} setLang={setLang} t={t} name={name} setName={(n) => { localStorage.setItem('bp_name', n); setName(n); }} onLogout={logout} />;
}

/** Sign-in pages: the live city on one side (desktop) or on top (phone), the form on the other. */
function AuthShell({ t, lang, setLang, children }: { t: T; lang?: Lang; setLang?: (l: Lang) => void; children: ReactNode }) {
  return (
    <div className="authwrap">
      <aside className="auth-art">
        <div className="auth-art-copy">
          <div className="auth-hero"><div><span className="eyebrow"><span className="live" /> {t('authLive')}</span><h2>{t('authHead')}</h2></div></div>
          <ul>
            <li><b>1</b><span>{t('authP1')}<em className="ttag sarvam">Sarvam AI</em></span></li>
            <li><b>2</b><span>{t('authP2')}<em className="ttag neo">Neo4j</em></span></li>
            <li><b>3</b><span>{t('authP3')}</span></li>
          </ul>
          <GraphCard compact t={t} />
          <VoiceCard lang={lang} setLang={setLang} t={t} />
        </div>
      </aside>
      <div className="auth fade">
        {setLang && <button className="hi-toggle auth-hi" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>{lang === 'en' ? 'हिंदी में देखें' : 'View in English'}</button>}
        {children}
      </div>
    </div>
  );
}

function NameStep({ t, lang, setLang, onDone }: { t: T; lang?: Lang; setLang?: (l: Lang) => void; onDone: (name: string) => void }) {
  const [v, setV] = useState('');
  return (
    <AuthShell t={t} lang={lang} setLang={setLang}><div className="card" style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 24 }}>{t('yourName')}</h2>
      <div className="stack" style={{ marginTop: 16 }}>
        <input className="input" autoFocus value={v} maxLength={40} placeholder={t('namePlaceholder')} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v.trim() && onDone(v.trim())} />
        <button className="btn primary lg" disabled={!v.trim()} onClick={() => onDone(v.trim())}>{t('saveName')}</button>
        <button className="btn ghost" onClick={() => onDone('')}>{t('skip')}</button>
      </div>
    </div></AuthShell>
  );
}

function PhoneLogin({ t, lang, setLang, onDone }: { t: T; lang?: Lang; setLang?: (l: Lang) => void; onDone: () => void }) {
  const saved = api.saved();
  const remembered = (saved?.phone ?? localStorage.getItem('bp_phone') ?? '').slice(0, 10);
  const [phone, setPhone] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [wait, setWait] = useState(0);
  const [demo, setDemo] = useState<string>();
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => { if (wait <= 0) return; const h = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(h); }, [wait]);

  async function send(number = phone) {
    setBusy(true); setErr('');
    try { const r = await api.otpRequest(number.trim()); setDemo(r.demoCode); setPhone(number); setStep('otp'); setWait(30); setTimeout(() => boxes.current[0]?.focus(), 50); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function resume() {
    setBusy(true); setErr('');
    try { await api.continueSaved(); onDone(); } catch { await send(remembered); } finally { setBusy(false); } // an expired login falls back to a new code
  }
  async function verify(code: string) {
    setBusy(true); setErr('');
    try { await api.verify(phone.trim(), code); onDone(); } catch (e) { setErr((e as Error).message); setDigits(Array(6).fill('')); boxes.current[0]?.focus(); } finally { setBusy(false); }
  }
  const type = (i: number, v: string) => {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) { const d = clean.slice(0, 6).split(''); setDigits([...d, ...Array(6 - d.length).fill('')]); if (d.length === 6) verify(d.join('')); return; }
    const next = [...digits]; next[i] = clean; setDigits(next);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
    if (next.every(Boolean)) verify(next.join(''));
  };

  return (
    <AuthShell t={t} lang={lang} setLang={setLang}>
      <button className="backlink" onClick={goHome}><ArrowLeft size={18} /> {t('backHome')}</button>
      <div className="row between"><Logo dark /><CityPicker /></div>
      <div className="card" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 24 }}>{t('verify')}</h2>
        {step === 'phone' ? (
          <div className="stack" style={{ marginTop: 16 }}>
            {remembered.length === 10 && (
              <>
                <button className="btn primary lg" disabled={busy} onClick={() => (saved ? resume() : send(remembered))}>{t('continueAs')} +91 {remembered.slice(0, 2)}••••••{remembered.slice(-2)}</button>
                <div className="row between"><p className="muted small">{t('notYou')}</p><button className="btn ghost sm" onClick={() => { api.forgetSaved(); location.reload(); }}>{t('forgetNumber')}</button></div>
              </>
            )}
            <label className="field">{t('phone')}<div className="row"><span className="input" style={{ width: 70, textAlign: 'center' }}>+91</span><input className="input" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="98765 43210" onKeyDown={(e) => e.key === 'Enter' && phone.length === 10 && send()} /></div></label>
            {err && <p className="error small">{err}</p>}
            <button className={`btn lg ${remembered.length === 10 ? 'secondary' : 'primary'}`} disabled={busy || phone.length !== 10} onClick={() => send()}><Send size={17} /> {t('sendOtp')}</button>
          </div>
        ) : (
          <div className="stack" style={{ marginTop: 16 }}>
            <p className="muted">{t('enterOtp')} · +91 {phone}</p>
            <div className="otp">{digits.map((d, i) => <input key={i} ref={(el) => { boxes.current[i] = el; }} value={d} inputMode="numeric" maxLength={6} aria-label={`digit ${i + 1}`} onChange={(e) => type(i, e.target.value)} onKeyDown={(e) => e.key === 'Backspace' && !d && i > 0 && boxes.current[i - 1]?.focus()} />)}</div>
            {demo ? <p className="demo-sms" role="status"><MessageSquare size={16} /> {t('demoSms', { code: demo })}</p> : <p className="small muted">{t('testMode')}</p>}
            {err && <p className="error small">{err}</p>}
            <button className="btn primary lg" disabled={busy || digits.some((d) => !d)} onClick={() => verify(digits.join(''))}>{t('verifyBtn')}</button>
            <div className="row between"><button className="btn ghost sm" onClick={() => { setStep('phone'); setDigits(Array(6).fill('')); }}>{t('changeNumber')}</button><button className="btn ghost sm" disabled={wait > 0} onClick={() => send()}>{t('resend')}{wait > 0 ? ` (${wait})` : ''}</button></div>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

/** What changed on a citizen's complaints, as readable messages. Built from the officers' action log, so there is nothing extra to store. */
const MSG: Record<string, Key> = { verify: 'm_verified', approve: 'm_approved', assign: 'm_assigned', start: 'm_started', resolve: 'm_proof', 'approve-proof': 'm_resolved', 'reject-proof': 'm_proofBack', reject: 'm_rejected', reopen: 'm_reopened', forward: 'm_escalated', 'sla-breach': 'm_escalated', confirm: 'm_confirmed' };
export interface Update { key: string; at: number; text: string; incidentId: string }
export function buildUpdates(t: T, mine: MyComplaint[], all: Incident[]): Update[] {
  const out: Update[] = [];
  for (const id of new Set(mine.map((m) => m.incidentId).filter(Boolean))) {
    const inc = all.find((i) => i.id === id);
    if (!inc) continue;
    const what = t(((Object.entries(inc.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0]) ?? 'OTHER_WATER') as Key);
    for (const a of inc.workflow?.audit ?? []) if (MSG[a.action]) out.push({ key: `${id}|${a.at}|${a.action}`, at: a.at, text: t(MSG[a.action], { what }), incidentId: id! });
  }
  return out.sort((a, b) => b.at - a.at);
}

function CitizenApp({ lang, setLang, t, name, setName, onLogout }: { lang: Lang; setLang: (l: Lang) => void; t: T; name: string; setName: (n: string) => void; onLogout: () => void }) {
  const [tab, setTab] = useState<'report' | 'mine' | 'updates' | 'help'>('report');
  const [geo, locate] = useLocation();
  const [pin, setPinState] = useState<{ lat: number; lng: number }>();
  const manual = useRef(false);
  const setPin = (p: { lat: number; lng: number }) => { manual.current = true; setPinState(p); };
  const [health, setHealth] = useState<Health>();
  const [city, setCity] = useState<City>();
  const [place, setPlace] = useState<Place>();
  const [mine, setMine] = useState<MyComplaint[]>();
  const [all, setAll] = useState<Incident[]>([]);
  const [seen, setSeen] = useState(() => Number(localStorage.getItem('bp_seen') ?? 0));
  const [nameHi, setNameHi] = useState(localStorage.getItem('bp_name_hi') ?? '');
  const [draftHi, setDraftHi] = useState('');

  useEffect(() => { if (geo.status === 'ok' && !manual.current) setPinState({ lat: geo.lat!, lng: geo.lng! }); }, [geo.status, geo.lat, geo.lng]);
  const refresh = useCallback(() => { api.mine().then(setMine).catch(() => setMine([])); api.incidents(true).then(setAll).catch(() => undefined); }, []);
  useEffect(() => { refresh(); api.health().then(setHealth).catch(() => undefined); api.city().then(setCity).catch(() => undefined); window.addEventListener('bp-mine', refresh); const h = setInterval(refresh, 8000); return () => { window.removeEventListener('bp-mine', refresh); clearInterval(h); }; }, [refresh]);
  useEffect(() => { if (pin) api.place(pin.lat, pin.lng, 'WATER').then(setPlace).catch(() => setPlace(undefined)); }, [pin?.lat, pin?.lng]);

  const updates = buildUpdates(t, mine ?? [], all);
  const unread = updates.filter((u) => u.at > seen).length;
  useEffect(() => { if (tab === 'updates' && updates.length) { const latest = Math.max(...updates.map((u) => u.at)); setSeen(latest); localStorage.setItem('bp_seen', String(latest)); } }, [tab, updates.length]);
  const toConfirm = [...new Set((mine ?? []).map((m) => m.incidentId))].map((id) => all.find((i) => i.id === id)).filter((i): i is Incident => !!i && i.workflow?.stage === 'RESOLVED');

  const shown = lang === 'hi' ? (nameHi || (isDevanagari(name) ? name : '')) : name;
  const needHi = lang === 'hi' && !!name && !shown;
  useEffect(() => { if (needHi) setDraftHi(toHindiName(name)); }, [needHi, name]);

  const tabs = [['report', t('tabHome'), Home, 0], ['mine', t('tabTrack'), CalendarClock, 0], ['updates', t('tabAlerts'), Bell, unread], ['help', t('help'), LifeBuoy, 0]] as const;
  const ghost = { background: '#f1f5f9', color: '#064e3b', border: 0 };
  return (
    <div className="cz">
      <header className="top">
        <div className="topin">
          <div className="row between"><a href="#/" style={{ textDecoration: 'none' }}><Logo /></a><div className="row"><button className="btn sm hi-toggle" onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>{lang === 'en' ? 'हिंदी में देखें' : 'View in English'}</button><LangPicker lang={lang} setLang={setLang} style={ghost} /><button className="btn sm" style={ghost} onClick={onLogout} aria-label={t('logout')}><LogOut size={16} /></button></div></div>
          <h1 style={{ fontSize: 26, marginTop: 18, letterSpacing: -0.5 }}>{t('hello')}{shown ? ` ${shown}` : ''} 👋 {name && <button className="btn sm" style={{ ...ghost, padding: '4px 8px', verticalAlign: 'middle' }} aria-label="edit name" onClick={() => { const n = window.prompt(t('yourName'), shown || name)?.trim(); if (!n) return; if (lang === 'hi' || isDevanagari(n)) { setNameHi(n); localStorage.setItem('bp_name_hi', n); } if (!isDevanagari(n)) setName(n); }}><Pencil size={13} /></button>}</h1>
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>{place?.zone && <span className="where" style={{ marginTop: 0 }}><MapPin size={14} /> {place.zone.locality} · {place.zone.name}</span>}<CityPicker onChange={() => location.reload()} /></div>
        </div>
      </header>
      <div className="cz-body">
      <main className="wrapc">
        {needHi && (
          <section className="card fade">
            <h2>{t('nameHiPrompt')}</h2>
            <p className="muted small" style={{ margin: '4px 0 10px' }}>{t('nameHiHint')}</p>
            <div className="row"><input className="input" style={{ flex: 1 }} value={draftHi} onChange={(e) => setDraftHi(e.target.value)} /><button className="btn primary" disabled={!draftHi.trim()} onClick={() => { setNameHi(draftHi.trim()); localStorage.setItem('bp_name_hi', draftHi.trim()); }}>{t('save')}</button></div>
          </section>
        )}
        {toConfirm.map((i) => <FixedBanner key={i.id} t={t} inc={i} onChange={refresh} />)}
        {tab === 'report' && <ReportTab t={t} lang={lang} geo={geo} locate={() => { manual.current = false; locate(); }} pin={pin} setPin={setPin} health={health} city={city} locality={place?.zone?.locality} goMine={() => setTab('mine')} onLogout={onLogout} />}
        {tab === 'mine' && <MyComplaints t={t} lang={lang} mine={mine} all={all} refresh={refresh} />}
        {tab === 'updates' && <Updates t={t} lang={lang} updates={updates} seen={seen} />}
        {tab === 'help' && <HelpPanel t={t} pin={pin} locate={() => { manual.current = false; locate(); }} finding={geo.status === 'finding'} />}
      </main>
      <CitizenAside t={t} lang={lang} setLang={setLang} city={city} mine={mine?.length ?? 0} open={all.filter((i) => ['open', 'escalated'].includes(i.status)).length} />
      </div>
      <nav className="tabbar">{tabs.map(([k, label, Icon, n]) => <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}><Icon size={22} />{label}{n > 0 && <span className="dot">{n}</span>}</button>)}</nav>
    </div>
  );
}

/** Desktop only: the town live in 3D, and what happens to a report. */
function CitizenAside({ t, lang, setLang, city, mine, open }: { t: T; lang: Lang; setLang: (l: Lang) => void; city?: City; mine: number; open: number }) {
  const [sum, setSum] = useState<{ fixed: number; avgHours: number | null }>();
  useEffect(() => { api.summary().then((s) => setSum({ fixed: s.totals.fixed, avgHours: s.totals.avgHours })).catch(() => undefined); }, []);
  return (
    <aside className="cz-aside">
      <section className="cz-live">
        <div className="cz-live-top"><span className="live" /> {city?.name ?? t('authLive')}</div>
        <div className="cz-live-stats"><div><b>{open}</b><span>{t('nOpen')}</span></div><div><b>{sum?.fixed ?? '–'}</b><span>{t('asideFixed')}</span></div><div><b>{sum?.avgHours ? `${sum.avgHours}h` : '–'}</b><span>{t('nAvg')}</span></div></div>
      </section>
      <GraphCard compact t={t} />
      <VoiceCard lang={lang} setLang={setLang} t={t} />
      <section className="card cz-how">
        <h3>{t('asideHow')}</h3>
        <ol><li><b>{t('asideH1')}</b><span>{t('asideH1s')}</span></li><li><b>{t('asideH2')}</b><span>{t('asideH2s')}</span></li><li><b>{t('asideH3')}</b><span>{t('asideH3s')}</span></li></ol>
        <p className="muted small">{t('asideMine', { n: mine })}</p>
      </section>
    </aside>
  );
}

function FixedBanner({ t, inc, onChange }: { t: T; inc: Incident; onChange: () => void }) {
  const [photo, setPhoto] = useState<string>();
  useEffect(() => { api.proofFor(inc.id, 'citizen').then((r) => setPhoto(r.photo)).catch(() => undefined); }, [inc.id]);
  const what = t((Object.entries(inc.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTHER_WATER') as Key);
  const act = async (a: string) => { try { await api.actAsCitizen(inc.id, a); onChange(); } catch (e) { toast((e as ApiError).message, true); } };
  return (
    <div className="banner fade">
      <b>{t('m_resolved', { what })}</b>
      {photo && <PhotoView src={photo} alt={t('fixPhoto')} />}
      <div className="row"><button className="btn primary" onClick={() => act('confirm')}>{t('yes')}</button><button className="btn" onClick={() => act('reopen')}>{t('no')}</button></div>
    </div>
  );
}

function Updates({ t, lang, updates, seen }: { t: T; lang: Lang; updates: Update[]; seen: number }) {
  if (updates.length === 0) return <section className="card empty fade"><span className="big"><Bell /></span><p className="muted">{t('noUpdates')}</p></section>;
  return (
    <section className="card fade">
      {updates.map((u) => <div key={u.key} className={`msg ${u.at > seen ? 'new' : ''}`}><span className="mi"><Bell size={18} /></span><div><p>{u.text}</p><p className="muted small">{new Date(u.at).toLocaleString(localeOf(lang))}</p><ReadAloud text={u.text} lang={lang} t={t} /></div></div>)}
    </section>
  );
}

function shareLink(t: T, id: string, what: string): void {
  const url = `${location.origin}${location.pathname}#/join/${encodeURIComponent(id)}`;
  const text = t('shareText', { what });
  if (navigator.share) navigator.share({ text, url }).catch(() => undefined);
  else { window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank'); navigator.clipboard?.writeText(url).then(() => toast(t('copied'))).catch(() => undefined); }
}

function MyComplaints({ t, lang, mine, all, refresh }: { t: T; lang: Lang; mine?: MyComplaint[]; all: Incident[]; refresh: () => void }) {
  if (!mine) return <section className="card"><Skeleton h={120} /></section>;
  if (mine.length === 0) return <section className="card empty fade"><span className="big"><FileText /></span><p className="muted">{t('noneYet')}</p></section>;
  const seen = new Set<string>();
  return (
    <>
      {mine.map((m) => {
        const inc = all.find((i) => i.id === m.incidentId);
        if (inc) { if (seen.has(inc.id)) return null; seen.add(inc.id); }
        const road = categoryOf(m.issueType) === 'ROADS';
        return (
          <section key={m.id} className="card fade">
            <div className="row between wrap">
              <div className="row"><span className="badge" style={{ background: road ? 'var(--amber)' : 'var(--blue)', width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', color: '#fff' }}>{road ? <Construction size={20} /> : <Droplets size={20} />}</span><div><b>{t(m.issueType as Key)}</b><p className="muted small">{new Date(m.createdAt).toLocaleString(localeOf(lang))}{m.address ? ` · ${m.address}` : ''}</p></div></div>
              <div className="row">{inc && <span className="pill soft">{t(`st_${inc.workflow?.stage ?? 'REPORTED'}` as Key)}</span>}<ReadAloud lang={lang} t={t} text={`${t(m.issueType as Key)}. ${inc ? t(`st_${inc.workflow?.stage ?? 'REPORTED'}` as Key) : t('waiting')}.`} />{(!inc || !isDoneStage(inc)) && <button className="btn sm" onClick={() => shareLink(t, inc?.id ?? m.id, t(m.issueType as Key))}><Share2 size={14} /> {t('share')}</button>}</div>
            </div>
            {m.office && <p className="small" style={{ marginTop: 10 }}><Building2 size={14} style={{ verticalAlign: -2 }} /> {t('withOffice')} <b>{m.office.name}</b>{m.office.handles.length > 1 && <span className="pill soft" style={{ marginLeft: 8 }}>{t('waterRoads')}</span>}</p>}
            {inc?.workflow && !isDoneStage(inc) && <p className="small muted" style={{ marginTop: 6 }}><Clock size={14} style={{ verticalAlign: -2 }} /> {t('expectBy', { when: new Date(inc.workflow.slaDueAt).toLocaleString(localeOf(lang), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</p>}
            {inc?.repeat && <p className="small" style={{ color: 'var(--purple)', fontWeight: 700, marginTop: 4 }}>{t('repeatNote')}</p>}
            {inc ? <Cycle t={t} lang={lang} inc={inc} office={m.office?.name} onChange={refresh} /> : (
              <div className="notice" style={{ marginTop: 12 }}><b>{t('waiting')}</b><p className="small muted">{t('waitingSub')}</p></div>
            )}
          </section>
        );
      })}
    </>
  );
}
const isDoneStage = (i: Incident): boolean => ['RESOLVED', 'CONFIRMED', 'CLOSED'].includes(i.workflow?.stage ?? '');

function Cycle({ t, lang, inc, office, onChange }: { t: T; lang: Lang; inc: Incident; office?: string; onChange: () => void }) {
  const w = inc.workflow;
  const stage = w?.stage ?? 'REPORTED';
  const done = stepsDone(stage);
  const rejected = !!w?.rejection && ['REJECTED', 'DISPUTED', 'CLOSED'].includes(stage);
  const [objecting, setObjecting] = useState(false);
  const [note, setNote] = useState('');
  const [cert, setCert] = useState<{ valid: boolean; role?: string; what?: string }>();
  useEffect(() => { if (['CONFIRMED', 'CLOSED'].includes(stage) && !w?.rejection) api.certificate(inc.id, ctx.reporterId).then(setCert).catch(() => undefined); }, [stage, inc.id]);

  const act = async (action: string, body: Record<string, unknown> = {}) => { try { await api.actAsCitizen(inc.id, action, body); onChange(); } catch (e) { toast((e as ApiError).message, true); } };
  const entry = (action: string | null) => (action ? [...(w?.audit ?? [])].reverse().find((a) => a.action === action) : w?.audit[0]);
  const time = (at: number) => new Date(at).toLocaleString(localeOf(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const handler = roleName(t, levelRole(w?.level ?? 1));

  return (
    <div>
      <div className="cycle">
        {STEPS.map(([key, action, Icon], n) => {
          const state = rejected && n === 1 ? 'bad' : n < done && !(rejected && n > 1) ? 'done' : n === done && !rejected ? 'now' : 'todo';
          const e = entry(action);
          const meta = state === 'bad' ? `${t('rejected')}: ${w?.rejection?.reason ?? ''}` : state === 'done' && e ? `${roleName(t, e.role)} · ${time(e.at)}` : state === 'now' ? `${t('withOffice')} ${office ?? handler} · ${handler}` : '';
          return (
            <div key={key} className={`cstep ${state}`}>
              <span className="node">{state === 'done' ? <Check size={17} /> : <Icon size={16} />}</span>
              <div><b>{t(key)}</b>{meta && <p className="meta">{meta}</p>}</div>
            </div>
          );
        })}
      </div>

      {rejected && !w?.disputed && (
        <div className="notice">
          <b>{t('rejected')}</b>
          {!objecting ? <div style={{ marginTop: 8 }}><button className="btn danger sm" onClick={() => setObjecting(true)}>{t('objection')}</button></div> : (
            <div className="stack" style={{ marginTop: 8 }}>
              <textarea className="input" rows={2} placeholder={t('objectionHint')} value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn primary sm" onClick={() => act('dispute', { note })}>{t('sendObjection')}</button>
            </div>
          )}
        </div>
      )}
      {w?.disputed && <p className="small" style={{ color: 'var(--purple)', fontWeight: 700 }}>{t('objected')}</p>}

      {inc.hasProof && ['PROOF_REVIEW', 'RESOLVED', 'CONFIRMED', 'CLOSED'].includes(stage) && <ProofPhoto t={t} id={inc.id} />}
      {cert?.valid && <Certificate t={t} incidentId={inc.id} role={cert.role ?? ''} what={cert.what ?? ''} />}
    </div>
  );
}

function ProofPhoto({ t, id }: { t: T; id: string }) {
  const [photo, setPhoto] = useState<string>();
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (asked) api.proofFor(id, 'citizen').then((r) => setPhoto(r.photo)).catch(() => undefined); }, [asked, id]);
  return photo ? <div style={{ marginTop: 10 }}><PhotoView src={photo} alt={t('fixPhoto')} /></div> : <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setAsked(true)}><CamIcon size={14} /> {t('fixPhoto')}</button>;
}

function Certificate({ t, incidentId, role, what }: { t: T; incidentId: string; role: string; what: string }) {
  const [qr, setQr] = useState('');
  const [name, setName] = useState(localStorage.getItem('bp_name') ?? '');
  useEffect(() => { QRCode.toDataURL(`${location.origin}${location.pathname}#/verify/${encodeURIComponent(incidentId)}/${ctx.reporterId}`, { margin: 1, width: 120 }).then(setQr); }, [incidentId]);
  return (
    <div className="cert fade">
      <HeartHandshake color="var(--blue)" size={30} />
      <h3 style={{ margin: 0 }}>{t('cert')}</h3><p className="muted small">{t('certSub')}</p>
      <input className="name" value={name} placeholder={t('namePh')} onChange={(e) => { setName(e.target.value); localStorage.setItem('bp_name', e.target.value); }} />
      <p>{t('firstBy')}: <b>{what}</b></p>
      <span className="pill ok">{role}</span>
      {qr && <img src={qr} alt="QR" width={110} height={110} />}
      <button className="btn sm no-print" onClick={() => window.print()}>{t('print')}</button>
    </div>
  );
}

/** The page a neighbour lands on from a shared link: see the problem, sign in, confirm it from where they are. */
export function Join({ id, lang, setLang }: { id: string; lang: Lang; setLang: (l: Lang) => void }) {
  const t = makeT(lang);
  const [item, setItem] = useState<{ issueType: string; family: string; reports: number } | null | undefined>();
  const [authed, setAuthed] = useState(!!ctx.token);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  useEffect(() => { fetch(`${(import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000'}/public/item/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then(setItem).catch(() => setItem(null)); }, [id]);
  async function confirm() {
    setState('busy');
    navigator.geolocation.getCurrentPosition(async (p) => {
      try { await api.metooAny(id, p.coords.latitude, p.coords.longitude); setState('done'); } catch (e) { toast((e as ApiError).message, true); setState('idle'); }
    }, () => { toast(t('denied'), true); setState('idle'); }, { enableHighAccuracy: true, timeout: 15000 });
  }
  if (item === undefined) return <div className="auth"><Skeleton h={160} /></div>;
  if (!authed && item) return <PhoneLogin t={t} lang={lang} setLang={setLang} onDone={() => setAuthed(true)} />;
  return (
    <AuthShell t={t} lang={lang} setLang={setLang}>
      <button className="backlink" onClick={goHome}><ArrowLeft size={18} /> {t('backHome')}</button>
      <div className="row between"><Logo dark /><CityPicker /></div>
      <div className="card" style={{ marginTop: 18 }}>
        {!item ? <p>{t('joinGone')}</p> : state === 'done' ? <div className="success"><div className="check"><Check size={40} /></div><h2>{t('confirmed')}</h2><a className="btn primary lg" style={{ marginTop: 14 }} href="#/citizen">{t('track')}</a></div> : (
          <div className="stack">
            <h2>{t('joinTitle')}</h2>
            <p className="row"><span className="badge" style={{ background: item.family === 'ROAD' ? 'var(--amber)' : 'var(--blue)', width: 40, height: 40, borderRadius: 12, display: 'grid', placeItems: 'center', color: '#fff' }}>{item.family === 'ROAD' ? <Construction size={20} /> : <Droplets size={20} />}</span><b>{t(item.issueType as Key)}</b></p>
            <p className="muted">{t('joinSub')}</p>
            <button className="btn primary lg" disabled={state === 'busy'} onClick={confirm}><ThumbsUp size={18} /> {t('metoo')}</button>
            <LangPicker lang={lang} setLang={setLang} className="btn ghost sm" />
          </div>
        )}
      </div>
    </AuthShell>
  );
}

export function Verify({ id, reporter }: { id: string; reporter: string }) {
  const [r, setR] = useState<{ valid: boolean; role?: string; what?: string }>();
  useEffect(() => { api.certificate(id, reporter).then(setR).catch(() => setR({ valid: false })); }, [id, reporter]);
  return <div className="auth"><button className="backlink" onClick={goHome}><ArrowLeft size={18} /> BharatPulse</button><div className="card"><h2>Certificate check</h2><p style={{ marginTop: 10 }}>{!r ? 'Checking…' : r.valid ? <span className="ok"><b>Valid.</b> {r.role} for a {r.what}.</span> : <span className="error">Not valid.</span>}</p></div></div>;
}

function HelpPanel({ t, pin, locate, finding }: { t: T; pin?: { lat: number; lng: number }; locate: () => void; finding: boolean }) {
  const [cat, setCat] = useState<'WATER' | 'ROADS'>('WATER');
  const [p, setP] = useState<Place>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setP(undefined); setFailed(false); if (pin) api.place(pin.lat, pin.lng, cat).then(setP).catch(() => setFailed(true)); }, [pin?.lat, pin?.lng, cat]);
  const maps = (q: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const offices = [...(p?.office ? [{ name: p.office.name, address: p.office.address, phone: p.office.phone, sample: !!p.office.sample, both: p.officeHandlesBoth }] : []), ...(p?.nearby?.offices ?? []).map((o) => ({ name: o.name, address: o.address, phone: o.phone, sample: false, both: false }))];
  return (
    <>
      <section className="card fade">
        <h2>{t('helpNow')}</h2>
        <div className="contact sos" style={{ marginTop: 12 }}><span className="ico"><Phone /></span><div className="grow"><b>{t('emergency')}</b><p className="muted small">112</p></div><a className="btn danger sm" href="tel:112">{t('call')}</a></div>
      </section>
      <section className="card fade d1">
        <div className="chips" style={{ marginBottom: 12 }}>{(['WATER', 'ROADS'] as const).map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c === 'WATER' ? t('water') : t('road')}</button>)}</div>
        {!pin ? (
          <div className="stack"><p className="muted">{t('noPlace')}</p><button className="btn primary" disabled={finding} onClick={locate}><LocateFixed size={18} /> {finding ? t('locating') : t('findLocBtn')}</button></div>
        ) : failed ? <p className="muted">{t('zoneNone')}</p> : !p ? <div className="stack"><p className="muted small">{t('loadingOffices')}</p><Skeleton h={80} /></div> : (
          <div className="stack">
            {p.nearby?.address && <p className="small muted"><MapPin size={14} style={{ verticalAlign: -2 }} /> {t('youAreNear')}: {p.nearby.address}</p>}
            {p.contact ? (
              <div className="contact"><span className="ico"><Users /></span><div className="grow"><b>{t('zoneContact')}</b><p className="small">{p.contact.name}</p><p className="muted small">{p.contact.phone}{p.contact.sample && <> · <span className="pill soft">{t('sample')}</span></>}</p></div>{!p.contact.sample && <a className="btn primary sm" href={`tel:${p.contact.phone}`}>{t('call')}</a>}</div>
            ) : <p className="muted small">{t('zoneNone')}</p>}
            <h3 style={{ margin: '6px 0 0' }}>{t('nearOffices')}</h3>
            {offices.length === 0 && <p className="muted small">{t('zoneNone')}</p>}
            {offices.map((o, n) => (
              <div key={n} className="contact">
                <span className="ico"><Building2 /></span>
                <div className="grow">
                  <b>{o.name}</b>{o.sample && <> <span className="pill soft">{t('sample')}</span></>}
                  {o.address && <p className="muted small">{o.address}</p>}
                  {o.phone ? <p className="small">{o.phone}</p> : <p className="muted small">{t('phoneNotListed')}</p>}
                  {o.both && <p className="small" style={{ color: 'var(--teal-d)', fontWeight: 600, marginTop: 4 }}>{t('bothOffice')}</p>}
                </div>
                <div className="stack" style={{ gap: 6 }}>{o.phone && !o.sample && <a className="btn primary sm" href={`tel:${o.phone.replace(/\s/g, '')}`}>{t('call')}</a>}<a className="btn sm" href={maps(`${o.name} ${o.address ?? ''}`)} target="_blank" rel="noreferrer">{t('directions')}</a></div>
              </div>
            ))}
            {offices.some((o) => !o.sample) && <p className="muted small">{t('checkNote')}</p>}
          </div>
        )}
      </section>
    </>
  );
}
