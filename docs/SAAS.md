# BharatPulse as a SaaS product

## The judge's question: "Why would a government adopt this if it already has its own portal?"

**Short answer to say out loud:** *"They don't replace anything. Their portal collects complaints; it does not tell them
which ones are real, where the fault is, or who else will lose water next. BharatPulse plugs into the portal they
already have, by API or by a CSV export, and sends the answers back by webhook. Towns that have no portal at all use
our citizen app directly. A city can sign up and start a free pilot in a minute."*

Why that holds up:

| What their portal does today (CPGRAMS, state 1916 portals, call centres) | What it does not do, and BharatPulse adds |
|---|---|
| Takes one complaint at a time, one ticket each | Groups 40 tickets about one outage into **one incident**, with how many *independent* people are affected |
| Every ticket counts the same | **Fake and duplicate reports** are held back: accounts linked by a phone, a photo or travelling together count as one person (Neo4j) |
| Tickets are routed by category | **Root cause**: outages in several wards are traced up the pipe network to the one feeder they share; the wards it also feeds are warned (Neo4j) |
| Hindi/English forms | **22 languages by voice**; every complaint arrives in English for the officer (Sarvam) |
| Closure on the officer's word | Proof photo checked by a senior officer, then the citizen confirms |

So the buyer keeps its portal, its process and its data. That removes the biggest adoption blocker (no
rip-and-replace, no retraining of call-centre staff) and lets us sell to cities that have just spent money on a portal.

## The harder question: "We can build our own. Why pay you?"
**Say this:** *"A Municipal Corporation with an IT cell might build its own complaint form. Our customer is one of the
4,000+ Nagar Palikas and Nagar Panchayats with no software team; they already buy their accounts and property-tax software.
And what they cannot build alone is the network: when one town's graph catches a hired crowd, every other town on
BharatPulse holds those accounts on their very first report. A town on its own system starts with an empty list."*

| What a city builds alone | What it gets on BharatPulse |
|---|---|
| Complaint form, tracking, workflow (doable, a few months) | Live on day one, free 90-day pilot |
| Speech + translation in 22 languages (AI contracts and upkeep every year) | Included (Sarvam), shared by every city |
| Graph fraud detection (graph database, data scientists, tuning) | Included (Neo4j), improves with every city |
| **Crowds already caught in other towns: impossible alone** | **Held on their first report** (shared watchlist) |
| **Benchmarks against similar towns: impossible alone** | Live, other towns anonymised |
| Security audits, updates, uptime | Ours, for every city at once |

**Show it live (2 minutes):** load the sample town in the demo city (the travelling crowd is caught there by the graph) →
Start a pilot for a second town → sign in there as `head1` → **Network** → *Simulate the crowd arriving*. Ten reports
arrive; the second town has no evidence of its own (one incident, nothing elsewhere), yet they count as **one source** and
go to a site check instead of a crew, flagged `NETWORK_RING`. Without the network the same ten accounts look like ten real
people (`tests/network.test.ts` proves both).

**Privacy:** only accounts already in a ring of 3+ are shared, as one-way fingerprints (HMAC of the phone with the
platform key, identical across cities). No phone number, complaint text, photo or location crosses cities; the public
`/network` endpoint returns counts and city names only.

Where it is: `server/src/network.ts` (watchlist + benchmarks), `TenantHub.networkSummary/benchmarks`, routes `/network`,
`/network/benchmarks`, `/network/simulate`; engine signal `NETWORK_RING`; Cypher `crossCityAccounts` (the one query
deliberately not scoped to a tenant) runs on Neo4j through `Neo4jTenantRegistry.crossCity`; officer page **Network**.

## Two ways to use it (both live in this build)
1. **Standalone** (small Nagar Palikas / Panchayats with no portal): citizen app + officer portal, as demoed.
2. **Plug-in / Connect** (cities with a portal): `POST /v1/complaints` with an API key, or CSV upload in *City account*;
   results back via signed webhook (`incident.created`) or `GET /v1/incidents`. Re-sending the same `externalId` is safe.

## What makes it a SaaS, not a college project
| SaaS capability | Where it is |
|---|---|
| **Multi-tenant**: many cities on one deployment, data isolated | `TenantHub` (`server/src/tenants.ts`); in Neo4j every node carries `tenant` and every query filters on it, `(tenant, id)` is the key (`cypher.ts`). Tested: a second city sees nothing of the first (`tests/saas.test.ts`, `npm run neo4j:smoke`). |
| **Self-serve onboarding** | `#/onboard`: find your town (maps-style search), choose wards and a plan → own ward map + water network (draft), officer accounts with the city's own password (shown once), own data space. |
| **Per-city admin console** | Officer portal → *City account* (department head / commissioner): usage vs plan, plan switch, API keys (hashed, shown once, revocable), webhooks (HMAC-signed, test button), CSV import. |
| **Usage metering** | Reports, imports, Sarvam calls, graph queries, Ask, webhook deliveries, per city per month. |
| **Plans and pricing** | `GET /plans`; pricing page on the landing site. |
| **Security per tenant** | Officer tokens are bound to their city (`wrong_city`), API keys map to one city, rate limits, city signup limited to 3 per network per hour. |

## Pricing hypothesis (validate in the 3 customer calls)
- **Pilot**: free 90 days, up to 10 wards.
- **Town**: ₹1,500 per ward per month (a 30-ward Nagar Palika ≈ ₹5.4 lakh/year).
- **City**: ₹1,100 per ward per month for 60+ wards.
- **Connect** (keep your portal): ₹0.40 per complaint processed.
Questions to ask a municipal officer: Who signs off a ₹5 lakh/year software purchase? Does it come from the 15th Finance
Commission / AMRUT / Smart City funds? Would they rather pay per ward or per complaint?

## Honest limits to say before a judge does
- The generated ward map and water network are a **draft**: the city's engineers must correct ward boundaries and pipes (an editor is the next step).
- No real billing: plans switch instantly; nothing is charged.
- No SMS provider: OTPs are shown on screen as a "demo SMS".
- Neo4j and Sarvam must be checked once live with `npm run neo4j:smoke` and `npm run sarvam:smoke`.
