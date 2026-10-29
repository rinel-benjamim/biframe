import type { ReactNode } from 'react';
import {
  ArrowRight,
  FileArchive,
  FileCode2,
  FolderOpen,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { formatBytes, formatNumber, formatRelative, pluralize } from '@shared/format';
import { KIND_LABELS, projectEntryName, statusLabel } from '../lib/labels';
import { useAppActions, useAppState, useLanguage, useProjectDiagnostics, useT } from '../lib/store';
import { ExportPanel } from '../components/export-panel';
import { PreviewStage } from '../components/stage';
import {
  DiagnosticList,
  DiagnosticSummary,
  Mark,
  Spinner,
} from '../components/ui';

function EmptyStudio(): ReactNode {
  const { history, importBusy, exampleAvailable } = useAppState();
  const { importHtml, importZip, loadExample, openResult, reveal } = useAppActions();
  const t = useT();
  const language = useLanguage();
  const recent = history.slice(0, 3);

  return (
    <div className="empty">
      <div className="empty__mark">
        <Mark size={46} />
      </div>
      <div className="empty__lead">
        <h2>{t('ui.studio.emptyTitle')}</h2>
        <p>{t('ui.studio.emptyLead')}</p>
      </div>
      <div className="empty__actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={() => void importHtml()} disabled={importBusy}>
          {importBusy ? <Spinner size={15} /> : <FileCode2 size={16} aria-hidden="true" />}
          {t('ui.action.importHtml')}
        </button>
        <button type="button" className="btn btn--lg" onClick={() => void importZip()} disabled={importBusy}>
          <FileArchive size={16} aria-hidden="true" />
          {t('ui.action.importZip')}
        </button>
        {exampleAvailable ? (
          <button type="button" className="btn btn--quiet btn--lg" onClick={() => void loadExample()} disabled={importBusy}>
            <Wand2 size={16} aria-hidden="true" />
            {t('ui.studio.openExample')}
          </button>
        ) : null}
      </div>
      <p className="empty__hint">{t('ui.studio.emptyHint')}</p>

      {recent.length > 0 ? (
        <div className="recent">
          <div className="recent__title">{t('ui.studio.recentTitle')}</div>
          {recent.map((entry) => (
            <div className="recent__row" key={entry.id}>
              <span className="status-mark" data-status={entry.status} aria-hidden="true" />
              <span className="recent__name">{entry.projectName}</span>
              <span className="recent__file mono">{entry.fileName}</span>
              <span className="spacer" />
              <span className="recent__meta tnum">{formatRelative(entry.startedAt, Date.now(), language)}</span>
              <span className="recent__meta tnum">{formatBytes(entry.sizeBytes)}</span>
              {entry.status === 'completed' ? (
                <>
                  <button type="button" className="btn btn--quiet" onClick={() => openResult(entry.id)}>
                    {t('ui.action.open')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet btn--icon"
                    onClick={() => void reveal(entry.outputPath)}
                    aria-label={t('ui.action.revealAria', { fileName: entry.fileName })}
                  >
                    <FolderOpen size={14} aria-hidden="true" />
                  </button>
                </>
              ) : (
                <span className="recent__status">{statusLabel(entry.status, t)}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <ol className="steps" aria-label={t('ui.studio.stepsAria')}>
        <li>
          <span className="steps__num mono">01</span>
          <strong>{t('ui.studio.step1Title')}</strong>
          <span>{t('ui.studio.step1Text')}</span>
        </li>
        <li>
          <span className="steps__num mono">02</span>
          <strong>{t('ui.studio.step2Title')}</strong>
          <span>{t('ui.studio.step2Text')}</span>
        </li>
        <li>
          <span className="steps__num mono">03</span>
          <strong>{t('ui.studio.step3Title')}</strong>
          <span>{t('ui.studio.step3Text')}</span>
        </li>
      </ol>
    </div>
  );
}

export function StudioScreen(): ReactNode {
  const { project, preview, jobs, importBusy } = useAppState();
  const { importHtml, closeProject, clearPreviewDiagnostics } = useAppActions();
  const t = useT();
  const language = useLanguage();
  const diagnostics = useProjectDiagnostics();
  const activeJob = jobs.find((job) => job.status === 'running') ?? null;
  const running = Boolean(activeJob);

  if (!project) {
    return (
      <>
        <header className="page-head">
          <div className="page-head__text">
            <p className="eyebrow">{t('ui.view.studio')}</p>
            <h1>{t('ui.studio.headline')}</h1>
            <p className="page-head__sub">{t('ui.studio.headlineSub')}</p>
          </div>
        </header>
        <EmptyStudio />
      </>
    );
  }

  const fileCount = project.htmlFileCount + project.assetCount;
  const remoteCount = project.remoteResourceHosts.length;

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">{t('ui.view.studio')}</p>
          <h1 title={project.name}>{project.name}</h1>
          <p className="page-head__sub">
            <span className="mono">{projectEntryName(project)}</span>
            <span className="page-head__sep" aria-hidden="true">·</span>
            {KIND_LABELS[project.kind]}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatBytes(project.sizeBytes)}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatNumber(fileCount, 0, language)} {pluralize(fileCount, t('ui.files.one'), t('ui.files.many'))}
            {remoteCount > 0 ? (
              <>
                <span className="page-head__sep" aria-hidden="true">·</span>
                {remoteCount} {pluralize(remoteCount, t('ui.studio.host.one'), t('ui.studio.host.many'))}
              </>
            ) : (
              <>
                <span className="page-head__sep" aria-hidden="true">·</span>
                offline
              </>
            )}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {t('ui.studio.importedAt', { when: formatRelative(project.importedAt, Date.now(), language) })}
          </p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void importHtml()}
            disabled={running || importBusy}
            title={running ? t('ui.notice.renderInRun.title') : t('ui.studio.replaceHtmlTitle')}
          >
            <Upload size={15} aria-hidden="true" />
            {t('ui.action.replace')}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void closeProject()}
            disabled={running || importBusy}
            title={running ? t('ui.notice.renderInRun.title') : t('ui.studio.closeProjectTitle')}
          >
            <X size={15} aria-hidden="true" />
            {t('ui.action.close')}
          </button>
        </div>
      </header>

      <div className="studio">
        <div className="studio__left">
          <PreviewStage activeJob={activeJob} />

          <section className="panel" aria-labelledby="diagnostics-title">
            <div className="panel__head">
              <h2 id="diagnostics-title">{t('ui.diagnostics.title')}</h2>
              <DiagnosticSummary diagnostics={diagnostics} />
              <span className="spacer" />
              {preview.diagnostics.length > 0 ? (
                <button type="button" className="btn btn--quiet" onClick={() => void clearPreviewDiagnostics()}>
                  {t('ui.action.clear')}
                </button>
              ) : null}
            </div>
            {diagnostics.length > 0 ? (
              <DiagnosticList diagnostics={diagnostics} />
            ) : (
              <div className="panel__body panel__body--tight">
                <p className="calm">{t('ui.diagnostics.emptyStudio')}</p>
              </div>
            )}
          </section>

          <p className="studio__note">
            <ArrowRight size={13} aria-hidden="true" />
            {t('ui.studio.previewNote')}
          </p>
        </div>

        <div className="studio__right">
          <ExportPanel />
        </div>
      </div>
    </>
  );
}
