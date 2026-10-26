/**
 * Turns the real-time stream of captured frames into a constant-frame-rate
 * plan for the encoder.
 *
 * Real-time capture never delivers frames at exactly 1/fps. The plan therefore
 * holds the latest frame that existed at each target instant: content can be
 * duplicated (never stretched), and the output duration always matches the
 * requested duration. Both properties are asserted by the unit tests.
 */

export interface CapturedFrame {
  /** Host clock timestamp (ms) when the frame arrived. */
  t: number;
  /** Absolute path of the frame image on disk. */
  file: string;
}

export interface FramePlanStats {
  targetFrames: number;
  sourceFrames: number;
  duplicateFrames: number;
  /** Largest interval between two consecutive source frames, in ms. */
  maxGapMs: number;
  /** Capture rate actually achieved (frames per second). */
  captureFps: number;
  /** True when the capture rate is far below the requested rate. */
  belowRequestedRate: boolean;
}

export interface FramePlan {
  /** Index into the source frame array for every target frame. */
  indices: number[];
  stats: FramePlanStats;
}

export function frameCountFor(fps: number, durationMs: number): number {
  return Math.max(1, Math.round((fps * durationMs) / 1000));
}

/**
 * `startMs` is the host clock instant that maps to t=0 of the animation.
 * Frames older than `startMs` are ignored. When a target instant precedes the
 * first usable frame, the first usable frame is repeated, which is the only
 * defensible choice: the alternative would shift the timeline.
 */
export function buildFramePlan(input: {
  frames: CapturedFrame[];
  startMs: number;
  fps: number;
  durationMs: number;
}): FramePlan {
  const { frames, startMs, fps, durationMs } = input;
  const targetFrames = frameCountFor(fps, durationMs);
  const usable = frames.filter((frame) => frame.t >= startMs);
  const pool = usable.length > 0 ? usable : frames;

  const indices: number[] = new Array(targetFrames);
  if (pool.length === 0) {
    return {
      indices: [],
      stats: {
        targetFrames,
        sourceFrames: 0,
        duplicateFrames: 0,
        maxGapMs: 0,
        captureFps: 0,
        belowRequestedRate: true,
      },
    };
  }

  let cursor = 0;
  let duplicates = 0;
  for (let target = 0; target < targetFrames; target += 1) {
    const targetTime = startMs + (target * 1000) / fps;
    while (cursor + 1 < pool.length && (pool[cursor + 1]?.t ?? Number.POSITIVE_INFINITY) <= targetTime) {
      cursor += 1;
    }
    indices[target] = cursor;
    if (target > 0 && cursor === indices[target - 1]) duplicates += 1;
  }

  const sorted = [...pool].sort((a, b) => a.t - b.t);
  let maxGapMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = (sorted[i]?.t ?? 0) - (sorted[i - 1]?.t ?? 0);
    if (gap > maxGapMs) maxGapMs = gap;
  }
  const captureSpanMs = sorted.length > 1 ? (sorted[sorted.length - 1]?.t ?? 0) - (sorted[0]?.t ?? 0) : 0;
  const captureFps = captureSpanMs > 0 ? ((sorted.length - 1) * 1000) / captureSpanMs : 0;

  return {
    indices,
    stats: {
      targetFrames,
      sourceFrames: pool.length,
      duplicateFrames: duplicates,
      maxGapMs: Math.round(maxGapMs),
      captureFps: Math.round(captureFps * 10) / 10,
      belowRequestedRate: captureSpanMs > 0 && captureFps < fps * 0.75,
    },
  };
}

/** Collapses the plan into runs so the resampler can hardlink instead of copying duplicates. */
export function planToRuns(indices: number[]): { index: number; repeat: number }[] {
  const runs: { index: number; repeat: number }[] = [];
  for (const index of indices) {
    const last = runs[runs.length - 1];
    if (last && last.index === index) {
      last.repeat += 1;
    } else {
      runs.push({ index, repeat: 1 });
    }
  }
  return runs;
}
