import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import { BiframeError, isErrorCode, serializeError } from '@shared/errors';
import { validateRenderSettings } from '@shared/settings';
import { createTranslator, type Language } from '@shared/i18n';
import type { HistoryEntry, RenderJob, RenderProgress, RenderSettings } from '@shared/types';
import { prunePosterRoot, resolveOutputPath, runRenderPipeline } from '../../engine/render/pipeline';
import { CancellationToken } from '../../engine/render/token';
import type { CaptureSessionHost } from '../../engine/capture/types';
import type { AppPaths } from '../paths';
import type { Logger } from '../log';
import type { HistoryStore } from './history-store';
import type { ProjectService } from './project-service';
import type { SettingsStore } from './settings-store';

/**
 * Owns render jobs.
 *
 * One render at a time (`maxConcurrentJobs` is 1 in this version): the engine is
 * real-time, so two simultaneous captures would compete for the compositor and
 * distort each other's animations. `start` therefore returns a running job and a
 * second call while busy fails with `RENDER_IN_PROGRESS` instead of queueing
 * silently.
 */

const MAX_JOBS = 20;
const KEEP_POSTER_SETS = 20;

export interface RenderServiceOptions {
  paths: AppPaths;
  logger: Logger;
  settings: SettingsStore;
  history: HistoryStore;
  projects: ProjectService;
  host: CaptureSessionHost;
}

export class RenderService {
  private readonly jobs = new Map<string, RenderJob>();
  private order: string[] = [];
  private active: { jobId: string; token: CancellationToken } | null = null;
  private readonly options: RenderServiceOptions;
  private readonly logger: Logger;
  private progressListeners = new Set<(job: RenderJob, progress: RenderProgress) => void>();
  private finishedListeners = new Set<(job: RenderJob) => void>();

  constructor(options: RenderServiceOptions) {
    this.options = options;
    this.logger = options.logger.child('render');
  }

  list(): RenderJob[] {
    return this.order.map((id) => this.jobs.get(id)).filter((job): job is RenderJob => Boolean(job));
  }

