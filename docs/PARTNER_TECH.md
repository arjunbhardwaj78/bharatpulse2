# How BharatPulse uses Neo4j and Sarvam AI

Both run inside the core flow (report → trust → incident → officer action), not on the side. Everything below is in the
live build. Items marked **verify live** were written against the official docs and tested with mocks: run the smoke
scripts once with real keys (`npm run neo4j:smoke`, `npm run sarvam:smoke`).

## Neo4j: the graph decides what is real and where to send the crew

**Model.** Nodes have real properties (point locations with a spatial index, timestamps with a range index), not JSON blobs:

```
(:Reporter)-[:FILED]->(:Complaint)-[:FROM_DEVICE]->(:Device)          phones stored as one-way fingerprints
(:Complaint)-[:HAS_PHOTO]->(:Photo)    (:Complaint)-[:IN]->(:Locality)-[:PART_OF]->(:Zone)
(:Complaint)-[:PART_OF]->(:Incident)-[:AFFECTS]->(:Locality)
(:Asset {TANK|PUMP|PIPE})-[:FEEDS]->(:Asset)-[:SUPPLIES]->(:Zone)     the water network
(:Zone)-[:FEEDS]->(:Zone)   (:Incident)-[:POSSIBLE_CAUSE]->(:Incident)   (:Reporter)-[:CONFIRMED]->(:Incident|:Complaint)
(:Reporter)-[:CHECKED_IN]->(:Checkin)-[:IN]->(:Locality)   (:Notice)-[:COVERS]->(:Locality)   (:Cache) language packs
```

**What the graph answers** (all queries in `packages/server/src/cypher.ts`, each one checked by Neo4j's own Cypher
parser in `tests/cypher_lint.test.ts`, and shown on screen next to its answer):

| Question | Query | Where it shows |
|---|---|---|
| Which accounts are really one source? | `deviceAndPhotoLinks`: accounts that ever shared a phone or photo, across ALL history | Trust score, Graph page |
| Is this a hired crowd? | `coReportingLinks`: the same pair of accounts reported 2+ incidents together **more than 2 km apart** | Trust score (`GRAPH_RING`), Graph page |
| Where did the water network fail? | `rootCause`: trace trusted open water incidents UP `FEEDS/SUPPLIES` to the asset that explains the most zones with the shortest pipes | "Where to send the crew" |
| Who loses water next? | `atRisk` and `downstream` | "Warn before they call" |
| What is near me? | `complaintsNear`: `point.distance` on the point index | Citizen "problems near you" |
| Did the last fix hold? | `repeatSpots`: same family fixed within 150 m before | Board "came back" tag, Ask |
| Who is behind this incident? | `incidentGraph` + `sharedDevices` | Incident drawer |

**The graph changes the score, not just the screen.** Rings of 3+ linked accounts are attached to every complaint
before detection runs (`service.recompute`). The engine counts a ring as ONE independent source and, when the
per-report checks missed it, takes 20 points off (`GRAPH_RING` in `packages/engine/src/trust.ts`). Because rings
depend on incidents, detection runs a second pass when the rings change.

**Measured** (`npm run eval`, synthetic data, fixed seeds):
- careful hired crowd that comes back 3 km away: caught **0/5 without the graph, 5/5 with it**
- naive campaigns (shared phones, SIM farm, pasted photo): 15/15
- real outages wrongly flagged: 0/10 (neighbours who report the same street twice are not linked: the 2 km rule)

**Speed.** One transaction per save, every step batched with `UNWIND`; only changed incidents are written; reads
re-use the last detection for 10 s (`RECOMPUTE_TTL_MS`); fix photos live on a separate property and are never part of list reads.

## Sarvam AI: anyone can report, in their own language; the officer reads it in English

| Sarvam API | Model | Used for |
|---|---|---|
| Speech to text `/speech-to-text` | `saaras:v3`, mode `transcribe` | Citizen's "Speak your complaint" and the mic in step 3; officer asks by voice. Language detected automatically (22 Indian languages). |
| Translate `/translate` | `sarvam-translate:v1` | Every non-English complaint gets English for the officer; the **classifier runs on the English**, so Tamil or Bengali complaints are classified as well as Hindi. Answers translated back. The whole app UI in 9 more languages. |
| Language ID `/text-lid` | – | Typed complaints in any script. |
| Text to speech `/text-to-speech` | `bulbul:v3` | "Read aloud" for citizens (updates, notices) and officers (what people said, Ask answers). Falls back to the browser voice. |
| Chat `/v1/chat/completions` | `sarvam-105b`, reasoning off, JSON mode | **Ask BharatPulse**: picks ONE whitelisted graph question (it never writes Cypher), then words a 2–3 sentence answer from the graph's facts only. |

**Ask BharatPulse = Sarvam + Neo4j together.** "वार्ड 3 में पानी क्यों नहीं आ रहा?" → Sarvam detects Hindi and
translates → Sarvam-105B picks `root_cause` → Neo4j traces the pipes → Sarvam words the answer → Sarvam translates it
back to Hindi → Bulbul reads it aloud. The screen shows each step and the Cypher that ran. Without a key it still works
(keyword routing, English/Hindi).

**Fallbacks.** If Sarvam is down: typed text is kept and classified by the Hindi/Hinglish keyword list; voice falls back
to the browser recogniser; read-aloud falls back to the browser voice; Ask falls back to keywords and a template answer.
`/health` shows `sarvam.calls` (counts per API) so you can prove in the demo that Sarvam is really being called.

## 3-minute judge demo
1. Officer → **Sample data → Load sample town**. Open **Graph & Ask**.
2. "Where to send the crew": two real outages (Ward 3, Ward 8) trace to the **North feeder**; Wards 4 and 7 are at risk. Open the Cypher.
3. "Fake-report rings": the dark-red row is the hired crowd (same 10 accounts, Ward 5 two days ago, Ward 7 now). Click it: the drawer says *Likely fake campaign* and shows the graph. Live version: **Sample data → Crowd in Ward 5**, then **Same crowd in Ward 7**.
4. Ask by voice or tap the Hindi/Tamil example: answer in that language, Read aloud (Bulbul), Cypher shown.
5. Citizen on a phone: **Speak your complaint** in Tamil → "Heard in தமிழ்", English for the officer, problem type filled in. Switch the app to தமிழ் with the language button.
