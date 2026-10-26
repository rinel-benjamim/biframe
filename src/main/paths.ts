import { app } from 'electron';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './log';

/**
 * Every location Biframe writes to. All of them live under the application's
 * user-data directory except the example project, which ships with the app.
 *
 *   userData/
 *     settings.json
 *     history.json
 *     logs/biframe.log
 *     temp/
 *       projects/<projectId>/   extracted or copied import
 *       frames/<jobId>/         raw + constant-rate capture frames (deleted after a render)
 *       posters/<jobId>/        stills kept for the result view
 */

export interface AppPaths {
  userData: string;
  tempRoot: string;
  framesRoot: string;
  postersRoot: string;
  projectsRoot: string;
  logsDir: string;
  settingsFile: string;
  historyFile: string;
  exampleDir: string;
}

export function resolveAppPaths(): AppPaths {
  const userData = app.getPath('userData');
  const tempRoot = path.join(userData, 'temp');
  return {
    userData,
    tempRoot,
    framesRoot: path.join(tempRoot, 'frames'),
    postersRoot: path.join(tempRoot, 'posters'),
    projectsRoot: path.join(tempRoot, 'projects'),
    logsDir: path.join(userData, 'logs'),
    settingsFile: path.join(userData, 'settings.json'),
    historyFile: path.join(userData, 'history.json'),
    exampleDir: resolveExampleDir(),
  };
}

/**
 * The bundled example project. In development it sits in the repository; in the
 * packaged application electron-builder copies it to `resources/example`.
 */
export function resolveExampleDir(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'example'),
    path.join(app.getAppPath(), 'resources', 'example'),
    path.join(app.getAppPath(), '..', 'resources', 'example'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return candidates[1] ?? candidates[0] ?? '';
}

export async function ensureAppDirectories(paths: AppPaths): Promise<void> {
  await Promise.all([
    fsp.mkdir(paths.tempRoot, { recursive: true }),
    fsp.mkdir(paths.framesRoot, { recursive: true }),
    fsp.mkdir(paths.postersRoot, { recursive: true }),
    fsp.mkdir(paths.projectsRoot, { recursive: true }),
    fsp.mkdir(paths.logsDir, { recursive: true }),
  ]);
}

async function directorySize(target: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [target];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      entries += 1;
      try {
        bytes += (await fsp.stat(full)).size;
      } catch {
        // The file vanished while walking; ignore.
      }
    }
  }
  return { bytes, entries };
}

/**
 * Removes frames and imported projects left behind by a previous run. Poster
 * stills are kept (they belong to history entries) and pruned separately.
 */
export async function sweepTemporaryState(paths: AppPaths, logger: Logger): Promise<void> {
  for (const directory of [paths.framesRoot, paths.projectsRoot]) {
    try {
      await fsp.rm(directory, { recursive: true, force: true });
      await fsp.mkdir(directory, { recursive: true });
    } catch (error) {
      logger.log('warn', 'could not sweep temporary directory', { directory, error: String(error) });
    }
  }
}

export async function clearTemporaryState(paths: AppPaths, logger: Logger): Promise<{ removedBytes: number; removedEntries: number }> {
  let removedBytes = 0;
  let removedEntries = 0;
  for (const directory of [paths.framesRoot, paths.projectsRoot, paths.postersRoot]) {
    const size = await directorySize(directory);
    removedBytes += size.bytes;
    removedEntries += size.entries;
    try {
      await fsp.rm(directory, { recursive: true, force: true });
      await fsp.mkdir(directory, { recursive: true });
    } catch (error) {
      logger.log('warn', 'could not clear temporary directory', { directory, error: String(error) });
    }
  }
  logger.log('info', 'temporary files cleared', { removedBytes, removedEntries });
  return { removedBytes, removedEntries };
}
