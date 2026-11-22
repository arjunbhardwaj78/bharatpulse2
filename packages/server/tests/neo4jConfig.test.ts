import { describe, expect, it } from 'vitest';
import { hostOf, neo4jConfigFromEnv } from '../src/neo4jStore.js';

// Offline: only how the Aura settings are read and checked (no connection is made).
describe('Neo4j Aura settings', () => {
  const aura = { NEO4J_URI: 'neo4j+s://abcd1234.databases.neo4j.io', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'secret', NEO4J_DATABASE: 'neo4j' };

  it('is off when NEO4J_URI is empty', () => {
    expect(neo4jConfigFromEnv({})).toBeUndefined();
    expect(neo4jConfigFromEnv({ NEO4J_URI: '  ' })).toBeUndefined();
  });

  it('reads the four Aura variables', () => {
    expect(neo4jConfigFromEnv(aura)).toEqual({ uri: aura.NEO4J_URI, user: 'neo4j', password: 'secret', database: 'neo4j' });
  });

  it('still accepts NEO4J_USER, prefers NEO4J_USERNAME, defaults to neo4j', () => {
    expect(neo4jConfigFromEnv({ ...aura, NEO4J_USERNAME: undefined, NEO4J_USER: 'old' })?.user).toBe('old');
    expect(neo4jConfigFromEnv({ ...aura, NEO4J_USERNAME: 'new', NEO4J_USER: 'old' })?.user).toBe('new');
    expect(neo4jConfigFromEnv({ ...aura, NEO4J_USERNAME: '' })?.user).toBe('neo4j');
  });

  it('uses the default database when NEO4J_DATABASE is empty', () => {
    expect(neo4jConfigFromEnv({ ...aura, NEO4J_DATABASE: '' })?.database).toBeUndefined();
  });

  it('requires an encrypted scheme for Aura hosts', () => {
    expect(() => neo4jConfigFromEnv({ ...aura, NEO4J_URI: 'neo4j://abcd1234.databases.neo4j.io' })).toThrow(/neo4j\+s:\/\/abcd1234\.databases\.neo4j\.io/);
    expect(neo4jConfigFromEnv({ ...aura, NEO4J_URI: 'bolt://localhost:7687' })?.uri).toBe('bolt://localhost:7687'); // a local Neo4j still works
  });

  it('rejects other schemes and a missing password with a clear message', () => {
    expect(() => neo4jConfigFromEnv({ ...aura, NEO4J_URI: 'https://abcd1234.databases.neo4j.io' })).toThrow(/must start with neo4j\+s:\/\//);
    expect(() => neo4jConfigFromEnv({ ...aura, NEO4J_PASSWORD: '' })).toThrow(/NEO4J_PASSWORD is empty/);
  });

  it('shows only the host in messages', () => {
    expect(hostOf('neo4j+s://abcd1234.databases.neo4j.io')).toBe('abcd1234.databases.neo4j.io');
    expect(hostOf('neo4j+s://user:pw@abcd1234.databases.neo4j.io:7687/db')).toBe('abcd1234.databases.neo4j.io');
  });
});
