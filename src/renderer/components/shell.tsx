import type { ReactNode } from 'react';
import {
  FileArchive,
  FileCode2,
  Film,
  History,
  Settings2,
  Upload,
} from 'lucide-react';
import { formatBytes, formatNumber, pluralize } from '@shared/format';
import { KIND_LABELS, VIEW_LABELS } from '../lib/labels';
import { useAppActions, useAppState } from '../lib/store';
import { Mark, Spinner } from './ui';

function engineLabel(ready: boolean | undefined, engineAvailable: boolean): string {
  if (engineAvailable === false) return 'Motor indisponível';
  if (ready === undefined) return 'A verificar o motor';
  return ready ? 'Motor pronto' : 'Motor incompleto';
}

export function Titlebar(): ReactNode {
  const { project, view, engine, appVersion } = useAppState();
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
            <span>{VIEW_LABELS[view] ?? 'Estúdio'}</span>
          </>
        ) : (
          <span>{VIEW_LABELS[view] ?? 'Estúdio'}</span>
        )}
      </div>
      <span className="titlebar__spacer" />
      <div className="titlebar__meta">
        <span className="titlebar__version mono" title="Versão do Biframe">
          v{appVersion}
        </span>
        <span
          className="engine-dot"
          data-state={state}
          title={engine?.ffmpeg.version ? `FFmpeg ${engine.ffmpeg.version}` : 'A verificar os binários do motor'}
        >
          {ready === undefined ? <Spinner size={12} /> : null}
          {engineLabel(ready, engineAvailable)}
        </span>
      </div>
    </header>
  );
}

export function Rail(): ReactNode {
  const { project, view, importBusy, history } = useAppState();
  const { setView, importHtml, importZip, closeProject } = useAppActions();
  const studioCurrent = view === 'studio' || view === 'result';

  return (
    <nav className="rail" aria-label="Navegação principal">
      <div className="rail__label">ESPAÇO DE TRABALHO</div>
      <button
        type="button"
        className="rail__item"
        aria-current={studioCurrent ? 'page' : undefined}
        onClick={() => setView('studio')}
      >
        <Film aria-hidden="true" />
        <span>Estúdio</span>
      </button>
      <button
        type="button"
        className="rail__item"
        aria-current={view === 'history' ? 'page' : undefined}
        onClick={() => setView('history')}
      >
        <History aria-hidden="true" />
        <span>Histórico</span>
        {history.length > 0 ? <span className="rail__count tnum">{formatNumber(history.length)}</span> : null}
      </button>
      <button
        type="button"
        className="rail__item"
        aria-current={view === 'settings' ? 'page' : undefined}
        onClick={() => setView('settings')}
      >
        <Settings2 aria-hidden="true" />
        <span>Definições</span>
      </button>

      <div className="rail__spacer" />

      <div className="rail__project">
        {project ? (
          <>
            <span className="rail__project-label">Projeto aberto</span>
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
                {formatNumber(project.htmlFileCount + project.assetCount)} {pluralize(project.htmlFileCount + project.assetCount, 'ficheiro', 'ficheiros')}
              </span>
            </div>
            <div className="rail__project-actions">
              <button type="button" className="btn btn--quiet" onClick={() => void importHtml()} disabled={importBusy}>
                <Upload size={14} aria-hidden="true" />
                Substituir
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => void closeProject()} disabled={importBusy}>
                Fechar
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="rail__project-name">Nenhum projeto</span>
            <span className="rail__project-hint">Importe uma página para começar.</span>
            <div className="rail__project-actions rail__project-actions--stack">
              <button type="button" className="btn btn--quiet" onClick={() => void importHtml()} disabled={importBusy}>
                <FileCode2 size={14} aria-hidden="true" />
                Importar HTML
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => void importZip()} disabled={importBusy}>
                <FileArchive size={14} aria-hidden="true" />
                Importar ZIP
              </button>
            </div>
          </>
        )}
      </div>

      <div className="rail__foot">
        <span>Desde a web até ao vídeo.</span>
        <span className="mono">MIT · open source</span>
      </div>
    </nav>
  );
}
