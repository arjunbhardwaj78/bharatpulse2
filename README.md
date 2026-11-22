# BharatPulse

**Turn 40 scattered water complaints into one clear incident: "Ward 12 has no water, 9 households, getting worse."**

Water departments receive complaints one at a time, by phone, app or WhatsApp. Nobody sees the pattern until it is
already a crisis. BharatPulse groups complaints that point at the same problem, scores how serious it is, explains
the score, and suggests a first response.

> **Status (finale build):** engine 58, server 258 and web 22 automated tests pass, and every Cypher query is checked by Neo4j's own parser; typecheck and build clean; every screen checked in a browser at desktop and phone sizes; 48/48 security checks pass on a production build.
> **Live:** runs on Neo4j AuraDB (`neo4j+s://`). Sarvam: run `npm run sarvam:smoke` with a key in `.env`. All demo data is simulated.

## A SaaS, not a single-town app (details: `docs/SAAS.md`)
One deployment serves many cities. A city signs up at `#/onboard` and gets its own ward map and water network (draft),
officer accounts, its own data space in Neo4j, an admin console (usage, plan, API keys, webhooks, CSV import) and a
free pilot. Cities that already run a portal (CPGRAMS, state 1916) **keep it**: complaints come in through
`POST /v1/complaints` or CSV, answers go back by signed webhook.

## Partner technology (details: `docs/PARTNER_TECH.md`)
- **Neo4j** decides trust and dispatch: fake-report rings (shared phones/photos across all history, and *hired crowds* = the same accounts reporting together in far-apart places) count as one source in the score; open water problems are traced **up the pipe network** to the likely failed asset, and the wards it also feeds are warned. Measured: a careful crowd that comes back is caught 0/5 without the graph, 5/5 with it; real outages wrongly flagged 0/10.
- **Sarvam AI** lets anyone report by voice in 22 Indian languages (Saaras), gives officers every complaint in English and classifies from the English (Sarvam-Translate), reads updates aloud (Bulbul), translates the app into 11 languages, and powers **Ask BharatPulse**: a question in any language → Sarvam-105B picks a whitelisted graph query → Neo4j answers → reply in the asker's language.
- Officer portal → **Graph & Ask** shows all of it, with the Cypher behind each answer.

## What the engine does

`complaints in -> incidents out`, as one pure function:

```ts
import { detectIncidents } from '@bharatpulse/engine';

const { incidents, isolated, rejected, duplicatesRemoved } = detectIncidents(complaints, Date.now());
```

Pipeline: **validate -> de-duplicate -> cluster -> score -> recommend**.

| Step | What happens | Why |
|---|---|---|
| Validate | Bad coordinates, unknown issue types, duplicate ids and future timestamps are rejected *with a reason* | Nothing is silently lost |
| De-duplicate | Repeat reports from one person (same issue family, within 30 min) count once | One person cannot fake an outage |
| Cluster | Spatio-temporal DBSCAN, run per issue family | Finds incidents without knowing how many exist; follows an outage along a street |
| Score | 0-100 from five visible factors | Officers can see *why* an incident ranks high |
| Recommend | Rule-based first action by issue family and level | Auditable, no black box |

### How clustering works (plain words)
Two complaints are **neighbours** if they are within 500 m *and* within 3 hours of each other. A complaint with at
least 3 neighbours (itself included) is a **core point** and starts a cluster. Anything reachable from a core point
joins that cluster, so the cluster can stretch along a pipe line. Complaints that never reach a cluster are
**isolated**, shown but not raised as incidents.

"No water" and "low pressure" count as one **supply** family. "Dirty water" (health risk) and "leak"
(infrastructure) are separate, so a health problem is never buried inside a supply outage.

### How the score works
Each report first gets an **authenticity score** (0-100, starts at 60; GPS match, shared device, reused photo,
duplicate text, too-fast submission and similar signals add or remove points; see `packages/engine/src/trust.ts`).
Reports under 40 are dropped from the count. The rest are grouped into **independent sources**: reports that share a
reporter, device or photo count as one.

Priority = (sum of factor points) x credibility (mean authenticity of the kept reports).

| Factor (water) | Max | Meaning |
|---|---|---|
| Sources | 30 | Independent sources, weighted by authenticity, on a log curve (the 3rd matters more than the 30th; 25 is the cap) |
| Velocity | 25 | New reports in the last 30 min: is it still growing? |
| Spread | 15 | How wide the affected area is |
| Duration | 15 | How long it has been going on |
| Issue type | 15 | Health risk 15, supply 10, leak 6 |

Road incidents use sources 25, size 20, road class 20, duration 15, facilities 10, photo 10. Roads cluster within 40 m
and 14 days, water within 500 m and 3 h (`perFamily` in `config.ts`).

Levels: LOW below 25, MEDIUM 25+, HIGH 50+, CRITICAL 75+. An incident with fewer than 3 *trusted* independent sources
is flagged `needsVerification` and can never be CRITICAL. Every number is configurable in `config.ts`.

## Run it

```bash
npm install
npm test          # engine + server tests (builds the engine first)
npm run typecheck
npm run build
node packages/engine/examples/demo.mjs   # prints a worked example
npm run dev:server                       # API on http://localhost:3000 (in-memory, resets on restart)
```

## Design decisions
- **Pure and deterministic.** Same input gives the same output (tested), so it is safe to re-run on every new complaint.
- **Explainable over clever.** Rules and a transparent score, not a model. AI (Sarvam) handles speech and language only; decisions stay rule-based.
- **Honest limits.** Clustering is O(n^2) per family, fine for a ward-sized live window (thousands of complaints). A grid index is the upgrade path. Location accuracy depends on citizen GPS.

