import path from 'node:path';

/**
 * Archive entry validation. Nothing is written to disk before an entry passes
 * these checks, and the extraction step re-verifies containment against the
 * destination root after resolving the final path.
 */

export interface ArchiveEntryInfo {
  /** Raw path as stored in the archive. */
  path: string;
  sizeBytes: number;
  isDirectory: boolean;
  /** Unix mode bits, when the archive provides them. */
  unixMode?: number;
  /** Windows attribute bits, when the archive provides them. */
  dosAttributes?: number;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}

export type EntryVerdict =
  | { accept: true; path: string; sizeBytes: number; isDirectory: boolean }
  | { accept: false; path: string; reason: string };

const MAX_SEGMENT_LENGTH = 120;
const MAX_PATH_LENGTH = 240;
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

/** `true` when the entry is a symbolic link (posix or windows reparse point). */
export function isSymlinkEntry(entry: ArchiveEntryInfo): boolean {
  if (typeof entry.unixMode === 'number' && (entry.unixMode & S_IFMT) === S_IFLNK) return true;
  // Windows reparse point / symlink bit in the DOS attribute word.
  if (typeof entry.dosAttributes === 'number' && (entry.dosAttributes & 0x0400) !== 0) return true;
  return false;
}

/**
 * Normalises an archive path to a relative posix path, or returns null when the
 * path is unsafe. Rejects absolute paths, drive letters, `..` segments, NTFS
 * alternate data streams, control characters and names Windows cannot store.
 */
export function normalizeArchivePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const replaced = raw.replace(/\\/g, '/');
  if (replaced.length === 0 || replaced.length > MAX_PATH_LENGTH) return null;
  // Control characters are rejected on purpose: they hide path segments from humans.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(replaced)) return null;
  if (replaced.startsWith('/') || replaced.startsWith('~')) return null;
  if (/^[a-zA-Z]:/.test(replaced)) return null;

  const rawSegments = replaced.split('/');
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    if (segment.length > MAX_SEGMENT_LENGTH) return null;
    if (segment.includes(':')) return null; // alternate data stream
    if (/[<>"|?*]/.test(segment)) return null;
    if (/[. ]$/.test(segment)) return null; // trailing dot/space is silently stripped by Windows
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

export interface ArchivePlan {
  accepted: Extract<EntryVerdict, { accept: true }>[];
  rejected: Extract<EntryVerdict, { accept: false }>[];
  totalBytes: number;
  truncated: boolean;
}

export function classifyArchiveEntries(entries: ArchiveEntryInfo[], limits: ArchiveLimits): ArchivePlan {
  const accepted: ArchivePlan['accepted'] = [];
  const rejected: ArchivePlan['rejected'] = [];
  let totalBytes = 0;
  let truncated = false;

  if (entries.length > limits.maxEntries) {
    truncated = true;
  }

  for (const entry of entries.slice(0, limits.maxEntries)) {
    const normalized = normalizeArchivePath(entry.path);
    if (normalized === null) {
      rejected.push({ accept: false, path: entry.path, reason: 'caminho inválido' });
      continue;
    }
    if (isSymlinkEntry(entry)) {
      rejected.push({ accept: false, path: entry.path, reason: 'link simbólico' });
      continue;
    }
    const size = Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : 0;
    if (size > limits.maxEntryBytes) {
      rejected.push({ accept: false, path: entry.path, reason: 'ficheiro demasiado grande' });
      continue;
    }
    if (totalBytes + size > limits.maxTotalBytes) {
      rejected.push({ accept: false, path: entry.path, reason: 'limite total excedido' });
      truncated = true;
      continue;
    }
    totalBytes += size;
    accepted.push({ accept: true, path: normalized, sizeBytes: size, isDirectory: entry.isDirectory });
  }

  return { accepted, rejected, totalBytes, truncated };
}

/**
 * Resolves `relativePath` inside `root` and guarantees the result cannot escape.
 * Used by the loopback server on every request and by the extractor per entry.
 */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const normalized = normalizeArchivePath(relativePath);
  if (normalized === null) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

/** Picks the HTML entry point of an extracted project. */
export function pickHtmlEntry(paths: string[]): string | null {
  const htmlFiles = paths.filter((candidate) => /\.(html?|xhtml)$/i.test(candidate));
  if (htmlFiles.length === 0) return null;
  const indexAtRoot = htmlFiles.find((candidate) => candidate.toLowerCase() === 'index.html');
  if (indexAtRoot) return indexAtRoot;
  const sorted = [...htmlFiles].sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });
  return sorted[0] ?? null;
}
