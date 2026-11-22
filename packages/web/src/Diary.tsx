import { CheckCircle2, Clock, Megaphone, Volume2, VolumeX, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError, type Checkin, type Notice } from './api';
import { toast } from './components';
import { bcpOf, localeOf, type Key, type Lang } from './i18n';
import { hasServerVoice, speakText, stopVoice } from './voice';
import { canSpeak, istDate } from './util';

type T = (k: Key, v?: Record<string, string | number>) => string;
const STATUS: [Checkin['status'], Key, typeof CheckCircle2, string][] = [['CAME', 'diaryCame', CheckCircle2, 'var(--green)'], ['LATE', 'diaryLate', Clock, 'var(--amber)'], ['NONE', 'diaryNone', XCircle, 'var(--red)']];

/** "Did water come today?" One tap a day. Many answers together show how supply really is, with no complaint needed. */
export function DiaryCard({ t, lang, pin, onLogout }: { t: T; lang: Lang; pin?: { lat: number; lng: number }; onLogout: () => void }) {
  const [list, setList] = useState<Checkin[]>();
  const today = istDate(Date.now());
  const load = () => api.myCheckins().then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const mine = list?.find((c) => c.date === today);

  async function say(status: Checkin['status']) {
    if (!pin) return toast(t('diaryNeed'), true);
    try { await api.checkin(status, pin.lat, pin.lng); await load(); } catch (e) { if ((e as ApiError).status === 401) onLogout(); else toast((e as Error).message, true); }
  }
  const week = Array.from({ length: 7 }, (_, n) => { const d = istDate(Date.now() - (6 - n) * 86_400_000); return { d, c: list?.find((x) => x.date === d) }; });
  return (
    <section className="card fade d1">
      <h2>{t('diaryTitle')}</h2>
      <p className="muted small" style={{ marginBottom: 10 }}>{t('diaryHint')}</p>
      <div className="diary">{STATUS.map(([st, key, Icon, col]) => <button key={st} className={`dbtn ${mine?.status === st ? 'on' : ''}`} style={{ ['--c' as string]: col }} onClick={() => say(st)}><Icon size={22} />{t(key)}</button>)}</div>
      {mine && <p className="small ok" style={{ marginTop: 10 }}>{t('diaryThanks')}</p>}
      <p className="muted small" style={{ margin: '12px 0 6px' }}>{t('diaryWeek')}</p>
      <div className="weekdots">{week.map(({ d, c }) => <span key={d} className={`wd ${c?.status ?? ''}`} title={`${d}${c ? ` · ${c.status}` : ''}`}>{new Date(`${d}T12:00:00`).toLocaleDateString(localeOf(lang), { weekday: 'narrow' })}</span>)}</div>
    </section>
  );
}

/** Planned water cuts and road work near you, so nobody complains about something that was announced. */
export function NoticesBanner({ t, lang, pin }: { t: T; lang: Lang; pin?: { lat: number; lng: number } }) {
  const [list, setList] = useState<Notice[]>([]);
  useEffect(() => { if (!pin) return; const f = () => api.noticesNear(pin.lat, pin.lng).then(setList).catch(() => undefined); f(); const h = setInterval(f, 60_000); return () => clearInterval(h); }, [pin?.lat, pin?.lng]);
  if (list.length === 0) return null;
  const now = Date.now();
  const when = (n: number) => new Date(n).toLocaleString(localeOf(lang), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <>
      {list.map((n) => (
        <section key={n.id} className="notice fade" style={{ display: 'grid', gap: 6 }}>
          <div className="row between wrap"><b><Megaphone size={16} style={{ verticalAlign: -3 }} /> {n.title}</b><span className={`pill ${n.startsAt <= now ? 'warn' : 'soft'}`}>{n.startsAt <= now ? t('noticeNow') : t('noticePlanned')}</span></div>
          <p className="small">{n.kind === 'WATER_CUT' ? t('noticeWater') : n.kind === 'ROAD_WORK' ? t('noticeRoad') : ''} {when(n.startsAt)} {t('noticeUntil')} {when(n.endsAt)}</p>
          {n.note && <p className="small muted">{n.note}</p>}
          <p className="small muted">{t('noticeHint')}</p>
        </section>
      ))}
    </>
  );
}

/** A small speaker button: reads a message out loud, for people who find reading hard. */
export function ReadAloud({ text, lang, t }: { text: string; lang: Lang; t: T }) {
  const [on, setOn] = useState(false);
  if (!canSpeak() && !hasServerVoice()) return null;
  return <button className="btn ghost sm" aria-label={t('readAloud')} onClick={() => { if (on) { stopVoice(); setOn(false); } else { void speakText(text, bcpOf(lang)); setOn(true); const done = () => setOn(false); setTimeout(done, Math.min(60_000, text.length * 90)); } }}>{on ? <VolumeX size={15} /> : <Volume2 size={15} />} {on ? t('stopReading') : t('readAloud')}</button>;
}
