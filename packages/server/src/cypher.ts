/**
 * Every Cypher query BharatPulse runs, in one place.
 *  - tests/cypher_lint.test.ts checks every query with Neo4j's own Cypher parser (syntax + variables).
 *  - The officer Graph page shows the query behind each answer, so a judge can see what the graph did.
 * Parameters are always passed as $params, never pasted into the text.
 */

/** Schema: one statement per entry (Neo4j runs schema commands one at a time). */
export const TENANT_LABELS = ['Complaint', 'Reporter', 'Device', 'Photo', 'Incident', 'Zone', 'Locality', 'Facility', 'Checkin', 'Notice', 'Asset', 'Cache'];
/**
 * Multi-city: every node carries `tenant` (the city's id) and every query filters on it, so one Neo4j database
 * serves many cities without any city seeing another's data. Ids are unique per city: (tenant, id) is the key.
 * Additive only (`IF NOT EXISTS`): this may be a database that already holds other data, so nothing is ever dropped.
 * Older single-city builds made `<label>_id` unique on id alone; `legacyIdConstraints` finds those so the server can
 * say how to remove them, instead of removing them itself.
 */
export const SCHEMA: string[] = [
  ...TENANT_LABELS.map((t) => `CREATE CONSTRAINT ${t.toLowerCase()}_tenant_id IF NOT EXISTS FOR (n:${t}) REQUIRE (n.tenant, n.id) IS UNIQUE`),
  'CREATE CONSTRAINT tenant_id IF NOT EXISTS FOR (t:Tenant) REQUIRE t.id IS UNIQUE',
  'CREATE INDEX complaint_created IF NOT EXISTS FOR (c:Complaint) ON (c.createdAt)',
  'CREATE POINT INDEX complaint_location IF NOT EXISTS FOR (c:Complaint) ON (c.location)',
  'CREATE INDEX incident_status IF NOT EXISTS FOR (i:Incident) ON (i.status)',
  'CREATE POINT INDEX incident_location IF NOT EXISTS FOR (i:Incident) ON (i.location)',
  'CREATE INDEX checkin_at IF NOT EXISTS FOR (k:Checkin) ON (k.at)',
];

