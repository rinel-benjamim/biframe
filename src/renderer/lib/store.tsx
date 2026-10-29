import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { BootstrapPayload } from '@shared/channels';
import { isErrorCode } from '@shared/errors';
import { formatBytes, formatNumber, sanitizeFileName, ensureExtension } from '@shared/format';
import { createTranslator, DEFAULT_LANGUAGE, type Language, type Translator } from '@shared/i18n';
import { defaultRenderSettings } from '@shared/presets';
import type {
  AppSettings,
  Diagnostic,
  EffectiveTheme,
  EngineStatus,
  HistoryEntry,
  PreviewState,
  ProjectInfo,
  RenderJob,
  RenderSettings,
  SerializedError,
} from '@shared/types';
import { ApiError, getBridge, toSerializedError, unwrap } from './api';

/** Screens live in one window; the rail is the only navigator. */
export type View = 'studio' | 'result' | 'history' | 'settings';

export interface AppNotice {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  bootstrapped: boolean;
  fatal: SerializedError | null;
  settings: AppSettings | null;
  engine: EngineStatus | null;
  project: ProjectInfo | null;
  preview: PreviewState;
  jobs: RenderJob[];
  history: HistoryEntry[];
  appVersion: string;
  exampleAvailable: boolean;
  platform: string;
  theme: EffectiveTheme;
  paths: BootstrapPayload['paths'];
  shortcuts: BootstrapPayload['keyboardShortcuts'];
  view: View;
  selectedResultId: string | null;
  draft: RenderSettings | null;
  notice: AppNotice | null;
  importBusy: boolean;
  rechecking: boolean;
  busy: string | null;
  exportRequest: number;
}

export interface AppActions {
  importHtml: () => Promise<void>;
  importZip: () => Promise<void>;
  importPath: (path: string) => Promise<void>;
  loadExample: () => Promise<void>;
  closeProject: () => Promise<void>;
  pickOutputDir: () => Promise<string | null>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  recheckEngine: () => Promise<void>;
  clearTemp: () => Promise<void>;
  reveal: (path: string) => Promise<void>;
  open: (path: string) => Promise<void>;
  reloadPreview: () => Promise<void>;
  clearPreviewDiagnostics: () => Promise<void>;
  setView: (view: View) => void;
  setPreviewVisible: (visible: boolean) => void;
  updateDraft: (patch: Partial<RenderSettings>) => void;
  requestExport: () => void;
  consumeExportRequest: () => void;
  startRender: (settings: RenderSettings, overwrite: boolean) => Promise<SerializedError | null>;
  cancelRender: (jobId: string) => Promise<void>;
  openResult: (id: string) => void;
  backToStudio: () => void;
  clearHistory: () => Promise<void>;
  notify: (notice: Omit<AppNotice, 'id'>) => void;
  dismissNotice: () => void;
}

const emptyPreview: PreviewState = {
  loading: false,
  url: null,
  projectId: null,
  lastReloadAt: null,
  diagnostics: [],
  error: null,
};

const initialState: AppState = {
  bootstrapped: false,
  fatal: null,
  settings: null,
  engine: null,
  project: null,
  preview: emptyPreview,
  jobs: [],
  history: [],
  appVersion: '0.1.0',
  exampleAvailable: false,
  platform: 'win32',
  theme: 'light',
  paths: { logs: '', temp: '', userData: '' },
  shortcuts: [],
  view: 'studio',
  selectedResultId: null,
  draft: null,
  notice: null,
  importBusy: false,
  rechecking: false,
  busy: null,
  exportRequest: 0,
};

const AppStateContext = createContext<AppState | null>(null);
const AppActionsContext = createContext<AppActions | null>(null);

/**
 * The translator the whole interface wears. It lives in the store rather than
 * in a separate provider because the actions (notices, error titles) need it
 * too, and it must change the moment Definições changes the language.
 */
const TranslatorContext = createContext<Translator>(createTranslator(DEFAULT_LANGUAGE));

/** The language itself, separate from the translator so consumers that only
 * need the locale (format helpers) do not depend on store state. */
const LanguageContext = createContext<Language>(DEFAULT_LANGUAGE);

