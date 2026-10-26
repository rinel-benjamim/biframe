import fs from 'node:fs';
import path from 'node:path';

/**
 * A deliberately boring file logger.
 *
 * The user-facing interface never shows a stack trace; the log keeps them. Writes
 * are synchronous and infrequent (a handful per render phase, never per frame),
 * so the main process is not blocked by logging and a crash still leaves a
 * readable tail on disk.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  readonly file: string;
  log(level: LogLevel, message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

function describeDetail(detail: unknown): string {
  if (detail === undefined) return '';
  if (typeof detail === 'string') return ` | ${detail}`;
  try {
    return ` | ${JSON.stringify(detail)}`;
  } catch {
    return ` | ${String(detail)}`;
  }
}

class FileLogger implements Logger {
  readonly file: string;
  private readonly scope: string;
  private readonly directory: string;
  private readonly mirrorToConsole: boolean;

  constructor(directory: string, scope: string, mirrorToConsole: boolean) {
    this.directory = directory;
    this.scope = scope;
    this.mirrorToConsole = mirrorToConsole;
    this.file = path.join(directory, 'biframe.log');
  }

  log(level: LogLevel, message: string, detail?: unknown): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${describeDetail(detail)}`;
    if (this.mirrorToConsole) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(line);
    }
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      // Logging must never break the application.
    }
  }

  child(scope: string): Logger {
    return new FileLogger(this.directory, `${this.scope}:${scope}`, this.mirrorToConsole);
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < MAX_LOG_BYTES) return;
    try {
      fs.rmSync(`${this.file}.1`, { force: true });
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // If the rotation fails the log simply keeps growing; not fatal.
    }
  }
}

export function createLogger(directory: string, options: { mirrorToConsole?: boolean } = {}): Logger {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    // The caller may point at a read-only location during a test; writes fail softly.
  }
  return new FileLogger(directory, 'app', options.mirrorToConsole ?? !process.env.BIFRAME_TEST);
}
