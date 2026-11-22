import { envFile } from './loadEnv.js';
import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { Auth } from './auth.js';
import { MemoryStore } from './memoryStore.js';
import { Officers } from './officers.js';
import { makePlaceFinder, makePlaceSearch, makePlaceSuggest } from './places.js';
import { TenantHub, type Tenant, type TenantRegistry } from './tenants.js';
import { Sarvam } from './sarvam.js';
import type { IncidentStore } from './store.js';
import type { Driver } from 'neo4j-driver';

const isProd = process.env.NODE_ENV === 'production';

// Neo4j Aura when NEO4J_URI is set (one driver, one tenant-scoped store per city). If it is set but the connection
// fails, the server stops with a clear error: it never falls back to memory. Without NEO4J_URI: memory, for local
// development; production refuses that unless ALLOW_MEMORY_STORE=true is set on purpose.
let makeStore: ((t: Tenant) => Promise<IncidentStore>) | undefined;
let registry: TenantRegistry | undefined;
let driver: Driver | undefined;
if (process.env.NEO4J_URI?.trim()) {
  const { Neo4jStore, Neo4jTenantRegistry, neo4jConfigFromEnv, hostOf } = await import('./neo4jStore.js');
  try {
    const cfg = neo4jConfigFromEnv()!;
    const d = await Neo4jStore.openDriver(cfg.uri, cfg.user, cfg.password, cfg.database);
    driver = d;
    const info = await d.getServerInfo({ database: cfg.database }).catch(() => undefined);
    console.log(`Neo4j: connected to ${hostOf(cfg.uri)} (database: ${cfg.database ?? 'default'}${info?.agent ? `, ${info.agent}` : ''}). All graph reads and writes go here.`);
    makeStore = (t) => Neo4jStore.forTenant(d, t.city, t.id);
    registry = new Neo4jTenantRegistry(d);
  } catch (e) {
    console.error(`Neo4j: ${(e as Error).message}`);
    console.error('Neo4j: not starting without the graph database (no in-memory fallback when NEO4J_URI is set).');
    process.exit(1);
  }
} else if (isProd && process.env.ALLOW_MEMORY_STORE !== 'true') {
  console.error('NEO4J_URI is not set. In production BharatPulse keeps its graph in Neo4j Aura and does not fall back to memory. Set NEO4J_URI, NEO4J_USERNAME (or NEO4J_USER), NEO4J_PASSWORD and NEO4J_DATABASE in the Render dashboard, or set ALLOW_MEMORY_STORE=true to run a throwaway in-memory demo on purpose.');
  process.exit(1);
} else {
  if (isProd) console.warn('WARNING: ALLOW_MEMORY_STORE=true and no NEO4J_URI: running in memory. All data is lost on every restart or sleep.');
  else console.log(`Storage: in memory (local development). Set NEO4J_URI in .env to use Neo4j Aura (.env: ${envFile.path}, ${envFile.status}).`);
  makeStore = async (t) => new MemoryStore(t.city);
}

// Production must not run with the public sample password from .env.example.
if (isProd && !process.env.OFFICER_PASSWORD) {
  console.error('OFFICER_PASSWORD is not set. Refusing to start in production with the public sample password. Set it in the Render dashboard.');
  process.exit(1);
}
if (isProd && !process.env.ADMIN_KEY) {
  console.warn('WARNING: ADMIN_KEY is not set. The sample-data buttons are disabled in production.');
}

// A stable salt keeps people signed in across restarts. In production set ID_SALT; the development fallback is fixed on purpose.
const salt = process.env.ID_SALT ?? (process.env.NODE_ENV === 'production' ? randomBytes(16).toString('hex') : 'bharatpulse-dev-salt');
// No OTP_CODE: every request gets a random code, shown in the app as a "demo SMS" (no SMS provider is connected).
const auth = new Auth(salt, process.env.OTP_CODE || undefined);
const sarvam = process.env.SARVAM_API_KEY
  ? new Sarvam(process.env.SARVAM_API_KEY, { sttModel: process.env.SARVAM_STT_MODEL, translateModel: process.env.SARVAM_TRANSLATE_MODEL, ttsModel: process.env.SARVAM_TTS_MODEL, ttsSpeaker: process.env.SARVAM_TTS_SPEAKER, chatModel: process.env.SARVAM_CHAT_MODEL, baseUrl: process.env.NODE_ENV === 'production' ? undefined : process.env.SARVAM_BASE_URL })
  : undefined;
const hub = await new TenantHub({ makeStore, registry, serviceOptions: { auth, sarvam, recomputeTtlMs: Number(process.env.RECOMPUTE_TTL_MS ?? 10_000) }, maxTenants: Number(process.env.MAX_CITIES ?? 200) }).init();
const app = buildApp(hub, { logger: true }, { auth, sarvam, suggest: process.env.PLACES === 'off' ? undefined : makePlaceSuggest({ email: process.env.CONTACT_EMAIL }), officers: new Officers(process.env.OFFICER_PASSWORD, `${salt}:officers`), search: process.env.PLACES === 'off' ? undefined : makePlaceSearch({ email: process.env.CONTACT_EMAIL }), places: process.env.PLACES === 'off' ? undefined : makePlaceFinder({ googleKey: process.env.GOOGLE_MAPS_KEY, email: process.env.CONTACT_EMAIL }), geofence: process.env.GEOFENCE !== 'false', requireOtp: process.env.REQUIRE_OTP !== 'false', adminKey: process.env.ADMIN_KEY });

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  await driver?.close().catch(() => undefined);
  process.exit(1);
}

// Clean shutdown (Render sends SIGTERM on deploy/restart): stop taking requests, save pending city records, close the driver.
let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info(`${signal}: shutting down`);
  await app.close().catch((e: unknown) => app.log.error(e));
  await hub.flush().catch((e: unknown) => app.log.error(e));
  await driver?.close().catch((e: unknown) => app.log.error(e));
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
