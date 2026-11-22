# Design note: how an incident keeps the same id

## The problem
The engine is a pure function. Every run it forgets the last one and returns groups with ids like
`SUPPLY:<earliest complaint id>`. That id is **not stable**:

- the earliest complaint can age out of the 48 h window, so the id changes;
- two outages can grow together into one group;
- one group can shrink and fall apart into two.

An officer who resolved or escalated "incident X" needs X to still mean the same incident on the next run.

## Decision: match by shared complaints, not by id
A complaint belongs to at most one **active** incident. So after each engine run, for every new group we
count which complaints it shares with each stored active incident:

| Situation | Result |
|---|---|
| shares nothing | new incident, takes the engine's id (suffix `#2`, `#3`... if that id is taken) |
| shares with one | same incident, snapshot refreshed |
| shares with several (merge) | the **oldest** (earliest `detectedAt`) survives; the others become `merged` with `mergedInto` |
| one stored incident overlaps several groups (split) | the group with the most shared complaints keeps the id (ties: earliest first report); the others become new incidents |
| active incident, no group left | `resolved` with `resolution: expired` |

Escalation survives a merge: if any merged incident was `escalated`, the survivor is `escalated`.

## Resolved incidents stay resolved
Complaints that belong to a `resolved` incident are removed from the engine's input. Without that, the next
request would re-cluster the same complaints and silently reopen the incident. New complaints afterwards need
three **new** neighbours to form a new incident.

## Alternatives rejected
- **Use the engine id as the key.** Breaks when the earliest complaint ages out. Officers would lose their incident.
- **Never re-cluster, only append.** Cannot merge or split; incidents drift away from reality.
- **Random id per run.** Nothing is stable at all.

## Known limits
- Complaints that were isolated noise before a resolve are still eligible to join a new incident afterwards.
- A same-reporter duplicate of a resolved incident's complaint can also become eligible again (small edge case).
- Reconciliation reads all incidents and the whole window on every request. Fine at ward scale; needs caching or
  incremental updates beyond that.
- One process only: a mutex serialises recomputation, but two server instances would race. A multi-instance
  deployment (Neo4j) would need a transaction or lock around reconciliation.
