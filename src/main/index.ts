import { BrowserWindow, Menu, app, nativeTheme } from 'electron';
import path from 'node:path';
import { ElectronCaptureHost } from './capture/electron-host';
import { ContentGateway } from './content-session';
import { registerIpc } from './ipc';
import { createLogger, type Logger } from './log';
import { installMediaProtocol, registerMediaScheme } from './media-protocol';
import { ensureAppDirectories, resolveAppPaths, sweepTemporaryState } from './paths';
import { checkEngineStatus } from './services/engine-status';
import { HistoryStore } from './services/history-store';
import { PreviewService } from './services/preview-service';
import { ProjectService } from './services/project-service';
import { RenderService } from './services/render-service';
import { SettingsStore } from './services/settings-store';
import { applyTheme, createMainWindow } from './window';
import { IPC } from '@shared/channels';
import type { EngineStatus } from '@shared/types';

/**
 * Application entry point: wires the real services together and hands the
 * window to the renderer. Everything here is process-level; the engine lives in
 * `src/engine` and knows nothing about Electron, and the interface knows nothing
 * about either.
 */

// A test or portable run can isolate the profile before any path is resolved.
const userDataOverride = process.env['BIFRAME_USER_DATA_DIR'];
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));

// Custom protocols must be declared before `ready`; the handler is installed once
// the services that own the files exist.
registerMediaScheme();

let logger: Logger | null = null;
let renderService: RenderService | null = null;
let projectService: ProjectService | null = null;
let previewService: PreviewService | null = null;
let gateway: ContentGateway | null = null;

async function bootstrap(): Promise<void> {
  const paths = resolveAppPaths();
  const log = createLogger(paths.logsDir);
  logger = log;
  log.log('info', 'biframe starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
  });

  Menu.setApplicationMenu(null);
  await ensureAppDirectories(paths);
  await sweepTemporaryState(paths, log);

  const settings = new SettingsStore(paths.settingsFile, app.getPath('downloads'), log);
  await settings.load();
  const history = new HistoryStore(paths.historyFile, log);
  await history.load();

  const contentGateway = new ContentGateway('content', log);
  gateway = contentGateway;

  let cachedEngine: EngineStatus | null = null;
  const engineStatus = async (): Promise<EngineStatus> => {
    if (cachedEngine) return cachedEngine;
    cachedEngine = await checkEngineStatus(paths, log);
    return cachedEngine;
  };
  const refreshEngineStatus = async (): Promise<EngineStatus> => {
    cachedEngine = await checkEngineStatus(paths, log);
    return cachedEngine;
  };

  const captureHost = new ElectronCaptureHost({
    gateway: contentGateway,
    logger: log,
    policy: () => ({
      projectOrigin: projectService?.serverOrigin ?? '',
      allowRemote: settings.get().allowRemoteResources,
    }),
  });

  const projects = new ProjectService({
    paths,
    logger: log,
    limits: () => settings.get().limits,
    onProjectChanged: (project) => {
      contentGateway.setPolicy({
        projectOrigin: projects.serverOrigin ?? '',
        allowRemote: settings.get().allowRemoteResources,
      });
      if (!project) void previewService?.reset();
    },
  });
  projectService = projects;

  const preview = new PreviewService({ gateway: contentGateway, logger: log });
  previewService = preview;

  const render = new RenderService({
    paths,
    logger: log,
    settings,
    history,
    projects,
    host: captureHost,
  });
  renderService = render;

  const window = createMainWindow();
  preview.attach(window);
  applyTheme(window, settings.get().theme);
  const broadcastTheme = (): void => {
    const effective = applyTheme(window, settings.get().theme);
    if (!window.isDestroyed()) window.webContents.send(IPC.app.themeChanged, effective);
  };
  nativeTheme.on('updated', broadcastTheme);
  installMediaProtocol({ paths, render, history, logger: log });

  registerIpc({
    window,
    paths,
    logger: log,
    gateway: contentGateway,
    settings,
    history,
    projects,
    preview,
    render,
    engineStatus,
    refreshEngineStatus,
    applySettingsSideEffects: (updated) => applyTheme(window, updated.theme),
  });

  window.on('closed', () => {
    logger?.log('info', 'window closed');
  });

  // Warm the engine check and clear stale posters in the background.
  void engineStatus().then((status) => {
    logger?.log('info', 'engine status', {
      ready: status.ready,
      ffmpeg: status.ffmpeg.version,
      ffprobe: status.ffprobe.version,
      freeBytes: status.tempDir.freeBytes,
    });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    logger?.log('error', 'bootstrap failed', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    console.error('Biframe failed to start:', error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await renderService?.shutdown();
        await previewService?.close();
        await projectService?.close();
        await gateway?.clearData();
      } catch (error) {
        logger?.log('warn', 'shutdown was not clean', { error: String(error) });
      } finally {
        app.exit(0);
      }
    })();
  });
}
