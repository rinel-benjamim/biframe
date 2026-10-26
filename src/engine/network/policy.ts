/**
 * Network policy for imported content.
 *
 * Imported projects are untrusted. Every request made by a preview or render
 * session passes through this policy:
 *
 *  - the project's own origin (a loopback server created by Biframe) is allowed;
 *  - `data:` and `blob:` are allowed (they cannot reach the network);
 *  - remote http(s) resources are allowed only when the user enabled them, and
 *    never when the host resolves to a private, loopback, link-local or
 *    otherwise special address (SSRF defence);
 *  - every other scheme, including `file:`, is blocked;
 *  - navigation is restricted to the project origin, so an imported page cannot
 *    navigate the capture window to a foreign site.
 *
 * Hostnames are resolved before the decision is taken; `isPrivateHost` covers
 * literals and special names synchronously for the fast path.
 */

export type BlockReason =
  | 'remote-disabled'
  | 'private-network'
  | 'scheme-not-allowed'
  | 'outside-project'
  | 'empty-url';

export type ResourceDecision =
  | { action: 'allow'; kind: 'project' | 'data' | 'remote' }
  | { action: 'block'; reason: BlockReason; detail: string };

export interface PolicyOptions {
  /** Origin of the loopback project server, e.g. `http://127.0.0.1:41337`. */
  projectOrigin: string;
  allowRemote: boolean;
}

const SPECIAL_HOSTNAMES = ['localhost', 'localhost.localdomain', 'metadata.google.internal'];

export function hostFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.hostname ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

const PRIVATE_V4_RANGES: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function toInt(octets: number[]): number {
  return ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
}

function inRange(value: number, base: number[], prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (toInt(base) & mask) >>> 0;
}

export function isPrivateIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const value = toInt(octets);
  return PRIVATE_V4_RANGES.some(([base, prefix]) => inRange(value, base, prefix));
}

function parseIpv6(host: string): number[] | null {
  let value = host.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(':')) return null;
  if (!/^[0-9a-f:.]+$/.test(value)) return null;

  // An embedded dotted-quad tail (::ffff:127.0.0.1) is converted to two
  // hexadecimal groups so the rest of the parser only sees hex.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const high = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const low = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    value = `${value.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  const tailParts = halves.length === 2 && (halves[1] ?? '') !== '' ? (halves[1] ?? '').split(':') : [];
  const explicit = [...head, ...tailParts];
  if (halves.length === 1 && explicit.length !== 8) return null;
  if (halves.length === 2 && explicit.length > 7) return null;

  const groups: number[] = [];
  for (const segment of head) {
    if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
    groups.push(parseInt(segment, 16));
  }
  const missing = 8 - explicit.length;
  for (let index = 0; index < missing; index += 1) groups.push(0);
  for (const segment of tailParts) {
    if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
    groups.push(parseInt(segment, 16));
  }
  return groups.length === 8 ? groups : null;
}

function embeddedIpv4(groups: number[], at: number): string {
  return [
    (groups[at] ?? 0) >> 8,
    (groups[at] ?? 0) & 0xff,
    (groups[at + 1] ?? 0) >> 8,
    (groups[at + 1] ?? 0) & 0xff,
  ].join('.');
}

export function isPrivateIpv6(host: string): boolean {
  const groups = parseIpv6(host);
  if (!groups) return false;
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();

  const allZeroPrefix = groups.slice(0, 5).every((group) => group === 0);
  if (allZeroPrefix && groups[5] === 0 && groups[6] === 0 && groups[7] === 0) return true; // ::
  if (allZeroPrefix && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true; // ::1

  // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96.
  if (allZeroPrefix && groups[5] === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(groups, 6));
  }
  if (allZeroPrefix && groups[5] === 0) return true;

  // NAT64 well-known prefix, 6to4 and Teredo can all tunnel to arbitrary IPv4
  // destinations; none of them is useful for loading a project asset.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return true;
  if (groups[0] === 0x2002) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return true;

  if ((groups[0] ?? 0) >= 0xfc00 && (groups[0] ?? 0) <= 0xfdff) return true; // unique local
  if ((groups[0] ?? 0) >= 0xfe80 && (groups[0] ?? 0) <= 0xfebf) return true; // link local
  if ((groups[0] ?? 0) >= 0xff00) return true; // multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0010) return true; // ORCHID
  if (groups[0] === 0x2001 && groups[1] === 0x0002) return true; // benchmarking
  if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // discard-only

  // A zone identifier only makes sense on a scoped address; if one survived,
  // fail closed rather than treating it as global.
  if (normalized.includes('%')) return true;
  return false;
}

/** Synchronous check for host literals and well-known special names. */
export function isPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized.length === 0) return true;
  if (SPECIAL_HOSTNAMES.includes(normalized)) return true;
  if (normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal') || normalized.endsWith('.home.arpa')) {
    return true;
  }
  if (isPrivateIpv4(normalized)) return true;
  if (isPrivateIpv6(normalized)) return true;
  return false;
}

/** Resolved addresses for a hostname, used by the engine before allowing a remote request. */
export function isPrivateAddressList(addresses: string[]): boolean {
  return addresses.length === 0 || addresses.some((address) => isPrivateHost(address));
}

export function isRemoteHostName(host: string): boolean {
  return !isPrivateHost(host);
}

function sameOrigin(rawUrl: string, origin: string): boolean {
  try {
    const url = new URL(rawUrl);
    const base = new URL(origin);
    return url.protocol === base.protocol && url.host === base.host;
  } catch {
    return false;
  }
}

export function classifyResource(rawUrl: string, options: PolicyOptions): ResourceDecision {
  if (!rawUrl || rawUrl === 'about:blank') {
    return { action: 'allow', kind: 'project' };
  }
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) {
    return { action: 'allow', kind: 'data' };
  }
  if (sameOrigin(rawUrl, options.projectOrigin)) {
    return { action: 'allow', kind: 'project' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: 'block', reason: 'empty-url', detail: rawUrl.slice(0, 200) };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'block', reason: 'scheme-not-allowed', detail: url.protocol };
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    return { action: 'block', reason: 'private-network', detail: host };
  }
  if (!options.allowRemote) {
    return { action: 'block', reason: 'remote-disabled', detail: url.origin };
  }
  return { action: 'allow', kind: 'remote' };
}

/** Navigation is stricter than subresource loading: only the project itself. */
export function classifyNavigation(rawUrl: string, options: Pick<PolicyOptions, 'projectOrigin'>): ResourceDecision {
  if (rawUrl === 'about:blank') return { action: 'allow', kind: 'project' };
  if (sameOrigin(rawUrl, options.projectOrigin)) return { action: 'allow', kind: 'project' };
  return { action: 'block', reason: 'outside-project', detail: rawUrl.slice(0, 200) };
}

/** Makes an absolute URL for a project-relative resource path. */
export function projectUrlFor(origin: string, relativePath: string): string {
  const cleaned = relativePath.replace(/^\/+/, '');
  return `${origin.replace(/\/+$/, '')}/${cleaned}`;
}