/** Replaces a hardcoded sentence with its catalog key in the active language. */
export function useT(): Translator {
  return useContext(TranslatorContext);
}

/** The active language, for the `format*` helpers that take one.
 * Defaults to Portuguese outside the provider (unit tests, isolated mounts),
 * mirroring `useT`. */
export function useLanguage(): Language {
  return useContext(LanguageContext);
}

/**
 * A serialized error carries the engine's copy in the default language. The
 * code is stable, so the interface can always re-render it in its own language.
 */
export function localizedErrorTitle(error: SerializedError, t: Translator): string {
  return isErrorCode(error.code) ? t(`error.${error.code}.title`) : error.title;
}

export function localizedErrorMessage(error: SerializedError, t: Translator): string {
  return isErrorCode(error.code) ? t(`error.${error.code}.message`) : error.message;
}

/**
 * Puts a language around an isolated mount — component tests, portals or any
 * subtree rendered outside the full `AppProvider`. The application itself uses
 * `AppProvider`, which provides the same two contexts from the saved settings.
 */
export function TranslatorProvider({ language, children }: { language: Language; children: ReactNode }): ReactNode {
  const translator = useMemo(() => createTranslator(language), [language]);
  return (
    <TranslatorContext.Provider value={translator}>
      <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>
    </TranslatorContext.Provider>
  );
}

function suggestedFileName(projectName: string | null): string {
  if (!projectName) return 'biframe-export.mp4';
  const base = projectName.replace(/\.(html?|xhtml|zip)$/i, '');
  return ensureExtension(sanitizeFileName(base.length > 0 ? base : 'biframe-export'), '.mp4');
}

function mergeJobs(jobs: RenderJob[], incoming: RenderJob): RenderJob[] {
  const exists = jobs.some((job) => job.id === incoming.id);
  if (!exists) return [incoming, ...jobs].slice(0, 40);
  return jobs.map((job) => (job.id === incoming.id ? incoming : job));
}

function importPreviewState(project: ProjectInfo, previous: PreviewState): PreviewState {
  if (previous.projectId === project.id) return previous;
  return { ...emptyPreview, projectId: project.id, loading: true };
}

