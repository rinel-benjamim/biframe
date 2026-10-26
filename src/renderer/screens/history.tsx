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
import { STATUS_LABELS } from '../lib/labels';
import { useAppActions, useAppState } from '../lib/store';
import { Mark } from '../components/ui';

export function HistoryScreen(): ReactNode {
  const { history, jobs } = useAppState();
  const { setView, openResult, reveal, clearHistory } = useAppActions();
  const [confirming, setConfirming] = useState(false);

  const completed = history.filter((entry) => entry.status === 'completed').length;
  const failed = history.filter((entry) => entry.status === 'failed').length;

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">Arquivo</p>
          <h1>Histórico</h1>
          <p className="page-head__sub">
            As últimas {formatNumber(history.length)} exportações, com o estado real de cada uma. Os
            ficheiros ficam onde os guardou; limpar esta lista não os apaga.
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
            Limpar histórico
          </button>
        </div>
      </header>

      {confirming ? (
        <div className="notice" data-kind="warn" role="alert">
          <Trash2 size={17} aria-hidden="true" className="notice__icon notice__icon--warning" />
          <div className="notice__body">
            <div className="notice__title">Limpar todo o histórico?</div>
            <div className="notice__message">
              A lista desaparece desta aplicação. Os ficheiros já exportados continuam nas respectivas
              pastas.
            </div>
            <div className="notice__actions">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setConfirming(false);
                  void clearHistory();
                }}
              >
                Limpar lista
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => setConfirming(false)}>
                Cancelar
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
            <h2>Ainda não há exportações</h2>
            <p>O primeiro vídeo que exportar aparece aqui, com a duração, o tamanho e a validação reais.</p>
          </div>
          <div className="empty__actions">
            <button type="button" className="btn btn--primary" onClick={() => setView('studio')}>
              Ir para o estúdio
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : (
        <section className="panel" aria-labelledby="history-title">
          <div className="panel__head">
            <h2 id="history-title">Exportações</h2>
            <span className="chip">{formatNumber(completed)} concluídas</span>
            {failed > 0 ? <span className="chip chip--error">{formatNumber(failed)} falhadas</span> : null}
            <span className="spacer" />
            <span className="panel__hint">Guardadas neste computador</span>
          </div>
          <div className="panel__body panel__body--table">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Projeto</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Imagem</th>
                  <th scope="col" className="num">
                    Duração
                  </th>
                  <th scope="col" className="num">
                    Tamanho
                  </th>
                  <th scope="col">Data</th>
                  <th scope="col" aria-label="Acções" />
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
                          title={entry.error?.detail ?? entry.error?.message}
                        >
                          {STATUS_LABELS[entry.status]}
                        </span>
                      </td>
                      <td className="mono tnum">{formatResolution(entry.width, entry.height)}</td>
                      <td className="num tnum">{entry.durationSeconds > 0 ? formatSeconds(entry.durationSeconds) : '—'}</td>
                      <td className="num tnum">{entry.sizeBytes > 0 ? formatBytes(entry.sizeBytes) : '—'}</td>
                      <td className="tnum">{formatDateTime(entry.startedAt)}</td>
                      <td>
                        <div className="row-actions">
                          {canOpen ? (
                            <>
                              <button
                                type="button"
                                className="btn btn--quiet"
                                onClick={() => openResult(entry.id)}
                                title={job ? 'Abrir o resultado completo' : 'Reproduzir o ficheiro guardado'}
                              >
                                Abrir
                              </button>
                              <button
                                type="button"
                                className="btn btn--quiet btn--icon"
                                onClick={() => void reveal(entry.outputPath)}
                                aria-label={`Mostrar ${entry.fileName} no Explorador`}
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
