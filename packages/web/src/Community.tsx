import { ArrowLeft, Camera, CheckCircle2, LocateFixed, MapPin, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type PublicSummary, type SupplyWard } from './api';
import { LangPicker, Logo, PlaceSearch } from './components';
import { useLocation } from './geo';
import { makeT, type Key, type Lang } from './i18n';

interface Area { name: string; lat: number; lng: number }
const load = (): Area | null => { try { return JSON.parse(localStorage.getItem('bp_area') ?? 'null') as Area | null; } catch { return null; } };
const short = (name: string) => name.split(',').slice(0, 2).join(',').trim();

/** Open numbers for the area around you (or any town you search for): reported, fixed, how fast, ward by ward. No sign-in needed. */
export function Community({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  const t = makeT(lang);
  const [geo, locate] = useLocation();
  const [area, setArea] = useState<Area | null>(load);
  const [km, setKm] = useState(10);
  const [s, setS] = useState<PublicSummary>();
  const [supply, setSupply] = useState<SupplyWard[]>();
  const [label, setLabel] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Area[] | null>(null);
  const [searching, setSearching] = useState(false);

  const center = area ?? (geo.status === 'ok' ? { name: '', lat: geo.lat!, lng: geo.lng! } : null);
  useEffect(() => {
    if (!center) return;
    setS(undefined);
    const f = () => { api.summary({ lat: center.lat, lng: center.lng, km }).then(setS).catch(() => undefined); api.supply({ lat: center.lat, lng: center.lng, km }).then((r) => setSupply(r.wards.slice(0, 8))).catch(() => undefined); };
    f(); const h = setInterval(f, 15000); return () => clearInterval(h);
  }, [center?.lat, center?.lng, km]);
  useEffect(() => {
    if (!center) return;
    if (area) return setLabel(short(area.name));
    api.place(center.lat, center.lng, 'WATER').then((p) => setLabel(p.zone ? `${p.zone.locality} · ${p.zone.name}` : p.nearby?.address ? short(p.nearby.address) : t('cYourLoc'))).catch(() => setLabel(t('cYourLoc')));
  }, [center?.lat, center?.lng, area]);

  async function search(text = q) {
    if (text.trim().length < 3) return;
    setSearching(true);
    try { setFound((await api.searchPlace(text.trim())).map((p) => ({ name: p.name, lat: p.lat, lng: p.lng }))); } catch { setFound([]); } finally { setSearching(false); }
  }
  useEffect(() => { if (q.trim().length < 3) { setFound(null); return; } const h = setTimeout(() => void search(q), 450); return () => clearTimeout(h); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (a: Area | null) => { if (a) localStorage.setItem('bp_area', JSON.stringify(a)); else localStorage.removeItem('bp_area'); setArea(a); setFound(null); setQ(''); if (!a) locate(); };
  const back = () => { const to = sessionStorage.getItem('bp_back') ?? '#/'; sessionStorage.removeItem('bp_back'); location.hash = to; };
  const maxWard = Math.max(1, ...(s?.wards.map((w) => w.open + w.fixed) ?? [1]));

  return (
    <div className="cm">
      <div className="hero2"><div className="in">
        <div className="row between"><button className="backlink light" onClick={back}><ArrowLeft size={18} /> {t('back')}</button><LangPicker lang={lang} setLang={setLang} className="lang-small" /></div>
        <a href="#/" style={{ textDecoration: 'none', color: '#fff', display: 'inline-block', marginTop: 8 }}><Logo /></a>
        <h1 className="fade" style={{ fontSize: 34, marginTop: 22, letterSpacing: -0.8 }}>{t('cTitle')}</h1>
        <p className="fade d1" style={{ color: '#d1fae5', marginTop: 8 }}>{t('cSub')}</p>
      </div></div>
      <div className="body">
        <section className="card fade">
          <div className="row between wrap">
            <p className="row" style={{ gap: 8 }}><MapPin size={18} color="var(--blue)" />{center ? <span>{t('cShowing', { n: km })} <b>{label || '…'}</b></span> : <span className="muted">{geo.status === 'finding' ? t('locating') : t('cNeedLoc')}</span>}</p>
            <div className="chips">{[5, 10, 25].map((n) => <button key={n} className={`chip ${km === n ? 'on' : ''}`} onClick={() => setKm(n)}>{n} km</button>)}</div>
          </div>
          <div className="row wrap" style={{ marginTop: 12 }}>
            <div style={{ flex: 1, minWidth: 240 }}><PlaceSearch placeholder={t('cSearchPh')} onPick={(p) => choose({ name: [p.name, p.detail].filter(Boolean).join(', '), lat: p.lat, lng: p.lng })} /></div>
            <button className="btn" onClick={() => choose(null)}><LocateFixed size={16} /> {t('cUseMine')}</button>
          </div>
          {found && <div className="stack" style={{ marginTop: 10 }}>{found.length === 0 ? <p className="muted small">{t('cNoPlaces')}</p> : found.map((f) => <button key={`${f.lat}${f.lng}`} className="near" style={{ textAlign: 'left' }} onClick={() => choose(f)}><MapPin size={18} /> <span className="small">{f.name}</span></button>)}</div>}
        </section>

        {center && (
          <>
            <div className="bigs">{([['reports', 'cReports'], ['open', 'cOpen'], ['fixed', 'cFixed'], ['avgHours', 'cHours']] as const).map(([k, label], n) => <div key={k} className={`big4 fade d${n}`}><b>{s ? (s.totals[k] ?? '–') : '…'}</b><span>{t(label)}</span></div>)}</div>
            {s && s.totals.reports === 0 && <section className="card empty"><span className="big"><MapPin /></span><p className="muted">{t('cNoData')}</p></section>}
            {s && s.wards.length > 0 && (
              <section className="card">
                <h2>{t('cWards')}</h2>
                <table className="wards"><thead><tr><th>{t('cWard')}</th><th /><th>{t('cFixedCol')}</th><th>{t('cOpenCol')}</th><th>{t('cAvg')}</th></tr></thead>
                  <tbody>{s.wards.map((w) => <tr key={w.id}><td><b>{w.name}</b></td><td style={{ width: '38%' }}><div className="bands"><i style={{ flex: w.fixed, background: 'var(--green)' }} /><i style={{ flex: w.open, background: 'var(--amber)' }} /><i style={{ flex: Math.max(0, maxWard - w.open - w.fixed), background: 'transparent' }} /></div></td><td>{w.fixed}</td><td>{w.open}</td><td>{w.avgHours ?? '–'}</td></tr>)}</tbody>
                </table>
                {s.moreWards > 0 && <p className="muted small" style={{ marginTop: 8 }}>{t('cMore', { n: s.moreWards })}</p>}
              </section>
            )}
            {supply && (
              <section className="card">
                <h2>{t('sTitle')}</h2><p className="muted small" style={{ marginBottom: 6 }}>{t('sSub')}</p>
                {supply.length === 0 ? <p className="muted">{t('sNone')}</p> : supply.map((w) => (
                  <div key={w.id} className="supplyrow" style={{ ['--c' as string]: w.reliability >= 80 ? 'var(--green)' : w.reliability >= 50 ? 'var(--amber)' : 'var(--red)' }}>
                    <b>{w.name}</b>
                    <div><div className="track"><div style={{ width: `${w.reliability}%` }} /></div><p className="muted small">{t('sReliab', { n: w.reliability })} · {t('sPeople', { n: w.people })}</p></div>
                    {w.chronic ? <span className="pill warn">{t('sChronic')}</span> : <span />}
                  </div>
                ))}
              </section>
            )}
            {s && s.recentlyFixed.length > 0 && (
              <section><h2 style={{ margin: '0 0 12px' }}>{t('cRecent')}</h2><div className="fixedcards">{s.recentlyFixed.map((f) => <FixedCard key={f.id} f={f} t={t} />)}</div></section>
            )}
          </>
        )}
        <a className="btn primary lg" href="#/citizen" style={{ textDecoration: 'none' }}>{t('reportBtn')}</a>
      </div>
    </div>
  );
}

function FixedCard({ f, t }: { f: PublicSummary['recentlyFixed'][number]; t: (k: Key) => string }) {
  const [photo, setPhoto] = useState<string>();
  useEffect(() => { if (f.hasProof) api.publicProof(f.id).then((r) => setPhoto(r.photo)).catch(() => undefined); }, [f.id, f.hasProof]);
  return (
    <div className="fixedcard fade">
      <div className="ph">{photo ? <img src={photo} alt={t('cPhoto')} /> : f.hasProof ? <Camera /> : <CheckCircle2 size={36} />}</div>
      <div className="t"><b>{t(f.issueType as Key)}</b><p className="muted small">{f.ward ?? ''}{f.hours !== null ? ` · ${f.hours} h` : ''}</p></div>
    </div>
  );
}
