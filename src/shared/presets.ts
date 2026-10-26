import type {
  AspectRatioId,
  QualityPreset,
  QualityPresetId,
  RenderSettings,
  ResolutionPreset,
} from './types';

export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 3840;
export const MIN_DURATION_SECONDS = 0.5;
export const MAX_DURATION_SECONDS = 600;
export const FPS_OPTIONS = [24, 25, 30, 50, 60] as const;
export type FpsValue = (typeof FPS_OPTIONS)[number];
/**
 * 60 fps by default: it matches the refresh rate of the display the page is
 * animated on, so exported transitions keep the cadence the browser shows.
 * 30 fps remains available for compatibility and smaller files.
 */
export const DEFAULT_FPS: FpsValue = 60;
export const MAX_FPS = 60;
/**
 * 1280 × 720 by default: on the reference machine (Intel i5-6200U) capture
 * reaches 56–58 fps at 720p but only ~26.5 fps at 1080p, which cannot fill a
 * 60 fps timeline without visible duplication. 1080p stays one click away.
 */
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

export const ASPECT_RATIOS: { id: AspectRatioId; label: string; ratio: number }[] = [
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: 'custom', label: 'Personalizado', ratio: 0 },
];

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: '720p', label: '720p', detail: '1280 × 720', width: 1280, height: 720, aspect: '16:9' },
  { id: '1080p', label: '1080p', detail: '1920 × 1080', width: 1920, height: 1080, aspect: '16:9' },
  { id: '1440p', label: '1440p', detail: '2560 × 1440', width: 2560, height: 1440, aspect: '16:9', demanding: true },
  { id: '2160p', label: '4K', detail: '3840 × 2160', width: 3840, height: 2160, aspect: '16:9', demanding: true },
  { id: 'vertical-1080', label: 'Vertical', detail: '1080 × 1920', width: 1080, height: 1920, aspect: '9:16' },
  { id: 'square-1080', label: 'Quadrado', detail: '1080 × 1080', width: 1080, height: 1080, aspect: '1:1' },
  { id: 'social-1080', label: 'Feed 4:5', detail: '1080 × 1350', width: 1080, height: 1350, aspect: '4:5' },
];

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'compact',
    label: 'Ficheiro mais pequeno',
    description: 'CRF 26 · ficheiros leves para partilha rápida',
    crf: 26,
    x264Preset: 'medium',
  },
  {
    id: 'balanced',
    label: 'Equilibrada',
    description: 'CRF 21 · bom compromisso entre qualidade e tamanho',
    crf: 21,
    x264Preset: 'medium',
  },
  {
    id: 'high',
    label: 'Alta qualidade',
    description: 'CRF 17 · detalhe alto para texto e gráficos',
    crf: 17,
    x264Preset: 'slow',
  },
];

export const DEFAULT_QUALITY: QualityPresetId = 'balanced';

export function qualityPreset(id: QualityPresetId): QualityPreset {
  const preset = QUALITY_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown quality preset: ${id}`);
  return preset;
}

export function findResolutionPreset(width: number, height: number): ResolutionPreset | null {
  return (
    RESOLUTION_PRESETS.find((preset) => preset.width === width && preset.height === height) ?? null
  );
}

/** True when both dimensions are valid, even-sized (required by yuv420p) and within bounds. */
export function isValidFrameSize(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MIN_DIMENSION &&
    height >= MIN_DIMENSION &&
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    width % 2 === 0 &&
    height % 2 === 0
  );
}

export interface Rect {
  width: number;
  height: number;
  x: number;
  y: number;
}

/**
 * Fits `content` inside `frame` preserving the aspect ratio (the "contain"
 * policy) and centres it. Used both by the preview stage and by the encoded
 * frame geometry, so a project is framed identically in both places.
 */
export function fitRect(contentWidth: number, contentHeight: number, frameWidth: number, frameHeight: number): Rect {
  if (contentWidth <= 0 || contentHeight <= 0) {
    return { width: frameWidth, height: frameHeight, x: 0, y: 0 };
  }
  const scale = Math.min(frameWidth / contentWidth, frameHeight / contentHeight);
  const width = Math.round(contentWidth * scale);
  const height = Math.round(contentHeight * scale);
  return {
    width,
    height,
    x: Math.round((frameWidth - width) / 2),
    y: Math.round((frameHeight - height) / 2),
  };
}

export function aspectRatioOf(width: number, height: number): AspectRatioId {
  const preset = findResolutionPreset(width, height);
  if (preset) return preset.aspect;
  const ratio = width / height;
  for (const candidate of ASPECT_RATIOS) {
    if (candidate.id === 'custom') continue;
    if (Math.abs(candidate.ratio - ratio) < 0.002) return candidate.id;
  }
  return 'custom';
}

/** Rough output size estimate used for the disk-space pre-flight check. */
export function estimateOutputBytes(width: number, height: number, fps: number, seconds: number, quality: QualityPresetId): number {
  const bitsPerPixelPerFrame = { compact: 0.035, balanced: 0.07, high: 0.14 }[quality];
  const pixels = width * height;
  const frames = Math.max(1, Math.round(fps * seconds));
  const videoBits = pixels * frames * bitsPerPixelPerFrame;
  // Capture frames live on disk as JPEG during the render as well.
  const captureBytes = pixels * frames * 0.06;
  const videoBytes = videoBits / 8;
  return Math.round(videoBytes + captureBytes + 8 * 1024 * 1024);
}

export function defaultRenderSettings(outputDir: string, fileName = 'biframe-export.mp4'): RenderSettings {
  return {
    fileName,
    outputDir,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    fps: DEFAULT_FPS,
    duration: { mode: 'manual', seconds: 10 },
    quality: DEFAULT_QUALITY,
    container: 'mp4',
    encoder: 'x264',
    fit: 'contain',
  };
}
