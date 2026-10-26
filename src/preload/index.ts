import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC,
  type ApiResult,
  type BiframeApi,
  type PreviewStateEvent,
  type ProjectImportResult,
  type RenderCompletedEvent,
  type RenderProgressEvent,
  type StartRenderPayload,
} from '@shared/channels';
import { serializeError } from '@shared/errors';
import type { AppSettings, EffectiveTheme, EngineStatus, HistoryEntry, PreviewBounds, PreviewState, ProjectInfo, RenderJob, SerializedError } from '@shared/types';

/**
 * The bridge. The renderer gets exactly the methods declared in `BiframeApi`
 * and nothing else: no `ipcRenderer`, no Node, no module access. Every call
 * answers with a result object so the interface never has to catch a bridge
 * rejection to show an error.
 */

const unavailable = (error: unknown): ApiResult<never> => ({
  ok: false,
  error: serializeError(error) as SerializedError,
});

async function invoke<T>(channel: string, payload?: unknown): Promise<ApiResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as ApiResult<T>;
  } catch (error) {
    return unavailable(error);
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: BiframeApi = {
  app: {
    getBootstrap: () => invoke(IPC.app.getBootstrap),
    updateSettings: (patch: Partial<AppSettings>) => invoke(IPC.app.updateSettings, patch),
    revealPath: (target: string) => invoke(IPC.app.revealPath, target),
    openPath: (target: string) => invoke(IPC.app.openPath, target),
    getLogDirectory: () => invoke(IPC.app.getLogDirectory),
    clearTemp: () => invoke(IPC.app.clearTemp),
    onThemeChanged: (listener: (theme: EffectiveTheme) => void) => subscribe(IPC.app.themeChanged, listener),
    resolveDroppedPath: (file: unknown) => {
      try {
        return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]) ?? '';
      } catch {
        return '';
      }
    },
  },
  engine: {
    recheck: () => invoke<EngineStatus>(IPC.engine.recheck),
  },
  project: {
    pickHtml: () => invoke<ProjectImportResult>(IPC.project.pickHtml),
    pickZip: () => invoke<ProjectImportResult>(IPC.project.pickZip),
    importPath: (path: string) => invoke<ProjectImportResult>(IPC.project.import, path),
    current: () => invoke<ProjectInfo | null>(IPC.project.current),
    close: () => invoke(IPC.project.close),
    pickOutputDir: () => invoke<string | null>(IPC.project.pickOutputDir),
    loadExample: () => invoke<ProjectImportResult>(IPC.project.loadExample),
  },
  preview: {
    getState: () => invoke<PreviewState>(IPC.preview.state),
    setBounds: (bounds: PreviewBounds) => invoke(IPC.preview.setBounds, bounds),
    setVisible: (visible: boolean) => invoke(IPC.preview.setVisible, visible),
    reload: () => invoke(IPC.preview.reload),
    clearDiagnostics: () => invoke(IPC.preview.clearDiagnostics),
    onStateChanged: (listener: (event: PreviewStateEvent) => void) => subscribe(IPC.preview.stateChanged, listener),
  },
  render: {
    start: (settings, options) => {
      const payload: StartRenderPayload = { settings, overwrite: options?.overwrite === true };
      return invoke<RenderJob>(IPC.render.start, payload);
    },
    cancel: (jobId: string) => invoke(IPC.render.cancel, jobId),
    get: (jobId: string) => invoke<RenderJob | null>(IPC.render.get, jobId),
    list: () => invoke<RenderJob[]>(IPC.render.list),
    onProgress: (listener: (event: RenderProgressEvent) => void) => subscribe(IPC.render.progress, listener),
    onCompleted: (listener: (event: RenderCompletedEvent) => void) => subscribe(IPC.render.completed, listener),
  },
  history: {
    list: () => invoke<HistoryEntry[]>(IPC.history.list),
    clear: () => invoke(IPC.history.clear),
  },
};

contextBridge.exposeInMainWorld('biframe', api);
