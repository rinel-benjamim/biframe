import { describe, expect, it } from 'vitest';
import { buildFramePlan, frameCountFor, planToRuns, type CapturedFrame } from '@engine/frame-plan';

function frame(t: number): CapturedFrame {
  return { t, file: `frame-${t}.jpg` };
}

describe('frameCountFor', () => {
  it('rounds the frame count and always asks for at least one frame', () => {
    expect(frameCountFor(30, 1000)).toBe(30);
    expect(frameCountFor(30, 36_500)).toBe(1095);
    expect(frameCountFor(60, 33)).toBe(2);
    expect(frameCountFor(30, 0)).toBe(1);
  });
});

describe('buildFramePlan', () => {
  it('picks the frame nearest to every target instant', () => {
    const plan = buildFramePlan({
      frames: [frame(0), frame(100), frame(200)],
      startMs: 0,
      fps: 10,
      durationMs: 500,
    });
    expect(plan.indices).toEqual([0, 1, 2, 2, 2]);
    expect(plan.stats).toMatchObject({
      targetFrames: 5,
      sourceFrames: 3,
      duplicateFrames: 2,
      captureFps: 10,
      belowRequestedRate: false,
    });
  });

  it('picks the next frame when it is strictly closer to the target', () => {
    // Targets fall at 0/100/200 ms; source frames at 0/60/120 ms. The old
    // hold-last rule put every target one capture interval behind the page,
    // which is exactly what stutter during a fast transition looks like.
    const plan = buildFramePlan({
      frames: [frame(0), frame(60), frame(120)],
      startMs: 0,
      fps: 10,
      durationMs: 300,
    });
    expect(plan.indices).toEqual([0, 2, 2]);
  });

  it('maps targets back to the original positions when frames arrive out of order', () => {
    // Disk writes can finish out of order; plan indices must still address the
    // array the store recorded, not a reordered copy of it.
    const plan = buildFramePlan({
      frames: [frame(200), frame(0), frame(100)],
      startMs: 0,
      fps: 10,
      durationMs: 500,
    });
    expect(plan.indices).toEqual([1, 2, 0, 0, 0]);
    expect(plan.stats).toMatchObject({ sourceFrames: 3, captureFps: 10, belowRequestedRate: false });
  });

  it('flags a capture clearly slower than the requested rate', () => {
    const plan = buildFramePlan({
      frames: [frame(0), frame(200)],
      startMs: 0,
      fps: 10,
      durationMs: 500,
    });
    expect(plan.indices).toEqual([0, 0, 1, 1, 1]);
    expect(plan.stats.captureFps).toBe(5);
    expect(plan.stats.belowRequestedRate).toBe(true);
  });

  it('flags a capture below 90% of the requested rate', () => {
    // 9 source frames over 1000 ms = 8 fps against a 10 fps request: still
    // comfortable for the old 75% rule, but short of what the user asked for.
    const frames = [0, 125, 250, 375, 500, 625, 750, 875, 1000].map(frame);
    const plan = buildFramePlan({ frames, startMs: 0, fps: 10, durationMs: 1000 });
    expect(plan.stats.captureFps).toBe(8);
    expect(plan.stats.belowRequestedRate).toBe(true);
  });

  it('discards frames captured before the animation start', () => {
    const plan = buildFramePlan({
      frames: [frame(900), frame(1000), frame(1100), frame(1200)],
      startMs: 1000,
      fps: 10,
      durationMs: 300,
    });
    // Indices address the original array: target 1000 ms must materialise the
    // frame recorded at position 1, not the pre-start frame at position 0.
    expect(plan.indices).toEqual([1, 2, 3]);
    expect(plan.stats.sourceFrames).toBe(3);
  });

  it('repeats the first usable frame when the stream starts late', () => {
    const plan = buildFramePlan({
      frames: [frame(1000)],
      startMs: 900,
      fps: 10,
      durationMs: 300,
    });
    expect(plan.indices).toEqual([0, 0, 0]);
    expect(plan.stats.duplicateFrames).toBe(2);
  });

  it('returns an empty plan when no frame was captured', () => {
    const plan = buildFramePlan({ frames: [], startMs: 0, fps: 30, durationMs: 1000 });
    expect(plan.indices).toEqual([]);
    expect(plan.stats).toMatchObject({ sourceFrames: 0, captureFps: 0, belowRequestedRate: true });
  });

  it('never asks for more source frames than exist', () => {
    const plan = buildFramePlan({
      frames: [frame(0), frame(40), frame(80)],
      startMs: 0,
      fps: 30,
      durationMs: 500,
    });
    expect(plan.indices).toHaveLength(15);
    expect(Math.max(...plan.indices)).toBe(2);
  });

  it('measures the real capture rate from the source timestamps', () => {
    const plan = buildFramePlan({
      frames: [frame(0), frame(33), frame(66), frame(99), frame(132)],
      startMs: 0,
      fps: 30,
      durationMs: 132,
    });
    expect(plan.stats.captureFps).toBeCloseTo(30.3, 1);
    expect(plan.stats.belowRequestedRate).toBe(false);
    expect(plan.stats.maxGapMs).toBe(33);
  });
});

describe('planToRuns', () => {
  it('collapses consecutive duplicates into runs', () => {
    expect(planToRuns([0, 0, 1, 1, 1, 2])).toEqual([
      { index: 0, repeat: 2 },
      { index: 1, repeat: 3 },
      { index: 2, repeat: 1 },
    ]);
  });

  it('returns no runs for an empty plan', () => {
    expect(planToRuns([])).toEqual([]);
  });
});
