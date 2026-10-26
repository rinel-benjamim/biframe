import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveFfmpeg, resolveFfprobe } from '../../engine/media/binaries';
import { freeSpaceBytes } from '../../engine/frame-store';
import type { EngineBinaryStatus, EngineStatus } from '@shared/types';
import type { Logger } from '../log';

/**
 * Engine readiness, resolved from real facts: the Chromium version comes from
 * the running Electron binary, FFmpeg/FFprobe from their resolved paths and
 * `-version` output, and the temporary directory from an actual write.
 *
 * `ready` is only true when both binaries run and the temp directory is
 * writable; the interface blocks export otherwise and says why.
 */
export async function checkEngineStatus(paths: { tempRoot: string }, logger: Logger): Promise<EngineStatus> {
  const version = app.getVersion();
  const chromiumVersion = process.versions.chrome ?? 'unknown';

  const [ffmpeg, ffprobe] = await Promise.all([probeBinary('ffmpeg', logger), probeBinary('ffprobe', logger)]);

  let writable = false;
  let freeBytes: number | null = null;
  try {
    await fsp.mkdir(paths.tempRoot, { recursive: true });
    const probeFile = path.join(paths.tempRoot, `.biframe-write-${process.pid}.tmp`);
    await fsp.writeFile(probeFile, 'ok');
    await fsp.unlink(probeFile);
    writable = true;
  } catch {
    writable = false;
  }
  freeBytes = await freeSpaceBytes(paths.tempRoot);

  return {
    ready: ffmpeg.available && ffprobe.available && writable,
    chromium: { version: chromiumVersion, available: true },
    ffmpeg,
    ffprobe,
    tempDir: { path: paths.tempRoot, writable, freeBytes },
    platform: process.platform,
    appVersion: version,
    checkedAt: Date.now(),
  };
}

async function probeBinary(kind: 'ffmpeg' | 'ffprobe', logger: Logger): Promise<EngineBinaryStatus> {
  try {
    const resolution = kind === 'ffmpeg' ? await resolveFfmpeg() : await resolveFfprobe();
    return {
      kind,
      available: true,
      path: resolution.path,
      version: resolution.version,
      source: resolution.source,
    };
  } catch (error) {
    logger.log('error', `${kind} is not available`, { error: String(error) });
    return {
      kind,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
