import { lintCypherQuery } from '@neo4j-cypher/language-support';
import { describe, expect, it } from 'vitest';
import { Q, SCHEMA } from '../src/cypher.js';

// Every query the app sends to Neo4j goes through Neo4j's own Cypher parser here: syntax errors and undefined
// variables fail the build. ($parameters are supplied at run time, so "parameter not defined" is ignored.)
describe('Cypher', () => {
  const all: [string, string][] = [...Object.entries(Q), ...SCHEMA.map((s, i): [string, string] => [`schema ${i}`, s])];
  it.each(all)('%s is valid Cypher', (_name, query) => {
    const out = lintCypherQuery(query, {}) as unknown as { message: string }[] | { diagnostics: { message: string }[] };
    const problems = (Array.isArray(out) ? out : out.diagnostics).filter((d: { message: string }) => !/Parameter \$\w+ is not defined/.test(d.message));
    expect(problems.map((d: { message: string }) => d.message)).toEqual([]);
  });
});
