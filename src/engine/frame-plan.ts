/**
 * Turns the real-time stream of captured frames into a constant-frame-rate
 * plan for the encoder.
 *
 * Real-time capture never delivers frames at exactly 1/fps, so each target
 * instant has to reuse a captured frame. The plan picks the frame whose
 * presentation timestamp is **nearest** to the target instant instead of
 * holding back a whole capture interval: nearest keeps motion evenly spaced
 * (the hold-last rule visibly stuttered during fast transitions, because every
 * target fell just short of the next real frame and repeated the previous
 * one), while duplicates are still spread evenly instead of clumped after a
 * stall. Content is duplicated, never interpolated, and the output duration
 * always matches the requested duration. Both properties are asserted by the
 * unit tests.
 */

export interface CapturedFrame {
  /** Presentation instant (host clock, ms) when the frame was composited. */
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
  /** True when the capture rate fell short of the requested rate (below 90 %). */
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
 *
 * Source frames are ordered by presentation timestamp and each plan index
 * points back at the original position, so a stream whose disk writes finish
 * out of order still resamples against a monotonic timeline.
 */
export function buildFramePlan(input: {
  frames: CapturedFrame[];
  startMs: number;
  fps: number;
  durationMs: number;
}): FramePlan {
  const { frames, startMs, fps, durationMs } = input;
  const targetFrames = frameCountFor(fps, durationMs);
  const ordered = frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => a.frame.t - b.frame.t || a.index - b.index);
  const usable = ordered.filter((entry) => entry.frame.t >= startMs);
  const pool = usable.length > 0 ? usable : ordered;

  const indices: number[] = [];
  if (pool.length === 0) {
    return {
      indices,
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
    while (cursor + 1 < pool.length && (pool[cursor + 1]?.frame.t ?? Number.POSITIVE_INFINITY) <= targetTime) {
      cursor += 1;
    }
    // Nearest frame: keep the frame before the target unless the next one is
    // strictly closer, so motion stays evenly spaced instead of running one
    // whole capture interval late. Ties keep the earlier frame, so the
    // timeline never plays content from the future.
    let chosen = cursor;
    const next = pool[cursor + 1];
    if (next) {
      const gapBefore = targetTime - (pool[cursor]?.frame.t ?? targetTime);
      const gapAfter = next.frame.t - targetTime;
      if (gapAfter < gapBefore) chosen = cursor + 1;
    }
    const index = pool[chosen]?.index ?? 0;
    indices.push(index);
    if (target > 0 && index === indices[target - 1]) duplicates += 1;
  }

  const timestamps = pool.map((entry) => entry.frame.t);
  let maxGapMs = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    maxGapMs = Math.max(maxGapMs, (timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0));
  }
  const captureSpanMs =
    timestamps.length > 1 ? (timestamps[timestamps.length - 1] ?? 0) - (timestamps[0] ?? 0) : 0;
  const captureFps = captureSpanMs > 0 ? ((timestamps.length - 1) * 1000) / captureSpanMs : 0;

  return {
    indices,
    stats: {
      targetFrames,
      sourceFrames: pool.length,
      duplicateFrames: duplicates,
      maxGapMs: Math.round(maxGapMs),
      captureFps: Math.round(captureFps * 10) / 10,
      belowRequestedRate: captureSpanMs > 0 && captureFps < fps * 0.9,
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
