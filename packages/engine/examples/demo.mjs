// Run after `npm run build`:  node packages/engine/examples/demo.mjs
import { detectIncidents } from '../dist/index.js';

const now = Date.UTC(2026, 9, 12, 12, 0, 0);
const min = 60_000;
const BASE = { lat: 27.4924, lng: 77.6737 };
const m = (metres) => metres / 111_195;
let n = 0;
const c = (type, northM, minutesAgo, reporter) => ({
  id: `C${++n}`,
  reporterId: reporter ?? `resident-${n}`,
  issueType: type,
  lat: BASE.lat + m(northM),
  lng: BASE.lng,
  createdAt: now - minutesAgo * min,
});

const complaints = [
  // A supply failure that started ~4 hours ago and is still growing
  ...[0, 60, 120, 200, 260, 330, 400, 480, 520].map((d, i) => c(i % 3 ? 'NO_WATER' : 'LOW_PRESSURE', d, 240 - i * 25 + (i > 6 ? -10 : 0))),
  // Dirty water in a different ward, just started
  c('DIRTY_WATER', 4000, 25), c('DIRTY_WATER', 4060, 18), c('DIRTY_WATER', 4120, 9),
  // One person reporting the same leak five times
  ...[40, 35, 30, 25, 20].map((t) => c('LEAK', 8000, t, 'angry-resident')),
  // A lone complaint
  c('NO_WATER', 12000, 15),
  // Bad data
  { ...c('NO_WATER', 0, 5), lat: 999 },
];

const result = detectIncidents(complaints, now);
console.log(`Incidents: ${result.incidents.length} | isolated: ${result.isolated.length} | duplicates merged: ${result.duplicatesRemoved} | rejected: ${result.rejected.length}\n`);
for (const i of result.incidents) {
  console.log(`[${i.severity.level} ${i.severity.score}] ${i.family}  (${i.complaintCount} complaints, ~${Math.round(i.radiusMeters)} m)`);
  for (const f of i.severity.factors) console.log(`   ${f.name.padEnd(10)} ${String(f.points).padStart(4)}/${f.max}  ${f.detail}`);
  console.log(`   -> ${i.recommendedAction}\n`);
}
console.log('Rejected:', result.rejected.map((r) => `${r.complaint.id}: ${r.reason}`).join('; '));
