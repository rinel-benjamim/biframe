import type { Translator } from '@shared/i18n';
import type { RenderSettings, ValidationCheck, ValidationReport, VideoMetadata } from '@shared/types';

/**
 * Parsing and validation of the produced file. `ffprobe` is the source of
 * truth: the interface never reports success from a process exit code alone.
 */

export interface ParsedFps {
  numerator: number;
  denominator: number;
  value: number;
}

export function parseFps(raw: string | undefined): ParsedFps | null {
  if (!raw) return null;
  const [numRaw, denRaw] = raw.split('/');
  const numerator = Number(numRaw);
  const denominator = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return { numerator, denominator, value: numerator / denominator };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

export interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ProbeParseResult {
  metadata: VideoMetadata;
  formatName: string;
  audioStreams: number;
}

export function parseFfprobeDocument(document: FfprobeDocument): ProbeParseResult {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio').length;
  if (!video) {
    throw new Error('ffprobe did not report a video stream');
  }
  const fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate);
  const durationRaw = Number(document.format?.duration ?? video.duration ?? '0');
  const metadata: VideoMetadata = {
    codec: video.codec_name ?? 'unknown',
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: fps ? Math.round(fps.value * 1000) / 1000 : 0,
    pixFmt: video.pix_fmt ?? 'unknown',
    frames: video.nb_frames ? Number(video.nb_frames) : null,
    durationSeconds: Number.isFinite(durationRaw) ? durationRaw : 0,
    bitrate: Number(document.format?.bit_rate ?? video.bit_rate ?? '0') || 0,
  };
  if (video.profile) metadata.profile = video.profile;
  return { metadata, formatName: document.format?.format_name ?? 'unknown', audioStreams };
}

export interface ValidationInput {
  /** Translator for the check labels and details shown on the result screen. */
  t: Translator;
  metadata: VideoMetadata;
  formatName: string;
  audioStreams: number;
  sizeBytes: number;
  settings: RenderSettings;
  requestedDurationSeconds: number;
  expectedFrames: number;
}

const FRAME_TOLERANCE = 3;

export function validateOutput(input: ValidationInput): ValidationReport {
  const { t, metadata, formatName, audioStreams, sizeBytes, settings, requestedDurationSeconds, expectedFrames } = input;
  const checks: ValidationCheck[] = [];

  checks.push({
    id: 'file-size',
    label: t('check.fileSize'),
    status: sizeBytes > 0 ? 'pass' : 'fail',
    detail: `${sizeBytes} bytes`,
  });

  checks.push({
    id: 'container',
    label: t('check.container'),
    status: formatName.includes('mp4') ? 'pass' : 'fail',
    detail: formatName,
  });

  checks.push({
    id: 'codec',
    label: t('check.codec'),
    status: metadata.codec === 'h264' ? 'pass' : 'fail',
    detail: `${metadata.codec}${metadata.profile ? ` (${metadata.profile})` : ''}`,
  });

  checks.push({
    id: 'resolution',
    label: t('check.resolution'),
    status: metadata.width === settings.width && metadata.height === settings.height ? 'pass' : 'fail',
    detail: t('check.resolutionDetail', {
      width: metadata.width,
      height: metadata.height,
      requestedWidth: settings.width,
      requestedHeight: settings.height,
    }),
  });

  const fpsDelta = Math.abs(metadata.fps - settings.fps);
  checks.push({
    id: 'fps',
    label: t('check.fps'),
    status: fpsDelta <= 0.05 ? 'pass' : 'fail',
    detail: t('check.fpsDetail', { fps: metadata.fps, requested: settings.fps }),
  });

  checks.push({
    id: 'pixel-format',
    label: t('check.pixelFormat'),
    status: metadata.pixFmt === 'yuv420p' ? 'pass' : 'fail',
    detail: metadata.pixFmt,
  });

  // Two frames of slack absorb the rounding of the frame count and of the
  // container duration; anything larger means capture and settings disagree.
  const durationToleranceSeconds = Math.max(0.35, 2 / settings.fps);
  const durationDelta = Math.abs(metadata.durationSeconds - requestedDurationSeconds);
  checks.push({
    id: 'duration',
    label: t('check.duration'),
    status: durationDelta <= durationToleranceSeconds ? 'pass' : 'fail',
    detail: t('check.durationDetail', {
      duration: metadata.durationSeconds.toFixed(2),
      requested: requestedDurationSeconds.toFixed(2),
      tolerance: durationToleranceSeconds.toFixed(2),
    }),
  });

  if (metadata.frames !== null) {
    const frameDelta = Math.abs(metadata.frames - expectedFrames);
    checks.push({
      id: 'frames',
      label: t('check.frames'),
      status: frameDelta <= FRAME_TOLERANCE ? 'pass' : 'warn',
      detail: t('check.framesDetail', { frames: metadata.frames, expected: expectedFrames }),
    });
  }

  checks.push({
    id: 'audio',
    label: t('check.audio'),
    status: audioStreams === 0 ? 'pass' : 'warn',
    detail: audioStreams === 0 ? t('check.audioNone') : t('check.audioPresent', { count: audioStreams }),
  });

  const ok = checks.every((check) => check.status !== 'fail');
  return { ok, checks };
}

export interface FrameSampleStats {
  mean: number;
  stdDev: number;
  uniform: boolean;
  uniqueBytes: number;
  /** FNV-1a hash of the pixel buffer, used to detect a fully static video. */
  hash: string;
}

/** Statistics over raw 8-bit grey pixels; `uniform` means a visually flat frame. */
export function analyseGreyFrame(gray: Uint8Array): FrameSampleStats {
  if (gray.length === 0) {
    return { mean: 0, stdDev: 0, uniform: true, uniqueBytes: 0, hash: '0' };
  }
  let sum = 0;
  let hash = 0x811c9dc5;
  const seen = new Set<number>();
  for (const value of gray) {
    sum += value;
    if (seen.size < 256) seen.add(value);
    hash ^= value;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const mean = sum / gray.length;
  let variance = 0;
  for (const value of gray) {
    const delta = value - mean;
    variance += delta * delta;
  }
  variance /= gray.length;
  const stdDev = Math.sqrt(variance);
  return {
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    uniform: stdDev < 1.5,
    uniqueBytes: seen.size,
    hash: hash.toString(16),
  };
}

export interface BlankAnalysis {
  samples: FrameSampleStats[];
  blank: boolean;
  staticFrames: boolean;
}

/**
 * `blank` and `staticFrames` are warnings, not failures: a deliberately black or
 * still video is legitimate. They only raise the flag someone should check.
 */
export function analyseSamples(samples: FrameSampleStats[]): BlankAnalysis {
  const blank = samples.length > 0 && samples.every((sample) => sample.uniform);
  const first = samples[0];
  const staticFrames = samples.length > 1 && first !== undefined && samples.every((sample) => sample.hash === first.hash);
  return { samples, blank, staticFrames };
}
