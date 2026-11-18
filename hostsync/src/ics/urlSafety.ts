/**
 * SSRF guard for calendar feeds (spec §6.1 "ICS fetch").
 *
 * The original app fetched any URL a user pasted, from the server, with no
 * checks. That is a request forwarder into the private network. Every feed URL
 * must pass this gate before a socket is opened.
 */
export class UnsafeFeedUrlError extends Error {
  readonly code = 'unsafe_url';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeFeedUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (numbers.some((value) => Number.isNaN(value) || value > 255)) return null;
  return numbers;
}

function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!value.includes(':')) return false;
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
    return true; // fe80::/10
  }
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  if (value.startsWith('::ffff:')) return isPrivateIpv4(value.slice('::ffff:'.length));
  return false;
}

export const MAX_FEED_BYTES = 2 * 1024 * 1024;

export function assertFetchableFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeFeedUrlError("That doesn't look like a web link");
  }

  if (url.protocol !== 'https:') {
    throw new UnsafeFeedUrlError('calendar links must use https');
  }
  if (url.username || url.password) {
    throw new UnsafeFeedUrlError('calendar links cannot carry credentials');
  }
  if (url.port && url.port !== '443') {
    throw new UnsafeFeedUrlError('calendar links must use the standard https port');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeFeedUrlError('that address is not reachable from here');
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new UnsafeFeedUrlError('that address is not reachable from here');
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new UnsafeFeedUrlError('that address is not reachable from here');
  }

  return url;
}
