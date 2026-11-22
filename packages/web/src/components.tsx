import { Building2, ChevronDown, Languages, Loader2, MapPin, Search } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, ctx, setCity, type CityInfo, type Suggestion } from './api';
import { addPack, englishStrings, LANGS, makeT, packReady, type Lang } from './i18n';

/** Tiny global toast: call `toast('text')` from anywhere, render <Toasts /> once. */
const listeners = new Set<(t: { id: number; text: string; bad: boolean } | null) => void>();
let nextId = 1;
export const toast = (text: string, bad = false): void => listeners.forEach((l) => l({ id: nextId++, text, bad }));
export function Toasts() {
  const [t, setT] = useState<{ id: number; text: string; bad: boolean } | null>(null);
  useEffect(() => { listeners.add(setT); return () => void listeners.delete(setT); }, []);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), 3800); return () => clearTimeout(h); }, [t]);
  return t ? <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.text}</div> : null;
}

/** A number that counts up to its value, so the dashboard feels alive. */
export function CountUp({ value }: { value: number | string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (typeof value !== 'number') return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => { const p = Math.min(1, (now - start) / 700); setShown(Math.round(value * (1 - (1 - p) ** 3))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{typeof value === 'number' ? shown : value}</>;
}

const MAP_D = 'M40 2L47 4 52 10 50 17 57 22 64 24 66 29 74 31 82 30 90 33 96 32 97 37 90 40 85 38 80 41 74 40 68 43 66 48 62 53 62 60 58 68 55 78 52 90 50 98 47 90 43 79 38 69 33 62 28 55 22 53 16 50 8 48 6 43 12 40 20 40 18 36 22 31 29 28 30 22 36 17 36 9Z';
export const IndiaMark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 104" aria-hidden="true"><path d={MAP_D} fill="#fff" /></svg>
);
export const Logo = ({ dark = false }: { dark?: boolean }) => (
  <div className="logo" style={dark ? { color: '#156246' } : undefined}><span className="mark"><IndiaMark size={26} /></span>BharatPulse</div>
);

export const Skeleton = ({ h = 18, w = '100%' }: { h?: number; w?: string }) => <div className="skeleton" style={{ height: h, width: w }} />;


/** Soft Red Fort backdrop (SVG, hazy and low-contrast so it reads as scenery). Put a real photo at public/landing-bg.jpg and it is used instead. */
export function FortScene({ wave = true }: { wave?: boolean }) {
  const [photo, setPhoto] = useState(false);
  useEffect(() => { const i = new Image(); i.onload = () => setPhoto(true); i.src = '/landing-bg.jpg'; }, []);
  const tower = (x: number, h: number, k: string) => (
    <g key={k}>
      <rect x={x - 26} y={190 - h} width="52" height={h} fill="url(#fs-stone)" />
      <rect x={x - 26} y={190 - h} width="14" height={h} fill="#7d2e1d" opacity=".25" />
      <rect x={x - 31} y={184 - h} width="62" height="8" fill="#b9553a" />
      {[-16, 0, 16].map((d) => <path key={d} d={`M${x + d - 5} ${190 - h + 40}v18a5 5 0 0 0 10 0v-18a5 5 0 0 0-10 0z`} fill="#5c2214" opacity=".55" />)}
      <path d={`M${x - 20} ${184 - h}a20 20 0 0 1 40 0z`} fill="url(#fs-dome)" />
      <rect x={x - 1.5} y={150 - h} width="3" height="14" fill="#e3b562" />
    </g>
  );
  return (
    <div className="fortscene" aria-hidden="true">
      {photo ? <div className="photo" /> : (
        <svg className="fort" viewBox="0 0 1200 300" preserveAspectRatio="xMidYMax meet">
          <defs>
            <linearGradient id="fs-stone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d98e6e" /><stop offset="1" stopColor="#a9482f" /></linearGradient>
            <linearGradient id="fs-dome" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fbf6ee" /><stop offset="1" stopColor="#cfc4b4" /></linearGradient>
            <linearGradient id="fs-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b2e6d3" stopOpacity="0.55" /><stop offset="0.6" stopColor="#b2e6d3" stopOpacity="0.1" /><stop offset="1" stopColor="#b2e6d3" stopOpacity="0" /></linearGradient>
            <linearGradient id="fs-lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#96e0c5" /><stop offset="1" stopColor="#cce9de" /></linearGradient>
            <linearGradient id="fs-bush" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4f8f43" /><stop offset="1" stopColor="#2c6a2c" /></linearGradient>
            <pattern id="fs-cren" width="20" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#b9553a" /></pattern>
            <pattern id="fs-arch" width="26" height="40" patternUnits="userSpaceOnUse"><path d="M7 40V22a6 6 0 0 1 12 0v18z" fill="#5c2214" opacity=".45" /></pattern>
            <filter id="fs-soft"><feGaussianBlur stdDeviation="0.7" /></filter>
            <filter id="fs-blur"><feGaussianBlur stdDeviation="2.5" /></filter>
            <g id="fs-fort">
              <rect x="0" y="118" width="1200" height="72" fill="url(#fs-stone)" />
              <rect x="0" y="106" width="1200" height="13" fill="url(#fs-cren)" />
              <rect x="0" y="130" width="1200" height="40" fill="url(#fs-arch)" />
              <rect x="0" y="168" width="1200" height="6" fill="#8f3a25" opacity=".7" />
              {tower(200, 92, 'a')}{tower(340, 110, 'b')}{tower(860, 110, 'c')}{tower(1000, 92, 'd')}
              <rect x="480" y="52" width="240" height="138" fill="url(#fs-stone)" />
              <rect x="472" y="44" width="256" height="10" fill="#b9553a" />
              <rect x="480" y="52" width="40" height="138" fill="#7d2e1d" opacity=".22" />
              {[510, 555, 600, 645, 690].map((x) => <path key={x} d={`M${x - 13} 44a13 13 0 0 1 26 0z`} fill="url(#fs-dome)" />)}
              <path d="M566 190v-58a34 34 0 0 1 68 0v58z" fill="#4a1a0e" opacity=".85" />
              <path d="M578 190v-46a22 22 0 0 1 44 0v46z" fill="#2e0f07" opacity=".7" />
              {[520, 680].map((x) => <path key={x} d={`M${x - 11} 150v-18a11 11 0 0 1 22 0v18z`} fill="#5c2214" opacity=".5" />)}
            </g>
          </defs>
          <rect x="0" y="190" width="1200" height="110" fill="url(#fs-lake)" />
          <g filter="url(#fs-soft)"><use href="#fs-fort" /></g>
          <rect x="0" y="40" width="1200" height="150" fill="url(#fs-haze)" />
          <g opacity="0.22" filter="url(#fs-blur)" transform="translate(0 380) scale(1 -1)"><use href="#fs-fort" /></g>
          <g filter="url(#fs-blur)"><ellipse cx="40" cy="176" rx="130" ry="42" fill="url(#fs-bush)" /><ellipse cx="1160" cy="176" rx="130" ry="42" fill="url(#fs-bush)" /><ellipse cx="540" cy="192" rx="200" ry="10" fill="#3a7a35" opacity=".5" /><ellipse cx="660" cy="192" rx="200" ry="10" fill="#3a7a35" opacity=".5" /></g>
        </svg>
      )}
      {wave && (
        <svg className="wave" viewBox="0 0 1200 120" preserveAspectRatio="none">
          <path d="M0 30C250 95 650 110 1200 20L1200 40C650 130 250 115 0 50Z" fill="#f97316" />
          <path d="M0 50C250 115 650 130 1200 40L1200 58C650 148 250 133 0 68Z" fill="#fff" />
          <path d="M0 68C250 133 650 148 1200 58L1200 76C650 166 250 151 0 86Z" fill="#138808" />
          <path d="M0 86C250 151 650 166 1200 76L1200 120L0 120Z" fill="#156246" />
        </svg>
      )}
    </div>
  );
}

export const IndiaEmblem = () => (
  <svg className="india-emblem" viewBox="0 0 160 170" aria-hidden="true">
    <defs>
      <linearGradient id="ie-map" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3fdda3" /><stop offset=".55" stopColor="#1e8a63" /><stop offset="1" stopColor="#0d4b35" /></linearGradient>
      <linearGradient id="ie-ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#f97316" /><stop offset=".5" stopColor="#ffffff" /><stop offset="1" stopColor="#138808" /></linearGradient>
      <radialGradient id="ie-glow" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#ffe9a8" stopOpacity=".95" /><stop offset=".45" stopColor="#ffc86b" stopOpacity=".35" /><stop offset="1" stopColor="#ffc86b" stopOpacity="0" /></radialGradient>
      <filter id="ie-blur"><feGaussianBlur stdDeviation="2.2" /></filter>
    </defs>
    <circle cx="80" cy="84" r="78" fill="url(#ie-glow)" />
    <g transform="translate(22 14) scale(1.15)">
      <path d={MAP_D} fill="#ffd479" opacity=".55" filter="url(#ie-blur)" />
      <path d={MAP_D} fill="url(#ie-map)" stroke="#ffe3a3" strokeWidth="1.2" strokeLinejoin="round" />
      <g stroke="#ffd98a" strokeWidth=".7" opacity=".9"><line x1="44" y1="12" x2="52" y2="24" /><line x1="44" y1="12" x2="40" y2="30" /><line x1="52" y1="24" x2="40" y2="30" /><line x1="52" y1="24" x2="62" y2="34" /><line x1="62" y1="34" x2="74" y2="36" /><line x1="74" y1="36" x2="84" y2="36" /><line x1="40" y1="30" x2="30" y2="40" /><line x1="40" y1="30" x2="50" y2="44" /><line x1="62" y1="34" x2="50" y2="44" /><line x1="62" y1="34" x2="66" y2="46" /><line x1="50" y1="44" x2="66" y2="46" /><line x1="30" y1="40" x2="22" y2="46" /><line x1="30" y1="40" x2="50" y2="44" /><line x1="50" y1="44" x2="44" y2="56" /><line x1="66" y1="46" x2="56" y2="62" /><line x1="44" y1="56" x2="56" y2="62" /><line x1="44" y1="56" x2="48" y2="74" /><line x1="56" y1="62" x2="48" y2="74" /><line x1="48" y1="74" x2="50" y2="90" /></g>
      <g fill="#fff3c9"><circle cx="44" cy="12" r="1.8" /><circle cx="52" cy="24" r="1.8" /><circle cx="40" cy="30" r="1.8" /><circle cx="62" cy="34" r="1.8" /><circle cx="74" cy="36" r="1.8" /><circle cx="84" cy="36" r="1.8" /><circle cx="30" cy="40" r="1.8" /><circle cx="50" cy="44" r="1.8" /><circle cx="66" cy="46" r="1.8" /><circle cx="22" cy="46" r="1.8" /><circle cx="44" cy="56" r="1.8" /><circle cx="56" cy="62" r="1.8" /><circle cx="48" cy="74" r="1.8" /><circle cx="50" cy="90" r="1.8" /></g>
    </g>
    <ellipse cx="80" cy="96" rx="74" ry="24" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth="13" transform="rotate(-20 80 96)" filter="url(#ie-blur)" />
    <ellipse cx="80" cy="96" rx="74" ry="24" fill="none" stroke="url(#ie-ring)" strokeWidth="9" strokeLinecap="round" transform="rotate(-20 80 96)" />
    <g fill="#fff"><path d="M18 22l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" opacity=".95" /><path d="M140 14l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" opacity=".9" /><circle cx="148" cy="60" r="2" opacity=".8" /><circle cx="10" cy="70" r="1.6" opacity=".8" /></g>
  </svg>
);

export const Swoosh = () => (
  <svg className="swoosh" viewBox="0 0 360 26" preserveAspectRatio="none" aria-hidden="true">
    <path d="M2 8C90 22 230 24 358 2" stroke="#f97316" strokeWidth="4" fill="none" strokeLinecap="round" />
    <path d="M2 13C90 27 230 29 358 7" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
    <path d="M2 18C90 32 230 34 358 12" stroke="#138808" strokeWidth="4" fill="none" strokeLinecap="round" />
  </svg>
);
/**
 * Language picker: English and Hindi are built in; the other 9 are translated by Sarvam-Translate on the server the
 * first time anyone asks (then cached on the server and in this browser).
 */
export function LangPicker({ lang, setLang, className = 'btn sm', style }: { lang: Lang; setLang: (l: Lang) => void; className?: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const t = makeT(lang);
  const cur = LANGS.find((l) => l.code === lang) ?? LANGS[0];
  async function pick(code: Lang, bcp: string, name: string) {
    setOpen(false);
    if (packReady(code)) return setLang(code);
    setBusy(code);
    toast(t('translatingApp', { lang: name }));
    try {
      const r = await api.languagePack(bcp, englishStrings());
      if (Object.keys(r.strings).length === 0) throw new Error('empty');
      addPack(code, r.strings);
      setLang(code);
      toast(makeT(code)('langReady', { lang: name }));
    } catch {
      toast(t('langUnavailable'), true);
    } finally { setBusy(undefined); }
  }
  return (
    <span className="langpick">
      <button className={className} style={style} onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label={t('chooseLang')}>
        <Languages size={16} /> {busy ? <Loader2 size={15} className="spin" /> : null} {cur.name}
      </button>
      {open && (
        <>
          <span className="langpick-bg" onClick={() => setOpen(false)} />
          <span className="langpick-menu" role="listbox">
            {LANGS.map((l) => <button key={l.code} role="option" aria-selected={l.code === lang} className={l.code === lang ? 'on' : ''} onClick={() => pick(l.code, l.bcp, l.name)}>{l.name}{l.code !== 'en' && l.code !== 'hi' && !packReady(l.code) && <small>Sarvam</small>}</button>)}
          </span>
        </>
      )}
    </span>
  );
}


const Scene3DLazy = lazy(() => import('./Scene3D'));
/** The 3D city network, loaded only when shown (three.js is ~150 KB gzipped). */
const TwinLazy = lazy(() => import('./CityTwin'));
/** The live 3D twin of the current city (see CityTwin.tsx), loaded only when shown. */
export const Twin = (p: import('./CityTwin').TwinProps) => <Suspense fallback={<div className={`twin ${p.mode ?? 'ambient'}`} aria-hidden="true" />}><TwinLazy {...p} /></Suspense>;
export const Scene = ({ variant = 'city', offset = 0 }: { variant?: 'city' | 'sky'; offset?: number }) => <Suspense fallback={<div className={`scene3d ${variant}`} aria-hidden="true" />}><Scene3DLazy variant={variant} offset={offset} /></Suspense>;

/**
 * Search box that suggests places while you type, like a maps app (OpenStreetMap Photon on the server, India only).
 * Arrow keys + Enter, or tap a suggestion.
 */
export function PlaceSearch({ onPick, placeholder = 'Search a town, area or landmark', autoFocus = false }: { onPick: (s: Suggestion) => void; placeholder?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<Suggestion[]>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(0);
  const [failed, setFailed] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    if (q.trim().length < 2) { setList(undefined); return; }
    const n = ++last.current;
    const h = setTimeout(async () => {
      setBusy(true); setFailed(false);
      try { const r = await api.suggest(q.trim()); if (n === last.current) { setList(r); setCur(0); setOpen(true); } } catch { if (n === last.current) { setFailed(true); setList([]); } } finally { if (n === last.current) setBusy(false); }
    }, 220);
    return () => clearTimeout(h);
  }, [q]);
  const pick = (s: Suggestion) => { setQ(s.name); setOpen(false); onPick(s); };
  return (
    <div className="psearch">
      <div className="psearch-box">
        <Search size={18} />
        <input value={q} autoFocus={autoFocus} placeholder={placeholder} aria-label={placeholder} role="combobox" aria-expanded={open} aria-autocomplete="list"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => { if (!list?.length) return; if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(list.length - 1, c + 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); } if (e.key === 'Enter') { e.preventDefault(); pick(list[cur]); } }} />
        {busy && <Loader2 size={16} className="spin" />}
      </div>
      {open && list && q.trim().length >= 2 && (
        <ul className="psearch-list" role="listbox">
          {list.length === 0 ? <li className="none">{failed ? 'Place search is not reachable from the server right now.' : 'No places found. Try the town or district name.'}</li> : list.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`} role="option" aria-selected={i === cur} className={i === cur ? 'on' : ''} onMouseDown={() => pick(s)} onMouseEnter={() => setCur(i)}>
              <MapPin size={16} /><span><b>{s.name}</b><small>{s.detail || s.kind}</small></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Which city you are in. Changing it signs officers out (each city has its own officers). */
export function CityPicker({ onChange, dark = false }: { onChange?: (c: CityInfo) => void; dark?: boolean }) {
  const [cities, setCities] = useState<CityInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.cities().then(setCities).catch(() => undefined); }, []);
  const cur = cities.find((c) => c.id === ctx.city);
  return (
    <span className={`citypick ${dark ? 'dark' : ''}`}>
      <button className="citypick-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox"><Building2 size={16} /> {cur?.name ?? 'Choose city'} <ChevronDown size={14} /></button>
      {open && (
        <>
          <span className="langpick-bg" onClick={() => setOpen(false)} />
          <span className="citypick-menu" role="listbox">
            {cities.map((c) => <button key={c.id} role="option" aria-selected={c.id === ctx.city} className={c.id === ctx.city ? 'on' : ''} onClick={() => { setCity(c.id); setOpen(false); onChange?.(c); }}><b>{c.name}</b><small>{c.state} · {c.wards} wards{c.kind === 'demo' ? ' · demo' : ''}</small></button>)}
            <a href="#/onboard" className="citypick-new">+ Add your city</a>
          </span>
        </>
      )}
    </span>
  );
}
