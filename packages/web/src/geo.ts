import { useCallback, useEffect, useRef, useState } from 'react';

export interface Geo { status: 'finding' | 'ok' | 'denied' | 'error' | 'unsupported'; lat?: number; lng?: number; accuracy?: number; /** true while we show the last known position and look for a fresh one */ stale?: boolean }
const KEY = 'bp_last_pos';
const DAY = 86_400_000;

/**
 * Finds the user fast. It shows the last known position at once, takes a quick coarse fix (Wi-Fi or mobile network, usually
 * under a second or two), then lets the GPS refine it for a few seconds. A slow GPS therefore never leaves the screen spinning.
 */
export function useLocation(): [Geo, () => void] {
  const [geo, setGeo] = useState<Geo>({ status: 'finding' });
  const watch = useRef<number>();
  const best = useRef(Infinity);

  const locate = useCallback(() => {
    if (!navigator.geolocation) return setGeo({ status: 'unsupported' });
    if (watch.current !== undefined) navigator.geolocation.clearWatch(watch.current);
    best.current = Infinity;
    try {
      const last = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { lat: number; lng: number; acc: number; at: number } | null;
      setGeo(last && Date.now() - last.at < DAY ? { status: 'ok', lat: last.lat, lng: last.lng, accuracy: last.acc, stale: true } : { status: 'finding' });
    } catch { setGeo({ status: 'finding' }); }

    const take = (p: GeolocationPosition) => {
      if (p.coords.accuracy >= best.current) return; // only ever improve
      best.current = p.coords.accuracy;
      localStorage.setItem(KEY, JSON.stringify({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }));
      setGeo({ status: 'ok', lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
    };
    const fail = (e: GeolocationPositionError) => setGeo((g) => (g.status === 'ok' && !g.stale ? g : { status: e.code === 1 ? 'denied' : 'error' }));

    navigator.geolocation.getCurrentPosition(take, fail, { enableHighAccuracy: false, timeout: 7000, maximumAge: 300_000 });
    watch.current = navigator.geolocation.watchPosition(take, () => undefined, { enableHighAccuracy: true, maximumAge: 0 });
    setTimeout(() => { if (watch.current !== undefined) navigator.geolocation.clearWatch(watch.current); watch.current = undefined; setGeo((g) => (g.status === 'finding' ? { status: 'error' } : g)); }, 12_000);
  }, []);

  useEffect(() => { locate(); return () => { if (watch.current !== undefined) navigator.geolocation?.clearWatch(watch.current); }; }, [locate]);
  return [geo, locate];
}
