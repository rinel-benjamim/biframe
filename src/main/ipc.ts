import { dialog, ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BiframeError, serializeError } from '@shared/errors';
import { IPC, type ApiResult, type BootstrapPayload, type PreviewStateEvent, type ProjectImportResult, type RenderCompletedEvent, type RenderProgressEvent } from '@shared/channels';
import { validateRenderSettings } from '@shared/settings';
import type { AppSettings, EffectiveTheme, EngineStatus, PreviewBounds, RenderJob, SerializedError } from '@shared/types';
import type { AppPaths } from './paths';
import { clearTemporaryState } from './paths';
import { resolveEffectiveTheme } from './window';
import type { Logger } from './log';
import type { ContentGateway } from './content-session';
import type { HistoryStore } from './services/history-store';
import type { PreviewService } from './services/preview-service';
import type { ProjectService } from './services/project-service';
import type { RenderService } from './services/render-service';
import type { SettingsStore } from './services/settings-store';

/**
 * The whole IPC surface in one place. Every handler validates its input before
 * touching a service and answers with a discriminated result instead of
 * throwing across the bridge: the interface can always render a real error.
 */

export interface IpcContext {
  window: BrowserWindow;
  paths: AppPaths;
  logger: Logger;
  gateway: ContentGateway;
  settings: SettingsStore;
  history: HistoryStore;
  projects: ProjectService;
  preview: PreviewService;
  render: RenderService;
  engineStatus: () => Promise<EngineStatus>;
  refreshEngineStatus: () => Promise<EngineStatus>;
  /** Applies process-level consequences of a settings change (native theme). */
  applySettingsSideEffects: (settings: AppSettings) => EffectiveTheme;
}

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0).max(20_000),
  height: z.number().finite().min(0).max(20_000),
  scale: z.number().finite().min(0.01).max(10).optional(),
});

const pathSchema = z.string().min(1).max(4096);

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failed(error: unknown): ApiResult<never> {
  return { ok: false, error: serializeError(error) };
}

