// npm run eval: how well does the trust layer catch fake campaigns, and does it leave real outages alone?
import { writeFileSync } from 'node:fs';
import { detectIncidents, type Complaint } from '@bharatpulse/engine';
import { MemoryStore } from '../src/memoryStore.js';
import { SCENARIOS, genuineOutage, rng, travellingCrowd, type Opts } from '../src/scenarios.js';
import { IncidentService } from '../src/service.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0);
const AT = { lat: 27.4924, lng: 77.6737 };
const opts = (seed: number, n: number, prefix: string): Opts => ({ n, at: AT, now: NOW, r: rng(seed), prefix });
const top = (cs: Complaint[], now = NOW) => detectIncidents(cs, now).incidents[0];
/** "Caught" = the incident would sit in Needs verification, or credibility is under 0.5. */
const caught = (cs: Complaint[]): boolean => {
  const i = top(cs);
  return !i || i.trust.needsVerification || i.trust.credibility < 0.5;
};

const KINDS = ['attack', 'simfarm', 'photo', 'sophisticated'] as const;
const RUNS = 5;
const report: Record<string, unknown> = { note: 'Synthetic data, fixed seeds. "sophisticated" is an attacker whose reports look human on every signal we check; it is expected to get through.' };

const fake: Record<string, { runs: number; caught: number }> = {};
for (const kind of KINDS) {
  let hit = 0;
  for (let k = 0; k < RUNS; k++) hit += caught(SCENARIOS[kind](opts(100 * k + 1, 20 + k * 10, `${kind}${k}-`))) ? 1 : 0;
  fake[kind] = { runs: RUNS, caught: hit };
}
const naive = KINDS.filter((k) => k !== 'sophisticated');
report.fakeCampaigns = fake;
report.detectionRateExcludingSophisticated = naive.reduce((s, k) => s + fake[k].caught, 0) / (naive.length * RUNS);

let falsePositives = 0;
const minutesToFlag: number[] = [];
const GENUINE = 10;
for (let k = 0; k < GENUINE; k++) {
  const n = 12 + k * 5;
  const all = genuineOutage({ ...opts(500 + k, n, `real${k}-`), minutes: 60 });
  if (caught(all)) falsePositives++;
  // first minute at which the incident is MEDIUM or worse and trusted
  const start = Math.min(...all.map((c) => c.createdAt));
  for (let m = 0; m <= 90; m++) {
    const at = start + m * 60_000;
    const i = top(all.filter((c) => c.createdAt <= at), at);
    if (i && !i.trust.needsVerification && i.severity.level !== 'LOW') { minutesToFlag.push(m); break; }
  }
}
report.genuineOutages = { runs: GENUINE, falselyFlagged: falsePositives, falsePositiveRate: falsePositives / GENUINE, flaggedAtAll: minutesToFlag.length, medianMinutesFromFirstReportToFlag: minutesToFlag.sort((a, b) => a - b)[Math.floor(minutesToFlag.length / 2)] ?? null };

// The graph (Neo4j in production, the same logic in memory here): a careful crowd that comes back somewhere else.
let aloneCaught = 0;
let graphCaught = 0;
for (let k = 0; k < RUNS; k++) {
  const crowd = `crowd${k}`;
  const first = travellingCrowd({ ...opts(900 + k, 12 + k * 2, `cA${k}-`), now: NOW - 2 * 86_400_000, crowd });
  const second = travellingCrowd({ ...opts(950 + k, 12 + k * 2, `cB${k}-`), at: { lat: AT.lat + 0.03, lng: AT.lng }, crowd }); // ~3.3 km away, today
  if (caught(second)) aloneCaught++; // what the per-report checks see on their own
  const service = new IncidentService(new MemoryStore(), { clock: () => NOW });
  await service.ingestDemo(first);
  const after = await service.ingestDemo(second);
  const inc = after.find((s) => s.incident.complaintIds.some((id) => id.startsWith(`cB${k}-`)));
  if (!inc || inc.incident.trust.needsVerification || inc.incident.trust.credibility < 0.5) graphCaught++;
}
report.travellingCrowd = { runs: RUNS, caughtWithoutGraph: aloneCaught, caughtWithGraph: graphCaught, note: 'Same accounts, every signal human, second fake outage 3 km from the first. The graph links them by co-reporting.' };

console.log(JSON.stringify(report, null, 2));
writeFileSync(new URL('../eval-results.json', import.meta.url), JSON.stringify(report, null, 2));
