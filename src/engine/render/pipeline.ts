import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  Diagnostic,
  RenderProgress,
  RenderResult,
  RenderSettings,
  ResourceLimits,
  ValidationReport,
} from '@shared/types';
import { BiframeError, toBiframeError } from '@shared/errors';
import { ensureExtension, formatClock, sanitizeFileName } from '@shared/format';
import { estimateOutputBytes, qualityPreset } from '@shared/presets';
import type { DiagnosticInput } from '../diagnostics';
import { DiagnosticCollector, inspectionDiagnostics, stillFramesInput } from '../diagnostics';
import type { CaptureSession, CaptureSessionHost } from '../capture/types';
import { FrameStore, freeSpaceBytes } from '../frame-store';
import { buildEncodeArgs, buildPosterFrameArgs, buildProbeArgs, buildSampleArgs } from '../encoding/args';
import { parseProgressLine } from '../encoding/progress';
import { analyseGreyFrame, analyseSamples, parseFfprobeDocument, validateOutput } from '../encoding/probe';
import { captureBinary, resolveFfmpeg, resolveFfprobe, runBinary, runBinaryBuffer, type BinaryResolution } from '../media/binaries';
import { buildFramePlan, frameCountFor } from '../frame-plan';
import { delay, type CancellationToken } from './token';

export interface RenderPipelineInput {
  jobId: string;
  entryUrl: string;
  settings: RenderSettings;
  limits: ResourceLimits;
  /** Root for temporary frame directories (one subdirectory per job). */
  tempRoot: string;
  /** Root for the poster stills kept after the render (result view). */
  posterRoot: string;
  allowRemote: boolean;
  keepTempFiles: boolean;
  overwrite: boolean;
}

export interface RenderPipelineEnvironment {
  host: CaptureSessionHost;
  token: CancellationToken;
  emit: (progress: RenderProgress) => void;
  log?: (message: string, detail?: unknown) => void;
}

const CAPTURE_PROGRESS_INTERVAL_MS = 250;
const ENCODE_PROGRESS_INTERVAL_MS = 400;

/** The exact file a render will write. Shared with the preflight check. */
export function resolveOutputPath(settings: RenderSettings): string {
  return path.join(settings.outputDir, ensureExtension(sanitizeFileName(settings.fileName), '.mp4'));
}

function resolveRequestedDuration(settings: RenderSettings, limits: ResourceLimits): number {
  const requested = settings.duration.mode === 'manual' ? settings.duration.seconds : settings.duration.maxSeconds;
  return Math.min(requested, limits.maxDurationSeconds);
}

function logTail(value: string, max = 2000): string {
  return value.length > max ? value.slice(value.length - max) : value;
}

async function canWriteDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(directory);
    if (!stat.isDirectory()) return false;
    const probe = path.join(directory, `.biframe-write-${process.pid}.tmp`);
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole render, from empty temp directory to validated MP4.
 *
 * The caller provides the capture host (Electron in production, a scripted host
 * in tests), receives real progress and can cancel at any await point. Frames
 * are written to disk as they arrive; only their paths and timestamps stay in
 * memory, so a long 4K capture never grows the heap.
 */
