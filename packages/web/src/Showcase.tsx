import { Languages, Mic, Network, ShieldCheck } from 'lucide-react';
import { LANGS, makeT, type Lang } from './i18n';
type T = ReturnType<typeof makeT>;
const EN = makeT('en');

/** The India map artwork (the team's image), softly faded into whatever is behind it. */
export const BharatMap = ({ className = '' }: { className?: string }) => <img className={`bharat-map ${className}`} src="/bharat-map.png" alt="" aria-hidden="true" />;

/**
 * The product in one picture: the water network as a Neo4j graph. Water flows from the tank down the pipes; two wards
 * report an outage and the graph traces both to the same feeder (root cause, orange); the wards past it are at risk;
 * a ring of linked accounts is fenced off and counts as one source.
 */
export function NetworkArt() {
  const N = { tank: [60, 70], pump: [140, 70], trunk: [230, 110], north: [330, 70], south: [330, 190], ext: [430, 60] } as const;
  const wards: [number, number, string, boolean?][] = [[300, 20, 'W3', true], [380, 125, 'W4'], [470, 120, 'W7'], [500, 20, 'W8', true], [270, 245, 'W5'], [390, 245, 'W6']];
  const E: [readonly number[], readonly number[], boolean][] = [
    [N.tank, N.pump, false], [N.pump, N.trunk, false], [N.trunk, N.north, true], [N.trunk, N.south, false], [N.north, N.ext, true],
    [N.north, [300, 20], true], [N.north, [380, 125], false], [N.ext, [470, 120], false], [N.ext, [500, 20], true], [N.south, [270, 245], false], [N.south, [390, 245], false],
  ];
  // water keeps flowing where the network is healthy; it stops past the failed feeder
  const flowing = E.filter(([, , hot]) => !hot);
  return (
    <svg className="netart" viewBox="0 0 560 300" role="img" aria-label="A water network drawn as a graph: two wards with outages are traced to the same pipe">
      <g className="edges">{E.map(([a, b, hot], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={hot ? 'hot' : ''} />)}</g>
      <g className="flowdots">{flowing.map(([a, b], i) => <circle key={i} r="3.2"><animateMotion dur={`${1.6 + (i % 3) * 0.4}s`} repeatCount="indefinite" path={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} begin={`${(i * 0.37) % 1.5}s`} /></circle>)}</g>
      {Object.entries(N).map(([k, [x, y]]) => <g key={k} className={`asset k-${k} ${k === 'north' ? 'suspect' : ''}`}><circle cx={x} cy={y} r={k === 'north' ? 17 : k === 'tank' ? 15 : 13} />{k === 'north' && <circle className="ring" cx={x} cy={y} r="17" />}</g>)}
      <text className="alabel" x="60" y="100">tank</text><text className="alabel" x="140" y="100">pump</text>
      {wards.map(([x, y, label, hit]) => <g key={label} className={`ward ${hit ? 'hit' : ''}`}><rect x={x - 19} y={y - 13} width="38" height="26" rx="8" /><text x={x} y={y + 5}>{label}</text></g>)}
      <g className="fakes">{[[150, 230], [180, 262], [120, 266], [92, 228]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="8" />)}<path d="M150 230L180 262L120 266L92 228Z" /><text x="136" y="292">ring = 1 source</text></g>
      <text className="tag" x="330" y="106">check here</text>
    </svg>
  );
}

export function GraphCard({ live, compact, t = EN }: { live?: boolean; compact?: boolean; t?: T }) {
  const [a, b] = t('scFeeder').split(/(?=one feeder|एक ही लाइन)/);
  return (
    <div className={`lp-art ${compact ? 'compact' : ''}`}>
      <div className="lp-art-head"><Network size={18} /> <b>{t('scGraph')}</b><span className={`eng ${live ? 'on' : ''}`}>{live ? t('scGraphLive') : t('scGraphEng')}</span></div>
      <NetworkArt />
      <div className="lp-art-foot">
        <span><i className="dot hit" /> {a}{b && <b>{b}</b>}</span>
        <span><ShieldCheck size={15} /> {t('scRing')}</span>
      </div>
    </div>
  );
}

/** Every app language, one tap away. Speech and translation by Sarvam AI. */
export function VoiceCard({ lang, setLang, sarvam, t = EN }: { lang?: Lang; setLang?: (l: Lang) => void; sarvam?: boolean; t?: T }) {
  return (
    <div className="lp-card lp-voice">
      <div className="lp-voice-head"><span className="micdot"><Mic size={18} /></span><div><b>{t('scSpeak')}</b><small>{sarvam ? t('scSpeakLive') : t('scSpeakSub')}</small></div></div>
      <div className="lp-langs">{LANGS.map((l) => setLang ? <button key={l.code} className={l.code === lang ? 'on' : ''} onClick={() => setLang(l.code)} title={`Use the app in ${l.name}`}>{l.name}</button> : <span key={l.code}>{l.name}</span>)}<span className="more"><Languages size={13} /> {t('scMore')}</span></div>
    </div>
  );
}
