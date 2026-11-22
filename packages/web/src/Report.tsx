import { ArrowRight, ArrowLeft, Camera, Construction, Droplets, Image as ImageIcon, Languages, Loader2, Mic, MapPin, Plus, RefreshCw, Square, ThumbsUp, Trash2, Check, LocateFixed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type City, type Health, type Heard, type NearbyItem } from './api';
import { CameraModal } from './Camera';
import { DiaryCard, NoticesBanner } from './Diary';
import { asBase64, photoToBase64 } from './photo';
import { toast } from './components';
import { bcpOf, nameOfBcp, type Key, type Lang } from './i18n';
import { useVoiceInput } from './voice';
import { NearbyMap, PinMap } from './MapView';
import { agoParts, haversine } from './util';

type T = (k: Key, v?: Record<string, string | number>) => string;
export type { Geo } from './geo';
import type { Geo } from './geo';
export interface Props { t: T; lang: Lang; geo: Geo; locate: () => void; pin?: { lat: number; lng: number }; setPin: (p: { lat: number; lng: number }) => void; health?: Health; city?: City; locality?: string; goMine: () => void; onLogout: () => void }

const TYPES = { WATER: ['NO_WATER', 'LOW_PRESSURE', 'DIRTY_WATER', 'LEAK', 'OTHER_WATER'], ROAD: ['POTHOLE', 'CAVE_IN', 'WATERLOGGING', 'OTHER_ROAD'] } as const;
const load = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') as T; } catch { return d; } };

