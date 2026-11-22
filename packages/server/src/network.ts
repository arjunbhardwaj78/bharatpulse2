import type { Ring } from './graph.js';

/**
 * The platform's shared fraud watchlist: what no single city can build on its own.
 *
 * Every city finds fake-report rings in its own graph (shared phones, reused photos, accounts that travel together to
 * report). Those rings are recorded here by account fingerprint. Fingerprints are one-way HMACs of the phone number made
 * with the platform's secret, so the same phone has the same fingerprint in every city and no city ever sees a number.
 * Only accounts already in a ring of 3+ are shared; no complaint text, photo or location crosses cities.
 *
 * When one of those accounts reports in another city, that city treats it as part of the ring from its FIRST report:
 * the crowd counts as one source and is held for checking. On its own, the second city would need the crowd to strike
 * twice, far apart, before its graph could see the pattern.
 */
export interface NetworkCrowd { origin: string; size: number; via: string[]; seenIn: string[]; heldReports: number }
export interface NetworkSummary {
  cities: number;
  citiesSharing: number;
  watchedAccounts: number;
  crossCityAccounts: number;
  heldOnFirstReport: number;
  crowds: NetworkCrowd[];
}

export class NetworkWatch {
  /** tenant -> its current rings (3+ accounts). Replaced on every graph refresh of that city. */
  private rings = new Map<string, Ring[]>();
  /** account -> tenant -> ring in that tenant. */
  private index = new Map<string, Map<string, Ring>>();
  /** tenant -> accounts held there because another city flagged them (and the origin ring id). */
  private hits = new Map<string, Map<string, string>>();

  record(tenant: string, rings: Ring[]): void {
    for (const r of this.rings.get(tenant) ?? []) for (const a of r.accounts) this.index.get(a)?.delete(tenant);
    const kept = rings.filter((r) => r.accounts.length >= 3);
    this.rings.set(tenant, kept);
    for (const r of kept) for (const a of r.accounts) {
      let m = this.index.get(a);
      if (!m) this.index.set(a, (m = new Map()));
      m.set(tenant, r);
    }
  }

  /** A ring another city found for this account (the biggest one), or nothing. Remembers the hit for the summary. */
  ringFor(tenant: string, account: string): Ring | undefined {
    const elsewhere = [...(this.index.get(account) ?? new Map<string, Ring>()).entries()].filter(([t]) => t !== tenant).sort((a, b) => b[1].accounts.length - a[1].accounts.length)[0];
    if (!elsewhere) return undefined;
    const [origin, ring] = elsewhere;
    const id = `net:${origin}:${ring.id}`;
    let h = this.hits.get(tenant);
    if (!h) this.hits.set(tenant, (h = new Map()));
    h.set(account, id);
    return { id, accounts: ring.accounts, via: ['NETWORK', ...ring.via.filter((v) => v !== 'NETWORK')] };
  }

  /** What the network has caught, by city name. No account ids leave this function. */
  summary(names: Map<string, string>): NetworkSummary {
    const name = (t: string) => names.get(t) ?? t;
    const watched = new Set([...this.rings.values()].flatMap((rs) => rs.flatMap((r) => r.accounts)));
    const where = new Map<string, Set<string>>();
    const mark = (a: string, t: string) => { let s = where.get(a); if (!s) where.set(a, (s = new Set())); s.add(t); };
    for (const [t, rs] of this.rings) for (const r of rs) for (const a of r.accounts) mark(a, t);
    for (const [t, h] of this.hits) for (const a of h.keys()) mark(a, t);
    const crowds: NetworkCrowd[] = [];
    for (const [origin, rs] of this.rings) {
      for (const r of rs) {
        const id = `net:${origin}:${r.id}`;
        const seen = [...this.hits.entries()].filter(([t, h]) => t !== origin && [...h.values()].includes(id));
        if (seen.length === 0) continue;
        crowds.push({ origin: name(origin), size: r.accounts.length, via: r.via, seenIn: seen.map(([t]) => name(t)), heldReports: seen.reduce((n, [, h]) => n + [...h.values()].filter((v) => v === id).length, 0) });
      }
    }
    return {
      cities: names.size,
      citiesSharing: [...this.rings.entries()].filter(([, rs]) => rs.length > 0).length,
      watchedAccounts: watched.size,
      crossCityAccounts: [...where.values()].filter((s) => s.size > 1).length,
      heldOnFirstReport: [...this.hits.values()].reduce((n, h) => n + h.size, 0),
      crowds: crowds.sort((a, b) => b.heldReports - a.heldReports),
    };
  }

  /** Ring accounts recorded for a city (for the cross-city graph query). */
  accounts(): string[] { return [...this.index.keys()]; }
}

export interface Benchmark { open: number; avgHoursToResolve: number | null; heldShare: number; slaAtRisk: number }
export interface Benchmarks { you: Benchmark & { name: string }; peers: (Benchmark & { label: string })[]; median: Benchmark; note: string }

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Your city against the others on the platform. Peers are anonymised ("Town A"); only your own name is shown. */
export function benchmarks(you: { id: string; name: string }, all: { id: string; m: Benchmark }[]): Benchmarks {
  const mine = all.find((x) => x.id === you.id)?.m ?? { open: 0, avgHoursToResolve: null, heldShare: 0, slaAtRisk: 0 };
  const peers = all.filter((x) => x.id !== you.id).map((x, i) => ({ label: `Town ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`, ...x.m }));
  const pool = all.map((x) => x.m);
  const hours = pool.map((m) => m.avgHoursToResolve).filter((h): h is number => h !== null);
  return {
    you: { name: you.name, ...mine },
    peers,
    median: { open: median(pool.map((m) => m.open)), avgHoursToResolve: hours.length ? Math.round(median(hours) * 10) / 10 : null, heldShare: Math.round(median(pool.map((m) => m.heldShare)) * 100) / 100, slaAtRisk: median(pool.map((m) => m.slaAtRisk)) },
    note: peers.length ? 'Other cities are shown without names.' : 'You are the only city on this platform so far.',
  };
}
