import type { Sarvam } from './sarvam.js';

/**
 * Translates the app's English strings into one Indian language with Sarvam-Translate.
 * Strings are sent in batches, one per line as "[n] text", so ~300 strings take ~15 requests, not 300.
 * A line is accepted only if its number came back and every {placeholder} survived; anything else stays English.
 */
export async function buildPack(english: Record<string, string>, lang: string, sarvam: Sarvam, maxChars = 1800): Promise<Record<string, string>> {
  const entries = Object.entries(english).filter(([, v]) => typeof v === 'string' && v.trim() && v.length <= 400).slice(0, 600);
  const batches: [string, string][][] = [];
  let cur: [string, string][] = [];
  let size = 0;
  for (const e of entries) {
    const line = e[1].replace(/\s*\n\s*/g, ' ');
    if (size + line.length + 8 > maxChars && cur.length) { batches.push(cur); cur = []; size = 0; }
    cur.push([e[0], line]);
    size += line.length + 8;
  }
  if (cur.length) batches.push(cur);

  const out: Record<string, string> = {};
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
  const run = async (batch: [string, string][]) => {
    const input = batch.map(([, v], i) => `[${i}] ${v}`).join('\n');
    let text: string;
    try {
      text = await sarvam.translate(input, 'en-IN', lang);
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
      if (!m) continue;
      const entry = batch[Number(m[1])];
      if (entry && holes(m[2]) === holes(entry[1])) out[entry[0]] = m[2].trim();
    }
  };
  // a few at a time: fast, without flooding the API
  for (let i = 0; i < batches.length; i += 3) await Promise.all(batches.slice(i, i + 3).map(run));
  return out;
}
