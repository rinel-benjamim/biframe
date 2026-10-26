import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BiframeError } from '@shared/errors';

/**
 * Locating the media binaries.
 *
 * Resolution order (documented in docs/adr/0003-ffmpeg-distribution.md):
 *   1. explicit override (`BIFRAME_FFMPEG_PATH`), for tests and advanced users;
 *   2. the bundled `ffmpeg-static` / `ffprobe-static` binary shipped with the
 *      application (unpacked from the asar archive when packaged);
 *   3. a system installation found on `PATH`, as a last resort.
 *
 * The user never has to install FFmpeg for Biframe to work.
 */

export interface BinaryResolution {
  kind: 'ffmpeg' | 'ffprobe';
  path: string;
  source: 'bundled' | 'system';
  version: string;
}

const UNPACKED_SEGMENT = `${path.sep}app.asar${path.sep}`;

/** Electron runs bundled files from inside app.asar; executables live next to it. */
export function unpackAsarPath(candidate: string): string {
  if (!candidate.includes(UNPACKED_SEGMENT)) return candidate;
  return candidate.replace(UNPACKED_SEGMENT, `${path.sep}app.asar.unpacked${path.sep}`);
}

function bundledFfmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const value: unknown = require('ffmpeg-static');
    if (typeof value === 'string' && value.length > 0) return unpackAsarPath(value);
  } catch {
    // Not installed; fall through to the system lookup.
  }
  return null;
}

function bundledFfprobePath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const value: unknown = require('ffprobe-static');
    if (typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string') {
      return unpackAsarPath((value as { path: string }).path);
    }
  } catch {
    // Not installed; fall through to the system lookup.
  }
  return null;
}

function systemPathCandidates(name: string): string[] {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      candidates.push(path.join(directory, `${name}${extension}`));
    }
  }
  return candidates;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Upper bound for buffered stdout/stderr (progress parsing only needs lines). */
  maxBufferBytes?: number;
}

export function runBinary(binaryPath: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = options.maxBufferBytes ?? 4 * 1024 * 1024;
  return new Promise<RunResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(binaryPath, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const appendLines = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        stdout = (stdout + text).slice(-maxBuffer);
      } else {
        stderr = (stderr + text).slice(-maxBuffer);
      }
      const lines = text.split(/\r?\n/);
      const handler = target === 'stdout' ? options.onStdoutLine : options.onStderrLine;
      if (!handler) return;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) handler(trimmed);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => appendLines(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => appendLines(chunk, 'stderr'));

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;

    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };

    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => fail(error));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut, aborted }));
  });
}

export async function readVersion(binaryPath: string): Promise<string> {
  try {
    const result = await runBinary(binaryPath, ['-version'], { timeoutMs: 10_000, maxBufferBytes: 256 * 1024 });
    const firstLine = result.stdout.split(/\r?\n/)[0] ?? '';
    const match = /version\s+([^\s]+)/i.exec(firstLine);
    return match?.[1] ?? firstLine.slice(0, 60) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function resolveBinary(
  kind: 'ffmpeg' | 'ffprobe',
  overrideEnv: string,
  bundled: () => string | null,
): Promise<BinaryResolution> {
  const override = process.env[overrideEnv];
  if (override && override.trim().length > 0) {
    const candidate = path.resolve(override);
    if (fs.existsSync(candidate)) {
      return { kind, path: candidate, source: 'bundled', version: await readVersion(candidate) };
    }
  }

  const bundledPath = bundled();
  if (bundledPath && fs.existsSync(bundledPath)) {
    return { kind, path: bundledPath, source: 'bundled', version: await readVersion(bundledPath) };
  }

  const system = await firstExisting(systemPathCandidates(kind));
  if (system) {
    return { kind, path: system, source: 'system', version: await readVersion(system) };
  }

  throw new BiframeError('ENCODER_MISSING', {
    detail: `No ${kind} binary found. Checked the bundled binary and PATH.`,
  });
}

export function resolveFfmpeg(): Promise<BinaryResolution> {
  return resolveBinary('ffmpeg', 'BIFRAME_FFMPEG_PATH', bundledFfmpegPath);
}

export function resolveFfprobe(): Promise<BinaryResolution> {
  return resolveBinary('ffprobe', 'BIFRAME_FFPROBE_PATH', bundledFfprobePath);
}

/** Reads stdout of a binary fully; used for ffprobe JSON. */
export async function captureBinary(binaryPath: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  return runBinary(binaryPath, args, { timeoutMs });
}

/** Reads binary stdout into a Buffer (used for raw frame sampling). */
export function runBinaryBuffer(
  binaryPath: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ code: number | null; stdout: Buffer; stderr: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let aborted = false;
    let settled = false;
    const child = spawn(binaryPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    const timeout = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : null;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, aborted });
    });
  });
}
