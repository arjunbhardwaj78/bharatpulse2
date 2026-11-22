import { Q } from './cypher.js';
import type { City } from './data.js';
import type { Downstream, Ring, RootCause } from './graph.js';
import { firstJson, hasIndicScript, isEnglish, type Sarvam } from './sarvam.js';
import type { WardStatus } from './store.js';
import type { StoredIncident } from './types.js';

/**
 * "Ask BharatPulse": an officer asks a question in any Indian language, typed or spoken.
 *  1. Sarvam detects the language and translates the question to English.
 *  2. Sarvam-105B picks ONE of a fixed list of graph questions (it never writes Cypher itself, so it cannot run
 *     anything unexpected against the database). Without Sarvam, a keyword router picks.
 *  3. The graph question runs on Neo4j (the Cypher is returned so the officer can see exactly what ran).
 *  4. Sarvam-105B words a short answer from those facts only, and Sarvam-Translate puts it back in the officer's language.
 */

export const TOOLS = {
  root_cause: 'Why is water failing in several places? Traces open water problems up the pipe network to the likely failure point.',
  fraud_rings: 'Which reports are fake? Groups of accounts tied together by shared phones, shared photos, or reporting together in far-apart places.',
  downstream: 'If a zone fails, which wards lose water next? args: {"zone": "Z1".."Z4"}',
  ward_status: 'What is happening in one ward? args: {"ward": "L1".."L8"} (Ward 3 is L3)',
  top_incidents: 'What is most urgent right now? The highest-priority open problems.',
  repeat_problems: 'Which problems came back after being fixed?',
} as const;
export type Tool = keyof typeof TOOLS;

export interface GraphTools {
  rootCause(): Promise<RootCause>;
  rings(): Promise<{ rings: Ring[]; targets: { ring: string; incident: string }[] }>;
  downstream(zone: string): Promise<Downstream[]>;
  wardStatus(ward: string): Promise<WardStatus | undefined>;
  top(): Promise<StoredIncident[]>;
  repeats(): Promise<{ incident: string; fixedBefore: number }[]>;
}

export interface Answer {
  question: string;
  questionEn: string;
  language: string;
  tool: Tool;
  args: Record<string, string>;
  /** The Cypher that answered it (Neo4j). */
  cypher: string[];
  data: unknown;
  answer: string;
  answerEn: string;
  /** Who did each step, for the UI. */
  via: { understood: 'sarvam' | 'keywords'; worded: 'sarvam' | 'template'; translated: boolean };
}

const CYPHER: Record<Tool, string[]> = {
  root_cause: [Q.rootCause, Q.atRisk],
  fraud_rings: [Q.deviceAndPhotoLinks, Q.coReportingLinks, Q.ringTargets],
  downstream: [Q.downstream],
  ward_status: [Q.wardStatus],
  top_incidents: [Q.overviewIncidents],
  repeat_problems: [Q.repeatSpots],
};

const num = (s: string): string | undefined => s.match(/(?:ward|वार्ड|zone|ज़ोन|जोन)\s*(?:no\.?|number|नंबर)?\s*(\d)/i)?.[1] ?? s.match(/\b(\d)\b/)?.[1];

/** Works with no AI at all: English, Hinglish and Hindi keywords. */
export function route(q: string): { tool: Tool; args: Record<string, string> } {
  const s = q.toLowerCase();
  const n = num(s);
  if (/fake|fraud|ring|scam|bogus|farzi|nakli|फ़र्ज़ी|फर्जी|नकली|झूठ/.test(s)) return { tool: 'fraud_rings', args: {} };
  if (/repeat|again|came back|keeps|dobara|phir se|दोबारा|फिर से/.test(s)) return { tool: 'repeat_problems', args: {} };
  if (/downstream|next|affect|impact|aage|asar|असर|आगे/.test(s) && n) return { tool: 'downstream', args: { zone: `Z${n}` } };
  if (/why|root|cause|source|common|reason|kyon|kyun|kaaran|क्यों|कारण|वजह/.test(s)) return { tool: 'root_cause', args: {} };
  if (/ward|वार्ड|mohalla|मोहल्ला/.test(s) && n) return { tool: 'ward_status', args: { ward: `L${n}` } };
  if (/zone|ज़ोन|जोन/.test(s) && n) return { tool: 'downstream', args: { zone: `Z${n}` } };
  return { tool: 'top_incidents', args: {} };
}

