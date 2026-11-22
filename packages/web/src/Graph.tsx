import { useEffect, useRef, useState } from 'react';
import { api, type Graph } from './api';
import { CypherBox } from './GraphPage';

/** Neo4j Browser's colours, so the picture looks like what an officer would see in the database itself. */
const LABEL: Record<string, { color: string; border: string; size: number }> = {
  Incident: { color: '#F79767', border: '#f36924', size: 64 },
  Reporter: { color: '#F16667', border: '#eb2728', size: 40 },
  Complaint: { color: '#34D399', border: '#059669', size: 34 },
  Device: { color: '#D9C8AE', border: '#c0a378', size: 44 },
  Photo: { color: '#8DCC93', border: '#5db665', size: 44 },
};
const MAX = 45;

type Cy = import('cytoscape').Core;

/**
 * Who is behind one incident, drawn like Neo4j Browser: (:Reporter)-[:FILED]->(:Complaint)-[:PART_OF]->(:Incident),
 * (:Complaint)-[:FROM_DEVICE]->(:Device), (:Complaint)-[:HAS_PHOTO]->(:Photo). A phone or photo shared by many
 * accounts pulls them into one knot, which is exactly what makes a fake campaign visible. Drag, zoom, tap.
 */
export function GraphView({ id }: { id: string }) {
  const [g, setG] = useState<Graph>();
  const [picked, setPicked] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Cy>();
  useEffect(() => { api.graph(id).then(setG).catch(() => setG({ nodes: [], edges: [], sharedDevices: [] })); }, [id]);

  useEffect(() => {
    if (!g || !box.current) return;
    let alive = true;
    const complaints = g.nodes.filter((n) => n.type === 'Complaint').slice(0, MAX).map((n) => n.id);
    const keep = new Set(complaints);
    for (const e of g.edges) if (keep.has(e.from) || keep.has(e.to)) { keep.add(e.from); keep.add(e.to); }
    const shared = new Set(g.sharedDevices.map((d) => `dev:${d.deviceId}`));
    const degree = new Map<string, number>();
    for (const e of g.edges) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    import('cytoscape').then(({ default: cytoscape }) => {
      if (!alive || !box.current) return;
      cy.current?.destroy();
      cy.current = cytoscape({
        container: box.current,
        elements: [
          ...g.nodes.filter((n) => keep.has(n.id)).map((n) => {
            const st = LABEL[n.type] ?? LABEL.Complaint;
            const many = (n.type === 'Device' || n.type === 'Photo') && (degree.get(n.id) ?? 0) > 2;
            const caption = n.type === 'Incident' ? 'Incident' : n.type === 'Reporter' ? n.label.replace(/^r_/, '').slice(0, 6) : n.type === 'Complaint' ? n.label.toLowerCase().replace(/_/g, ' ').slice(0, 10) : n.label.replace('phone ', '').slice(0, 6);
            return { data: { id: n.id, type: n.type, caption, color: st.color, border: many || shared.has(n.id) ? '#b42318' : st.border, bw: many || shared.has(n.id) ? 5 : 2, size: st.size + (many ? Math.min(30, (degree.get(n.id) ?? 0) * 2) : 0) } };
          }),
          ...g.edges.filter((e) => keep.has(e.from) && keep.has(e.to)).map((e, i) => ({ data: { id: `e${i}`, source: e.from, target: e.to, type: e.type } })),
        ],
        style: [
          { selector: 'node', style: { 'background-color': 'data(color)', 'border-color': 'data(border)', 'border-width': 'data(bw)', width: 'data(size)', height: 'data(size)', label: 'data(caption)', color: '#fff', 'font-size': 9, 'font-weight': 700, 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'ellipsis', 'text-max-width': 'data(size)', 'text-outline-color': 'data(border)', 'text-outline-width': 1 } },
          { selector: 'edge', style: { width: 1.4, 'line-color': '#a5abb6', 'target-arrow-color': '#a5abb6', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier', label: 'data(type)', 'font-size': 6, color: '#78716c', 'text-rotation': 'autorotate', 'text-background-color': '#fff', 'text-background-opacity': 1, 'text-background-padding': '1px' } },
          { selector: 'node:selected', style: { 'overlay-color': '#047857', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
        ],
        layout: { name: 'cose', animate: false, padding: 16, idealEdgeLength: () => 46, nodeRepulsion: () => 5200, gravity: 0.6, randomize: false } as never,
        wheelSensitivity: 0.25,
        autoungrabify: true, // nodes stay where the layout put them; drag the background to pan
      });
      cy.current.on('tap', 'node', (e) => { const d = e.target.data(); setPicked(`(:${d.type}) ${d.id.replace(/^(dev|photo):/, '')}`); });
    });
    return () => { alive = false; cy.current?.destroy(); cy.current = undefined; };
  }, [g]);

  if (!g) return <p className="muted">Loading graph…</p>;
  const counts = Object.entries(g.nodes.reduce<Record<string, number>>((m, n) => ({ ...m, [n.type]: (m[n.type] ?? 0) + 1 }), {}));
  const owner = new Map(g.edges.filter((e) => e.type === 'FILED').map((e) => [e.to, e.from]));
  const photoOwners = new Map<string, Set<string>>();
  for (const e of g.edges.filter((x) => x.type === 'HAS_PHOTO')) photoOwners.set(e.to, (photoOwners.get(e.to) ?? new Set()).add(owner.get(e.from) ?? e.from));
  const sharedPhotos = [...photoOwners.values()].filter((s) => s.size > 1).length;
  return (
    <div>
      <div className="neo-labels">{counts.map(([t, n]) => <span key={t} style={{ background: LABEL[t]?.color, borderColor: LABEL[t]?.border }}>{t} ({n})</span>)}</div>
      <div ref={box} className="neograph" aria-label="Graph of the accounts, reports, phones and photos behind this incident" />
      {picked && <p className="small picked">{picked}</p>}
      <p className="muted small">
        {g.sharedDevices.length > 0 ? `${g.sharedDevices.length} phone(s) used by 3 or more accounts (red ring). Each counts as one source. ` : 'No phone is shared by 3 or more accounts. '}
        {sharedPhotos > 0 && `${sharedPhotos} photo(s) appear in reports from different accounts (red ring): the same picture pasted into many reports. `}
        {g.nodes.filter((n) => n.type === 'Complaint').length > MAX && `Showing the first ${MAX} reports.`}
      </p>
      <CypherBox cypher={g.cypher} engine={g.engine} />
    </div>
  );
}
