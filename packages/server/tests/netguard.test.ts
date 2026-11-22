import { describe, expect, it } from 'vitest';
import { checkWebhookUrl, isPrivateAddress, resolvesPublic } from '../src/netguard.js';
import { TenantHub } from '../src/tenants.js';

describe('webhook targets must be public (SSRF)', () => {
  it('refuses internal and unsafe URLs when a webhook is added', () => {
    for (const u of ['http://example.com/h', 'https://localhost/h', 'https://localhost./h', 'https://127.1/h', 'https://2130706433/h', 'https://10.0.0.5/h', 'https://172.16.0.1/h',
      'https://172.31.255.255/h', 'https://192.168.1.1/h', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/h', 'https://[::1]/h', 'https://[fd00::1]/h', 'https://[fe80::1]/h',
      'https://[::ffff:10.0.0.1]/h', 'https://metadata.google.internal/x', 'https://printer.local/x', 'https://intranet/x', 'https://user:pw@example.com/h', 'https://example.com:22/h', 'not a url']) {
      expect('error' in checkWebhookUrl(u), u).toBe(true);
    }
  });
  it('accepts ordinary public https URLs', () => {
    for (const u of ['https://example.com/hooks/bp', 'https://hooks.city.gov.in:443/bp', 'https://8.8.8.8/x', 'https://[2606:4700::1111]/x', 'https://172.32.0.1/x']) expect('url' in checkWebhookUrl(u), u).toBe(true);
  });
  it('knows the private ranges', () => {
    expect(['10.1.2.3', '172.20.0.1', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.100.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', '::ffff:7f00:1'].every(isPrivateAddress)).toBe(true);
    expect(['8.8.8.8', '172.15.0.1', '100.63.0.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
  });
  it('blocks delivery when a public name now resolves inside the network, and never follows redirects', async () => {
    expect(await resolvesPublic('hooks.example.com', async () => ['10.0.0.7'])).toBe(false);
    expect(await resolvesPublic('hooks.example.com', async () => ['93.184.216.34', '127.0.0.1'])).toBe(false);
    expect(await resolvesPublic('hooks.example.com', async () => { throw new Error('NXDOMAIN'); })).toBe(false);
    expect(await resolvesPublic('hooks.example.com', async () => ['93.184.216.34'])).toBe(true);
    const seen: RequestInit[] = [];
    let answer = ['10.0.0.7'];
    const hub = await new TenantHub({ fetchFn: (async (_u: string, init: RequestInit) => { seen.push(init); return new Response('', { status: 302 }); }) as unknown as typeof fetch, resolve: async () => answer, serviceOptions: {} }).init();
    const w = hub.addWebhook('demo', 'https://hooks.example.com/bp');
    expect(await hub.fire('demo', 'test', {}, w.id)).toEqual([{ id: w.id, status: 'blocked: not a public address' }]);
    expect(seen).toHaveLength(0);
    answer = ['93.184.216.34'];
    expect(await hub.fire('demo', 'test', {}, w.id)).toEqual([{ id: w.id, status: '302' }]);
    expect(seen[0].redirect).toBe('manual');
  });
});
