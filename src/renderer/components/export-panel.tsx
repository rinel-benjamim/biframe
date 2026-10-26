import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  ArrowRight,
  FolderOpen,
  Play,
  X,
} from 'lucide-react';
import { formatBytes, formatNumber, formatSeconds, sanitizeFileName, ensureExtension } from '@shared/format';
import {
  FPS_OPTIONS,
  QUALITY_PRESETS,
  RESOLUTION_PRESETS,
  estimateOutputBytes,
  findResolutionPreset,
  isValidFrameSize,
  MAX_DURATION_SECONDS,
  MAX_DIMENSION,
  MIN_DIMENSION,
  MIN_DURATION_SECONDS,
} from '@shared/presets';
import type { RenderSettings, SerializedError } from '@shared/types';
import { useAppActions, useAppState } from '../lib/store';
import { Notice, ProgressBlock } from './ui';

interface DraftIssues {
  fileName?: string;
  outputDir?: string;
  size?: string;
  duration?: string;
}

function validateDraft(draft: RenderSettings, maxDuration: number): DraftIssues {
  const issues: DraftIssues = {};
  if (draft.fileName.trim().length === 0) {
    issues.fileName = 'Dê um nome ao ficheiro.';
  } else if (draft.fileName.trim().length > 160) {
    issues.fileName = 'O nome não pode exceder 160 caracteres.';
  }
  if (draft.outputDir.trim().length === 0) {
    issues.outputDir = 'Escolha a pasta onde o vídeo será guardado.';
  }
  if (!isValidFrameSize(draft.width, draft.height)) {
    issues.size =
      `Use dimensões pares entre ${MIN_DIMENSION} e ${MAX_DIMENSION} px. O H.264 4:2:0 exige largura e altura pares.`;
  }
  const seconds = draft.duration.mode === 'manual' ? draft.duration.seconds : draft.duration.maxSeconds;
  if (!Number.isFinite(seconds) || seconds < MIN_DURATION_SECONDS || seconds > Math.min(MAX_DURATION_SECONDS, maxDuration)) {
    issues.duration =
      draft.duration.mode === 'manual'
        ? `A duração tem de estar entre ${MIN_DURATION_SECONDS} s e ${Math.min(MAX_DURATION_SECONDS, maxDuration)} s.`
        : `O limite tem de estar entre 1 s e ${Math.min(MAX_DURATION_SECONDS, maxDuration)} s.`;
  }
  return issues;
}

function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
}): ReactNode {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <input
      id={id}
      className="input input--number tnum"
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step ?? 1}
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const parsed = Number(next);
        if (next.trim().length > 0 && Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        const parsed = Number(text);
        if (text.trim().length === 0 || !Number.isFinite(parsed)) {
          setText(String(value));
        } else {
          setText(String(parsed));
        }
      }}
    />
  );
}

