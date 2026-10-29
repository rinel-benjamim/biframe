import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FileCode2, FileArchive, Upload } from 'lucide-react';
import { getBridge } from './lib/api';
import {
  AppProvider,
  localizedErrorTitle,
  localizedErrorMessage,
  useAppActions,
  useAppState,
  useT,
} from './lib/store';
import { Notice, Mark, Spinner } from './components/ui';
import { Rail, Titlebar } from './components/shell';
import { HistoryScreen } from './screens/history';
import { ResultScreen } from './screens/result';
import { SettingsScreen } from './screens/settings';
import { StudioScreen } from './screens/studio';

const SUPPORTED_EXTENSIONS = /\.(html?|xhtml|zip)$/i;

function Boot(): ReactNode {
  const t = useT();
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot__mark">
        <Mark size={34} />
      </div>
      <div className="boot__title">{t('ui.boot.title')}</div>
      <div className="boot__sub">
        <Spinner size={14} />
        {t('ui.boot.sub')}
      </div>
    </div>
  );
}

function Fatal({ error }: { error: NonNullable<ReturnType<typeof useAppState>['fatal']> }): ReactNode {
  const t = useT();
  return (
    <div className="boot boot--fatal">
      <div className="boot__mark">
        <Mark size={34} />
      </div>
      <div className="boot__title">{localizedErrorTitle(error, t)}</div>
      <div className="boot__sub">{localizedErrorMessage(error, t)}</div>
      {error.detail ? <pre className="boot__detail mono">{error.detail}</pre> : null}
      <div className="boot__actions">
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          {t('ui.action.retry')}
        </button>
      </div>
    </div>
  );
}

function AppFrame(): ReactNode {
  const state = useAppState();
  const actions = useAppActions();
  const t = useT();
  const {
    view,
    notice,
    project,
    bootstrapped,
    fatal,
    importBusy,
    jobs,
  } = state;
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const running = jobs.some((job) => job.status === 'running');

  useEffect(() => {
    sheetRef.current?.scrollTo({ top: 0 });
  }, [view]);

  useEffect(() => {
    if (!notice || notice.action) return undefined;
    if (notice.kind !== 'success' && notice.kind !== 'info') return undefined;
    const timer = window.setTimeout(() => actions.dismissNotice(), 6500);
    return () => window.clearTimeout(timer);
  }, [actions, notice]);

  useEffect(() => {
    const isFileDrag = (event: { dataTransfer: DataTransfer | null }): boolean =>
      Boolean(event.dataTransfer?.types?.includes('Files'));

    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDropActive(true);
    };
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (!isFileDrag(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropActive(false);
    };
    const onDrop = (event: globalThis.DragEvent): void => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDropActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      const filePath = getBridge().app.resolveDroppedPath(file);
      if (!filePath) {
        actions.notify({
          kind: 'error',
          title: t('ui.drop.unreadable.title'),
          message: t('ui.drop.unreadable.message'),
        });
        return;
      }
      if (!SUPPORTED_EXTENSIONS.test(filePath)) {
        actions.notify({
          kind: 'error',
          title: t('ui.drop.unsupported.title'),
          message: t('ui.drop.unsupported.message'),
          detail: filePath,
        });
        return;
      }
      if (running) {
        actions.notify({
          kind: 'warning',
          title: t('ui.notice.renderInRun.title'),
          message: t('ui.notice.renderInRun.import.message'),
        });
        return;
      }
      void actions.importPath(filePath);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [actions, running, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        if (running) {
          actions.notify({
            kind: 'warning',
            title: t('ui.notice.renderInRun.title'),
            message: t('ui.notice.renderInRun.keyboard.message'),
          });
          return;
        }
        if (event.shiftKey) void actions.importZip();
        else void actions.importHtml();
        return;
      }
      if (key === 'e') {
        event.preventDefault();
        actions.requestExport();
        return;
      }
      if (key === '1') {
        event.preventDefault();
        actions.setView('studio');
        return;
      }
      if (key === '2') {
        event.preventDefault();
        actions.setView('history');
        return;
      }
      if (key === '3' || key === ',') {
        event.preventDefault();
        actions.setView('settings');
        return;
      }
      if (key === 'r' && !event.shiftKey) {
        event.preventDefault();
        if (project) void actions.reloadPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, project, running, t]);

  if (!bootstrapped) return <Boot />;
  if (fatal) return <Fatal error={fatal} />;

  return (
    <div className="app" data-view={view} data-drop-active={dropActive || undefined}>
      <Titlebar />
      <Rail />
      <main className="sheet">
        <div className="sheet__scroll" ref={sheetRef}>
          {view === 'studio' ? <StudioScreen /> : null}
          {view === 'result' ? <ResultScreen /> : null}
          {view === 'history' ? <HistoryScreen /> : null}
          {view === 'settings' ? <SettingsScreen /> : null}
        </div>
      </main>

      {notice ? (
        <div className="toast">
          <Notice notice={notice} onDismiss={actions.dismissNotice} />
        </div>
      ) : null}

      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__card">
            <Upload size={24} aria-hidden="true" />
            <strong>{t('ui.drop.title')}</strong>
            <span>{t('ui.drop.subtitle')}</span>
            <span className="drop-overlay__hint">
              <FileCode2 size={13} aria-hidden="true" /> .html
              <FileArchive size={13} aria-hidden="true" /> .zip
            </span>
          </div>
        </div>
      ) : null}

      {importBusy ? (
        <div className="import-pill" role="status">
          <Spinner size={13} />
          {t('ui.import.busy')}
        </div>
      ) : null}
    </div>
  );
}

export function App(): ReactNode {
  return (
    <AppProvider>
      <AppFrame />
    </AppProvider>
  );
}
