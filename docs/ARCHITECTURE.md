# BharatPulse architecture: one platform for governments and private operators

## Who runs a workspace
| Organisation type | Sector | Area called | Who reports | L1 → L4 titles | Plan |
|---|---|---|---|---|---|
| Municipality / Nagar Palika | Government | Ward | Residents | Field Officer → Zonal Officer → Department Head → Commissioner | Pilot / Town / City / Connect |
| Water utility (PPP / private) | Private | Service zone | Customers | Field Technician → Zone Supervisor → Operations Head → Managing Director | Pilot / Enterprise site / Connect |
| Highway / toll road operator | Private | Stretch | Road users | Patrol Engineer → Section Supervisor → Project Manager → Project Director | same |
| Industrial park / SEZ | Private | Block | Units and staff | Maintenance Technician → Block Supervisor → Estate Manager → Park CEO | same |
| Campus / hospital | Private | Block | Students and staff | Facilities Technician → Facilities Supervisor → Facilities Head → Registrar | same |

Source of truth: `packages/server/src/orgs.ts` (`ORG_TYPES`). Onboarding (`#/onboard`) asks for the type first;
the workspace gets that vocabulary, job titles (returned at sign-in) and a starting map of its areas and water network.

## Layers
1. **Channels** — resident / customer app (11 app languages, voice in 22 via Sarvam), staff console (board, graph,
   City twin, network, account), public API (`POST /v1/complaints`, `GET /v1/incidents`), CSV import, signed webhooks.
2. **Workspaces** — `TenantHub` (`tenants.ts`): one `IncidentService` per organisation, isolated data. In Neo4j every node
   carries `tenant`, keys are `(tenant, id)`; staff tokens are bound to their workspace (`wrong_city`), API keys map to one.
3. **Intelligence (shared engine)** — trust engine (independent sources, severity, SLA), Neo4j (rings, root cause,
   downstream, ward status), Sarvam (speech, translation, language detection, voice, Ask).
4. **Network (only possible on a platform)** — `network.ts`: shared fraud watchlist by one-way account fingerprint,
   anonymised benchmarks; `orgs.ts` + `TenantHub.maybeRefer`: cross-organisation referrals.

## Cross-organisation referral (government ↔ private)
A private site that takes its water from a city pipe records that link with consent (`Tenant.partner`):
in Neo4j the city's pipe `FEEDS_SITE` the site's tank across the two workspaces (`Q.linkPartner`).
When the site has a **confirmed** water outage (never a held / possibly fake one), the platform refers it to the city
at that pipe, as **one** report from the organisation (one source), so the city's graph can join it with residents'
reports. Only the referral (what, which pipe, how many people) crosses; the workers' reports stay in the site's workspace.
City officers see it under Network → Partner organisations and acknowledge it (L2+); the site sees the status.

Demo: officer → Sample data → *Add private partner organisations* (or `POST /admin/seed-partners`) creates
**Hodal Industrial Park** (fed by the town's South feeder; a 7-worker outage is referred) and **NH-19 Tollway**
(potholes; road problems stay with the operator). Sign in to either with the demo password; e.g. `head1` is the
Estate Manager / Project Manager. Tested in `packages/server/tests/orgs.test.ts`.

## What is not built yet (say "next")
- Editing a site's partner link in the UI (today: demo seed / API record).
- White-label branding per workspace (logo, colours) and a state / district dashboard.
- Billing: plans switch instantly; nothing is charged.
