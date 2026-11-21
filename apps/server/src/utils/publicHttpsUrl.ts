import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SsrfBlockedError } from './ssrf.js';

/**
 * Checks for images fetched from outside hosts a media server names in its data (Channels DVR
 * guide logos, Plex Live TV art from an M3U tuner): plain https on a public hostname that
 * resolves only to public addresses, so nothing on the local network can be reached through it.
 */

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('::ffff:') ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower)
    );
  }
  return true;
}

/** Only https hostnames that resolve to public addresses; never IP literals. */
export async function assertPublicHttpsUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SsrfBlockedError('Outside images must be plain https URLs');
  }
  if (isIP(host) !== 0 || host === 'localhost' || !host.includes('.')) {
    throw new SsrfBlockedError('Outside images must use a public hostname');
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new SsrfBlockedError('Outside image host resolves to a non-public address');
  }
}
