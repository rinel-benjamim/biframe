/** Parsing of `ffmpeg -progress pipe:1` output. Pure functions, unit tested. */

export interface FfmpegProgressUpdate {
  frame?: number;
  fps?: number;
  outTimeSeconds?: number;
  speed?: number;
  done?: boolean;
}

export function parseProgressLine(line: string): FfmpegProgressUpdate | null {
  const separator = line.indexOf('=');
  if (separator === -1) return null;
  const key = line.slice(0, separator).trim();
  const raw = line.slice(separator + 1).trim();
  const value = Number(raw);
  switch (key) {
    case 'frame':
      return Number.isFinite(value) ? { frame: value } : null;
    case 'fps':
      return Number.isFinite(value) ? { fps: value } : null;
    case 'out_time_us':
    case 'out_time_ms':
      // ffmpeg reports microseconds under both names (out_time_ms is a legacy alias).
      return Number.isFinite(value) ? { outTimeSeconds: value / 1_000_000 } : null;
    case 'out_time':
      return { outTimeSeconds: parseTimestamp(raw) };
    case 'speed': {
      const parsed = Number(raw.replace('x', ''));
      return Number.isFinite(parsed) ? { speed: parsed } : null;
    }
    case 'progress':
      return { done: raw === 'end' };
    default:
      return null;
  }
}

/** "00:00:12.345678" -> 12.345678 */
export function parseTimestamp(raw: string): number {
  const parts = raw.split(':');
  if (parts.length !== 3) return Number.NaN;
  const [hours, minutes, seconds] = parts.map(Number);
  if (![hours, minutes, seconds].every((part) => Number.isFinite(part))) return Number.NaN;
  return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}