export const Q = {
  /** Read-only: single-property uniqueness constraints on `id` (filtered to BharatPulse labels by the caller). */
  legacyIdConstraints: "SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties WHERE type IN ['UNIQUENESS', 'NODE_PROPERTY_UNIQUENESS'] AND size(labelsOrTypes) = 1 AND properties = ['id'] RETURN name, labelsOrTypes[0] AS label",
  // ---- the platform: one Tenant node per city (its settings as JSON) -------------------------------------------
  /**
   * The platform question no single city can ask: the same account fingerprint (an HMAC of the phone, identical in
   * every city) reporting in more than one city. Deliberately NOT tenant-scoped; it returns ids and city ids only.
   */
  crossCityAccounts: `MATCH (r:Reporter)
WHERE r.id IN $ids
WITH r.id AS account, collect(DISTINCT r.tenant) AS cities
WHERE size(cities) > 1
RETURN account, cities`,
  /**
   * A private site fed by a government network (with consent): the city's pipe FEEDS_SITE the site's tank, so a
   * root-cause walk can cross from one workspace into the other. Both ends stay scoped to their own tenant.
   */
  linkPartner: `MERGE (pipe:Asset {tenant: $to, id: $toAsset})
MERGE (site:Asset {tenant: $from, id: $fromAsset})
MERGE (pipe)-[:FEEDS_SITE]->(site)`,
  listTenants: 'MATCH (t:Tenant) RETURN t.data AS data ORDER BY t.createdAt',
  saveTenant: 'MERGE (t:Tenant {id: $id}) SET t.data = $data, t.createdAt = coalesce(t.createdAt, $createdAt), t.name = $name',

  // ---- the town: zones, wards, facilities and the water network --------------------------------------------
  seedZones: 'UNWIND $zones AS z MERGE (n:Zone {tenant: $tenant, id: z.id}) SET n.name = z.name',
  seedZoneFeeds: 'UNWIND $zones AS z UNWIND z.feeds AS to MATCH (a:Zone {tenant: $tenant, id: z.id}) MATCH (b:Zone {tenant: $tenant, id: to}) MERGE (a)-[:FEEDS]->(b)',
  seedLocalities:
    'UNWIND $ls AS l MERGE (n:Locality {tenant: $tenant, id: l.id}) SET n.name = l.name, n.location = point({latitude: l.lat, longitude: l.lng}) WITH n, l MATCH (z:Zone {tenant: $tenant, id: l.zoneId}) MERGE (n)-[:PART_OF]->(z)',
  seedFacilities:
    'UNWIND $fs AS f MERGE (n:Facility {tenant: $tenant, id: f.id}) SET n.name = f.name, n.type = f.type, n.location = point({latitude: f.lat, longitude: f.lng}) WITH n, f MATCH (l:Locality {tenant: $tenant, id: f.locality}) MERGE (n)-[:LOCATED_IN]->(l)',
  seedAssets:
    'UNWIND $assets AS a MERGE (n:Asset {tenant: $tenant, id: a.id}) SET n.name = a.name, n.kind = a.kind, n.location = point({latitude: a.lat, longitude: a.lng})',
  seedAssetFeeds: 'UNWIND $assets AS a UNWIND a.feeds AS to MATCH (x:Asset {tenant: $tenant, id: a.id}) MATCH (y:Asset {tenant: $tenant, id: to}) MERGE (x)-[:FEEDS]->(y)',
  seedAssetSupplies: 'UNWIND $assets AS a UNWIND a.supplies AS z MATCH (x:Asset {tenant: $tenant, id: a.id}) MATCH (y:Zone {tenant: $tenant, id: z}) MERGE (x)-[:SUPPLIES]->(y)',

  // ---- complaints ------------------------------------------------------------------------------------------------
  addComplaint: `MERGE (r:Reporter {tenant: $tenant, id: $reporterId})
ON CREATE SET r.firstSeen = $createdAt
CREATE (c:Complaint {tenant: $tenant, id: $id, createdAt: $createdAt, issueType: $issueType, family: $family,
  location: point({latitude: $lat, longitude: $lng}), text: $text, textEn: $textEn, language: $language, data: $data})
MERGE (r)-[:FILED]->(c)
FOREACH (_ IN CASE WHEN $deviceId IS NULL THEN [] ELSE [1] END | MERGE (d:Device {tenant: $tenant, id: $deviceId}) MERGE (c)-[:FROM_DEVICE]->(d))
FOREACH (_ IN CASE WHEN $localityId IS NULL THEN [] ELSE [1] END | MERGE (l:Locality {tenant: $tenant, id: $localityId}) MERGE (c)-[:IN]->(l))
WITH c
UNWIND $photos AS h
MERGE (p:Photo {tenant: $tenant, id: h})
MERGE (c)-[:HAS_PHOTO]->(p)`,
  complaintsSince: 'MATCH (c:Complaint {tenant: $tenant}) WHERE c.createdAt >= $since RETURN c.data AS data ORDER BY c.createdAt, c.id',
  /** Spatial index: complaints within a radius of a point (used for "problems near you"). */
  complaintsNear: `MATCH (c:Complaint {tenant: $tenant})
WHERE c.createdAt >= $since AND point.distance(c.location, point({latitude: $lat, longitude: $lng})) <= $radius
RETURN c.data AS data ORDER BY c.createdAt, c.id`,

  // ---- incidents (written in one transaction, batched with UNWIND) -----------------------------------------------
  upsertIncidents: `UNWIND $rows AS row
MERGE (i:Incident {tenant: $tenant, id: row.id})
SET i.data = row.data, i.status = row.status, i.family = row.family, i.level = row.level, i.score = row.score,
  i.sources = row.sources, i.needsVerification = row.needsVerification, i.firstReportedAt = row.firstReportedAt,
  i.location = point({latitude: row.lat, longitude: row.lng})`,
  dropIncidentLinks: `UNWIND $ids AS id
MATCH (i:Incident {tenant: $tenant, id: id})
OPTIONAL MATCH (:Complaint {tenant: $tenant})-[m:PART_OF]->(i)
OPTIONAL MATCH (i)-[o:POSSIBLE_CAUSE|AFFECTS]->()
DELETE m, o`,
  linkMembers: 'UNWIND $pairs AS p MATCH (c:Complaint {tenant: $tenant, id: p.c}) MATCH (i:Incident {tenant: $tenant, id: p.i}) MERGE (c)-[:PART_OF]->(i)',
  linkAffects: 'UNWIND $pairs AS p MATCH (i:Incident {tenant: $tenant, id: p.i}) MATCH (l:Locality {tenant: $tenant, id: p.l}) MERGE (i)-[:AFFECTS]->(l)',
  linkCauses: 'UNWIND $pairs AS p MATCH (a:Incident {tenant: $tenant, id: p.from}) MATCH (b:Incident {tenant: $tenant, id: p.to}) MERGE (a)-[x:POSSIBLE_CAUSE]->(b) SET x.distanceM = p.d',
  setProofPhotos: 'UNWIND $rows AS p MATCH (i:Incident {tenant: $tenant, id: p.id}) SET i.proofPhoto = p.photo',
  clearProofPhotos: 'UNWIND $ids AS id MATCH (i:Incident {tenant: $tenant, id: id}) REMOVE i.proofPhoto',
  listIncidents: 'MATCH (i:Incident {tenant: $tenant}) RETURN i.data AS data',
  getIncident: 'MATCH (i:Incident {tenant: $tenant, id: $id}) RETURN i.data AS data, i.proofPhoto AS photo',

  // ---- people ----------------------------------------------------------------------------------------------------
  getReporter: 'MATCH (r:Reporter {tenant: $tenant, id: $id}) RETURN r.firstSeen AS firstSeen, r.confirmedResolved AS confirmedResolved, r.lostDisputes AS lostDisputes',
  saveReporter: `MERGE (r:Reporter {tenant: $tenant, id: $id})
SET r.firstSeen = coalesce(r.firstSeen, $firstSeen), r.confirmedResolved = $confirmedResolved, r.lostDisputes = $lostDisputes`,
  confirm: `MERGE (r:Reporter {tenant: $tenant, id: $reporterId})
WITH r
MATCH (i:Incident {tenant: $tenant, id: $incidentId})
MERGE (r)-[x:CONFIRMED]->(i)
ON CREATE SET x.fresh = true
ON MATCH SET x.fresh = false
RETURN x.fresh AS fresh`,
  /** "Me too" on a single report that is not an incident yet: the lock sits on the complaint. */
  confirmComplaint: `MERGE (r:Reporter {tenant: $tenant, id: $reporterId})
WITH r
MATCH (c:Complaint {tenant: $tenant, id: $incidentId})
MERGE (r)-[x:CONFIRMED]->(c)
ON CREATE SET x.fresh = true
ON MATCH SET x.fresh = false
RETURN x.fresh AS fresh`,
  hasConfirmed: 'MATCH (:Reporter {tenant: $tenant, id: $reporterId})-[:CONFIRMED]->(n {tenant: $tenant, id: $incidentId}) RETURN 1 AS x LIMIT 1',
  confirmers: 'MATCH (r:Reporter {tenant: $tenant})-[:CONFIRMED]->(:Incident {tenant: $tenant, id: $incidentId}) RETURN r.id AS id ORDER BY id',
  confirmedBy: 'MATCH (:Reporter {tenant: $tenant, id: $reporterId})-[:CONFIRMED]->(n) RETURN n.id AS id',

  // ---- diary and notices (linked into the graph, not loose nodes) -------------------------------------------------
  addCheckin: `MERGE (k:Checkin {tenant: $tenant, id: $id})
SET k.at = $at, k.status = $status, k.date = $date, k.data = $data
MERGE (r:Reporter {tenant: $tenant, id: $reporterId})
MERGE (r)-[:CHECKED_IN]->(k)
WITH k
OPTIONAL MATCH (l:Locality {tenant: $tenant, id: $wardId})
FOREACH (_ IN CASE WHEN l IS NULL THEN [] ELSE [1] END | MERGE (k)-[:IN]->(l))`,
  checkinsSince: 'MATCH (k:Checkin {tenant: $tenant}) WHERE k.at >= $since RETURN k.data AS data ORDER BY k.at',
  saveNotice: `MERGE (k:Notice {tenant: $tenant, id: $id})
SET k.startsAt = $startsAt, k.endsAt = $endsAt, k.kind = $kind, k.data = $data
WITH k
UNWIND $wardIds AS w
MATCH (l:Locality {tenant: $tenant, id: w})
MERGE (k)-[:COVERS]->(l)`,
  listNotices: 'MATCH (k:Notice {tenant: $tenant}) RETURN k.data AS data ORDER BY k.startsAt',
  deleteNotice: 'MATCH (k:Notice {tenant: $tenant, id: $id}) DETACH DELETE k RETURN 1 AS x',
  clear: 'MATCH (n {tenant: $tenant}) WHERE n:Complaint OR n:Reporter OR n:Device OR n:Photo OR n:Incident OR n:Checkin OR n:Notice DETACH DELETE n',
  getCache: 'MATCH (k:Cache {tenant: $tenant, id: $id}) RETURN k.value AS value',
  setCache: 'MERGE (k:Cache {tenant: $tenant, id: $id}) SET k.value = $value, k.at = timestamp()',

  // ---- GRAPH QUESTIONS (the reason this product uses a graph) ---------------------------------------------------

  /** Who is behind one incident: accounts, their reports, the phones and photos they used. */
  incidentGraph: `MATCH (i:Incident {tenant: $tenant, id: $incidentId})<-[:PART_OF]-(c:Complaint {tenant: $tenant})<-[:FILED]-(r:Reporter {tenant: $tenant})
OPTIONAL MATCH (c)-[:FROM_DEVICE]->(d:Device {tenant: $tenant})
OPTIONAL MATCH (c)-[:HAS_PHOTO]->(p:Photo {tenant: $tenant})
RETURN c.id AS complaint, c.issueType AS issueType, r.id AS reporter, d.id AS device, collect(p.id) AS photos
ORDER BY complaint`,
  /** Phones behind this incident that 3+ different accounts used, counted across ALL history, not just this incident. */
  sharedDevices: `MATCH (:Incident {tenant: $tenant, id: $incidentId})<-[:PART_OF]-(:Complaint {tenant: $tenant})-[:FROM_DEVICE]->(d:Device {tenant: $tenant})<-[:FROM_DEVICE]-(:Complaint {tenant: $tenant})<-[:FILED]-(r:Reporter {tenant: $tenant})
WITH d, count(DISTINCT r) AS reporters
WHERE reporters > 2
RETURN d.id AS deviceId, reporters
ORDER BY deviceId`,

  /** Fake-report rings, part 1: two accounts that ever used the same phone or the same photo. */
  deviceAndPhotoLinks: `MATCH (r1:Reporter {tenant: $tenant})-[:FILED]->(:Complaint {tenant: $tenant})-[:FROM_DEVICE|HAS_PHOTO]->(x)<-[:FROM_DEVICE|HAS_PHOTO]-(:Complaint {tenant: $tenant})<-[:FILED]-(r2:Reporter {tenant: $tenant})
WHERE r1.id < r2.id
RETURN DISTINCT r1.id AS a, r2.id AS b, CASE WHEN x:Device THEN 'DEVICE' ELSE 'PHOTO' END AS via`,
  /**
   * Fake-report rings, part 2: the same pair of accounts reported 2+ incidents together, and those incidents are more
   * than $farM apart. Neighbours report together in one neighbourhood; a hired crowd travels.
   */
  coReportingLinks: `MATCH (r1:Reporter {tenant: $tenant})-[:FILED]->(:Complaint {tenant: $tenant})-[:PART_OF]->(i:Incident {tenant: $tenant})<-[:PART_OF]-(:Complaint {tenant: $tenant})<-[:FILED]-(r2:Reporter {tenant: $tenant})
WHERE r1.id < r2.id AND i.status <> 'merged'
WITH r1, r2, collect(DISTINCT i) AS shared
WHERE size(shared) >= 2 AND any(x IN shared WHERE any(y IN shared WHERE point.distance(x.location, y.location) > $farM))
RETURN r1.id AS a, r2.id AS b, 'CO_REPORTING' AS via`,
  /** Which open incidents each ring has reported into. */
  ringTargets: `UNWIND $rings AS ring
UNWIND ring.accounts AS acc
MATCH (:Reporter {tenant: $tenant, id: acc})-[:FILED]->(:Complaint {tenant: $tenant})-[:PART_OF]->(i:Incident {tenant: $tenant})
WHERE i.status IN ['open', 'escalated']
RETURN DISTINCT ring.id AS ring, i.id AS incident`,

  /**
   * Root cause: zones with trusted, open water incidents, traced UP the water network.
   * The asset that explains the most affected zones, with the shortest pipes to them, is the first place to check.
   */
  rootCause: `MATCH (i:Incident {tenant: $tenant})-[:AFFECTS]->(l:Locality {tenant: $tenant})-[:PART_OF]->(z:Zone {tenant: $tenant})
WHERE i.status IN ['open', 'escalated'] AND i.family IN ['SUPPLY', 'QUALITY'] AND i.needsVerification = false
WITH collect(DISTINCT z) AS hit, collect(DISTINCT i.id) AS incidents, collect(DISTINCT l.id) AS hitLocalities
UNWIND hit AS z
MATCH p = (a:Asset {tenant: $tenant})-[:FEEDS|SUPPLIES*1..6]->(z)
WHERE all(n IN nodes(p)[..-1] WHERE n:Asset)
WITH a, z, min(length(p)) AS d, hit, incidents, hitLocalities
WITH a, collect(z.id) AS covers, sum(d) AS distance, [h IN hit | h.id] AS zonesHit, incidents, hitLocalities
RETURN a.id AS assetId, a.name AS name, a.kind AS kind, covers, distance, zonesHit, incidents, hitLocalities
ORDER BY size(covers) DESC, distance ASC, assetId ASC
LIMIT 3`,
  /** Wards fed by the suspect asset that have not reported anything yet: warn them first. */
  atRisk: `MATCH p = (a:Asset {tenant: $tenant, id: $assetId})-[:FEEDS|SUPPLIES*1..6]->(z:Zone {tenant: $tenant})
WHERE all(n IN nodes(p)[..-1] WHERE n:Asset)
MATCH (l:Locality {tenant: $tenant})-[:PART_OF]->(z)
WHERE NOT l.id IN $hitLocalities
RETURN DISTINCT l.id AS localityId, l.name AS name, z.id AS zone
ORDER BY localityId`,
  /** If a zone fails, which zones lose water next (1 to 3 steps down the FEEDS chain). */
  downstream: `MATCH p = (:Zone {tenant: $tenant, id: $zone})-[:FEEDS*1..3]->(d:Zone {tenant: $tenant})
WHERE length(p) <= $hops
WITH d, min(length(p)) AS hops
OPTIONAL MATCH (l:Locality {tenant: $tenant})-[:PART_OF]->(d)
RETURN d.id AS zone, hops, collect(l.id) AS localities
ORDER BY hops, zone`,
  /** One ward: its zone, what feeds it, and what is open there now. */
  wardStatus: `MATCH (l:Locality {tenant: $tenant, id: $ward})-[:PART_OF]->(z:Zone {tenant: $tenant})
OPTIONAL MATCH (up:Zone {tenant: $tenant})-[:FEEDS]->(z)
OPTIONAL MATCH (src:Asset {tenant: $tenant})-[:SUPPLIES]->(z)
OPTIONAL MATCH (i:Incident {tenant: $tenant})-[:AFFECTS]->(l)
WHERE i.status IN ['open', 'escalated']
RETURN l.id AS ward, l.name AS name, z.id AS zone, z.name AS zoneName, collect(DISTINCT up.id) AS fedBy,
  collect(DISTINCT src.name) AS suppliedBy, collect(DISTINCT i.data) AS incidents`,
  /** The same kind of problem fixed within 150 m before: did the last fix hold? (spatial index) */
  repeatSpots: `MATCH (a:Incident {tenant: $tenant}) WHERE a.status IN ['open', 'escalated']
MATCH (b:Incident {tenant: $tenant})
WHERE b.status = 'resolved' AND b.family = a.family AND b.firstReportedAt < a.firstReportedAt
  AND point.distance(a.location, b.location) <= 150
RETURN a.id AS incident, count(b) AS fixedBefore
ORDER BY fixedBefore DESC`,

  // ---- officer Graph page: the whole picture ---------------------------------------------------------------------
  overviewNetwork: `MATCH (a:Asset {tenant: $tenant})
OPTIONAL MATCH (a)-[r:FEEDS|SUPPLIES]->(b)
RETURN a.id AS id, a.name AS name, a.kind AS kind, a.location.latitude AS lat, a.location.longitude AS lng,
  collect(CASE WHEN b IS NULL THEN NULL ELSE {to: b.id, type: type(r)} END) AS out`,
  overviewPlaces: `MATCH (l:Locality {tenant: $tenant})-[:PART_OF]->(z:Zone {tenant: $tenant})
RETURN l.id AS id, l.name AS name, l.location.latitude AS lat, l.location.longitude AS lng, z.id AS zone, z.name AS zoneName
ORDER BY id`,
  overviewIncidents: `MATCH (i:Incident {tenant: $tenant})
WHERE i.status IN ['open', 'escalated']
OPTIONAL MATCH (i)-[:AFFECTS]->(l:Locality {tenant: $tenant})
RETURN i.data AS data, l.id AS locality`,
};

export type QueryName = keyof typeof Q;