export async function runRenderPipeline(
  input: RenderPipelineInput,
  environment: RenderPipelineEnvironment,
): Promise<RenderResult> {
  const startedAt = Date.now();
  const collector = new DiagnosticCollector();
  const extraDiagnostics: DiagnosticInput[] = [];
  const outputPath = resolveOutputPath(input.settings);
  const requestedDuration = resolveRequestedDuration(input.settings, input.limits);
  const quality = qualityPreset(input.settings.quality);

  let session: CaptureSession | null = null;
  let frameStore: FrameStore | null = null;
  let ffmpeg: BinaryResolution | null = null;
  let ffprobe: BinaryResolution | null = null;
  let createdOutput = false;
  let capturing = false;

  const emit = (
    phase: RenderProgress['phase'],
    message: string,
    percent: number | null,
    frames?: { captured: number; target: number },
  ): void => {
    const progress: RenderProgress = {
      jobId: input.jobId,
      phase,
      message,
      percent,
      elapsedMs: Date.now() - startedAt,
      diagnostics: collector.all,
    };
    if (frames) progress.frames = frames;
    environment.emit(progress);
  };

  try {
    emit('preparing', 'A preparar o motor de renderização', 0);
    [ffmpeg, ffprobe] = await Promise.all([resolveFfmpeg(), resolveFfprobe()]);
    environment.log?.('media binaries resolved', { ffmpeg: ffmpeg.version, ffprobe: ffprobe.version, source: ffmpeg.source });

    const outputDir = path.resolve(input.settings.outputDir);
    if (!(await canWriteDirectory(outputDir))) {
      throw new BiframeError('OUTPUT_DIRECTORY_INVALID', { detail: outputDir });
    }

    try {
      const existing = await fsp.stat(outputPath);
      if (existing.isFile() && !input.overwrite) {
        throw new BiframeError('OUTPUT_EXISTS', { detail: outputPath });
      }
    } catch (error) {
      if (error instanceof BiframeError) throw error;
      // ENOENT is the normal path: the file does not exist yet.
    }

    const estimate = estimateOutputBytes(input.settings.width, input.settings.height, input.settings.fps, requestedDuration, quality.id);
    const freeBytes = await freeSpaceBytes(input.tempRoot);
    if (freeBytes !== null && freeBytes < estimate) {
      throw new BiframeError('INSUFFICIENT_DISK_SPACE', {
        detail: `free=${freeBytes} estimated=${estimate}`,
      });
    }

    frameStore = new FrameStore(path.join(input.tempRoot, input.jobId));
    await frameStore.init();
    frameStore.setExtension('jpg');

    emit('launching', 'A abrir o Chromium controlado', 2);
    session = await environment.host.createSession({
      width: input.settings.width,
      height: input.settings.height,
      origin: new URL(input.entryUrl).origin,
      allowRemote: input.allowRemote,
      label: input.jobId,
    });
    if (environment.token.cancelled) throw new BiframeError('RENDER_CANCELLED');

    emit('loading', 'A carregar o projeto', 4);
    const loadOutcome = await session.load(input.entryUrl, { timeoutMs: input.limits.pageLoadTimeoutMs });
    if (!loadOutcome.ok) {
      throw new BiframeError('PAGE_LOAD_FAILED', { detail: loadOutcome.errorDetail });
    }
    const inspection = await session.inspect();
    for (const diagnostic of inspectionDiagnostics(inspection)) collector.add(diagnostic);
    if (inspection.protocolDurationSeconds !== null) {
      extraDiagnostics.push({
        code: 'PAGE_WARNING',
        severity: 'info',
        message: 'Duração declarada pela página através do protocolo Biframe',
        detail: `${inspection.protocolDurationSeconds} s`,
      });
    }

    emit('capturing', 'A preparar a animação', 6);
    let writeError: unknown = null;
    const pendingWrites: Promise<void>[] = [];
    const frameTimes: number[] = [];
    capturing = true;

    await session.startFrameStream({
      fps: input.settings.fps,
      onFrame: (frame) => {
        if (!capturing || !frameStore) return;
        frameTimes.push(frame.t);
        const write = frameStore
          .writeFrame(Buffer.from(frame.base64, 'base64'), frame.t)
          .then(() => undefined)
          .catch((error: unknown) => {
            writeError = error;
          });
        pendingWrites.push(write);
      },
    });

    if (environment.token.cancelled) throw new BiframeError('RENDER_CANCELLED');
    const mark = await session.reloadAndMarkStart({ timeoutMs: input.limits.pageLoadTimeoutMs });
    const startMs = mark.startMs;

    let effectiveDuration: number;
    const autoWithoutDeclaredDuration = input.settings.duration.mode === 'auto' && mark.protocol.durationSeconds === null;

    if (input.settings.duration.mode === 'auto' && mark.protocol.durationSeconds !== null) {
      effectiveDuration = Math.min(mark.protocol.durationSeconds, input.limits.maxDurationSeconds);
    } else if (input.settings.duration.mode === 'auto') {
      emit('capturing', 'À espera que a página sinalize o fim da animação', null);
      const completion = await session.waitForCompletion(input.limits.maxDurationSeconds * 1000, environment.token);
      if (completion === 'cancelled') throw new BiframeError('RENDER_CANCELLED');
      if (completion === 'timeout') {
        throw new BiframeError('RENDER_TIMEOUT', {
          detail: `no completion signal within ${input.limits.maxDurationSeconds}s; a manual duration is recommended`,
        });
      }
      effectiveDuration = Math.max(0.1, (Date.now() - startMs) / 1000);
    } else {
      effectiveDuration = requestedDuration;
    }

    if (!autoWithoutDeclaredDuration) {
      const totalMs = effectiveDuration * 1000;
      const targetFrames = frameCountFor(input.settings.fps, totalMs);
      let lastEmit = 0;
      for (;;) {
        if (environment.token.cancelled) throw new BiframeError('RENDER_CANCELLED');
        if (writeError) throw new BiframeError('FRAME_CAPTURE_FAILED', { detail: String(writeError) });
        const elapsed = Date.now() - startMs;
        if (elapsed >= totalMs) break;
        if (elapsed - lastEmit >= CAPTURE_PROGRESS_INTERVAL_MS) {
          lastEmit = elapsed;
          const ratio = Math.min(1, Math.max(0, elapsed / totalMs));
          emit(
            'capturing',
            `A capturar ${formatClock(Math.max(0, elapsed / 1000))} de ${formatClock(effectiveDuration)}`,
            6 + ratio * 72,
            { captured: frameTimes.length, target: targetFrames },
          );
        }
        if (!(await delay(120, environment.token))) throw new BiframeError('RENDER_CANCELLED');
      }
    }

    capturing = false;
    await session.stopFrameStream();
    await Promise.all(pendingWrites);
    if (writeError) throw new BiframeError('FRAME_CAPTURE_FAILED', { detail: String(writeError) });

    const sourceFrames = [...frameStore.frames];
    if (sourceFrames.length === 0) {
      throw new BiframeError('NO_FRAMES_CAPTURED', { detail: 'the page produced no compositor frames during capture' });
    }

    emit('resampling', 'A construir a sequência de frames', 80, {
      captured: sourceFrames.length,
      target: frameCountFor(input.settings.fps, effectiveDuration * 1000),
    });
    const plan = buildFramePlan({
      frames: sourceFrames,
      startMs,
      fps: input.settings.fps,
      durationMs: effectiveDuration * 1000,
    });
    if (plan.indices.length === 0) throw new BiframeError('NO_FRAMES_CAPTURED');
    if (plan.stats.belowRequestedRate) {
      extraDiagnostics.push({
        code: 'CAPTURE_RATE_LOW',
        severity: 'warning',
        message: 'A captura ficou abaixo do FPS pedido',
        detail: `captura ≈ ${plan.stats.captureFps} fps para saída a ${input.settings.fps} fps; alguns frames foram repetidos`,
      });
    }
    const materialized = await frameStore.materialize(plan);
    if (materialized.count !== plan.indices.length) {
      throw new BiframeError('FRAME_CAPTURE_FAILED', {
        detail: `materialized ${materialized.count} of ${plan.indices.length} frames`,
      });
    }

    emit('encoding', 'A codificar H.264', 82, {
      captured: materialized.count,
      target: materialized.count,
    });

    let lastEncodeEmit = 0;
    const encodeResult = await runBinary(
      ffmpeg.path,
      buildEncodeArgs({
        inputPattern: frameStore.cfrPattern,
        outputPath,
        fps: input.settings.fps,
        crf: quality.crf,
        x264Preset: quality.x264Preset,
        overwrite: input.overwrite,
      }),
      {
        signal: environment.token.signal,
        onStdoutLine: (line) => {
          const update = parseProgressLine(line);
          if (!update?.frame) return;
          const now = Date.now();
          if (now - lastEncodeEmit < ENCODE_PROGRESS_INTERVAL_MS && update.frame < materialized.count) return;
          lastEncodeEmit = now;
          const ratio = Math.min(1, update.frame / materialized.count);
          emit('encoding', `A codificar ${update.frame} de ${materialized.count} frames`, 82 + ratio * 13, {
            captured: update.frame,
            target: materialized.count,
          });
        },
      },
    );

    if (environment.token.cancelled) throw new BiframeError('RENDER_CANCELLED');
    if (encodeResult.code !== 0) {
      throw new BiframeError('ENCODING_FAILED', {
        detail: `ffmpeg exit=${encodeResult.code} signal=${encodeResult.signal}\n${logTail(encodeResult.stderr)}`,
      });
    }
    createdOutput = true;

    emit('validating', 'A validar o vídeo produzido', 96);
    const probeRun = await captureBinary(ffprobe.path, buildProbeArgs({ inputPath: outputPath }));
    if (probeRun.code !== 0) {
      throw new BiframeError('OUTPUT_VALIDATION_FAILED', { detail: logTail(probeRun.stderr) });
    }
    let parsed;
    try {
      parsed = parseFfprobeDocument(JSON.parse(probeRun.stdout) as Parameters<typeof parseFfprobeDocument>[0]);
    } catch (error) {
      throw new BiframeError('OUTPUT_VALIDATION_FAILED', { detail: String(error) });
    }
    const size = (await fsp.stat(outputPath)).size;
    const validation: ValidationReport = validateOutput({
      metadata: parsed.metadata,
      formatName: parsed.formatName,
      audioStreams: parsed.audioStreams,
      sizeBytes: size,
      settings: input.settings,
      requestedDurationSeconds: effectiveDuration,
      expectedFrames: plan.indices.length,
    });

    const positions = [0.08, 0.28, 0.5, 0.72, 0.92].map((fraction) => Math.max(0, parsed.metadata.durationSeconds * fraction));
    const samples = [];
    for (const position of positions) {
      try {
        const sample = await runBinaryBuffer(ffmpeg.path, buildSampleArgs({
          inputPath: outputPath,
          atSeconds: position,
          width: 320,
          height: 180,
        }), { timeoutMs: 20_000, signal: environment.token.signal });
        if (sample.stdout.length > 0) samples.push(analyseGreyFrame(sample.stdout));
      } catch {
        // Sampling is diagnostic only; a failure here must not fail the render.
      }
    }
    if (samples.length > 0) {
      const analysis = analyseSamples(samples);
      for (const diagnostic of stillFramesInput(analysis)) extraDiagnostics.push(diagnostic);
    }

    const posterFrames = await extractPosters({
      ffmpeg,
      inputPath: outputPath,
      durationSeconds: parsed.metadata.durationSeconds,
      destination: path.join(input.posterRoot, input.jobId),
    });

    const diagnostics: Diagnostic[] = [...collector.all];
    const seen = new Set(diagnostics.map((item) => `${item.code}|${item.url ?? item.message}`));
    for (const inputDiagnostic of extraDiagnostics) {
      const key = `${inputDiagnostic.code}|${inputDiagnostic.url ?? inputDiagnostic.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push({
        id: `x${diagnostics.length + 1}`,
        code: inputDiagnostic.code,
        severity: inputDiagnostic.severity,
        message: inputDiagnostic.message,
        at: Date.now(),
        ...(inputDiagnostic.detail ? { detail: inputDiagnostic.detail } : {}),
        ...(inputDiagnostic.url ? { url: inputDiagnostic.url } : {}),
      });
    }
    for (const diagnostic of session.diagnostics()) {
      const key = `${diagnostic.code}|${diagnostic.url ?? diagnostic.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diagnostics.push(diagnostic);
    }

    const result: RenderResult = {
      jobId: input.jobId,
      outputPath,
      fileName: path.basename(outputPath),
      sizeBytes: size,
      metadata: parsed.metadata,
      validation,
      diagnostics,
      posterFrames,
      startedAt,
      finishedAt: Date.now(),
    };

    if (!validation.ok) {
      throw new BiframeError('OUTPUT_VALIDATION_FAILED', {
        detail: validation.checks
          .filter((check) => check.status === 'fail')
          .map((check) => `${check.id}: ${check.detail}`)
          .join('; '),
      });
    }

    emit('completed', 'Vídeo pronto', 100, {
      captured: materialized.count,
      target: materialized.count,
    });
    return result;
  } catch (error) {
    const normalized =
      environment.token.cancelled && !(error instanceof BiframeError && error.code === 'RENDER_TIMEOUT')
        ? new BiframeError('RENDER_CANCELLED')
        : toBiframeError(error);
    if (createdOutput) {
      try {
        await fsp.unlink(outputPath);
      } catch {
        // The file may have failed validation and already be gone.
      }
    }
    throw normalized;
  } finally {
    capturing = false;
    if (session) {
      try {
        await session.close();
      } catch {
        // Closing is best-effort; the process exits anyway.
      }
    }
    if (frameStore && !input.keepTempFiles) {
      try {
        await frameStore.cleanup();
      } catch {
        // Temporary files are cleaned again by the startup sweep.
      }
    }
  }
}

async function extractPosters(options: {
  ffmpeg: BinaryResolution;
  inputPath: string;
  durationSeconds: number;
  destination: string;
}): Promise<string[]> {
  const { ffmpeg, inputPath, durationSeconds, destination } = options;
  await fsp.mkdir(destination, { recursive: true });
  const posters: string[] = [];
  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  for (let index = 0; index < fractions.length; index += 1) {
    const at = Math.max(0, Math.min(durationSeconds - 0.05, durationSeconds * (fractions[index] ?? 0.5)));
    const output = path.join(destination, `frame-${index + 1}.jpg`);
    try {
      const run = await runBinary(
        ffmpeg.path,
        buildPosterFrameArgs({ inputPath, atSeconds: at, outputPath: output, width: 640 }),
        { timeoutMs: 20_000 },
      );
      if (run.code === 0) posters.push(output);
    } catch {
      // Posters are a convenience; missing ones leave the strip empty.
    }
  }
  return posters;
}

/** Removes poster directories that no longer belong to a retained job. */
export async function prunePosterRoot(root: string, keepJobIds: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keepJobIds.has(entry)) continue;
    try {
      await fsp.rm(path.join(root, entry), { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}
