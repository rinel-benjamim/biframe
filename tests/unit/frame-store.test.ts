import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameStore } from '@engine/frame-store';

/**
 * The store is written to by an asynchronous capture loop: several frames can
 * be in flight at the same time. These tests pin down the two invariants that
 * keep the timeline honest under that pressure.
 */
describe('FrameStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'biframe-frame-store-'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('gives every frame its own file even when writes overlap', async () => {
    const store = new FrameStore(root);
    await store.init();

    const results = await Promise.all([
      store.writeFrame(Buffer.from('first'), 10),
      store.writeFrame(Buffer.from('second'), 20),
      store.writeFrame(Buffer.from('third'), 30),
    ]);

    // Three distinct paths: no frame was silently overwritten by another.
    expect(new Set(results.map((frame) => frame.file)).size).toBe(3);
    expect(store.frameCount).toBe(3);
    // Records are appended in arrival order, so the timeline stays monotonic
    // even if the disk writes finish out of order.
    expect(store.frames.map((frame) => frame.t)).toEqual([10, 20, 30]);
    expect(results.map((frame) => path.basename(frame.file))).toEqual([
      'frame-000001.jpg',
      'frame-000002.jpg',
      'frame-000003.jpg',
    ]);
    await expect(fsp.readFile(results[0]!.file, 'utf8')).resolves.toBe('first');
    await expect(fsp.readFile(results[1]!.file, 'utf8')).resolves.toBe('second');
    await expect(fsp.readFile(results[2]!.file, 'utf8')).resolves.toBe('third');
  });

  it('resets the frame list and the file counter on init', async () => {
    const store = new FrameStore(root);
    await store.init();
    await store.writeFrame(Buffer.from('old'), 5);

    await store.init();

    expect(store.frameCount).toBe(0);
    const again = await store.writeFrame(Buffer.from('new'), 6);
    expect(path.basename(again.file)).toBe('frame-000001.jpg');
    await expect(fsp.readFile(again.file, 'utf8')).resolves.toBe('new');
  });

  it('honours the configured extension when naming frames', async () => {
    const store = new FrameStore(root);
    await store.init();
    store.setExtension('png');

    const frame = await store.writeFrame(Buffer.from('png'), 1);
    expect(path.basename(frame.file)).toBe('frame-000001.png');
  });
});