## Roadmap
- [x] 1. Detection engine and tests
- [x] 2. API and database: Fastify API, stable incident ids, rate limiting (see `packages/server/docs/incident-identity.md`), Neo4j AuraDB store (running live)
- [x] 3. Citizen intake: 11 app languages, voice in 22 Indian languages (Sarvam)
- [x] 4. Officer portal, citizen map, 3D city twin, Graph & Ask
- [x] 5. Sample town and attack scenarios
- [x] 6. Multi-tenant SaaS for cities and private operators, shared fraud watchlist
- [ ] 7. Real SMS sign-in, water-network editor, pilots with towns

## API
| Method | Path | What it does |
|---|---|---|
| POST | `/complaints` | `{reporterId, issueType, lat, lng}` -> 201 `{complaint, incidentId}`; 400 on bad input; 429 over the per-reporter limit (5 per 10 min) |
| GET | `/incidents` | Active incidents, highest severity first (re-runs detection so scores reflect now) |
| GET | `/incidents/:id` | One incident, any status (merged ones point at `mergedInto`) |
| GET | `/health` | Liveness check |

Errors always look like `{ "error": { "code", "message", "details?" } }`.

## Configuration: intake, workflow, graph

Copy `.env.example` to `.env`. With no keys it runs in demo mode: memory storage (same answers as Neo4j), typed complaints, browser voice, a random OTP shown on screen as a demo SMS.
With `NEO4J_URI` it stores everything in Neo4j (the graph answers `/incidents/:id/graph` and `/zones/:id/downstream` come from Cypher).
With `SARVAM_API_KEY`, `/complaints` accepts a base64 `audio` field and transcribes Indian-language speech.

Honest limits: OTP is simulated; officer login uses shared sample accounts (the `x-role` header works only when login is off, for tests); Neo4j and Sarvam code is written from their docs and
must be checked once with `npm run neo4j:smoke` / `npm run sarvam:smoke`; photo hashes catch reused photos, not fakes;
a careful attacker whose reports look human on every signal gets through (see `npm run eval`). All demo data is synthetic.

## The web app, sign-in and deployment

```powershell
npm install
copy .env.example .env      # optional: everything works without it
npm run dev:server          # API on http://localhost:3000
npm run dev:web             # web on http://localhost:5173
```
Open `http://localhost:5173`. The home page leads to the **citizen** portal (phone number, then an OTP step; no SMS is sent, the code is shown on screen) and the **officer** portal (ID and password; the level comes with the account). Sample officer accounts: `field1` (L1), `zonal1` (L2), `head1` (L3), `commissioner1` (L4), password `officer@123` (local default; **in production the server refuses to start until `OFFICER_PASSWORD` is set**).

**See it with data:** sign in as an officer, open **Sample data**, and press **Load sample town**. It loads a real outage, three kinds of fake campaign, a leak next to a pothole, a school-side pothole, dirty water and a few single reports, and moves some incidents along the workflow. **Clear all data** resets it.

**Where complaints are accepted:** anywhere. The phone must report its own location and the pin must stay within 3 km of it (turn this check off with `GEOFENCE=false`). Problems within 2 km are listed; a water problem can be confirmed from 1.5 km, a pothole from 300 m. `CITY_CENTER` only decides where the sample town is drawn (default Hodal).
**Staying signed in:** citizens and officers stay signed in (30 days and 7 days). Signing out returns to the home page, and the phone number is remembered for the next sign-in. Set `ID_SALT` so a server restart does not sign people out.
**Contacts:** "Need help now" shows the emergency number, the user's address, and the nearest real offices with address and phone, found through Google Places (if `GOOGLE_MAPS_KEY` is set) or OpenStreetMap. Maps data is crowd-sourced and often has no phone for small-town offices; the app says so and asks the user to confirm. No API lists the names of zone committee members or officers: those come only from `packages/server/src/data.ts` (placeholders marked Sample for the sample town). Replace them with real, verified data for each area you serve.
**Voice:** with `SARVAM_API_KEY` the server transcribes (Sarvam); without it the browser's own speech recognition fills the text box live (Chrome, Edge, Android; needs microphone permission and https or localhost).

**Deploy:** see `docs/DEPLOY.md` for the checklist (Render API, Vercel web, `VITE_API_URL`, keep-warm, demo settings).

## Known limits (say these before a judge does)
- **Storage:** without `NEO4J_URI` everything is in memory and disappears on restart or Render sleep. Neo4j is the real graph for incidents, reporters, devices, photos and `FEEDS` links; diary check-ins and planned-work notices are stored as JSON on nodes, not as graph relationships.
- **Fake-report defence:** catches naive and shared-device/photo campaigns; a careful attacker whose reports look human on every signal gets through (0 of 5 caught in `npm run eval`).
- **Location:** me-too and the pin check trust the phone's reported location, which a determined user can fake. The same browser counts as one person.
- **Voice:** Sarvam accepting the browser's webm recording is unverified. The browser fallback works mainly in Chrome/Edge/Android over https.
- **Identity:** OTP is simulated; officers use shared sample accounts; contacts for the sample town are placeholders marked Sample.

Docs: `docs/DEMO.md` (3-minute script), `docs/ARCHITECTURE.md`, `docs/SAAS.md`, `docs/PARTNER_TECH.md` (Neo4j and Sarvam), `docs/SECURITY.md`, `docs/DEPLOY.md`. `npm run smoke:web` renders the real screens against a real server in jsdom; it is not a browser test.

## Security
See `docs/SECURITY.md` (remediation log draft for ArgosX): open close/escalate routes removed, helmet headers, rate limits,
random single-use OTP with a per-network cap, officer-only graph routes, trustProxy, CORS allowlist, per-route body limits.
