/**
 * FFmpeg command construction. Pure functions: the whole pipeline is tested by
 * asserting on the argument arrays, and no component outside this module ever
 * builds an FFmpeg command.
 */

export interface EncodeOptions {
  /** Image-sequence pattern, e.g. `C:\\tmp\\frames\\%06d.jpg`. */
  inputPattern: string;
  outputPath: string;
  fps: number;
  crf: number;
  x264Preset: string;
  /** `true` overwrites the destination; the UI asks for confirmation first. */
  overwrite: boolean;
  /** First file number of the sequence (the resampler starts at 1). */
  startNumber?: number;
}

export function buildEncodeArgs(options: EncodeOptions): string[] {
  const { inputPattern, outputPath, fps, crf, x264Preset, overwrite } = options;
  const startNumber = options.startNumber ?? 1;
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    overwrite ? '-y' : '-n',
    '-framerate',
    String(fps),
    '-start_number',
    String(startNumber),
    '-i',
    inputPattern,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    x264Preset,
    '-crf',
    String(crf),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(Math.max(2, Math.round(fps * 2))),
    '-movflags',
    '+faststart',
    '-r',
    String(fps),
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'mp4',
    outputPath,
  ];
}

export interface ProbeArgsInput {
  inputPath: string;
}

export function buildProbeArgs({ inputPath }: ProbeArgsInput): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ];
}

export interface FrameSampleOptions {
  inputPath: string;
  /** Position of the sample inside the video, in seconds. */
  atSeconds: number;
  width: number;
  height: number;
}

/** Extracts one frame as raw 8-bit grey pixels on stdout (used for blank/still detection). */
export function buildSampleArgs({ inputPath, atSeconds, width, height }: FrameSampleOptions): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:${height}`, // no-op when the size matches; guards odd sources
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ];
}

export interface PosterFrameOptions {
  inputPath: string;
  atSeconds: number;
  outputPath: string;
  width: number;
}

/** Extracts one JPEG still, used for the contact strip in the result view. */
export function buildPosterFrameArgs({ inputPath, atSeconds, outputPath, width }: PosterFrameOptions): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${Math.max(2, Math.round(width / 2))}:-2`,
    '-q:v',
    '3',
    outputPath,
  ];
}