export function ReportTab({ t, lang, geo, locate, pin, setPin, health, city, locality, goMine, onLogout }: Props) {
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [category, setCategory] = useState<'WATER' | 'ROAD'>('WATER');
  const [issue, setIssue] = useState<string>();
  const [size, setSize] = useState<1 | 2 | 3>(2);
  const [roadClass, setRoadClass] = useState('LOCAL');
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ b64: string; url: string }>();
  const [menu, setMenu] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const isOther = issue === 'OTHER_WATER' || issue === 'OTHER_ROAD';
  const opened = useRef(Date.now());
  const [heard, setHeard] = useState<Heard & { via: 'sarvam' | 'browser' }>();
  const base = useRef('');
  /** Voice: Sarvam detects the language (22 Indian languages), adds English for the officer and guesses the problem type. */
  const voice = useVoiceInput({
    who: 'citizen', browserLang: lang === 'en' ? 'en-IN' : bcpOf(lang),
    onResult: (h, via) => {
      setText((base.current ? `${base.current} ` : '') + h.text);
      setHeard({ ...h, via });
      if (h.issueType) {
        const road = (TYPES.ROAD as readonly string[]).includes(h.issueType);
        setCategory(road ? 'ROAD' : 'WATER');
        setIssue(h.issueType);
      }
    },
    onError: (m) => toast(m === 'unsupported' ? t('voiceOff') : m === 'mic' ? t('noSpeech') : m, true),
  });
  const talk = () => { if (voice.state === 'idle') base.current = text.trim(); void voice.toggle(); };
  /** The big button on the home screen: speak first, then pick the place. */
  const speakFirst = () => { base.current = ''; setText(''); setHeard(undefined); void voice.toggle(); };
  useEffect(() => { if (step === 0 && heard && voice.state === 'idle' && text.trim()) { setStep(1); window.scrollTo(0, 0); } }, [heard, voice.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const movePin = (p: { lat: number; lng: number }) => {
    if (geo.status === 'ok' && haversine(p, { lat: geo.lat!, lng: geo.lng! }) > 3000) return toast(t('pinHint'), true);
    setPin(p);
  };
  const center: [number, number] = pin ? [pin.lat, pin.lng] : city?.service ? [city.service.center.lat, city.service.center.lng] : [27.894, 77.369];
  const sample = () => city?.service && setPin(city.service.center);

  async function pick(file?: File) {
    setMenu(false);
    if (!file) return;
    try { setPhoto({ b64: await photoToBase64(file), url: URL.createObjectURL(file) }); } catch { toast(t('photoErr'), true); }
  }

  async function submit() {
    if (!pin) return toast(t('locating'), true);
    if (!issue && !text.trim() && !photo) return toast(t('needSomething'), true);
    if (isOther && text.trim().length < 5) return toast(t('needDescribe'), true);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { lat: pin.lat, lng: pin.lng, category, submitMs: Date.now() - opened.current };
      if (geo.status === 'ok') { body.deviceLat = geo.lat; body.deviceLng = geo.lng; }
      if (issue) body.issueType = issue;
      if (text.trim()) body.text = text.trim();
      if (heard?.language && heard.via === 'sarvam') body.language = heard.language;
      if (address.trim()) body.address = address.trim();
      if (photo) body.photos = [photo.b64];
      if (category === 'ROAD') { body.size = size; body.roadClass = roadClass; }
      await api.submit(body);
      window.dispatchEvent(new Event('bp-mine'));
      setDone(true);
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
      toast((e as Error).message, true);
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <section className="card success fade">
        <div className="check"><Check size={40} /></div>
        <h2>{t('thanks')}</h2>
        <p className="muted" style={{ margin: '8px 0 18px' }}>{t('thanksSub')}</p>
        <div className="stack"><button className="btn primary lg" onClick={goMine}>{t('track')}</button><button className="btn lg" onClick={() => { setDone(false); setStep(0); setIssue(undefined); setText(''); setHeard(undefined); setPhoto(undefined); setAddress(''); opened.current = Date.now(); }}>{t('another')}</button></div>
      </section>
    );
  }

  const go = (c: 'WATER' | 'ROAD') => { setCategory(c); setIssue(undefined); setStep(1); window.scrollTo(0, 0); };
  const bar = (
    <>
      <div className="stephead"><button className="back" onClick={() => setStep(step === 1 ? 0 : ((step - 1) as 1 | 2))} aria-label={t('back')}><ArrowLeft size={20} /></button><b>{t(step === 1 ? 'stepPin' : step === 2 ? 'stepWhat' : 'stepSnap')}</b><span className="muted small">{t('stepOf', { n: step })}</span></div>
      <div className="dots3"><i className="on" /><i className={step >= 2 ? 'on' : ''} /><i className={step >= 3 ? 'on' : ''} /></div>
    </>
  );
  if (step === 0) {
    return (
      <>
        <div className="bigbtns fade">
          <button className="bigbtn water" onClick={() => go('WATER')}><span className="bb-ico"><Droplets /></span><span className="bb-txt"><b>{t('repWater')}</b><small>{t('repWaterSub')}</small></span><span className="bb-go"><ArrowRight size={18} /></span></button>
          <button className="bigbtn road" onClick={() => go('ROAD')}><span className="bb-ico"><Construction /></span><span className="bb-txt"><b>{t('repRoad')}</b><small>{t('repRoadSub')}</small></span><span className="bb-go"><ArrowRight size={18} /></span></button>
        </div>
        <button className={`speakbig fade ${voice.state !== 'idle' ? 'on' : ''}`} onClick={voice.state === 'idle' ? speakFirst : talk}>
          <span className="sb-ico">{voice.state === 'thinking' ? <Loader2 className="spin" /> : voice.state === 'listening' ? <Square /> : <Mic />}</span>
          <span className="sb-txt"><b>{voice.state === 'listening' ? t('listeningTap') : voice.state === 'thinking' ? t('understanding') : t('speakBig')}</b><small>{t('speakBigSub')}</small></span>
        </button>
        <section className="card fade">
          <div className={`loc ${geo.status === 'ok' ? '' : 'bad'}`}>
            <span className="dot">{geo.status === 'finding' ? <Loader2 className="spin" /> : <MapPin />}</span>
            <div className="grow">
              <b>{geo.status === 'ok' ? `${t('found')}${locality ? `: ${locality}` : ''}` : geo.status === 'finding' ? t('locating') : t('retry')}</b>
              <p className="muted small">{geo.status === 'ok' ? `${geo.stale ? `${t('locStale')} ` : ''}${geo.accuracy !== undefined ? t('accuracy', { n: Math.round(geo.accuracy) }) : ''}` : geo.status === 'finding' ? ' ' : t('denied')}</p>
            </div>
            <button className="btn sm" onClick={locate} aria-label={t('findAgain')}><RefreshCw size={16} /></button>
          </div>
          {geo.status !== 'ok' && geo.status !== 'finding' && health && !health.geofence && <button className="btn sm" style={{ marginTop: 10 }} onClick={sample}>{t('useSample')}</button>}
        </section>
        <NoticesBanner t={t} lang={lang} pin={pin} />
        <Nearby t={t} pin={pin} onLogout={onLogout} />
        <DiaryCard t={t} lang={lang} pin={pin} onLogout={onLogout} />
      </>
    );
  }
  return (
    <>
      {bar}
      {step === 1 && (
<>
      <section className="card fade">
        <div className={`loc ${geo.status === 'ok' ? '' : 'bad'}`}>
          <span className="dot">{geo.status === 'finding' ? <Loader2 className="spin" /> : <MapPin />}</span>
          <div className="grow">
            <b>{geo.status === 'ok' ? `${t('found')}${locality ? `: ${locality}` : ''}` : geo.status === 'finding' ? t('locating') : t('retry')}</b>
            <p className="muted small">{geo.status === 'ok' ? `${geo.stale ? `${t('locStale')} ` : ''}${geo.accuracy !== undefined ? t('accuracy', { n: Math.round(geo.accuracy) }) : ''}` : geo.status === 'finding' ? ' ' : t('denied')}</p>
          </div>
          {geo.status === 'ok' && <button className="btn sm" onClick={locate} aria-label={t('findAgain')}><RefreshCw size={16} /></button>}
        </div>
        {geo.status !== 'ok' && geo.status !== 'finding' && (
          <div className="stack" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={locate}><LocateFixed size={18} /> {t('findAgain')}</button>
            <p className="muted small">{t('enableHint')}</p>
            {health && !health.geofence && <button className="btn sm" onClick={sample}>{t('useSample')}</button>}
          </div>
        )}
        <div style={{ marginTop: 12 }}><PinMap value={pin} onChange={movePin} center={center} /></div>
        <p className="muted small" style={{ margin: '8px 0 10px' }}>{t('pinHint')}</p>
        <HeardNote t={t} heard={heard} />
        <label className="field">{t('address')}<input value={address} maxLength={120} onChange={(e) => setAddress(e.target.value)} placeholder={t('addressHint')} /></label>
        <button className="btn primary lg" style={{ marginTop: 12 }} disabled={!pin} onClick={() => setStep(2)}>{t('nextBtn')}</button>
      </section>
</>
      )}
      {step === 2 && (
<>
      <section className="card fade d1">
        <h2>{t(category === 'WATER' ? 'water' : 'road')}</h2>
        <div style={{ height: 10 }} />
        <div className="chips">{TYPES[category].map((k) => <button key={k} className={`chip ${issue === k ? 'on' : ''}`} onClick={() => setIssue(issue === k ? undefined : k)}>{t(k)}</button>)}</div>
        {category === 'ROAD' && (
          <div className="stack" style={{ marginTop: 14 }}>
            <div><p className="muted small" style={{ marginBottom: 6 }}>{t('size')}</p><div className="chips">{([1, 2, 3] as const).map((n) => <button key={n} className={`chip ${size === n ? 'on' : ''}`} onClick={() => setSize(n)}>{t((['small', 'medium', 'large'] as const)[n - 1])}</button>)}</div></div>
            <label className="field">{t('roadType')}<select value={roadClass} onChange={(e) => setRoadClass(e.target.value)}><option value="LOCAL">{t('local')}</option><option value="MAIN">{t('main')}</option><option value="HIGHWAY">{t('highway')}</option></select></label>
          </div>
        )}
        <button className="btn primary lg" style={{ marginTop: 14 }} onClick={() => setStep(3)}>{t('nextBtn')}</button>
      </section>
</>
      )}
      {step === 3 && (
<>
      <section className="card fade d2">
        <h2>{t('describe')}{isOther && <span className="req"> * {t('required')}</span>}</h2>{isOther && <p className="small req">{t('needDescribe')}</p>}
        <div className="row" style={{ alignItems: 'flex-start', margin: '10px 0' }}>
          <textarea className="input" rows={3} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t('describeHint')} />
          <button className={`mic ${voice.state === 'listening' ? 'on' : ''}`} onClick={talk} aria-label={t('speak')}>{voice.state === 'thinking' ? <Loader2 className="spin" /> : <Mic />}</button>
        </div>
        {voice.state === 'listening' && <p className="small" style={{ color: 'var(--red)' }}>{t('listening')}</p>}
        <HeardNote t={t} heard={heard} />
        {photo ? (
          <div className="photo"><img src={photo.url} alt={t('yourPhoto')} /><button className="x" onClick={() => setPhoto(undefined)} aria-label={t('remove')}><Trash2 size={16} /></button></div>
        ) : (
          <div className="stack">
            <button className="btn" onClick={() => setMenu(!menu)}><Plus size={18} /> {t('photo')}</button>
            {menu && (
              <div className="photobtns fade">
                <button className="btn" onClick={() => (typeof navigator.mediaDevices?.getUserMedia === 'function' ? (setMenu(false), setCamera(true)) : document.getElementById('cam-fallback')?.click())}><Camera size={18} /> {t('takePhoto')}</button>
                <input id="cam-fallback" type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files?.[0])} />
                <label className="btn"><ImageIcon size={18} /> {t('uploadPhoto')}<input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>
              </div>
            )}
          </div>
        )}
      </section>

      <button className="btn primary lg fade d3" style={{ marginTop: 6 }} disabled={busy || !pin || (isOther && text.trim().length < 5)} onClick={submit}>{busy ? t('submitting') : `${t('submit')} (${t('stepOf', { n: 3 })})`}</button>
</>
      )}
      {camera && <CameraModal t={t} onClose={() => setCamera(false)} onFail={() => { setCamera(false); toast(t('camFail'), true); }} onCapture={(f) => { setCamera(false); pick(f); }} />}

    </>
  );
}

