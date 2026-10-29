import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Translator } from '@shared/i18n';
import type { DiagnosticInput } from '../../engine/diagnostics';

/**
 * Single-file imports: a lone `.html` usually references a sibling folder of
 * assets (`./assets/...`, `style.css`, fonts). Biframe copies the HTML file and
 * the local files it references — and, recursively, what those CSS files
 * reference — into the temporary project, so relative paths keep working
 * without exposing the whole directory the user imported from.
 *
 * Scripts that build asset URLs at runtime cannot be followed by a static scan;
 * when that happens the render diagnostics report the missing requests, and the
 * interface suggests importing a ZIP instead.
 */

export interface HtmlAssetLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface HtmlAssetResult {
  /** Relative posix path of the copied HTML entry file. */
  entryRelative: string;
  copiedFiles: number;
  copiedBytes: number;
  remoteHosts: string[];
  missing: string[];
  skipped: string[];
  diagnostics: DiagnosticInput[];
}

const ATTRIBUTE_PATTERN = /(?:src|href|poster|data-src|data-lazy-src|data-background)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET_PATTERN = /srcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]+))\s*\)/gi;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi;
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const MAX_CSS_DEPTH = 4;

function isExternalReference(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return true;
  if (value.startsWith('#')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  if (value.startsWith('//')) return true;
  return false;
}

function stripQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function referencesFromCss(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(CSS_URL_PATTERN)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (!isExternalReference(value)) found.push(value);
  }
  for (const match of css.matchAll(CSS_IMPORT_PATTERN)) {
    const value = match[1] ?? match[2] ?? '';
    if (!isExternalReference(value)) found.push(value);
  }
  return found;
}

function referenceShaper(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter((part) => part.length > 0);
}

function referencesFromHtml(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(ATTRIBUTE_PATTERN)) {
    const value = match[1] ?? match[2] ?? '';
    if (!isExternalReference(value)) found.push(value);
  }
  for (const match of html.matchAll(SRCSET_PATTERN)) {
    const value = match[1] ?? match[2] ?? '';
    for (const candidate of referenceShaper(value)) {
      if (!isExternalReference(candidate)) found.push(candidate);
    }
  }
  for (const match of html.matchAll(STYLE_BLOCK_PATTERN)) {
    found.push(...referencesFromCss(match[1] ?? ''));
  }
  return found;
}

export function remoteHostsFromText(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"'`)<>]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname) hosts.add(url.hostname.toLowerCase());
    } catch {
      // Not a usable URL; ignore.
    }
  }
  return [...hosts].slice(0, 40);
}

export async function collectSingleHtmlProject(options: {
  htmlPath: string;
  destinationRoot: string;
  limits: HtmlAssetLimits;
  /** Translator for every diagnostic this scan produces. */
  t: Translator;
}): Promise<HtmlAssetResult> {
  const { htmlPath, destinationRoot, limits, t } = options;
  const sourceDir = path.dirname(path.resolve(htmlPath));
  // Resolve the source directory once so a symlinked/junctioned asset cannot
  // escape it through a path that only looks contained lexically.
  const realSourceDir = await fsp.realpath(sourceDir);
  const entryName = path.basename(htmlPath);
  const html = await fsp.readFile(htmlPath, 'utf8');

  const diagnostics: DiagnosticInput[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];
  const remoteHosts = new Set<string>(remoteHostsFromText(html));

  const queue: { file: string; relative: string; depth: number }[] = [];
  const queued = new Set<string>();
  const copied: { file: string; relative: string }[] = [];

  const enqueue = (reference: string, baseDir: string, depth: number): void => {
    const clean = stripQuery(reference).replace(/\\/g, '/');
    if (clean.length === 0) return;
    const absolute = path.resolve(baseDir, clean);
    const relative = path.relative(sourceDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      skipped.push(reference);
      return;
    }
    const key = path.resolve(absolute);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ file: key, relative: relative.split(path.sep).join('/'), depth });
  };

  for (const reference of referencesFromHtml(html)) enqueue(reference, sourceDir, 1);

  let totalBytes = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (copied.length >= limits.maxFiles) {
      skipped.push(item.relative);
      continue;
    }
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(item.file);
    } catch {
      missing.push(item.relative);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(item.relative);
      continue;
    }
    let realFile: string;
    try {
      realFile = await fsp.realpath(item.file);
    } catch {
      missing.push(item.relative);
      continue;
    }
    const realRelative = path.relative(realSourceDir, realFile);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      // A symlink or junction inside the folder pointed somewhere else. Copying
      // it would expose a file the user did not select; report it and move on.
      skipped.push(item.relative);
      diagnostics.push({
        code: 'HTML_ONLY_PROJECT',
        severity: 'warning',
        message: t('assets.outsideFolder'),
        detail: t('assets.outsideFolderDetail', { relative: item.relative }),
      });
      continue;
    }
    if (stat.size > limits.maxFileBytes || totalBytes + stat.size > limits.maxTotalBytes) {
      skipped.push(item.relative);
      diagnostics.push({
        code: 'ZIP_ENTRY_SKIPPED',
        severity: 'warning',
        message: t('assets.fileSkipped'),
        detail: `${item.relative} (${stat.size} bytes)`,
      });
      continue;
    }
    const destination = path.join(destinationRoot, item.relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(realFile, destination);
    totalBytes += stat.size;
    copied.push({ file: item.file, relative: item.relative });

    if (item.depth < MAX_CSS_DEPTH && /\.css$/i.test(item.file)) {
      try {
        const css = await fsp.readFile(item.file, 'utf8');
        const baseDir = path.dirname(item.file);
        for (const reference of referencesFromCss(css)) enqueue(reference, baseDir, item.depth + 1);
      } catch {
        // An unreadable CSS file is reported by the page itself when it loads.
      }
    }
  }

  // The entry file is copied last so the scan above never depends on it.
  await fsp.mkdir(destinationRoot, { recursive: true });
  await fsp.copyFile(htmlPath, path.join(destinationRoot, entryName));

  if (missing.length > 0) {
    for (const reference of missing.slice(0, 12)) {
      diagnostics.push({
        code: 'MISSING_RESOURCE',
        severity: 'warning',
        message: t('assets.missingFile'),
        detail: t('assets.missingFileDetail'),
        url: reference,
      });
    }
  }
  if (skipped.length > 0) {
    diagnostics.push({
      code: 'HTML_ONLY_PROJECT',
      severity: 'info',
      message: t('assets.skipped'),
      detail: t('assets.skippedDetail', { count: skipped.length }),
    });
  }
  if (remoteHosts.size > 0) {
    diagnostics.push({
      code: 'REMOTE_RESOURCES',
      severity: 'info',
      message: t('diag.remoteResources'),
      detail: [...remoteHosts].slice(0, 8).join(', '),
    });
  }
  diagnostics.push({
    code: 'HTML_ONLY_PROJECT',
    severity: 'info',
    message: t('assets.htmlOnly'),
    detail: t('assets.htmlOnlyDetail', { count: copied.length }),
  });

  return {
    entryRelative: entryName,
    copiedFiles: copied.length,
    copiedBytes: totalBytes,
    remoteHosts: [...remoteHosts],
    missing,
    skipped,
    diagnostics,
  };
}
