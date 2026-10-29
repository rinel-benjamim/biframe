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
import type { Language, Translator } from '@shared/i18n';
import type { HistoryEntry, RenderJob, ValidationCheck } from '@shared/types';
import { outputUrl, posterUrl, statusLabel } from '../lib/labels';
import {
  localizedErrorMessage,
  localizedErrorTitle,
  useAppActions,
  useAppState,
  useLanguage,
  useT,
} from '../lib/store';
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

function validationTone(checks: ValidationCheck[], t: Translator): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (checks.some((check) => check.status === 'fail')) return { label: t('ui.result.validation.failed'), tone: 'bad' };
  if (checks.some((check) => check.status === 'warn')) return { label: t('ui.result.validation.warn'), tone: 'warn' };
  return { label: t('ui.result.validation.ok'), tone: 'ok' };
}

function bitrateLabel(bitsPerSecond: number, language: Language): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—';
  if (bitsPerSecond >= 1_000_000) {
    return `${(bitsPerSecond / 1_000_000).toFixed(1).replace('.', language === 'en' ? '.' : ',')} Mb/s`;
  }
  return `${formatNumber(Math.round(bitsPerSecond / 1000), 0, language)} kb/s`;
}

function ResultMeta({ job, entry }: { job?: RenderJob; entry?: HistoryEntry }): ReactNode {
  const t = useT();
  const language = useLanguage();
  const metadata = job?.result?.metadata;
  const width = metadata?.width ?? entry?.width ?? job?.settings.width ?? 0;
  const height = metadata?.height ?? entry?.height ?? job?.settings.height ?? 0;
  const duration = metadata?.durationSeconds ?? entry?.durationSeconds ?? 0;
  const fps = metadata?.fps ?? entry?.fps ?? job?.settings.fps ?? 0;
  const size = job?.result?.sizeBytes ?? entry?.sizeBytes ?? 0;

  return (
    <dl className="result__meta">
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.size')}</dt>
        <dd className="meta__value tnum">{formatBytes(size)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.duration')}</dt>
        <dd className="meta__value tnum">{formatSeconds(duration, language)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.image')}</dt>
        <dd className="meta__value tnum">{formatResolution(width, height)}</dd>
      </div>
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.motion')}</dt>
        <dd className="meta__value tnum">
          {fps} <small>fps</small>
        </dd>
      </div>
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.codec')}</dt>
        <dd className="meta__value mono meta__value--code">
          <span>{metadata ? codecLabel(metadata.codec) : 'H.264'}</span>
          {metadata && (metadata.profile || metadata.pixFmt) ? (
            <small>{[metadata.profile, metadata.pixFmt].filter(Boolean).join(' · ')}</small>
          ) : null}
        </dd>
      </div>
      <div className="meta">
        <dt className="meta__label">{t('ui.meta.bitrate')}</dt>
        <dd className="meta__value tnum">{metadata ? bitrateLabel(metadata.bitrate, language) : '—'}</dd>
      </div>
    </dl>
  );
}

export function ResultScreen(): ReactNode {
  const { selectedResultId, jobs, history } = useAppState();
  const { backToStudio, reveal, open } = useAppActions();
  const t = useT();
  const language = useLanguage();
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
            <p className="eyebrow">{t('ui.view.result')}</p>
            <h1>{t('ui.result.noneTitle')}</h1>
            <p className="page-head__sub">{t('ui.result.noneSub')}</p>
          </div>
          <div className="page-head__actions">
            <button type="button" className="btn" onClick={backToStudio}>
              <ArrowLeft size={15} aria-hidden="true" />
              {t('ui.result.backToStudio')}
            </button>
          </div>
        </header>
      </>
    );
  }

  const result = job?.result;
  const outputPath = result?.outputPath ?? entry?.outputPath ?? '';
  const outputLocation = splitOutputPath(outputPath);
  const fileName = result?.fileName ?? entry?.fileName ?? job?.settings.fileName ?? t('ui.result.fallbackFileName');
  const projectName = job?.projectName ?? entry?.projectName ?? t('ui.result.fallbackProjectName');
  const finishedAt = result?.finishedAt ?? entry?.finishedAt ?? job?.finishedAt ?? entry?.startedAt ?? Date.now();
  const status = job?.status ?? entry?.status ?? 'completed';
  const playable = status === 'completed' && outputPath.length > 0;
  const posters = result?.posterFrames ?? [];
  const validation = result?.validation;
  const tone = validation ? validationTone(validation.checks, t) : null;
  const diagnostics = result?.diagnostics ?? (entry?.error ? [] : []);
  const error = job?.error ?? entry?.error;

  return (
    <>
      <header className="page-head">
        <div className="page-head__text">
          <p className="eyebrow">{t('ui.view.result')}</p>
          <h1>{playable ? t('ui.result.readyTitle') : statusLabel(status, t)}</h1>
          <p className="page-head__sub">
            <span className="mono">{fileName}</span>
            <span className="page-head__sep" aria-hidden="true">·</span>
            {projectName}
            <span className="page-head__sep" aria-hidden="true">·</span>
            {formatDateTime(finishedAt, language)}
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn--quiet" onClick={backToStudio}>
            <ArrowLeft size={15} aria-hidden="true" />
            {t('ui.view.studio')}
          </button>
          {playable ? (
            <>
              <button type="button" className="btn" onClick={() => void open(outputPath)}>
                <ExternalLink size={15} aria-hidden="true" />
                {t('ui.result.openVideo')}
              </button>
              <button type="button" className="btn btn--primary" onClick={() => void reveal(outputPath)}>
                <FolderOpen size={15} aria-hidden="true" />
                {t('ui.result.reveal')}
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
            title:
              status === 'cancelled'
                ? t('ui.result.cancelledNotice.title')
                : t('ui.result.failedNotice.title'),
            message: error ? localizedErrorTitle(error, t) : statusLabel(status, t),
            detail: error ? error.detail ?? localizedErrorMessage(error, t) : undefined,
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
                {t('ui.result.videoUnsupported')}
              </video>
            ) : playable ? (
              <div className="player__fallback">
                <AlertTriangle size={22} aria-hidden="true" />
                <strong>{t('ui.result.playbackFailedTitle')}</strong>
                <p>{t('ui.result.playbackFailedText')}</p>
                <div className="player__fallback-actions">
                  <button type="button" className="btn" onClick={() => void open(outputPath)}>
                    <ExternalLink size={14} aria-hidden="true" />
                    {t('ui.result.openSystemPlayer')}
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
                    {t('ui.action.retry')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="player__fallback">
                <AlertTriangle size={22} aria-hidden="true" />
                <strong>{t('ui.result.noVideoTitle')}</strong>
                <p>
                  {statusLabel(status, t)} · {formatDateTime(finishedAt, language)}
                </p>
              </div>
            )}
          </div>

          <aside className="panel result__side" aria-labelledby="result-meta-title">
            <div className="panel__head">
              <h2 id="result-meta-title">{t('ui.result.outputSheet')}</h2>
              <span className="spacer" />
              {tone ? (
                <span className="chip" data-tone={tone.tone}>{tone.label}</span>
              ) : (
                <span className="chip">{statusLabel(status, t)}</span>
              )}
            </div>
            <div className="panel__body">
              <ResultMeta job={job} entry={entry} />
              <div className="file-path">
                <span className="file-path__label">{t('ui.result.fileLabel')}</span>
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
              <h2 id="filmstrip-title">{t('ui.result.filmstripTitle')}</h2>
              <span className="chip mono">
                {t('ui.result.samples', { count: posters.length })}
              </span>
              <span className="spacer" />
              <span className="panel__hint">{t('ui.result.samplesHint')}</span>
            </div>
            <div className="panel__body">
              <div className="filmstrip">
                {posters.map((poster, index) => (
                  <figure key={poster}>
                    <img
                      src={posterUrl(id, index)}
                      alt={t('ui.result.frameAlt', {
                        time: formatSeconds(
                          (result?.metadata.durationSeconds ?? 0) * (POSTER_FRACTIONS[index] ?? 0.5),
                          language,
                        ),
                      })}
                      loading="lazy"
                    />
                    <figcaption>
                      {formatSeconds(
                        (result?.metadata.durationSeconds ?? 0) * (POSTER_FRACTIONS[index] ?? 0.5),
                        language,
                      )}
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
              <h2 id="validation-title">{t('ui.result.validationTitle')}</h2>
              {validation ? (
                <span className="chip" data-tone={tone?.tone ?? 'muted'}>
                  {t('ui.result.validationCount', {
                    passed: validation.checks.filter((check) => check.status === 'pass').length,
                    total: validation.checks.length,
                  })}
                </span>
              ) : null}
            </div>
            <div className="panel__body panel__body--tight">
              {validation ? (
                <CheckList checks={validation.checks} />
              ) : (
                <p className="calm">{t('ui.result.validationUnavailable')}</p>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="result-diagnostics-title">
            <div className="panel__head">
              <h2 id="result-diagnostics-title">{t('ui.diagnostics.title')}</h2>
              <span className="spacer" />
              {diagnostics.length > 0 ? (
                <span className="chip">
                  {diagnostics.length}{' '}
                  {pluralize(diagnostics.length, t('ui.diagnostics.note.one'), t('ui.diagnostics.note.many'))}
                </span>
              ) : null}
            </div>
            {diagnostics.length > 0 ? (
              <DiagnosticList diagnostics={diagnostics} />
            ) : (
              <div className="panel__body panel__body--tight">
                <p className="calm">{t('ui.diagnostics.emptyResult')}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
