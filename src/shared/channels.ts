import type {
  AppSettings,
  Diagnostic,
  EffectiveTheme,
  EngineStatus,
  HistoryEntry,
  PreviewBounds,
  PreviewState,
  ProjectInfo,
  RenderJob,
  RenderSettings,
} from './types';
import type { SerializedError } from './types';

/**
 * The complete IPC surface. Channel names are declared once, together with the
 * payload types, and every handler in the main process validates its input
 * against the schemas in `./settings` or `./ipc-schemas` before doing any work.
 */
export const IPC = {
  app: {
    getBootstrap: 'app:get-bootstrap',
    getSettings: 'app:get-settings',
    updateSettings: 'app:update-settings',
    revealPath: 'app:reveal-path',
    openPath: 'app:open-path',
    getLogDirectory: 'app:get-log-directory',
    clearTemp: 'app:clear-temp',
    themeChanged: 'app:theme-changed',
  },
  engine: {
    status: 'engine:status',
    recheck: 'engine:recheck',
  },
  project: {
    pickHtml: 'project:pick-html',
    pickZip: 'project:pick-zip',
    import: 'project:import',
    current: 'project:current',
    close: 'project:close',
    pickOutputDir: 'project:pick-output-dir',
    loadExample: 'project:load-example',
  },
  preview: {
    state: 'preview:state',
    setBounds: 'preview:set-bounds',
    setVisible: 'preview:set-visible',
    reload: 'preview:reload',
    clearDiagnostics: 'preview:clear-diagnostics',
    stateChanged: 'preview:state-changed',
  },
  render: {
    start: 'render:start',
    cancel: 'render:cancel',
    get: 'render:get',
    list: 'render:list',
    progress: 'render:progress',
    completed: 'render:completed',
  },
  history: {
    list: 'history:list',
    clear: 'history:clear',
  },
} as const;

export interface BootstrapPayload {
  settings: AppSettings;
  engine: EngineStatus;
  project: ProjectInfo | null;
  preview: PreviewState;
  jobs: RenderJob[];
  history: HistoryEntry[];
  appVersion: string;
  exampleAvailable: boolean;
  platform: string;
  /** The theme the shell resolved for this session (`system` already applied). */
  effectiveTheme: EffectiveTheme;
  paths: {
    logs: string;
    temp: string;
    userData: string;
  };
  keyboardShortcuts: { id: string; keys: string; description: string }[];
}

export interface StartRenderPayload {
  settings: RenderSettings;
  /** Confirms replacing an existing file with the same name. */
  overwrite?: boolean;
}

export interface RenderProgressEvent {
  jobId: string;
  progress: RenderJob['progress'];
}

export interface RenderCompletedEvent {
  jobId: string;
  job: RenderJob;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: SerializedError;
}

export interface PreviewStateEvent {
  state: PreviewState;
  diagnostics: Diagnostic[];
}

export interface ProjectImportResult {
  project: ProjectInfo | null;
  canceled: boolean;
  error?: SerializedError;
}

/** Shape of the API exposed to the React renderer through the preload script. */
export interface BiframeApi {
  app: {
    getBootstrap(): Promise<ApiResult<BootstrapPayload>>;
    updateSettings(patch: Partial<AppSettings>): Promise<ApiResult<AppSettings>>;
    revealPath(path: string): Promise<ApiResult<void>>;
    openPath(path: string): Promise<ApiResult<void>>;
    getLogDirectory(): Promise<ApiResult<string>>;
    clearTemp(): Promise<ApiResult<{ removedBytes: number; removedEntries: number }>>;
    onThemeChanged(listener: (theme: EffectiveTheme) => void): () => void;
    /** Absolute path of a dropped file; empty string when it cannot be resolved. */
    resolveDroppedPath(file: unknown): string;
  };
  engine: {
    recheck(): Promise<ApiResult<EngineStatus>>;
  };
  project: {
    pickHtml(): Promise<ApiResult<ProjectImportResult>>;
    pickZip(): Promise<ApiResult<ProjectImportResult>>;
    importPath(path: string): Promise<ApiResult<ProjectImportResult>>;
    current(): Promise<ApiResult<ProjectInfo | null>>;
    close(): Promise<ApiResult<void>>;
    pickOutputDir(): Promise<ApiResult<string | null>>;
    loadExample(): Promise<ApiResult<ProjectImportResult>>;
  };
  preview: {
    getState(): Promise<ApiResult<PreviewState>>;
    setBounds(bounds: PreviewBounds): Promise<ApiResult<void>>;
    setVisible(visible: boolean): Promise<ApiResult<void>>;
    reload(): Promise<ApiResult<void>>;
    clearDiagnostics(): Promise<ApiResult<void>>;
    onStateChanged(listener: (event: PreviewStateEvent) => void): () => void;
  };
  render: {
    start(settings: RenderSettings, options?: { overwrite?: boolean }): Promise<ApiResult<RenderJob>>;
    cancel(jobId: string): Promise<ApiResult<void>>;
    get(jobId: string): Promise<ApiResult<RenderJob | null>>;
    list(): Promise<ApiResult<RenderJob[]>>;
    onProgress(listener: (event: RenderProgressEvent) => void): () => void;
    onCompleted(listener: (event: RenderCompletedEvent) => void): () => void;
  };
  history: {
    list(): Promise<ApiResult<HistoryEntry[]>>;
    clear(): Promise<ApiResult<void>>;
  };
}

declare global {
  interface Window {
    biframe: BiframeApi;
  }
}
