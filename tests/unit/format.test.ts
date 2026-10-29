import { describe, expect, it } from 'vitest';
import {
  ensureExtension,
  formatBytes,
  formatClock,
  formatDateTime,
  formatFps,
  formatMilliseconds,
  formatNumber,
  formatRelative,
  formatResolution,
  formatSeconds,
  pluralize,
  sanitizeFileName,
  truncateMiddle,
} from '@shared/format';

describe('formatBytes', () => {
  it('keeps bytes below one thousand as integers', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('uses decimal units and scales up', () => {
    expect(formatBytes(1000)).toBe('1.00 kB');
    expect(formatBytes(1_234_567)).toBe('1.23 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.50 GB');
  });

  it('returns a dash for missing or invalid values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('time formatting', () => {
  it('formats seconds with Portuguese decimals and minutes', () => {
    expect(formatSeconds(36.5)).toBe('36,5 s');
    expect(formatSeconds(59.9)).toBe('59,9 s');
    expect(formatSeconds(75)).toBe('1 min 15 s');
    expect(formatSeconds(120)).toBe('2 min');
    expect(formatSeconds(-1)).toBe('—');
  });

  it('formats clocks with two-digit fields', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(75)).toBe('01:15');
    expect(formatClock(3661)).toBe('01:01:01');
    expect(formatClock(Number.NaN)).toBe('—');
  });

  it('formats milliseconds through the clock formatter', () => {
    expect(formatMilliseconds(65_000)).toBe('01:05');
  });

  it('formats resolution and fps', () => {
    expect(formatResolution(1280, 720)).toBe('1280 × 720');
    expect(formatFps(30)).toBe('30 fps');
  });

  it('formats numbers using the Portuguese locale', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(1234.5, 1)).toBe('1234,5');
    // pt-PT only groups numbers with five or more integer digits.
    expect(formatNumber(12345).replace(/\s/g, ' ')).toBe('12 345');
  });
});

describe('formatRelative', () => {
  const now = 1_700_000_000_000;

  it('describes recent moments', () => {
    expect(formatRelative(now - 10_000, now)).toBe('agora mesmo');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('há 5 min');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('há 3 h');
    expect(formatRelative(now - 24 * 3_600_000, now)).toBe('ontem');
    expect(formatRelative(now - 5 * 24 * 3_600_000, now)).toBe('há 5 dias');
  });
});

describe('English language', () => {
  const now = 1_700_000_000_000;

  it('uses English decimal separators in durations and numbers', () => {
    expect(formatSeconds(36.5, 'en')).toBe('36.5 s');
    expect(formatSeconds(75, 'en')).toBe('1 min 15 s');
    expect(formatNumber(1234.5, 1, 'en')).toBe('1,234.5');
  });

  it('describes recent moments in English', () => {
    expect(formatRelative(now - 10_000, now, 'en')).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now, 'en')).toBe('5 min ago');
    expect(formatRelative(now - 3 * 3_600_000, now, 'en')).toBe('3 h ago');
    expect(formatRelative(now - 24 * 3_600_000, now, 'en')).toBe('yesterday');
    expect(formatRelative(now - 5 * 24 * 3_600_000, now, 'en')).toBe('5 days ago');
  });

  it('formats dates with the English locale', () => {
    const rendered = formatDateTime(Date.UTC(2026, 0, 2, 3, 4), 'en');
    expect(rendered).toContain('2026');
  });
});

describe('sanitizeFileName', () => {
  it('replaces characters Windows cannot store', () => {
    expect(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('normalises whitespace and trims dots and spaces', () => {
    expect(sanitizeFileName('  ..  vídeo   final .. ')).toBe('vídeo final');
  });

  it('protects reserved device names with a suffix', () => {
    expect(sanitizeFileName('CON')).toBe('CON-video');
    expect(sanitizeFileName('lpt1', 'fallback')).toBe('lpt1-video');
  });

  it('falls back when nothing usable remains and caps the length', () => {
    expect(sanitizeFileName('...', 'biframe-export')).toBe('biframe-export');
    expect(sanitizeFileName('x'.repeat(200))).toHaveLength(120);
  });

  it('strips control characters', () => {
    expect(sanitizeFileName('a\u0000b\u001fc')).toBe('a-b-c');
  });
});

describe('ensureExtension', () => {
  it('adds the extension when missing, ignoring case', () => {
    expect(ensureExtension('filme', '.mp4')).toBe('filme.mp4');
    expect(ensureExtension('filme.MP4', '.mp4')).toBe('filme.MP4');
    expect(ensureExtension('filme.mp4', 'mp4')).toBe('filme.mp4');
  });
});

describe('small text helpers', () => {
  it('pluralises zero, one and many', () => {
    expect(pluralize(0, 'frame', 'frames')).toBe('frames');
    expect(pluralize(1, 'frame', 'frames')).toBe('frame');
    expect(pluralize(2, 'frame', 'frames')).toBe('frames');
  });

  it('truncates in the middle without losing both ends', () => {
    expect(truncateMiddle('abcdefghij', 7)).toBe('abc…hij');
    expect(truncateMiddle('short', 10)).toBe('short');
  });
});