const main = (s: StoredIncident): string => (Object.entries(s.incident.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.incident.family).toLowerCase().replace(/_/g, ' ');

async function run(tools: GraphTools, tool: Tool, args: Record<string, string>, city: City): Promise<{ data: unknown; facts: string }> {
  const ward = (id: string) => city.localities.find((l) => l.id === id)?.name ?? id;
  const zone = (id: string) => city.zones.find((z) => z.id === id)?.name ?? id;
  switch (tool) {
    case 'root_cause': {
      const r = await tools.rootCause();
      if (!r.suspects.length) return { data: r, facts: 'There are no trusted open water-supply problems right now, so there is nothing to trace.' };
      const top = r.suspects[0];
      return { data: r, facts: `${r.incidents.length} trusted water problem(s) are open in ${r.zonesHit.map(zone).join(', ')}. Tracing them up the pipe network, all of them are fed by "${top.name}" (${top.kind.toLowerCase()} ${top.assetId}), so check it first.${r.atRisk.length ? ` It also feeds ${r.atRisk.map((x) => x.name).join(', ')}, which have not reported yet: warn them.` : ''}` };
    }
    case 'fraud_rings': {
      const { rings, targets } = await tools.rings();
      if (!rings.length) return { data: { rings, targets }, facts: 'No group of 3 or more linked accounts was found.' };
      const how = (v: string) => (v === 'CO_REPORTING' ? 'the same accounts reporting together in places far apart (a hired crowd)' : v === 'DEVICE' ? 'several accounts on one phone' : 'one photo pasted into many accounts');
      const kinds = [...new Set(rings.flatMap((r) => r.via))];
      const hit = new Set(targets.map((t) => t.incident)).size;
      return { data: { rings, targets }, facts: `${rings.length} ring(s) of linked accounts, ${rings.reduce((n, r) => n + r.accounts.length, 0)} accounts in all, found through ${kinds.map(how).join('; ')}. They reported into ${hit} open problem(s). Each ring counts as one person, so it cannot push a fake problem up the list.` };
    }
    case 'downstream': {
      const z = args.zone ?? 'Z1';
      const d = await tools.downstream(z);
      return { data: d, facts: d.length ? `If ${zone(z)} fails, next to lose water: ${d.map((x) => `${zone(x.zone)} (${x.localities.map(ward).join(', ')}), ${x.hops} step(s) away`).join('; ')}.` : `${zone(z)} does not feed any other zone.` };
    }
    case 'ward_status': {
      const w = await tools.wardStatus(args.ward ?? 'L1');
      if (!w) return { data: null, facts: 'That ward is not in this town.' };
      return { data: w, facts: `${w.name} is in ${w.zoneName}, supplied by ${w.suppliedBy.join(', ') || 'no listed pipeline'}${w.fedBy.length ? ` (water comes from ${w.fedBy.map(zone).join(', ')})` : ''}. ${w.incidents.length ? `Open now: ${w.incidents.map((s) => `${main(s)} (${s.incident.severity.level.toLowerCase()}, ${s.incident.trust.independentSources} people)`).join(', ')}.` : 'Nothing is open there now.'}` };
    }
    case 'repeat_problems': {
      const r = await tools.repeats();
      return { data: r, facts: r.length ? `${r.length} open problem(s) are in a spot where the same kind of problem was fixed before (within 150 m): the earlier fix did not hold.` : 'No open problem is in a spot that was fixed before.' };
    }
    default: {
      const top = (await tools.top()).slice(0, 5);
      return { data: top.map((s) => ({ id: s.incident.id, issue: main(s), level: s.incident.severity.level, people: s.incident.trust.independentSources, unverified: s.incident.trust.needsVerification })), facts: top.length ? `Most urgent: ${top.map((s) => `${main(s)} in ${ward(cityWard(city, s))} (${s.incident.severity.level.toLowerCase()}, ${s.incident.trust.independentSources} people${s.incident.trust.needsVerification ? ', not yet verified' : ''})`).join('; ')}.` : 'Nothing is open right now.' };
    }
  }
}

function cityWard(city: City, s: StoredIncident): string {
  const c = s.incident.centroid;
  return [...city.localities].sort((a, b) => Math.hypot(a.lat - c.lat, a.lng - c.lng) - Math.hypot(b.lat - c.lat, b.lng - c.lng))[0]?.id ?? '';
}

export async function ask(question: string, tools: GraphTools, city: City, sarvam?: Sarvam, wantLanguage?: string): Promise<Answer> {
  const q = question.trim().slice(0, 500);
  let questionEn = q;
  let language = wantLanguage ?? (hasIndicScript(q) ? 'hi-IN' : 'en-IN');
  let translated = false;
  if (sarvam && (hasIndicScript(q) || (wantLanguage && !isEnglish(wantLanguage)))) {
    try {
      const en = await sarvam.toEnglish(q, hasIndicScript(q) ? undefined : wantLanguage);
      questionEn = en.text;
      language = wantLanguage ?? en.language;
      translated = !isEnglish(en.language);
    } catch { /* fall back to keywords on the original */ }
  }

  let pick = route(`${questionEn} ${q}`);
  let understood: Answer['via']['understood'] = 'keywords';
  if (sarvam) {
    try {
      const reply = await sarvam.chat([
        { role: 'system', content: `You route questions from a municipal water and roads officer to ONE tool. Tools:\n${Object.entries(TOOLS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\nWards: ${city.localities.map((l) => `${l.id}=${l.name}`).join(', ')}. Zones: ${city.zones.map((z) => `${z.id}=${z.name}`).join(', ')}.\nReply with JSON only: {"tool": "...", "args": {...}}` },
        { role: 'user', content: questionEn },
      ], true, 120);
      const j = firstJson<{ tool?: string; args?: Record<string, string> }>(reply);
      if (j?.tool && j.tool in TOOLS) { pick = { tool: j.tool as Tool, args: j.args ?? {} }; understood = 'sarvam'; }
    } catch { /* keyword route stays */ }
  }

  const { data, facts } = await run(tools, pick.tool, pick.args, city);
  let answerEn = facts;
  let worded: Answer['via']['worded'] = 'template';
  if (sarvam) {
    try {
      const reply = await sarvam.chat([
        { role: 'system', content: 'You answer a municipal officer in 2 to 3 short, plain sentences. Use ONLY the facts given. Do not add numbers, names or advice that are not in the facts.' },
        { role: 'user', content: `Question: ${questionEn}\nFacts: ${facts}` },
      ], false, 220);
      if (reply) { answerEn = reply; worded = 'sarvam'; }
    } catch { /* template stays */ }
  }
  let answer = answerEn;
  if (sarvam && !isEnglish(language)) {
    try { answer = await sarvam.translate(answerEn, 'en-IN', language); translated = true; } catch { /* English answer */ }
  }
  return { question: q, questionEn, language, tool: pick.tool, args: pick.args, cypher: CYPHER[pick.tool], data, answer, answerEn, via: { understood, worded, translated } };
}
