import { useEffect, useState } from 'react';
import { Toasts } from './components';
import { Citizen, Join, Verify } from './Citizen';
import { Community } from './Community';
import { Home } from './Home';
import { api } from './api';
import { packReady, type Lang } from './i18n';
import { setServerVoice } from './voice';
import { Officer } from './Officer';
import { Onboard } from './Onboard';
import { setCity } from './api';

const route = () => location.hash.replace(/^#\/?/, '');

export function App() {
  const [r, setR] = useState(route());
  const saved = localStorage.getItem('bp_lang') ?? 'en';
  const [lang, setLangState] = useState<Lang>(packReady(saved) ? saved : 'en');
  useEffect(() => { api.health().then((h) => setServerVoice(!!h.voice)).catch(() => undefined); }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const setLang = (l: Lang) => { localStorage.setItem('bp_lang', l); setLangState(l); };
  useEffect(() => { const f = () => { setR(route()); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  // A shared city link: #/c/<city-id> opens that city's citizen app.
  const cityLink = r.match(/^c\/([a-z0-9-]+)$/);
  useEffect(() => { if (cityLink) { setCity(cityLink[1]); location.hash = '#/citizen'; } }, [cityLink?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const verify = r.match(/^verify\/([^/]+)\/([^/]+)$/);
  const join = r.match(/^join\/([^/]+)$/);
  return (
    <>
      {verify ? <Verify id={decodeURIComponent(verify[1])} reporter={verify[2]} /> : join ? <Join id={decodeURIComponent(join[1])} lang={lang} setLang={setLang} /> : r.startsWith('onboard') ? <Onboard /> : r.startsWith('community') ? <Community lang={lang} setLang={setLang} /> : r.startsWith('officer') ? <Officer /> : r.startsWith('citizen') ? <Citizen lang={lang} setLang={setLang} /> : <Home lang={lang} setLang={setLang} />}
      <Toasts />
    </>
  );
}