export function registerIpc(context: IpcContext): void {
  const { window, paths, logger, gateway, settings, history, projects, preview, render } = context;

  const send = <T>(channel: string, payload: T): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  preview.onChange((state) => {
    const event: PreviewStateEvent = { state, diagnostics: state.diagnostics };
    send(IPC.preview.stateChanged, event);
  });

  render.onProgress((job, progress) => {
    const event: RenderProgressEvent = { jobId: job.id, progress };
    send(IPC.render.progress, event);
  });

  render.onFinished((job) => {
    const event: RenderCompletedEvent = { jobId: job.id, job };
    send(IPC.render.completed, event);
    if (job.status === 'completed' && settings.get().openResultAfterRender && job.result) {
      void shell.showItemInFolder(job.result.outputPath);
    }
  });

  /** Guards shell operations: only paths the application itself produced. */
  const assertKnownPath = async (candidate: string): Promise<string> => {
    const resolved = path.resolve(candidate);
    const roots = [paths.userData, paths.exampleDir].filter((root) => root.length > 0);
    const known = (job: RenderJob | undefined): boolean =>
      Boolean(job?.result && (job.result.outputPath === resolved || job.result.posterFrames.includes(resolved)));
    const jobs = [...render.list()];
    const historyEntry = history.list().find((entry) => entry.outputPath === resolved);
    const project = projects.current();
    const projectKnown =
      Boolean(project) &&
      (project?.sourcePath === resolved || project?.rootPath === resolved || project?.entryPath === resolved);
    if (roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)) || jobs.some(known) || historyEntry || projectKnown) {
      return resolved;
    }
    throw new BiframeError('INVALID_IPC_ARGUMENT', { detail: `path outside the application's own files: ${resolved}` });
  };

  const handleResult = (channel: string, handler: (payload: unknown) => Promise<ApiResult<unknown>>): void => {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        return await handler(payload);
      } catch (error) {
        return failed(error);
      }
    });
  };

  handleResult(IPC.app.getBootstrap, async (): Promise<ApiResult<BootstrapPayload>> => {
    const engine = await context.engineStatus();
    const appSettings = settings.get();
    let exampleAvailable = false;
    try {
      const entries = await fsp.readdir(paths.exampleDir);
      exampleAvailable = entries.some((entry) => /\.html?$/i.test(entry));
    } catch {
      exampleAvailable = false;
    }
    const jobs = render.list();
    const bootstrap: BootstrapPayload = {
      settings: appSettings,
      engine,
      project: projects.current(),
      preview: preview.getState(),
      jobs,
      history: history.list(),
      appVersion: engine.appVersion,
      exampleAvailable,
      platform: process.platform,
      effectiveTheme: resolveEffectiveTheme(appSettings.theme),
      paths: { logs: paths.logsDir, temp: paths.tempRoot, userData: paths.userData },
      keyboardShortcuts: [
        { id: 'import-html', keys: 'Ctrl+O', description: 'Importar um ficheiro HTML' },
        { id: 'import-zip', keys: 'Ctrl+Shift+O', description: 'Importar um projeto ZIP' },
        { id: 'export', keys: 'Ctrl+E', description: 'Exportar o vídeo' },
        { id: 'studio', keys: 'Ctrl+1', description: 'Abrir o estúdio' },
        { id: 'history', keys: 'Ctrl+2', description: 'Abrir o histórico' },
        { id: 'settings', keys: 'Ctrl+3', description: 'Abrir as definições' },
        { id: 'reload-preview', keys: 'Ctrl+R', description: 'Recarregar a pré-visualização' },
      ],
    };
    return ok(bootstrap);
  });

  handleResult(IPC.app.getSettings, async (): Promise<ApiResult<AppSettings>> => ok(settings.get()));

  handleResult(IPC.app.updateSettings, async (patch: unknown): Promise<ApiResult<AppSettings>> => {
    const updated = await settings.update(patch);
    gateway.setPolicy({ projectOrigin: projects.serverOrigin ?? '', allowRemote: updated.allowRemoteResources });
    const effective = context.applySettingsSideEffects(updated);
    send(IPC.app.themeChanged, effective);
    return ok(updated);
  });

  handleResult(IPC.app.revealPath, async (candidate: unknown): Promise<ApiResult<void>> => {
    const resolved = await assertKnownPath(pathSchema.parse(candidate));
    shell.showItemInFolder(resolved);
    return ok(undefined);
  });

  handleResult(IPC.app.openPath, async (candidate: unknown): Promise<ApiResult<void>> => {
    const resolved = await assertKnownPath(pathSchema.parse(candidate));
    const error = await shell.openPath(resolved);
    if (error) throw new BiframeError('PROJECT_NOT_FOUND', { detail: error });
    return ok(undefined);
  });

  handleResult(IPC.app.getLogDirectory, async (): Promise<ApiResult<string>> => ok(paths.logsDir));

  handleResult(IPC.app.clearTemp, async (): Promise<ApiResult<{ removedBytes: number; removedEntries: number }>> => {
    const removed = await clearTemporaryState(paths, logger);
    await gateway.clearData();
    return ok(removed);
  });

  handleResult(IPC.engine.status, async (): Promise<ApiResult<EngineStatus>> => ok(await context.engineStatus()));

  handleResult(IPC.engine.recheck, async (): Promise<ApiResult<EngineStatus>> => ok(await context.refreshEngineStatus()));

  const importFrom = async (filePath: string): Promise<ProjectImportResult> => {
    try {
      if (render.isBusy()) {
        throw new BiframeError('RENDER_IN_PROGRESS', { detail: 'a project cannot be replaced during a render' });
      }
      const project = await projects.importPath(filePath);
      const url = projects.entryUrl();
      if (url) await preview.show(url, project.id);
      return { project, canceled: false };
    } catch (error) {
      const serialized: SerializedError = serializeError(error);
      logger.log('warn', 'project import failed', { code: serialized.code, detail: serialized.detail });
      return { project: null, canceled: false, error: serialized };
    }
  };

  handleResult(IPC.project.pickHtml, async (): Promise<ApiResult<ProjectImportResult>> => {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Importar ficheiro HTML',
      properties: ['openFile'],
      filters: [
        { name: 'Páginas HTML', extensions: ['html', 'htm', 'xhtml'] },
        { name: 'Todos os ficheiros', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return ok<ProjectImportResult>({ project: null, canceled: true });
    return ok(await importFrom(picked.filePaths[0] as string));
  });

  handleResult(IPC.project.pickZip, async (): Promise<ApiResult<ProjectImportResult>> => {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Importar projeto ZIP',
      properties: ['openFile'],
      filters: [
        { name: 'Projetos ZIP', extensions: ['zip'] },
        { name: 'Todos os ficheiros', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return ok<ProjectImportResult>({ project: null, canceled: true });
    return ok(await importFrom(picked.filePaths[0] as string));
  });

  handleResult(IPC.project.import, async (candidate: unknown): Promise<ApiResult<ProjectImportResult>> => {
    const filePath = pathSchema.parse(candidate);
    return ok(await importFrom(filePath));
  });

  handleResult(IPC.project.current, async (): Promise<ApiResult<ReturnType<ProjectService['current']>>> => ok(projects.current()));

  handleResult(IPC.project.close, async (): Promise<ApiResult<void>> => {
    if (render.isBusy()) {
      throw new BiframeError('RENDER_IN_PROGRESS', { detail: 'the project cannot be closed during a render' });
    }
    await projects.close();
    await preview.reset();
    return ok(undefined);
  });

  handleResult(IPC.project.pickOutputDir, async (): Promise<ApiResult<string | null>> => {
    const picked = await dialog.showOpenDialog(window, {
      title: 'Escolher pasta de destino',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get().defaultOutputDir || undefined,
    });
    if (picked.canceled || picked.filePaths.length === 0) return ok(null);
    return ok(picked.filePaths[0] as string);
  });

  handleResult(IPC.project.loadExample, async (): Promise<ApiResult<ProjectImportResult>> => {
    try {
      const entries = await fsp.readdir(paths.exampleDir);
      const html = entries.find((entry) => /\.html?$/i.test(entry));
      if (!html) throw new BiframeError('PROJECT_NOT_FOUND', { detail: `no example in ${paths.exampleDir}` });
      return ok(await importFrom(path.join(paths.exampleDir, html)));
    } catch (error) {
      return ok<ProjectImportResult>({ project: null, canceled: false, error: serializeError(error) });
    }
  });

  handleResult(IPC.preview.state, async (): Promise<ApiResult<ReturnType<PreviewService['getState']>>> => ok(preview.getState()));

  handleResult(IPC.preview.setBounds, async (candidate: unknown): Promise<ApiResult<void>> => {
    const bounds: PreviewBounds = boundsSchema.parse(candidate);
    preview.setBounds(bounds);
    return ok(undefined);
  });

  handleResult(IPC.preview.setVisible, async (visible: unknown): Promise<ApiResult<void>> => {
    preview.setVisible(z.boolean().parse(visible));
    return ok(undefined);
  });

  handleResult(IPC.preview.reload, async (): Promise<ApiResult<void>> => {
    await preview.reload();
    return ok(undefined);
  });

  handleResult(IPC.preview.clearDiagnostics, async (): Promise<ApiResult<void>> => {
    preview.clearDiagnostics();
    return ok(undefined);
  });

  handleResult(IPC.render.start, async (payload: unknown): Promise<ApiResult<RenderJob>> => {
    const parsed = z.object({ settings: z.unknown(), overwrite: z.boolean().optional() }).parse(payload);
    const validated = validateRenderSettings(parsed.settings);
    if (!validated.ok || !validated.value) {
      throw new BiframeError('INVALID_SETTINGS', {
        detail: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      });
    }
    const job = await render.start(validated.value, { overwrite: parsed.overwrite === true });
    preview.setVisible(false);
    return ok(job);
  });

  handleResult(IPC.render.cancel, async (candidate: unknown): Promise<ApiResult<void>> => {
    await render.cancel(z.string().min(1).parse(candidate));
    return ok(undefined);
  });

  handleResult(IPC.render.get, async (candidate: unknown): Promise<ApiResult<RenderJob | null>> => {
    return ok(render.get(z.string().min(1).parse(candidate)));
  });

  handleResult(IPC.render.list, async (): Promise<ApiResult<RenderJob[]>> => ok(render.list()));

  handleResult(IPC.history.list, async (): Promise<ApiResult<ReturnType<HistoryStore['list']>>> => ok(history.list()));

  handleResult(IPC.history.clear, async (): Promise<ApiResult<void>> => {
    await history.clear();
    return ok(undefined);
  });
}
