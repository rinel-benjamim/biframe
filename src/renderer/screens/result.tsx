import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  RotateCw,
} from 'lucide-react';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatResolution,
  formatSeconds,
  pluralize,
} from '@shared/format';
import type { HistoryEntry, RenderJob, ValidationCheck } from '@shared/types';
import { outputUrl, posterUrl, STATUS_LABELS } from '../lib/labels';
import { useAppActions, useAppState } from '../lib/store';
import { CheckList, DiagnosticList, Notice } from '../components/ui';

const POSTER_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  vp9: 'VP9',
  av1: 'AV1',
};

function codecLabel(codec: string): string {
  return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

function splitOutputPath(fullPath: string): { directory: string; fileName: string } {
  const separator = Math.max(fullPath.lastIndexOf('\\'), fullPath.lastIndexOf('/'));
  if (separator < 0) return { directory: '', fileName: fullPath };
  return {
    directory: fullPath.slice(0, separator),
    fileName: fullPath.slice(separator + 1),
  };
}

function validationTone(checks: ValidationCheck[]): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (checks.some((check) => check.status === 'fail')) return { label: 'Com falhas', tone: 'bad' };
  if (checks.some((check) => check.status === 'warn')) return { label: 'Aprovado com avisos', tone: 'warn' };
  return { label: 'Aprovado', tone: 'ok' };
}

