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
import { KIND_LABELS, projectEntryName, STATUS_LABELS } from '../lib/labels';
import { useAppActions, useAppState, useProjectDiagnostics } from '../lib/store';
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
  const recent = history.slice(0, 3);

  return (
    <div className="empty">
      <div className="empty__mark">
        <Mark size={46} />
      </div>
      <div className="empty__lead">
        <h2>Importe uma página para começar</h2>
        <p>
          O Biframe abre a página num Chromium controlado, captura cada frame no instante certo e entrega um
          MP4 validado. O ficheiro original nunca é alterado.
        </p>
      </div>
      <div className="empty__actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={() => void importHtml()} disabled={importBusy}>
          {importBusy ? <Spinner size={15} /> : <FileCode2 size={16} aria-hidden="true" />}
          Importar HTML
        </button>
        <button type="button" className="btn btn--lg" onClick={() => void importZip()} disabled={importBusy}>
          <FileArchive size={16} aria-hidden="true" />
          Importar ZIP
        </button>
        {exampleAvailable ? (
          <button type="button" className="btn btn--quiet btn--lg" onClick={() => void loadExample()} disabled={importBusy}>
            <Wand2 size={16} aria-hidden="true" />
            Abrir exemplo
          </button>
        ) : null}
      </div>
      <p className="empty__hint">Também pode arrastar um ficheiro .html, .htm ou .zip para esta janela.</p>

      {recent.length > 0 ? (
        <div className="recent">
          <div className="recent__title">Exportações recentes</div>
          {recent.map((entry) => (
            <div className="recent__row" key={entry.id}>
              <span className="status-mark" data-status={entry.status} aria-hidden="true" />
              <span className="recent__name">{entry.projectName}</span>
              <span className="recent__file mono">{entry.fileName}</span>
              <span className="spacer" />
              <span className="recent__meta tnum">{formatRelative(entry.startedAt)}</span>
              <span className="recent__meta tnum">{formatBytes(entry.sizeBytes)}</span>
              {entry.status === 'completed' ? (
                <>
                  <button type="button" className="btn btn--quiet" onClick={() => openResult(entry.id)}>
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
                <span className="recent__status">{STATUS_LABELS[entry.status]}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <ol className="steps" aria-label="Como funciona">
        <li>
          <span className="steps__num mono">01</span>
          <strong>Importe</strong>
          <span>Uma página HTML ou um projeto ZIP completo.</span>
        </li>
        <li>
          <span className="steps__num mono">02</span>
          <strong>Enquadre</strong>
          <span>Escolha resolução, movimento e duração real.</span>
        </li>
        <li>
          <span className="steps__num mono">03</span>
          <strong>Exporte</strong>
          <span>MP4 H.264 validado, pronto para publicar.</span>
        </li>
      </ol>
    </div>
  );
}

export function StudioScreen(): ReactNode {
  const { project, preview, jobs, importBusy } = useAppState();
  const { importHtml, closeProject, clearPreviewDiagnostics } = useAppActions();
  const diagnostics = useProjectDiagnostics();
  const activeJob = jobs.find((job) => job.status === 'running') ?? null;
  const running = Boolean(activeJob);

  if (!project) {
    return (
      <>
        <header className="page-head">
          <div className="page-head__text">
            <p className="eyebrow">Estúdio</p>
            <h1>Da web para vídeo.</h1>
            <p className="page-head__sub">
              Páginas que se movem, exportadas como vídeo. Sem gravação de ecrã, sem pós-produção — o frame
              certo, no instante certo.
            </p>
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
          <p className="eyebrow">Estúdio</p>
          <h1 title={project.name}>{project.name}</h1>
          <p className="page-head__sub">
            <span className="mono">{projectEntryName(project)}</span>
            <span className="page-head__sep" aria-hidden="true">·</span>
            {KIND_LABELS[project.kind]}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatBytes(project.sizeBytes)}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatNumber(fileCount)} {pluralize(fileCount, 'ficheiro', 'ficheiros')}
            {remoteCount > 0 ? (
              <>
                <span className="page-head__sep" aria-hidden="true">·</span>
                {remoteCount} {pluralize(remoteCount, 'anfitrião externo', 'anfitriões externos')}
              </>
            ) : (
              <>
                <span className="page-head__sep" aria-hidden="true">·</span>
                offline
              </>
            )}
            <span className="page-head__sep" aria-hidden="true">·</span>
            importado {formatRelative(project.importedAt)}
          </p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void importHtml()}
            disabled={running || importBusy}
            title={running ? 'Uma renderização está em curso' : 'Importar outro ficheiro HTML'}
          >
            <Upload size={15} aria-hidden="true" />
            Substituir
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void closeProject()}
            disabled={running || importBusy}
            title={running ? 'Uma renderização está em curso' : 'Fechar o projeto'}
          >
            <X size={15} aria-hidden="true" />
            Fechar
          </button>
        </div>
      </header>

      <div className="studio">
        <div className="studio__left">
          <PreviewStage activeJob={activeJob} />

          <section className="panel" aria-labelledby="diagnostics-title">
            <div className="panel__head">
              <h2 id="diagnostics-title">Diagnóstico</h2>
              <DiagnosticSummary diagnostics={diagnostics} />
              <span className="spacer" />
              {preview.diagnostics.length > 0 ? (
                <button type="button" className="btn btn--quiet" onClick={() => void clearPreviewDiagnostics()}>
                  Limpar
                </button>
              ) : null}
            </div>
            {diagnostics.length > 0 ? (
              <DiagnosticList diagnostics={diagnostics} />
            ) : (
              <div className="panel__body panel__body--tight">
                <p className="calm">
                  Sem avisos. A página carregou sem erros assinaláveis; o diagnóstico de cada exportação
                  aparece no resultado.
                </p>
              </div>
            )}
          </section>

          <p className="studio__note">
            <ArrowRight size={13} aria-hidden="true" />
            A pré-visualização usa o mesmo viewport da exportação. O que vê é o que o codificador recebe.
          </p>
        </div>

        <div className="studio__right">
          <ExportPanel />
        </div>
      </div>
    </>
  );
}
