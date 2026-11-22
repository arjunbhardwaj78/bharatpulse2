import { ArrowLeft, ArrowRight, Building2, Check, CheckCircle2, Copy, Droplets, Factory, KeyRound, Landmark, Loader2, MapPin, Route, School, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, setCity, type CityInfo, type Plan, type Suggestion } from './api';
import { IndiaMark, PlaceSearch, toast } from './components';
import { PinMap } from './MapView';

const STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
/** Who can run a workspace (mirrors server/src/orgs.ts). */
const ORGS = [
  { id: 'municipality', sector: 'Government', label: 'Municipality / Nagar Palika', area: 'Ward', eg: 'Nagar Palika Parishad Dibai', icon: Landmark },
  { id: 'water_utility', sector: 'Private', label: 'Water utility', area: 'Service zone', eg: 'Sitapur Water Services Pvt Ltd', icon: Droplets },
  { id: 'toll_road', sector: 'Private', label: 'Highway / toll road', area: 'Stretch', eg: 'NH-19 Tollway (Palwal-Hodal)', icon: Route },
  { id: 'industrial_park', sector: 'Private', label: 'Industrial park / SEZ', area: 'Block', eg: 'Hodal Industrial Park', icon: Factory },
  { id: 'campus', sector: 'Private', label: 'Campus / hospital', area: 'Block', eg: 'AIIMS campus, Rewari', icon: School },
] as const;
const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast('Copied')).catch(() => toast('Copy failed', true));

/**
 * Self-serve onboarding: a municipality brings its city onto the platform in a minute and starts a pilot.
 * It gets its own ward map and water network (a draft it can correct), officer accounts with its own password,
 * its own data space in the graph, and can create an API key for its existing portal.
 */