function bitrateLabel(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—';
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1).replace('.', ',')} Mb/s`;
  return `${formatNumber(Math.round(bitsPerSecond / 1000))} kb/s`;
}

function ResultMeta({ job, entry }: { job?: RenderJob; entry?: HistoryEntry }): ReactNode {
  const metadata = job?.result?.metadata;
  const width = metadata?.width ?? entry?.width ?? job?.settings.width ?? 0;
  const height = metadata?.height ?? entry?.height ?? job?.settings.height ?? 0;
  const duration = metadata?.durationSeconds ?? entry?.durationSeconds ?? 0;
  const fps = metadata?.fps ?? entry?.fps ?? job?.settings.fps ?? 0;
  const size = job?.result?.sizeBytes ?? entry?.sizeBytes ?? 0;

  return (
    <dl className="result__meta">
      <div className="meta">
        <dt className="meta__label">Tamanho</dt>
        <dd className="meta__value tnum">{formatBytes(size)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">Duração</dt>
        <dd className="meta__value tnum">{formatSeconds(duration)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">Imagem</dt>
        <dd className="meta__value tnum">{formatResolution(width, height)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">Movimento</dt>
        <dd className="meta__value tnum">
          {fps} <small>fps</small>
        </dd>
      </div>
      <div className="meta">
        <dt className="meta__label">Código</dt>
        <dd className="meta__value mono meta__value--code">
          <span>{metadata ? codecLabel(metadata.codec) : 'H.264'}</span>
          {metadata && (metadata.profile || metadata.pixFmt) ? (
            <small>{[metadata.profile, metadata.pixFmt].filter(Boolean).join(' · ')}</small>
          ) : null}
        </dd>
      </div>
      <div className="meta">
        <dt className="meta__label">Débito</dt>
        <dd className="meta__value tnum">{metadata ? bitrateLabel(metadata.bitrate) : '—'}</dd>
      </div>
    </dl>
  );
}

export function ResultScreen(): ReactNode {
  const { selectedResultId, jobs, history } = useAppState();
  const { backToStudio, reveal, open } = useAppActions();
  const [videoError, setVideoError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const id = selectedResultId;
  const job = id ? jobs.find((candidate) => candidate.id === id) : undefined;
  const entry = id && !job?.result ? history.find((candidate) => candidate.id === id) : undefined;

  useEffect(() => {
    setVideoError(false);
    setAttempt(0);
  }, [id]);

  if (!id || (!job && !entry)) {
    return (
      <>
        <header className="page-head">
          <div className="page-head__text">
            <p className="eyebrow">Resultado</p>
            <h1>Nenhum resultado selecionado</h1>
            <p className="page-head__sub">Escolha uma exportação no histórico ou crie um novo vídeo no estúdio.</p>
          </div>
          <div className="page-head__actions">
            <button type="button" className="btn" onClick={backToStudio}>
              <ArrowLeft size={15} aria-hidden="true" />
              Voltar ao estúdio
            </button>
          </div>
        </header>
      </>
    );
  }

  const result = job?.result;
  const outputPath = result?.outputPath ?? entry?.outputPath ?? '';
  const outputLocation = splitOutputPath(outputPath);
  const fileName = result?.fileName ?? entry?.fileName ?? job?.settings.fileName ?? 'vídeo.mp4';
  const projectName = job?.projectName ?? entry?.projectName ?? 'Projeto';
  const finishedAt = result?.finishedAt ?? entry?.finishedAt ?? job?.finishedAt ?? entry?.startedAt ?? Date.now();
  const status = job?.status ?? entry?.status ?? 'completed';
  const playable = status === 'completed' && outputPath.length > 0;
  const posters = result?.posterFrames ?? [];
  const validation = result?.validation;
  const tone = validation ? validationTone(validation.checks) : null;
  const diagnostics = result?.diagnostics ?? (entry?.error ? [] : []);
  const error = job?.error ?? entry?.error;

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">Resultado</p>
          <h1>{playable ? 'Vídeo pronto.' : STATUS_LABELS[status]}</h1>
          <p className="page-head__sub">
            <span className="mono">{fileName}</span>
            <span className="page-head__sep" aria-hidden="true">·</span>
            {projectName}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatDateTime(finishedAt)}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn--quiet" onClick={backToStudio}>
            <ArrowLeft size={15} aria-hidden="true" />
            Estúdio
          </button>
          {playable ? (
            <>
              <button type="button" className="btn" onClick={() => void open(outputPath)}>
                <ExternalLink size={15} aria-hidden="true" />
                Abrir vídeo
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void reveal(outputPath)}>
                <FolderOpen size={15} aria-hidden="true" />
                Mostrar no Explorador
              </button>
            </>
          ) : null}
        </div>
      </header>

      {!playable ? (
        <Notice
          notice={{
            id: 0,
            kind: status === 'cancelled' ? 'info' : 'error',
            title: status === 'cancelled' ? 'Esta exportação foi cancelada' : 'Esta exportação não produziu um vídeo',
            message: error?.title ?? STATUS_LABELS[status],
            detail: error?.detail ?? error?.message,
          }}
        />
      ) : null}

      <div className="result">
        <div className="result__layout">
          <div className="player">
            {playable && !videoError ? (
              <video
                key={`${id}-${attempt}`}
                controls
                playsInline
                preload="metadata"
                poster={posters[0] ? posterUrl(id, 0) : undefined}
                src={outputUrl(id)}
                onError={() => setVideoError(true)}
              >
                O seu navegador não consegue reproduzir este vídeo.
              </video>
            ) : playable ? (
              <div className="player__fallback">
                <AlertTriangle size={22} aria-hidden="true" />
                <strong>Não foi possível reproduzir o vídeo aqui</strong>
                <p>O ficheiro existe, mas o leitor incorporado não o conseguiu abrir. Use o leitor do sistema.</p>
                <div className="player__fallback-actions">
                  <button type="button" className="btn" onClick={() => void open(outputPath)}>
                    <ExternalLink size={14} aria-hidden="true" />
                    Abrir no leitor do sistema
                  </button>
                  <button
                    type="button"
                    className="btn btn--quiet"
                    onClick={() => {
                      setVideoError(false);
                      setAttempt((value) => value + 1);
                    }}
                  >
                    <RotateCw size={14} aria-hidden="true" />
                    Tentar novamente
                  </button>
                </div>
              </div>
            ) : (
              <div className="player__fallback">
                <AlertTriangle size={22} aria-hidden="true" />
                <strong>Sem vídeo para reproduzir</strong>
                <p>{STATUS_LABELS[status]} · {formatDateTime(finishedAt)}</p>
              </div>
            )}
          </div>

          <aside className="panel result__side" aria-labelledby="result-meta-title">
            <div className="panel__head">
              <h2 id="result-meta-title">Ficha de saída</h2>
              <span className="spacer" />
              {tone ? <span className="chip" data-tone={tone.tone}>{tone.label}</span> : <span className="chip">{STATUS_LABELS[status]}</span>}
            </div>
            <div className="panel__body">
              <ResultMeta job={job} entry={entry} />
              <div className="file-path">
                <span className="file-path__label">Ficheiro</span>
                <span className="file-path__value file-path__value--name mono" title={outputPath}>
                  {outputLocation.fileName || '—'}
                </span>
                <span className="file-path__value file-path__value--dir mono" title={outputPath}>
                  {outputLocation.directory || '—'}
                </span>
              </div>
            </div>
          </aside>
        </div>

        {posters.length > 0 ? (
          <section className="panel" aria-labelledby="filmstrip-title">
            <div className="panel__head">
              <h2 id="filmstrip-title">Frames do vídeo</h2>
              <span className="chip mono">{posters.length} amostras</span>
              <span className="spacer" />
              <span className="panel__hint">extraídos do MP4 final</span>
            </div>
            <div className="panel__body">
              <div className="filmstrip">
                {posters.map((poster, index) => (
                  <figure key={poster}>
                    <img
                      src={posterUrl(id, index)}
                      alt={`Frame a ${formatSeconds((result?.metadata.durationSeconds ?? 0) * (POSTER_FRACTIONS[index] ?? 0.5))}`}
                      loading="lazy"
                    />
                    <figcaption>
                      {formatSeconds((result?.metadata.durationSeconds ?? 0) * (POSTER_FRACTIONS[index] ?? 0.5))}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <div className="result__layout result__layout--lower">
          <section className="panel" aria-labelledby="validation-title">
            <div className="panel__head">
              <h2 id="validation-title">Validação</h2>
              {validation ? (
                <span className="chip" data-tone={tone?.tone ?? 'muted'}>
                  {validation.checks.filter((check) => check.status === 'pass').length} de {validation.checks.length}{' '}
                  verificações
                </span>
              ) : null}
            </div>
            <div className="panel__body panel__body--tight">
              {validation ? (
                <CheckList checks={validation.checks} />
              ) : (
                <p className="calm">
                  A validação detalhada só está disponível para exportações feitas nesta sessão. O ficheiro
                  continua acessível a partir do histórico.
                </p>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="result-diagnostics-title">
            <div className="panel__head">
              <h2 id="result-diagnostics-title">Diagnóstico</h2>
              <span className="spacer" />
              {diagnostics.length > 0 ? (
                <span className="chip">
                  {diagnostics.length} {pluralize(diagnostics.length, 'nota', 'notas')}
                </span>
              ) : null}
            </div>
            {diagnostics.length > 0 ? (
              <DiagnosticList diagnostics={diagnostics} />
            ) : (
              <div className="panel__body panel__body--tight">
                <p className="calm">Sem avisos registados durante a captura e a codificação.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
