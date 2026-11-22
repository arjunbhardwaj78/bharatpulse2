// Run once after you have credentials:  npm run neo4j:smoke  /  npm run sarvam:smoke
//  neo4j: loads the sample town into Neo4j AND into memory, then checks that every graph answer is the same
//         (incidents, rings, root cause, at-risk wards, downstream, incident graph, me-too lock). Times each step.
//  sarvam: calls each Sarvam endpoint the app uses once (speech, language ID, translate, voice, chat).
import { envFile } from '../src/loadEnv.js';
import { MemoryStore } from '../src/memoryStore.js';
import { hostOf, Neo4jStore, neo4jConfigFromEnv } from '../src/neo4jStore.js';
import { Sarvam } from '../src/sarvam.js';
import { CITY, generateCity } from '../src/data.js';
import { IncidentService } from '../src/service.js';

const NOW = Date.now();
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const which = process.argv[2] ?? 'all';
const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => { const t = Date.now(); const r = await f(); console.log(`      ${label}: ${Date.now() - t} ms`); return r; };

async function neo4jSmoke(): Promise<void> {
  let cfg;
  try { cfg = neo4jConfigFromEnv(); } catch (e) { console.log(`FAIL  neo4j settings: ${(e as Error).message}`); process.exitCode = 1; return; }
  if (!cfg) return console.log(`neo4j: skipped: NEO4J_URI is empty. Looked for ${envFile.path}: ${envFile.status}. Put NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD and NEO4J_DATABASE in that file.`);
  console.log(`neo4j: ${hostOf(cfg.uri)} (database: ${cfg.database ?? 'default'}). This CLEARS BharatPulse's own complaints/incidents for the sample town (tenant "demo") and loads it again. Other data in the database is not touched.`);
  let neo: Neo4jStore;
  try { neo = await timed('connect + schema + town', async () => Neo4jStore.forTenant(await Neo4jStore.openDriver(cfg.uri, cfg.user, cfg.password, cfg.database), CITY, 'demo')); } catch (e) { console.log(`FAIL  connect: ${(e as Error).message}`); process.exitCode = 1; return; }
  const sides = [new IncidentService(neo, { clock: () => NOW }), new IncidentService(new MemoryStore(), { clock: () => NOW })];
  await neo.clear();
  await timed('load sample town (neo4j)', () => sides[0].loadSample());
  await sides[1].loadSample();
  const ids = (l: { incident: { id: string } }[]) => l.map((s) => s.incident.id).sort();
  const [a, b] = await Promise.all(sides.map((s) => s.listAll()));
  const checks: [string, boolean][] = [['same incidents', same(ids(a), ids(b))]];
  const [ra, rb] = await Promise.all(sides.map((s) => s.rings()));
  checks.push(['same fake-report rings', same(ra.rings, rb.rings)]);
  checks.push(['a travelling crowd ring was found', ra.rings.some((r) => r.via.includes('CO_REPORTING'))]);
  const [ca, cb] = await Promise.all(sides.map((s) => s.rootCause()));
  checks.push(['same root cause', same(ca, cb)]);
  checks.push(['root cause is the North feeder (M2)', ca.suspects[0]?.assetId === 'M2']);
  const [d1, d2] = await Promise.all(sides.map((s) => s.downstream('Z1', 3)));
  checks.push(['same downstream of Z1', same(d1, d2)]);
  const top = a.find((s) => s.incident.id.startsWith('SUPPLY'));
  if (top) {
    const [g1, g2] = await Promise.all(sides.map((s) => s.subgraph(top.incident.id)));
    const key = (g: { nodes: { id: string }[]; edges: unknown[]; sharedDevices: unknown[] }) => ({ n: g.nodes.map((x) => x.id).sort(), e: g.edges.length, s: g.sharedDevices });
    checks.push(['same incident graph', same(key(g1), key(g2))]);
    checks.push(['me-too lock: first ok, second refused', (await neo.confirm('smoke-r', top.incident.id)) === true && (await neo.confirm('smoke-r', top.incident.id)) === false]);
  }
  await timed('GET /incidents equivalent (cached)', () => sides[0].listActive());
  const [o1, o2] = await Promise.all(sides.map((s) => s.overview()));
  checks.push(['same overview graph', same(o1.nodes.map((n) => n.id).sort(), o2.nodes.map((n) => n.id).sort())]);
  for (const a of CITY.assets ?? []) { // "what if this pipe fails" from every asset
    const [x, y] = await Promise.all([neo.impact(a.id), new MemoryStore().impact(a.id)]);
    if (!same(x, y)) { checks.push([`same what-if impact for ${a.id}`, false]); break; }
  }
  checks.push(['same what-if impact for every pipe, pump and tank', !checks.some(([n, ok]) => n.startsWith('same what-if impact for ') && !ok)]);
  // multi-city: a second city on the same database sees none of the demo city's data, and has its own map
  const other = await Neo4jStore.forTenant((neo as unknown as { driver: Parameters<typeof Neo4jStore.forTenant>[0] }).driver, generateCity({ lat: 28.2089, lng: 78.2405 }, 6), 'smoke-city');
  await other.clear();
  checks.push(['second city sees no demo complaints', (await other.complaintsSince(0)).length === 0]);
  checks.push(['second city has no demo incidents', (await other.listIncidents()).length === 0]);
  checks.push(['second city downstream uses its own map', (await other.downstream('Z1', 3)).length > 0]);
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  await neo.close();
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function sarvamSmoke(): Promise<void> {
  const key = process.env.SARVAM_API_KEY;
  if (!key) return console.log('sarvam: skipped (set SARVAM_API_KEY in .env)');
  const s = new Sarvam(key);
  const wav = Buffer.alloc(44 + 32000); // one second of silence, 16 kHz mono 16-bit
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 32000, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  const steps: [string, () => Promise<unknown>][] = [
    ['speech to text (saaras)', () => s.transcribe(wav, 'audio/wav')],
    ['language ID (text-lid)', () => s.detect('எங்கள் தெருவில் இரண்டு நாட்களாக தண்ணீர் வரவில்லை')],
    ['translate ta -> en', () => s.translate('எங்கள் தெருவில் இரண்டு நாட்களாக தண்ணீர் வரவில்லை', 'ta-IN', 'en-IN')],
    ['translate en -> hi', () => s.translate('Water supply will return by evening.', 'en-IN', 'hi-IN')],
    ['voice (bulbul)', async () => (await s.speak('पानी शाम तक आ जाएगा।', 'hi-IN')).audio.length + ' base64 chars'],
    ['chat (sarvam-105b, JSON)', () => s.chat([{ role: 'user', content: 'Reply with JSON only: {"ok": true}' }], true, 50)],
  ];
  for (const [name, f] of steps) {
    try { console.log(`PASS  ${name}:`, JSON.stringify(await f()).slice(0, 160)); } catch (e) { console.log(`FAIL  ${name}:`, (e as Error).message, JSON.stringify((e as { details?: unknown }).details ?? '')); process.exitCode = 1; }
  }
}

if (which === 'all' || which === 'neo4j') await neo4jSmoke();
if (which === 'all' || which === 'sarvam') await sarvamSmoke();