export function Onboard() {
  const initialPlan = new URLSearchParams(location.hash.split('?')[1] ?? '').get('plan') ?? 'pilot';
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [org, setOrg] = useState<(typeof ORGS)[number]['id']>('municipality');
  const O = ORGS.find((o) => o.id === org)!;
  const isPrivate = O.sector === 'Private';
  const [name, setName] = useState('');
  const [state, setState] = useState('Uttar Pradesh');
  const [place, setPlace] = useState<{ lat: number; lng: number; label?: string }>();
  const [wards, setWards] = useState(8);
  const [email, setEmail] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plan, setPlan] = useState(initialPlan);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ tenant: CityInfo; officerPassword: string }>();
  useEffect(() => { api.plans().then(setPlans).catch(() => undefined); }, []);

  const picked = (s: Suggestion) => {
    setPlace({ lat: s.lat, lng: s.lng, label: [s.name, s.detail].filter(Boolean).join(', ') });
    if (!name && !isPrivate) setName(`${s.name} ${/city|nagar|corporation/i.test(s.kind) ? '' : 'Nagar Palika'}`.trim());
    const st = STATES.find((x) => s.detail.includes(x));
    if (st) setState(st);
  };
  const ok1 = name.trim().length >= 3 && !!place;
  async function create() {
    if (!place) return;
    setBusy(true);
    try {
      const r = await api.createCity({ name: name.trim(), state, lat: place.lat, lng: place.lng, wards, plan, email: email.trim() || undefined, orgType: org });
      setDone(r); setStep(3);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const base = location.origin + location.pathname;
  const apiBase = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

  return (
    <div className="onb">
      <div className="onb-in">
        <a href="#/" className="snav-brand"><span className="snav-mark"><IndiaMark size={22} /></span><span>BharatPulse</span></a>
        <div className="onb-card fade">
          <div className="onb-steps">{['Your organisation', 'Plan', 'Ready'].map((l, i) => <span key={l} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}><i>{step > i + 1 ? <Check size={14} /> : i + 1}</i>{l}</span>)}</div>

          {step === 1 && (
            <div className="stack">
              <h1>Bring your organisation onto BharatPulse</h1>
              <div className="orgpick" role="radiogroup" aria-label="Type of organisation">{ORGS.map(({ id, sector, label, icon: I }) => (
                <button key={id} role="radio" aria-checked={org === id} className={`orgopt ${org === id ? 'on' : ''}`} onClick={() => { setOrg(id); setPlan(id === 'municipality' ? initialPlan : 'site'); }}><span className="oi"><I size={20} /></span><span><b>{label}</b><small>{sector}</small></span></button>
              ))}</div>
              <p className="muted">Find your location. We draw a starting map of {O.area.toLowerCase()}s and a water network around it; your engineers can correct it later.</p>
              <PlaceSearch onPick={picked} placeholder="Search your town, e.g. Dibai, Hodal, Sitapur" autoFocus />
              {place && <p className="small"><MapPin size={14} style={{ verticalAlign: -2 }} /> {place.label ?? `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`} · drag the pin to the town centre</p>}
              <div className="onb-map"><PinMap value={place} onChange={(p) => setPlace({ ...p, label: place?.label })} center={place ? [place.lat, place.lng] : [23.5, 80]} /></div>
              <div className="grid2">
                <label className="field">Name of the body<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${O.eg}`} maxLength={60} /></label>
                <label className="field">State<select value={state} onChange={(e) => setState(e.target.value)}>{STATES.map((s) => <option key={s}>{s}</option>)}</select></label>
              </div>
              <label className="field">{O.area}s to start with: <b>{wards}</b><input type="range" min={2} max={40} value={wards} onChange={(e) => setWards(Number(e.target.value))} /></label>
              <label className="field">Contact email (optional)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={isPrivate ? 'operations@company.in' : 'eo@yourtown.gov.in'} /></label>
              <button className="btn primary lg" disabled={!ok1} onClick={() => setStep(2)}>Next: choose a plan <ArrowRight size={18} /></button>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <h1>Choose how to start</h1>
              <p className="muted">Pricing is a pilot hypothesis. Nothing is charged in this build.</p>
              <div className="onb-plans">{plans.filter((p) => (isPrivate ? p.id === 'pilot' || p.id === 'site' || p.id === 'connect' : p.id !== 'site')).map((p) => (
                <button key={p.id} className={`onb-plan ${plan === p.id ? 'on' : ''}`} disabled={wards > p.maxWards} onClick={() => setPlan(p.id)}>
                  <b>{p.name}</b><span className="price">{p.price}</span><small>{p.blurb}</small>{wards > p.maxWards && <small className="error">Up to {p.maxWards} wards</small>}
                </button>
              ))}</div>
              <div className="row between"><button className="btn" onClick={() => setStep(1)}><ArrowLeft size={18} /> Back</button><button className="btn orange lg" disabled={busy} onClick={create}>{busy ? <Loader2 className="spin" size={18} /> : <Building2 size={18} />} Create {name || 'my workspace'}</button></div>
            </div>
          )}

          {step === 3 && done && (
            <div className="stack">
              <div className="onb-ok"><CheckCircle2 size={40} /><div><h1>{done.tenant.name} is live</h1><p className="muted">{done.tenant.wards} {O.area.toLowerCase()}s · {done.tenant.plan} plan · its own data space in the graph</p></div></div>
              <div className="secret">
                <KeyRound size={18} />
                <div className="grow"><b>Officer password (shown once)</b><p className="small muted">Accounts: field1, zonal1, head1 (admin), commissioner1 (admin). Save it now.</p><code>{done.officerPassword}</code></div>
                <button className="btn sm" onClick={() => copy(done.officerPassword)}><Copy size={15} /> Copy</button>
              </div>
              <div className="onb-links">
                <button className="onb-link" onClick={() => { setCity(done.tenant.id); location.hash = '#/officer'; }}><Landmark size={22} /><b>Open the officer portal</b><small>Sign in as head1 to open the City account tab: API keys, webhooks, CSV import, usage.</small></button>
                <button className="onb-link" onClick={() => { setCity(done.tenant.id); location.hash = '#/citizen'; }}><Users size={22} /><b>Open the citizen app</b><small>Share this link with residents:</small><code onClick={(e) => { e.stopPropagation(); copy(`${base}#/c/${done.tenant.id}`); }}>{`${base}#/c/${done.tenant.id}`}</code></button>
              </div>
              <details className="acc"><summary>Connect your existing portal (API)</summary>
                <p className="small" style={{ margin: '8px 0' }}>Create an API key in City account, then send complaints from your portal. Results come back by webhook or from <code>GET /v1/incidents</code>.</p>
                <pre className="code">{`curl -X POST ${apiBase}/v1/complaints \\
  -H "x-api-key: bp_live_..." -H "content-type: application/json" \\
  -d '{"source":"cpgrams","complaints":[{"externalId":"CPG-1021","reporter":"citizen-77",
       "text":"सुबह से पानी नहीं आया","lat":${done.tenant.center.lat.toFixed(4)},"lng":${done.tenant.center.lng.toFixed(4)},
       "createdAt":"2026-11-21T08:10:00Z"}]}'`}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