  get(jobId: string): RenderJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  onProgress(listener: (job: RenderJob, progress: RenderProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onFinished(listener: (job: RenderJob) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /**
   * Starts a render. `overwrite` is false on the first attempt so an existing
   * file produces `OUTPUT_EXISTS`; the interface asks the user and retries with
   * `overwrite: true`.
   */
  async start(settings: RenderSettings, options: { overwrite?: boolean } = {}): Promise<RenderJob> {
    const validated = validateRenderSettings(settings);
    if (!validated.ok || !validated.value) {
      throw new BiframeError('INVALID_SETTINGS', {
        detail: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      });
    }
    if (this.active) {
      throw new BiframeError('RENDER_IN_PROGRESS', { detail: this.active.jobId });
    }
    const project = this.options.projects.current();
    const entryUrl = this.options.projects.entryUrl();
    if (!project || !entryUrl) {
      throw new BiframeError('PROJECT_NOT_FOUND', { detail: 'no project is open' });
    }

    // Fail before creating a job so the interface can ask for overwrite
    // confirmation instead of reporting a failed render. The pipeline repeats
    // this check to close the race between the prompt and the encoder.
    const overwrite = options.overwrite === true;
    if (!overwrite) {
      const outputPath = resolveOutputPath(validated.value);
      try {
        const existing = await fsp.stat(outputPath);
        if (existing.isFile()) {
          throw new BiframeError('OUTPUT_EXISTS', { detail: outputPath });
        }
      } catch (error) {
        if (error instanceof BiframeError) throw error;
        // ENOENT is the normal path: there is nothing to overwrite yet.
      }
    }

    const jobId = randomUUID();
    const appSettings = this.options.settings.get();
    const language = appSettings.language;
    const job: RenderJob = {
      id: jobId,
      projectId: project.id,
      projectName: project.name,
      settings: validated.value,
      status: 'running',
      progress: {
        jobId,
        phase: 'queued',
        message: createTranslator(language)('progress.queued'),
        percent: null,
        elapsedMs: 0,
        diagnostics: [],
      },
      startedAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    this.order = [jobId, ...this.order.filter((id) => id !== jobId)].slice(0, MAX_JOBS);

    const token = new CancellationToken();
    this.active = { jobId, token };
    void this.run(job, validated.value, entryUrl, token, overwrite, appSettings.allowRemoteResources, appSettings.keepTempFiles, language);
    return job;
  }

  private async run(
    job: RenderJob,
    settings: RenderSettings,
    entryUrl: string,
    token: CancellationToken,
    overwrite: boolean,
    allowRemote: boolean,
    keepTempFiles: boolean,
    language: Language,
  ): Promise<void> {
    const t = createTranslator(language);
    const limits = this.options.settings.get().limits;
    const emitProgress = (progress: RenderProgress): void => {
      job.progress = progress;
      for (const listener of this.progressListeners) listener(job, progress);
    };
    try {
      const result = await runRenderPipeline(
        {
          jobId: job.id,
          entryUrl,
          settings,
          limits,
          language,
          tempRoot: this.options.paths.framesRoot,
          posterRoot: this.options.paths.postersRoot,
          allowRemote,
          keepTempFiles,
          overwrite,
        },
        {
          host: this.options.host,
          token,
          emit: emitProgress,
          log: (message, detail) => this.logger.log('debug', message, detail),
        },
      );
      job.status = 'completed';
      job.result = result;
      job.finishedAt = Date.now();
      job.progress = {
        jobId: job.id,
        phase: 'completed',
        message: t('progress.completed'),
        percent: 100,
        elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
        diagnostics: result.diagnostics,
        frames: job.progress.frames,
      };
      this.logger.log('info', 'render completed', {
        jobId: job.id,
        file: result.outputPath,
        bytes: result.sizeBytes,
        seconds: result.metadata.durationSeconds,
      });
    } catch (error) {
      const serialized = serializeError(error);
      const cancelled = serialized.code === 'RENDER_CANCELLED';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.error = serialized;
      job.finishedAt = Date.now();
      job.progress = {
        ...job.progress,
        phase: cancelled ? 'cancelled' : 'failed',
        message: cancelled
          ? t('progress.cancelled')
          : isErrorCode(serialized.code)
            ? t(`error.${serialized.code}.title`)
            : serialized.title,
        percent: null,
      };
      this.logger.log(cancelled ? 'info' : 'error', 'render finished with an error', {
        jobId: job.id,
        code: serialized.code,
        detail: serialized.detail,
      });
    } finally {
      this.active = null;
      await this.recordHistory(job);
      await this.prunePosters();
      for (const listener of this.finishedListeners) listener(job);
    }
  }

  private async recordHistory(job: RenderJob): Promise<void> {
    const metadata = job.result?.metadata;
    const entry: HistoryEntry = {
      id: job.id,
      projectName: job.projectName,
      fileName: job.result?.fileName ?? job.settings.fileName,
      outputPath: job.result?.outputPath ?? '',
      sizeBytes: job.result?.sizeBytes ?? 0,
      durationSeconds: metadata?.durationSeconds ?? 0,
      width: metadata?.width ?? job.settings.width,
      height: metadata?.height ?? job.settings.height,
      fps: metadata?.fps ?? job.settings.fps,
      status: job.status,
      startedAt: job.startedAt,
    };
    if (job.finishedAt !== undefined) entry.finishedAt = job.finishedAt;
    if (job.error) entry.error = job.error;
    try {
      await this.options.history.add(entry);
    } catch (error) {
      this.logger.log('warn', 'history entry was not stored', { error: String(error) });
    }
  }

  private async prunePosters(): Promise<void> {
    const keep = new Set<string>();
    for (const job of this.list()) {
      if (keep.size >= KEEP_POSTER_SETS) break;
      if (job.result) keep.add(job.id);
    }
    try {
      await prunePosterRoot(this.options.paths.postersRoot, keep);
    } catch (error) {
      this.logger.log('warn', 'poster pruning failed', { error: String(error) });
    }
  }

  async cancel(jobId: string): Promise<void> {
    if (this.active?.jobId !== jobId) {
      // Cancelling an already finished job is not an error: the interface may
      // race the completion event.
      this.logger.log('debug', 'cancel ignored: job is not running', { jobId });
      return;
    }
    this.active.token.cancel('cancelado pelo utilizador');
  }

  async shutdown(): Promise<void> {
    if (this.active) {
      this.active.token.cancel('the application is shutting down');
      // Give the pipeline a moment to unwind so temporary files are removed.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
