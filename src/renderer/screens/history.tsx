import { useState, type ReactNode } from 'react';
import {
  ArrowRight,
  FolderOpen,
  Trash2,
} from 'lucide-react';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatResolution,
  formatSeconds,
} from '@shared/format';
import { statusLabel } from '../lib/labels';
import { localizedErrorMessage, useAppActions, useAppState, useLanguage, useT } from '../lib/store';
import { Mark } from '../components/ui';

export function HistoryScreen(): ReactNode {
  const { history, jobs } = useAppState();
  const { setView, openResult, reveal, clearHistory } = useAppActions();
  const t = useT();
  const language = useLanguage();
  const [confirming, setConfirming] = useState(false);

  const completed = history.filter((entry) => entry.status === 'completed').length;
  const failed = history.filter((entry) => entry.status === 'failed').length;

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">{t('ui.history.eyebrow')}</p>
          <h1>{t('ui.view.history')}</h1>
          <p className="page-head__sub">
            {t('ui.history.sub', { count: formatNumber(history.length, 0, language) })}
          </p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--quiet btn--danger"
            onClick={() => setConfirming(true)}
            disabled={history.length === 0 || confirming}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t('ui.history.clear')}
          </button>
        </div>
      </header>

      {confirming ? (
        <div className="notice" data-kind="warn" role="alert">
          <Trash2 size={17} aria-hidden="true" className="notice__icon notice__icon--warning" />
          <div className="notice__body">
            <div className="notice__title">{t('ui.history.confirmTitle')}</div>
            <div className="notice__message">{t('ui.history.confirmMessage')}</div>
            <div className="notice__actions">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setConfirming(false);
                  void clearHistory();
                }}
              >
                {t('ui.history.confirmClear')}
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => setConfirming(false)}>
                {t('ui.action.cancel')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {history.length === 0 ? (
        <div className="empty empty--compact">
          <div className="empty__mark">
            <Mark size={38} />
          </div>
          <div className="empty__lead">
            <h2>{t('ui.history.emptyTitle')}</h2>
            <p>{t('ui.history.emptyText')}</p>
          </div>
          <div className="empty__actions">
            <button type="button" className="btn btn--primary" onClick={() => setView('studio')}>
              {t('ui.history.goStudio')}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <section className="panel" aria-labelledby="history-title">
          <div className="panel__head">
            <h2 id="history-title">{t('ui.history.panelTitle')}</h2>
            <span className="chip">{t('ui.history.completedChip', { count: formatNumber(completed, 0, language) })}</span>
            {failed > 0 ? (
              <span className="chip chip--error">{t('ui.history.failedChip', { count: formatNumber(failed, 0, language) })}</span>
            ) : null}
            <span className="spacer" />
            <span className="panel__hint">{t('ui.history.storedHint')}</span>
          </div>
          <div className="panel__body panel__body--table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('ui.meta.project')}</th>
                  <th scope="col">{t('ui.meta.status')}</th>
                  <th scope="col">{t('ui.meta.image')}</th>
                  <th scope="col" className="num">
                    {t('ui.meta.duration')}
                  </th>
                  <th scope="col" className="num">
                    {t('ui.meta.size')}
                  </th>
                  <th scope="col">{t('ui.meta.date')}</th>
                  <th scope="col" aria-label={t('ui.history.actionsAria')} />
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => {
                  const job = jobs.find((candidate) => candidate.id === entry.id && candidate.result);
                  const canOpen = entry.status === 'completed' && entry.outputPath.length > 0;
                  return (
                    <tr key={entry.id}>
                      <td>
                        <div className="name">
                          <span className="status-mark" data-status={entry.status} aria-hidden="true" />
                          <div className="name__stack">
                            <span className="name__title" title={entry.projectName}>
                              {entry.projectName}
                            </span>
                            <span className="name__sub mono" title={entry.fileName}>
                              {entry.fileName}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className="status-label"
                          data-status={entry.status}
                          title={entry.error ? entry.error.detail ?? localizedErrorMessage(entry.error, t) : undefined}
                        >
                          {statusLabel(entry.status, t)}
                        </span>
                      </td>
                      <td className="mono tnum">{formatResolution(entry.width, entry.height)}</td>
                      <td className="num tnum">
                        {entry.durationSeconds > 0 ? formatSeconds(entry.durationSeconds, language) : '—'}
                      </td>
                      <td className="num tnum">{entry.sizeBytes > 0 ? formatBytes(entry.sizeBytes) : '—'}</td>
                      <td className="tnum">{formatDateTime(entry.startedAt, language)}</td>
                      <td>
                        <div className="row-actions">
                          {canOpen ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => openResult(entry.id)}
                                title={job ? t('ui.history.openResultTitle') : t('ui.history.openFileTitle')}
                              >
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
                            <span className="row-actions__empty">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