export function AppProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<AppState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const noticeCounter = useRef(0);
  const previewVisibleRef = useRef(false);

  const language = state.settings?.language ?? DEFAULT_LANGUAGE;
  const t = useMemo<Translator>(() => createTranslator(language), [language]);

  const notify = useCallback((notice: Omit<AppNotice, 'id'>): void => {
    noticeCounter.current += 1;
    setState((previous) => ({ ...previous, notice: { ...notice, id: noticeCounter.current } }));
  }, []);

  const notifyError = useCallback(
    (title: string, error: unknown): void => {
      const serialized = toSerializedError(error);
      notify({
        kind: 'error',
        title,
        message: localizedErrorTitle(serialized, t),
        detail: serialized.detail ?? localizedErrorMessage(serialized, t),
      });
    },
    [notify, t],
  );

  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      const history = unwrap(await getBridge().history.list());
      setState((previous) => ({ ...previous, history }));
    } catch {
      // History is informational; a failure must never interrupt a render.
    }
  }, []);

  const adoptProject = useCallback(async (project: ProjectInfo): Promise<void> => {
    let preview = importPreviewState(project, stateRef.current.preview);
    try {
      const current = await getBridge().preview.getState();
      if (current.ok && current.data) preview = current.data;
    } catch {
      // The placeholder loading state is enough.
    }
    setState((previous) => {
      const outputDir = previous.draft?.outputDir ?? previous.settings?.defaultOutputDir ?? '';
      const draft: RenderSettings = {
        ...(previous.draft ?? defaultRenderSettings(outputDir)),
        fileName: suggestedFileName(project.name),
        outputDir,
      };
      return {
        ...previous,
        project,
        preview,
        draft,
        view: 'studio',
        selectedResultId: null,
      };
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribePreview = (): void => undefined;
    let unsubscribeProgress = (): void => undefined;
    let unsubscribeCompleted = (): void => undefined;
    let unsubscribeTheme = (): void => undefined;

    let bridge: Window['biframe'];
    try {
      bridge = getBridge();
    } catch (error) {
      setState((previous) => ({ ...previous, fatal: toSerializedError(error) }));
      return undefined;
    }

    unsubscribePreview = bridge.preview.onStateChanged((event) => {
      if (disposed) return;
      setState((previous) => ({ ...previous, preview: event.state }));
    });

    unsubscribeTheme = bridge.app.onThemeChanged((theme) => {
      if (disposed) return;
      setState((previous) => ({ ...previous, theme }));
    });

    unsubscribeProgress = bridge.render.onProgress((event) => {
      if (disposed) return;
      setState((previous) => ({
        ...previous,
        jobs: previous.jobs.map((job) =>
          job.id === event.jobId ? { ...job, status: 'running', progress: event.progress } : job,
        ),
      }));
    });

    unsubscribeCompleted = bridge.render.onCompleted((event) => {
      if (disposed) return;
      const completed = event.job.status === 'completed';
      setState((previous) => ({
        ...previous,
        jobs: mergeJobs(previous.jobs, event.job),
        view: completed ? 'result' : previous.view,
        selectedResultId: completed ? event.job.id : previous.selectedResultId,
        draft: previous.draft ? { ...previous.draft, ...event.job.settings, outputDir: previous.draft.outputDir } : previous.draft,
      }));
      if (completed) {
        // The result screen is the confirmation; a second "Vídeo pronto"
        // toast would cover the filmstrip it points to.
        void refreshHistory();
      } else if (event.job.status === 'cancelled') {
        notify({ kind: 'info', title: t('ui.notice.renderCancelled.title'), message: t('ui.notice.renderCancelled.message') });
      } else {
        const serialized = event.job.error;
        notify({
          kind: 'error',
          title: t('ui.notice.exportFailed.title'),
          message: serialized ? localizedErrorTitle(serialized, t) : t('ui.notice.unknownError'),
          detail: serialized?.detail ?? (serialized ? localizedErrorMessage(serialized, t) : undefined),
        });
      }
    });

    void (async () => {
      try {
        const bootstrap = unwrap(await bridge.app.getBootstrap());
        if (disposed) return;
        setState((previous) => {
          const draft =
            previous.draft ??
            defaultRenderSettings(bootstrap.settings.defaultOutputDir, suggestedFileName(bootstrap.project?.name ?? null));
          return {
            ...previous,
            bootstrapped: true,
            fatal: null,
            settings: bootstrap.settings,
            engine: bootstrap.engine,
            project: bootstrap.project,
            preview: bootstrap.preview,
            jobs: bootstrap.jobs,
            history: bootstrap.history,
            appVersion: bootstrap.appVersion,
            exampleAvailable: bootstrap.exampleAvailable,
            platform: bootstrap.platform,
            theme: bootstrap.effectiveTheme,
            paths: bootstrap.paths,
            shortcuts: bootstrap.keyboardShortcuts,
            draft,
          };
        });
      } catch (error) {
        if (disposed) return;
        setState((previous) => ({ ...previous, bootstrapped: true, fatal: toSerializedError(error) }));
      }
    })();

    return () => {
      disposed = true;
      unsubscribePreview();
      unsubscribeProgress();
      unsubscribeCompleted();
      unsubscribeTheme();
    };
  }, [notify, refreshHistory, t]);

  /** The main process owns theme resolution; the shell only wears the answer. */
  useEffect(() => {
    document.documentElement.dataset['theme'] = state.theme;
    document.documentElement.style.colorScheme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    document.documentElement.dataset['platform'] = state.platform;
  }, [state.platform]);

  useEffect(() => {
    const scope = state.project?.name ?? t('ui.app.tagline');
    document.title = `Biframe — ${scope}`;
  }, [state.project?.name, t]);

  const actions = useMemo<AppActions>(() => {
    const runImport = async (
      task: () => ReturnType<Window['biframe']['project']['pickHtml']>,
    ): Promise<void> => {
      if (stateRef.current.importBusy) return;
      if (stateRef.current.jobs.some((job) => job.status === 'running')) {
        notify({
          kind: 'warning',
          title: t('ui.notice.renderInRun.title'),
          message: t('ui.notice.renderInRun.import.message'),
        });
        return;
      }
      setState((previous) => ({ ...previous, importBusy: true }));
      try {
        const imported = unwrap(await task());
        if (imported.canceled) return;
        if (imported.error) {
          notifyError(t('ui.action.importFailed'), new ApiError(imported.error));
          return;
        }
        if (imported.project) await adoptProject(imported.project);
      } catch (error) {
        notifyError(t('ui.action.importFailed'), error);
      } finally {
        setState((previous) => ({ ...previous, importBusy: false }));
      }
    };

    return {
      importHtml: () => runImport(() => getBridge().project.pickHtml()),
      importZip: () => runImport(() => getBridge().project.pickZip()),
      importPath: (path) => runImport(() => getBridge().project.importPath(path)),
      loadExample: () => runImport(() => getBridge().project.loadExample()),

      closeProject: async () => {
        if (stateRef.current.jobs.some((job) => job.status === 'running')) {
          notify({
            kind: 'warning',
            title: t('ui.notice.renderInRun.title'),
            message: t('ui.notice.renderInRun.close.message'),
          });
          return;
        }
        try {
          unwrap(await getBridge().project.close());
          setState((previous) => ({
            ...previous,
            project: null,
            preview: emptyPreview,
            view: 'studio',
            selectedResultId: null,
            draft: previous.draft ? { ...previous.draft, fileName: 'biframe-export.mp4' } : previous.draft,
          }));
        } catch (error) {
          notifyError(t('ui.action.closeFailed'), error);
        }
      },

      pickOutputDir: async () => {
        try {
          return unwrap(await getBridge().project.pickOutputDir());
        } catch (error) {
          notifyError(t('ui.action.pickDirFailed'), error);
          return null;
        }
      },

      updateSettings: async (patch) => {
        try {
          const updated = unwrap(await getBridge().app.updateSettings(patch));
          setState((previous) => ({
            ...previous,
            settings: updated,
            draft:
              previous.draft &&
              patch.defaultOutputDir !== undefined &&
              previous.draft.outputDir === previous.settings?.defaultOutputDir
                ? { ...previous.draft, outputDir: updated.defaultOutputDir }
                : previous.draft,
          }));
        } catch (error) {
          notifyError(t('ui.action.settingsNotSaved'), error);
        }
      },

      recheckEngine: async () => {
        setState((previous) => ({ ...previous, rechecking: true }));
        try {
          const engine = unwrap(await getBridge().engine.recheck());
          setState((previous) => ({ ...previous, engine }));
          notify(
            engine.ready
              ? { kind: 'success', title: t('ui.engine.ready.title'), message: t('ui.engine.ready.message') }
              : { kind: 'warning', title: t('ui.engine.incomplete.title'), message: t('ui.engine.incomplete.message') },
          );
        } catch (error) {
          notifyError(t('ui.action.engineCheckFailed'), error);
        } finally {
          setState((previous) => ({ ...previous, rechecking: false }));
        }
      },

      clearTemp: async () => {
        setState((previous) => ({ ...previous, busy: 'clear-temp' }));
        try {
          const removed = unwrap(await getBridge().app.clearTemp());
          const engine = unwrap(await getBridge().engine.recheck());
          setState((previous) => ({ ...previous, engine }));
          notify({
            kind: 'success',
            title: t('ui.temp.cleared.title'),
            message: t('ui.temp.cleared.message', {
              files: formatNumber(removed.removedEntries, 0, language),
              size: formatBytes(removed.removedBytes),
            }),
          });
        } catch (error) {
          notifyError(t('ui.action.tempClearFailed'), error);
        } finally {
          setState((previous) => ({ ...previous, busy: null }));
        }
      },

      reveal: async (path) => {
        try {
          unwrap(await getBridge().app.revealPath(path));
        } catch (error) {
          notifyError(t('ui.action.revealFailed'), error);
        }
      },

      open: async (path) => {
        try {
          unwrap(await getBridge().app.openPath(path));
        } catch (error) {
          notifyError(t('ui.action.openFailed'), error);
        }
      },

      reloadPreview: async () => {
        try {
          unwrap(await getBridge().preview.reload());
        } catch (error) {
          notifyError(t('ui.action.previewReloadFailed'), error);
        }
      },

      clearPreviewDiagnostics: async () => {
        try {
          unwrap(await getBridge().preview.clearDiagnostics());
          setState((previous) => ({ ...previous, preview: { ...previous.preview, diagnostics: [] } }));
        } catch (error) {
          notifyError(t('ui.action.diagnosticsClearFailed'), error);
        }
      },

      setView: (view) => {
        setState((previous) => ({ ...previous, view }));
      },

      setPreviewVisible: (visible) => {
        if (previewVisibleRef.current === visible) return;
        previewVisibleRef.current = visible;
        void getBridge().preview.setVisible(visible).then((result) => {
          if (!result.ok) previewVisibleRef.current = !visible;
        }).catch(() => {
          previewVisibleRef.current = !visible;
        });
      },

      updateDraft: (patch) => {
        setState((previous) => (previous.draft ? { ...previous, draft: { ...previous.draft, ...patch } } : previous));
      },

      requestExport: () => {
        if (!stateRef.current.project) {
          notify({
            kind: 'info',
            title: t('ui.export.noProject.title'),
            message: t('ui.export.noProject.message'),
          });
          return;
        }
        setState((previous) => ({ ...previous, view: 'studio', exportRequest: previous.exportRequest + 1 }));
      },

      consumeExportRequest: () => {
        setState((previous) => (previous.exportRequest === 0 ? previous : { ...previous, exportRequest: 0 }));
      },

      startRender: async (settings, overwrite) => {
        const normalized: RenderSettings = {
          ...settings,
          fileName: ensureExtension(sanitizeFileName(settings.fileName), '.mp4'),
        };
        setState((previous) => ({
          ...previous,
          draft: normalized,
          view: 'studio',
          selectedResultId: null,
        }));
        try {
          const job = unwrap(await getBridge().render.start(normalized, { overwrite }));
          setState((previous) => ({
            ...previous,
            jobs: mergeJobs(previous.jobs, job),
            draft: { ...normalized },
          }));
          return null;
        } catch (error) {
          return toSerializedError(error);
        }
      },

      cancelRender: async (jobId) => {
        try {
          unwrap(await getBridge().render.cancel(jobId));
        } catch (error) {
          notifyError(t('ui.action.cancelFailed'), error);
        }
      },

      openResult: (id) => {
        setState((previous) => ({ ...previous, view: 'result', selectedResultId: id }));
      },

      backToStudio: () => {
        setState((previous) => ({ ...previous, view: 'studio' }));
      },

      clearHistory: async () => {
        try {
          unwrap(await getBridge().history.clear());
          setState((previous) => ({ ...previous, history: [] }));
          notify({ kind: 'success', title: t('ui.history.cleared.title'), message: t('ui.history.cleared.message') });
        } catch (error) {
          notifyError(t('ui.action.historyClearFailed'), error);
        }
      },

      notify,

      dismissNotice: () => {
        setState((previous) => ({ ...previous, notice: null }));
      },
    };
  }, [adoptProject, notify, notifyError, refreshHistory, t, language]);

  const stateValue = useMemo<AppState>(() => state, [state]);

  return (
    <AppActionsContext.Provider value={actions}>
      <TranslatorContext.Provider value={t}>
        <LanguageContext.Provider value={language}>
          <AppStateContext.Provider value={stateValue}>{children}</AppStateContext.Provider>
        </LanguageContext.Provider>
      </TranslatorContext.Provider>
    </AppActionsContext.Provider>
  );
}

export function useAppState(): AppState {
  const value = useContext(AppStateContext);
  if (!value) throw new Error('useAppState must be used inside AppProvider');
  return value;
}

export function useAppActions(): AppActions {
  const value = useContext(AppActionsContext);
  if (!value) throw new Error('useAppActions must be used inside AppProvider');
  return value;
}

/** Diagnostics from the preview plus the import warnings, deduplicated. */
export function useProjectDiagnostics(): Diagnostic[] {
  const { project, preview } = useAppState();
  return useMemo(() => {
    const items: Diagnostic[] = [];
    const seen = new Set<string>();
    for (const diagnostic of [...(project?.warnings ?? []), ...preview.diagnostics]) {
      const key = `${diagnostic.code}|${diagnostic.url ?? diagnostic.message}|${diagnostic.detail ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(diagnostic);
    }
    return items;
  }, [project?.warnings, preview.diagnostics]);
}