function Nearby({ t, pin, onLogout }: { t: T; pin?: { lat: number; lng: number }; onLogout: () => void }) {
  const [items, setItems] = useState<NearbyItem[] | undefined>();
  const [just, setJust] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'map'>('map');
  const [now, setNow] = useState(Date.now());
  const refresh = () => { if (pin) api.nearby(pin.lat, pin.lng).then((r) => { setItems(r); setNow(Date.now()); }).catch(() => setItems([])); };
  useEffect(() => { setItems(undefined); refresh(); const h = setInterval(refresh, 10000); window.addEventListener('bp-mine', refresh); return () => { clearInterval(h); window.removeEventListener('bp-mine', refresh); }; }, [pin?.lat, pin?.lng]);

  async function metoo(i: NearbyItem) {
    if (!pin) return;
    setJust((j) => [...j, i.id]); // show it as done straight away
    try { await api.metooAny(i.id, pin.lat, pin.lng); toast(t('confirmed')); } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) return onLogout();
      if (err.code !== 'already_confirmed' && err.code !== 'own_report') { setJust((j) => j.filter((x) => x !== i.id)); toast(err.message, true); }
    }
    window.dispatchEvent(new Event('bp-mine'));
  }
  const ago = (at: number) => { const [k, n] = agoParts(at, now); return t(k, { n }); };

  return (
    <section className="card fade d1">
      <div className="row between"><h2>{t('nearComplaints')}</h2><div className="chips" style={{ margin: 0 }}>{(['list', 'map'] as const).map((v) => <button key={v} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{t(v === 'list' ? 'listView' : 'mapView')}</button>)}</div></div>
      {view === 'map' && items && <div style={{ marginTop: 10 }}><NearbyMap items={items} pin={pin} /></div>}
      {!pin || !items ? <div className="stack" style={{ marginTop: 10 }}><div className="skeleton" style={{ height: 58 }} /><div className="skeleton" style={{ height: 58 }} /></div> : items.length === 0 ? <p className="muted" style={{ marginTop: 8 }}>{t('nearEmpty')}</p> : (
        <div className="stack" style={{ marginTop: 10 }}>
          {items.filter((i) => i.kind !== 'fixed').map((i) => {
            const done = i.mine || just.includes(i.id);
            return (
              <div key={i.id} className="near">
                <span className="badge" style={{ background: i.family === 'ROAD' ? 'var(--blue)' : 'var(--navy)' }}>{i.family === 'ROAD' ? <Construction size={20} /> : <Droplets size={20} />}</span>
                <div className="grow">
                  <b>{t(i.issueType as Key)}</b>
                  <p className="small">{i.people === 1 ? t('neighbourOne', { n: 1 }) : t('neighboursMany', { n: i.people })}</p>
                  <p className="muted small">{ago(i.lastAt)} · {t('away', { n: i.distanceM })}</p>
                  <p className="muted small"><span className={`tag ${i.kind === 'report' ? 'rep' : ''}`}>{i.kind === 'report' ? t('tagReported') : t('tagIncident')}</span> {i.kind === 'report' ? t('notYetIncident') : t('isIncident')}</p>
                </div>
                <button className={`btn sm face ${done ? 'done' : 'orange'}`} disabled={done} onClick={() => metoo(i)}>{done ? <><Check size={15} /> {t('youReported')}</> : <><ThumbsUp size={15} /> {t('face')}</>}</button>
              </div>
            );
          })}
          {items.filter((i) => i.kind === 'fixed').map((i) => {
            const days = Math.floor((now - i.lastAt) / 86_400_000);
            return (
              <div key={i.id} className="near" style={{ background: '#f0faf5' }}>
                <span className="badge" style={{ background: 'var(--green)' }}><Check size={20} /></span>
                <div className="grow"><b>{t(i.issueType as Key)}</b><p className="small">{days < 1 ? t('fixedToday') : t('fixedAgo', { n: days })}</p><p className="muted small">{t('away', { n: i.distanceM })} · {t('fixedBack')}</p></div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** After speaking: which language was heard, what the officer will read in English, and what the problem was taken to be. */
function HeardNote({ t, heard }: { t: T; heard?: Heard & { via: 'sarvam' | 'browser' } }) {
  if (!heard?.text) return null;
  return (
    <div className="heard fade">
      <p className="small"><Languages size={14} style={{ verticalAlign: -2 }} /> <b>{t('heardIn', { lang: nameOfBcp(heard.language) || '?' })}</b> · {heard.via === 'sarvam' ? t('viaSarvam') : t('viaBrowser')}</p>
      <p lang={heard.language}>“{heard.text}”</p>
      {heard.textEn && <p className="small muted">{t('inEnglish')}: “{heard.textEn}”</p>}
      {heard.issueType && <p className="small">{t('understoodAs')}: <b>{t(heard.issueType as Key)}</b></p>}
    </div>
  );
}
