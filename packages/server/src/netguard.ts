import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Webhooks make the server send requests to addresses a city admin chooses, so they must only ever reach the
 * public internet: never loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast or reserved
 * addresses. The URL is checked when the webhook is added, and the host's DNS answer again before every delivery
 * (a public name can point at an internal address). Redirects are not followed.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (kind === 6) {
    const x = ip.toLowerCase();
    const dotted = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); // IPv4-mapped, dotted form
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x); // IPv4-mapped, hex form (what URL() produces)
    if (hex) { const h = parseInt(hex[1], 16); const l = parseInt(hex[2], 16); return isPrivateAddress(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`); }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('::ffff:') || x.startsWith('100::');
  }
  return true; // not an address at all: callers resolve names first
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home\.arpa|intranet|corp)$/;

/** Checks a webhook URL when it is added. Returns the normalised URL or a reason it is refused. */
export function checkWebhookUrl(raw: unknown): { url: URL } | { error: string } {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return { error: 'Enter a full https:// URL' }; }
  if (u.protocol !== 'https:') return { error: 'Webhooks must use https://' };
  if (u.username || u.password) return { error: 'Put credentials in your receiver, not in the webhook URL' };
  if (u.port && u.port !== '443' && u.port !== '8443') return { error: 'Webhooks must use port 443 (or 8443)' };
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host) ? isPrivateAddress(host) : LOCAL_NAMES.test(host) || !host.includes('.')) return { error: 'Webhooks must be public https:// URLs' };
  return { url: u };
}

/** True when every address the host resolves to is public (checked before each delivery). */
export async function resolvesPublic(hostname: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return !isPrivateAddress(host);
  try { const all = await resolve(host); return all.length > 0 && all.every((a) => !isPrivateAddress(a)); } catch { return false; }
}