export function ExportPanel(): ReactNode {
  const { draft, settings, engine, jobs, exportRequest } = useAppState();
  const {
    updateDraft,
    pickOutputDir,
    startRender,
    cancelRender,
    consumeExportRequest,
    notify,
  } = useAppActions();
  const [conflict, setConflict] = useState<{ settings: RenderSettings; error: SerializedError } | null>(null);
  const [renderError, setRenderError] = useState<SerializedError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const handledRequest = useRef(0);

  const activeJob = jobs.find((job) => job.status === 'running') ?? null;
  const running = Boolean(activeJob);

  useEffect(() => {
    if (!running) setCancelling(false);
  }, [running]);

  const normalize = (source: RenderSettings): RenderSettings => ({
    ...source,
    fileName: ensureExtension(sanitizeFileName(source.fileName), '.mp4'),
    outputDir: source.outputDir.trim(),
  });

  async function handleExport(overwrite: boolean, override?: RenderSettings): Promise<void> {
    if (!draft) return;
    if (running) {
      notify({ kind: 'info', title: 'Já existe uma exportação em curso', message: 'Cancele-a antes de iniciar outra.' });
      return;
    }
    setConflict(null);
    setRenderError(null);
    const normalized = normalize(override ?? draft);
    const failure = await startRender(normalized, overwrite);
    if (!failure) return;
    if (failure.code === 'OUTPUT_EXISTS') {
      setConflict({ settings: normalized, error: failure });
    } else {
      setRenderError(failure);
    }
  }

  useEffect(() => {
    if (exportRequest === 0 || handledRequest.current === exportRequest) return;
    handledRequest.current = exportRequest;
    consumeExportRequest();
    void handleExport(false);
    // The request counter is the trigger; the latest render state is read above.
  }, [exportRequest]);

  if (!draft || !settings) return null;

  const maxDuration = Math.min(MAX_DURATION_SECONDS, settings.limits.maxDurationSeconds);
  const issues = validateDraft(draft, maxDuration);
  const valid = Object.keys(issues).length === 0;
  const preset = findResolutionPreset(draft.width, draft.height);
  const presetValue = preset?.id ?? 'custom';
  const seconds = draft.duration.mode === 'manual' ? draft.duration.seconds : draft.duration.maxSeconds;
  const frames = Math.round((Number.isFinite(seconds) ? seconds : 0) * draft.fps);
  const estimate = estimateOutputBytes(draft.width, draft.height, draft.fps, Math.max(0.1, seconds), draft.quality);
  const engineReady = Boolean(engine?.ready);

  const update = (patch: Partial<RenderSettings>): void => {
    setConflict(null);
    setRenderError(null);
    updateDraft(patch);
  };

  return (
    <section className="panel export" aria-labelledby="export-title">
      <div className="panel__head">
        <h2 id="export-title">Exportar</h2>
        <span className="spacer" />
        <span className="chip mono">MP4 · H.264</span>
      </div>

      <div className="panel__body">
        {activeJob ? (
          <div className="export__progress">
            <ProgressBlock
              progress={activeJob.progress}
              onCancel={() => {
                setCancelling(true);
                void cancelRender(activeJob.id);
              }}
              cancelling={cancelling}
            />
          </div>
        ) : null}

        {!engineReady ? (
          <Notice
            notice={{
              id: 0,
              kind: 'warning',
              title: 'O motor de vídeo não está pronto',
              message: 'O FFmpeg ou o FFprobe não responderam. Verifique o estado em Definições.',
            }}
          />
        ) : null}

        {conflict ? (
          <div className="notice" data-kind="warn" role="alert">
            <AlertTriangle size={17} aria-hidden="true" className="notice__icon notice__icon--warning" />
            <div className="notice__body">
              <div className="notice__title">Já existe um ficheiro com este nome</div>
              <div className="notice__message">
                {conflict.settings.fileName} será substituído. Esta acção não pode ser desfeita.
              </div>
              <div className="notice__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleExport(true, conflict.settings)}
                >
                  Substituir ficheiro
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => setConflict(null)}>
                  Manter o nome
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {renderError ? (
          <div className="notice" data-kind="error" role="alert">
            <AlertTriangle size={17} aria-hidden="true" className="notice__icon notice__icon--error" />
            <div className="notice__body">
              <div className="notice__title">{renderError.title}</div>
              <div className="notice__message">{renderError.message}</div>
              {renderError.detail ? <div className="notice__detail">{renderError.detail}</div> : null}
            </div>
            <button
              type="button"
              className="btn btn--quiet btn--icon"
              onClick={() => setRenderError(null)}
              aria-label="Fechar erro"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <fieldset className="form" disabled={running}>
          <div className="field">
            <label className="field__label" htmlFor="export-file-name">
              Nome do ficheiro
            </label>
            <input
              id="export-file-name"
              className="input mono"
              value={draft.fileName}
              spellCheck={false}
              onChange={(event) => update({ fileName: event.currentTarget.value })}
              onBlur={(event) => update({ fileName: ensureExtension(sanitizeFileName(event.currentTarget.value), '.mp4') })}
              aria-invalid={Boolean(issues.fileName)}
            />
            {issues.fileName ? <span className="field__error">{issues.fileName}</span> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="export-output-dir">
              Pasta de destino
            </label>
            <div className="field__row">
              <input
                id="export-output-dir"
                className="input mono"
                value={draft.outputDir}
                spellCheck={false}
                onChange={(event) => update({ outputDir: event.currentTarget.value })}
                aria-invalid={Boolean(issues.outputDir)}
              />
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => {
                  void pickOutputDir().then((picked) => {
                    if (picked) update({ outputDir: picked });
                  });
                }}
                title="Escolher pasta"
                aria-label="Escolher pasta de destino"
              >
                <FolderOpen size={15} aria-hidden="true" />
              </button>
            </div>
            {issues.outputDir ? <span className="field__error">{issues.outputDir}</span> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="export-resolution">
              Resolução
              <span className="hint">a página é enquadrada e escalada</span>
            </label>
            <select
              id="export-resolution"
              className="select"
              value={presetValue}
              onChange={(event) => {
                const next = RESOLUTION_PRESETS.find((candidate) => candidate.id === event.currentTarget.value);
                if (next) update({ width: next.width, height: next.height });
              }}
            >
              {RESOLUTION_PRESETS.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.label} · {candidate.width} × {candidate.height}
                  {candidate.demanding ? ' — exigente' : ''}
                </option>
              ))}
              <option value="custom">Personalizado…</option>
            </select>
            {presetValue === 'custom' ? (
              <div className="grid-2 export__dimensions">
                <div className="field">
                  <label className="field__label" htmlFor="export-width">
                    Largura <span className="hint">px</span>
                  </label>
                  <NumberInput
                    id="export-width"
                    value={draft.width}
                    min={MIN_DIMENSION}
                    max={MAX_DIMENSION}
                    step={2}
                    onChange={(value) => update({ width: Math.round(value) })}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="export-height">
                    Altura <span className="hint">px</span>
                  </label>
                  <NumberInput
                    id="export-height"
                    value={draft.height}
                    min={MIN_DIMENSION}
                    max={MAX_DIMENSION}
                    step={2}
                    onChange={(value) => update({ height: Math.round(value) })}
                  />
                </div>
              </div>
            ) : (
              <span className="field__note mono">
                {draft.width} × {draft.height}
                {preset?.demanding ? ' · 4K e 1440p exigem mais memória e tempo' : ''}
              </span>
            )}
            {issues.size ? <span className="field__error">{issues.size}</span> : null}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="export-fps">
              Movimento
            </label>
            <select
              id="export-fps"
              className="select"
              value={draft.fps}
              onChange={(event) => update({ fps: Number(event.currentTarget.value) })}
            >
              {FPS_OPTIONS.map((fps) => (
                <option value={fps} key={fps}>
                  {fps} fps{fps === 60 ? ' — recomendado' : fps === 30 ? ' — compatibilidade' : ''}
                </option>
              ))}
            </select>
            <span className="field__note">
              60 fps acompanha o ecrã e mantém as transições tão fluidas como no navegador.
            </span>
          </div>

          <div className="field">
            <span className="field__label" id="duration-label">
              Duração
            </span>
            <div className="segmented" role="group" aria-labelledby="duration-label">
              <button
                type="button"
                aria-pressed={draft.duration.mode === 'manual'}
                onClick={() => update({ duration: { mode: 'manual', seconds: Math.min(10, maxDuration) } })}
              >
                Manual
              </button>
              <button
                type="button"
                aria-pressed={draft.duration.mode === 'auto'}
                onClick={() => update({ duration: { mode: 'auto', maxSeconds: Math.min(60, maxDuration) } })}
              >
                Automática
              </button>
            </div>
            {draft.duration.mode === 'manual' ? (
              <div className="field__row">
                <NumberInput
                  id="export-duration"
                  value={draft.duration.seconds}
                  min={MIN_DURATION_SECONDS}
                  max={maxDuration}
                  step={0.5}
                  onChange={(value) => update({ duration: { mode: 'manual', seconds: value } })}
                />
                <span className="field__unit">segundos</span>
              </div>
            ) : (
              <div className="field__row">
                <NumberInput
                  id="export-duration-max"
                  value={draft.duration.maxSeconds}
                  min={1}
                  max={maxDuration}
                  step={1}
                  onChange={(value) => update({ duration: { mode: 'auto', maxSeconds: value } })}
                />
                <span className="field__unit">segundos, no máximo</span>
              </div>
            )}
            <span className="field__note">
              {draft.duration.mode === 'manual'
                ? 'A captura termina exactamente no instante indicado.'
                : 'A página pode declarar window.biframe.duration ou emitir biframe:complete. Sem sinal, a captura pára no limite.'}
            </span>
            {issues.duration ? <span className="field__error">{issues.duration}</span> : null}
          </div>

          <div className="field">
            <span className="field__label">Qualidade</span>
            <div className="choice-list">
              {QUALITY_PRESETS.map((quality) => (
                <label className="choice" data-selected={draft.quality === quality.id} key={quality.id}>
                  <input
                    type="radio"
                    name="export-quality"
                    value={quality.id}
                    checked={draft.quality === quality.id}
                    onChange={() => update({ quality: quality.id })}
                  />
                  <span className="choice__text">
                    <strong>{quality.label}</strong>
                    <span>{quality.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        <div className="estimate" aria-live="polite">
          <span className="estimate__frames mono tnum">
            {draft.duration.mode === 'auto' ? 'até ' : ''}
            {formatNumber(frames)} frames
          </span>
          <span className="estimate__dot" aria-hidden="true">
            ·
          </span>
          <span className="tnum">≈ {formatBytes(estimate)}</span>
          <span className="estimate__note">estimativa antes da codificação</span>
        </div>
      </div>

      <div className="panel__foot">
        {activeJob ? (
          <button
            type="button"
            className="btn btn--danger btn--block btn--lg"
            onClick={() => {
              setCancelling(true);
              void cancelRender(activeJob.id);
            }}
            disabled={cancelling}
          >
            <X size={15} aria-hidden="true" />
            {cancelling ? 'A cancelar…' : 'Cancelar renderização'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary btn--block btn--lg"
            onClick={() => void handleExport(false)}
            disabled={!valid || !engineReady}
            title={!engineReady ? 'O motor de vídeo não está disponível' : 'Ctrl+E'}
          >
            <Play size={15} aria-hidden="true" />
            Exportar vídeo
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="panel__foot-note">
        {draft.duration.mode === 'manual' ? formatSeconds(draft.duration.seconds) : `até ${formatSeconds(draft.duration.maxSeconds)}`} ·{' '}
        {draft.fps} fps · H.264 / yuv420p · faststart
      </div>
    </section>
  );
}
