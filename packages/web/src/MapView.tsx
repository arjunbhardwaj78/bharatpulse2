import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { City, Incident, NearbyItem } from './api';

/** Leaflet tooltips render HTML: anything from data is escaped first. */
const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
import { LEVEL_COLOR, VERIFY_COLOR } from './util';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; OpenStreetMap contributors';

function useMap(center: [number, number], onReady: (map: L.Map) => void) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current).setView(center, 15);
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(m);
    map.current = m;
    onReady(m);
    return () => { m.remove(); map.current = undefined; };
  }, []);
  return { el, map };
}

/** Officer map: one circle per incident, coloured by level (purple when it needs verification). */
export function IncidentMap({ incidents, selected, onSelect, city, reports = [], tall = false, focus }: { incidents: Incident[]; selected?: string; onSelect: (id: string) => void; city?: City; reports?: { lat: number; lng: number }[]; tall?: boolean; focus?: { lat: number; lng: number; zoom?: number } }) {
  const layer = useRef(L.layerGroup());
  const fitted = useRef(false);
  const start: [number, number] = city?.service ? [city.service.center.lat, city.service.center.lng] : city ? [city.localities[0].lat, city.localities[0].lng] : [27.4924, 77.6737];
  const { el, map } = useMap(start, (m) => layer.current.addTo(m));
  useEffect(() => {
    layer.current.clearLayers();
    for (const i of incidents) {
      const color = i.trust.needsVerification ? VERIFY_COLOR : LEVEL_COLOR[i.severity.level];
      L.circle([i.centroid.lat, i.centroid.lng], { radius: Math.max(i.radiusMeters, 40), color, weight: i.id === selected ? 4 : 2, fillOpacity: 0.25, className: i.severity.level === 'CRITICAL' && !i.trust.needsVerification ? 'pulse' : '' })
        .bindTooltip(esc(`${i.severity.level} ${i.severity.score}`)).on('click', () => onSelect(i.id)).addTo(layer.current);
    }
    for (const r of reports) L.circleMarker([r.lat, r.lng], { radius: 5, color: '#78716c', fillColor: '#78716c', fillOpacity: 0.8, weight: 1 }).bindTooltip('New report').addTo(layer.current);
    if (!fitted.current && incidents.length > 0 && map.current) {
      map.current.fitBounds(L.latLngBounds(incidents.map((i) => [i.centroid.lat, i.centroid.lng] as [number, number])).pad(0.4), { maxZoom: 16 });
      fitted.current = true;
    }
  }, [incidents, selected, reports.length]);
  useEffect(() => { if (focus && map.current) map.current.setView([focus.lat, focus.lng], focus.zoom ?? 15); }, [focus?.lat, focus?.lng]);
  return <div ref={el} className="map" style={tall ? { height: 'min(70vh, 640px)' } : undefined} />;
}

/** Citizen map: tap to place the pin. */
export function PinMap({ value, onChange, center }: { value?: { lat: number; lng: number }; onChange: (p: { lat: number; lng: number }) => void; center: [number, number] }) {
  const pin = useRef<L.CircleMarker>();
  const { el, map } = useMap(center, (m) => m.on('click', (e) => onChange({ lat: e.latlng.lat, lng: e.latlng.lng })));
  useEffect(() => {
    if (!map.current || !value) return;
    pin.current?.remove();
    pin.current = L.circleMarker([value.lat, value.lng], { radius: 9, color: '#C8402C', fillColor: '#C8402C', fillOpacity: 0.9 }).addTo(map.current);
    map.current.panTo([value.lat, value.lng]);
  }, [value?.lat, value?.lng]);
  return <div ref={el} className="map small" />;
}

/** The problems around you on a map: blue and amber are open incidents, grey are single reports waiting for neighbours, green were fixed recently. */
export function NearbyMap({ items, pin }: { items: NearbyItem[]; pin?: { lat: number; lng: number } }) {
  const layer = useRef(L.layerGroup());
  const start: [number, number] = pin ? [pin.lat, pin.lng] : [27.894, 77.369];
  const { el, map } = useMap(start, (m) => layer.current.addTo(m));
  useEffect(() => {
    layer.current.clearLayers();
    const pts: [number, number][] = [];
    if (pin) { L.circleMarker([pin.lat, pin.lng], { radius: 8, color: '#e5484d', fillColor: '#e5484d', fillOpacity: 1 }).bindTooltip('You').addTo(layer.current); pts.push([pin.lat, pin.lng]); }
    for (const i of items) {
      const color = i.kind === 'fixed' ? '#22a06b' : i.kind === 'report' ? '#78716c' : i.family === 'ROAD' ? '#f5a524' : '#047857';
      L.circle([i.lat, i.lng], { radius: i.kind === 'incident' ? 140 : 70, color, weight: 2, fillOpacity: 0.3 }).bindTooltip(esc(`${i.issueType.replace(/_/g, ' ').toLowerCase()} · ${i.people}`)).addTo(layer.current);
      pts.push([i.lat, i.lng]);
    }
    if (pts.length > 1 && map.current) map.current.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 });
  }, [items, pin?.lat, pin?.lng]);
  return <div ref={el} className="map small" />;
}
