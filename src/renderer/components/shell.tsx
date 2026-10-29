import type { ReactNode } from 'react';
import {
  FileArchive,
  FileCode2,
  Film,
  History,
  Settings2,
  Upload,
} from 'lucide-react';
import type { Translator } from '@shared/i18n';
import { formatBytes, formatNumber, pluralize } from '@shared/format';
import { KIND_LABELS, viewLabel } from '../lib/labels';
import { useAppActions, useAppState, useLanguage, useT } from '../lib/store';
import { Mark, Spinner } from './ui';

function engineLabel(ready: boolean | undefined, engineAvailable: boolean, t: Translator): string {
  if (engineAvailable === false) return t('ui.engine.status.unavailable');
  if (ready === undefined) return t('ui.engine.status.checking');
  return ready ? t('ui.engine.status.ready') : t('ui.engine.status.incomplete');
}

export function Titlebar(): ReactNode {
  const { project, view, engine, appVersion } = useAppState();
  const t = useT();
  const ready = engine ? engine.ready : undefined;
  const state = ready === undefined ? 'pending' : ready ? 'ready' : 'broken';
  const engineAvailable = engine ? engine.ffmpeg.available && engine.ffprobe.available : true;

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <Mark size={18} />
        <span className="titlebar__name">Biframe</span>
      </div>
      <span className="titlebar__dot" aria-hidden="true">
        /
      </span>
      <div className="titlebar__scope">
        {project ? (
          <>
            <strong title={project.name}>{project.name}</strong>
            <span className="titlebar__dot" aria-hidden="true">
              ·
            </span>
            <span>{viewLabel(view, t)}</span>
          </>
        ) : (
          <span>{viewLabel(view, t)}</span>
        )}
      </div>
      <span className="titlebar__spacer" />
      <div className="titlebar__meta">
        <span className="titlebar__version mono" title={t('ui.titlebar.version')}>
          v{appVersion}
        </span>
        <span
          className="engine-dot"
          data-state={state}
          title={engine?.ffmpeg.version ? `FFmpeg ${engine.ffmpeg.version}` : t('ui.titlebar.engineChecking')}
        >
          {ready === undefined ? <Spinner size={12} /> : null}
          {engineLabel(ready, engineAvailable, t)}
        </span>
      </div>
    </header>
  );
}

export function Rail(): ReactNode {
  const { project, view, importBusy, history } = useAppState();
  const { setView, importHtml, importZip, closeProject } = useAppActions();
  const t = useT();
  const language = useLanguage();
  const studioCurrent = view === 'studio' || view === 'result';

  return (
    <nav className="rail" aria-label={t('ui.nav.ariaLabel')}>
      <div className="rail__label">{t('ui.nav.section')}</div>
      <button
        type="button"
        className="rail__item"
        aria-current={studioCurrent ? 'page' : undefined}
        onClick={() => setView('studio')}
      >
        <Film aria-hidden="true" />
        <span>{t('ui.view.studio')}</span>
      </button>
      <button
        type="button"
        className="rail__item"
        aria-current={view === 'history' ? 'page' : undefined}
        onClick={() => setView('history')}
      >
        <History aria-hidden="true" />
        <span>{t('ui.view.history')}</span>
        {history.length > 0 ? (
          <span className="rail__count tnum">{formatNumber(history.length, 0, language)}</span>
        ) : null}
      </button>
      <button
        type="button"
        className="rail__item"
        aria-current={view === 'settings' ? 'page' : undefined}
        onClick={() => setView('settings')}
      >
        <Settings2 aria-hidden="true" />
        <span>{t('ui.view.settings')}</span>
      </button>

      <div className="rail__spacer" />

      <div className="rail__project">
        {project ? (
          <>
            <span className="rail__project-label">{t('ui.nav.projectOpen')}</span>
            <span className="rail__project-name" title={project.name}>
              {project.name}
            </span>
            <div className="rail__project-meta">
              <span className="mono">{KIND_LABELS[project.kind]}</span>
              <span className="rail__project-dot" aria-hidden="true">
                ·
              </span>
              <span>{formatBytes(project.sizeBytes)}</span>
              <span className="rail__project-dot" aria-hidden="true">
                ·
              </span>
              <span>
                {formatNumber(project.htmlFileCount + project.assetCount, 0, language)}{' '}
                {pluralize(
                  project.htmlFileCount + project.assetCount,
                  t('ui.files.one'),
                  t('ui.files.many'),
                )}
              </span>
            </div>
            <div className="rail__project-actions">
              <button type="button" className="btn btn--quiet" onClick={() => void importHtml()} disabled={importBusy}>
                <Upload size={14} aria-hidden="true" />
                {t('ui.action.replace')}
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => void closeProject()} disabled={importBusy}>
                {t('ui.action.close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="rail__project-name">{t('ui.nav.noProject')}</span>
            <span className="rail__project-hint">{t('ui.nav.noProjectHint')}</span>
            <div className="rail__project-actions rail__project-actions--stack">
              <button type="button" className="btn btn--quiet" onClick={() => void importHtml()} disabled={importBusy}>
                <FileCode2 size={14} aria-hidden="true" />
                {t('ui.action.importHtml')}
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => void importZip()} disabled={importBusy}>
                <FileArchive size={14} aria-hidden="true" />
                {t('ui.action.importZip')}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="rail__foot">
        <span>{t('ui.nav.tagline')}</span>
        <span className="mono">MIT · open source</span>
      </div>
    </nav>
  );
}
