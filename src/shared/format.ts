/** Formatting helpers shared by the interface and the logs.
 *
 * Every function that can sound different in Portuguese and English takes the
 * interface language as its last parameter and defaults to Portuguese, so call
 * sites that predate the language setting keep their behaviour.
 */
import { createTranslator, DEFAULT_LANGUAGE, localeFor, type Language } from './i18n';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/** 36.5 -> "36,5 s" (pt) / "36.5 s" (en); 75 -> "1 min 15 s" */
export function formatSeconds(seconds: number, language: Language = DEFAULT_LANGUAGE): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const separator = language === 'en' ? '.' : ',';
  if (seconds < 60) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${String(rounded).replace('.', separator)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (rest === 60) return `${minutes + 1} min`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** 3661 -> "01:01:01"; 75 -> "01:15" */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatMilliseconds(ms: number): string {
  return formatClock(ms / 1000);
}

export function formatResolution(width: number, height: number): string {
  return `${width} × ${height}`;
}

export function formatFps(fps: number): string {
  return `${fps} fps`;
}

export function formatNumber(value: number, decimals = 0, language: Language = DEFAULT_LANGUAGE): string {
  return value.toLocaleString(localeFor(language), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatDateTime(epochMs: number, language: Language = DEFAULT_LANGUAGE): string {
  return new Date(epochMs).toLocaleString(localeFor(language), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(
  epochMs: number,
  now = Date.now(),
  language: Language = DEFAULT_LANGUAGE,
): string {
  const t = createTranslator(language);
  const diffSeconds = Math.round((now - epochMs) / 1000);
  if (diffSeconds < 45) return t('format.justNow');
  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 60) return t('format.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('format.hoursAgo', { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t('format.yesterday');
  if (days < 30) return t('format.daysAgo', { count: days });
  return formatDateTime(epochMs, language);
}

/** Makes a string safe to use as a file name on Windows, macOS and Linux. */
export function sanitizeFileName(input: string, fallback = 'biframe-export'): string {
  const cleaned = input
    .normalize('NFC')
    // Control characters cannot appear in file names on Windows and are stripped everywhere.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const base = cleaned.length > 0 ? cleaned : fallback;
  return reserved.test(base) ? `${base}-video` : base;
}

export function ensureExtension(fileName: string, extension: string): string {
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  return fileName.toLowerCase().endsWith(suffix) ? fileName : `${fileName}${suffix}`;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export function truncateMiddle(value: string, maxLength = 60): string {
  if (value.length <= maxLength) return value;
  const half = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - half)}`;
}
