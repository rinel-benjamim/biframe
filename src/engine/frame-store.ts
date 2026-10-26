import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CapturedFrame, FramePlan } from './frame-plan';
import { planToRuns } from './frame-plan';

/**
 * Owns the temporary frame storage of one render:
 *
 *   <job>/raw/frame-000001.jpg   frames as they were captured (real time)
 *   <job>/cfr/000001.jpg         constant-rate sequence handed to FFmpeg
 *
 * Duplicate target frames are materialised as hard links, so a 60 fps render of
 * a slow animation costs one file, not three. Nothing here touches the output
 * directory.
 */
export class FrameStore {
  readonly root: string;
  readonly rawDir: string;
  readonly cfrDir: string;
  private captured: CapturedFrame[] = [];
  private extension: 'jpg' | 'png' = 'jpg';

  constructor(root: string) {
    this.root = root;
    this.rawDir = path.join(root, 'raw');
    this.cfrDir = path.join(root, 'cfr');
  }

  async init(): Promise<void> {
    await fsp.rm(this.root, { recursive: true, force: true });
    await fsp.mkdir(this.rawDir, { recursive: true });
    await fsp.mkdir(this.cfrDir, { recursive: true });
  }

  setExtension(extension: 'jpg' | 'png'): void {
    this.extension = extension;
  }

  get frames(): readonly CapturedFrame[] {
    return this.captured;
  }

  get frameCount(): number {
    return this.captured.length;
  }

  /** Persists one captured frame and records its timestamp. Called per frame. */
  async writeFrame(data: Buffer, timestamp: number): Promise<CapturedFrame> {
    const index = this.captured.length + 1;
    const file = path.join(this.rawDir, `frame-${String(index).padStart(6, '0')}.${this.extension}`);
    await fsp.writeFile(file, data);
    const frame: CapturedFrame = { t: timestamp, file };
    this.captured.push(frame);
    return frame;
  }

  /** Discards frames captured before the animation start instant. */
  dropFramesBefore(startMs: number): number {
    const kept = this.captured.filter((frame) => frame.t >= startMs);
    const dropped = this.captured.length - kept.length;
    this.captured = kept;
    return dropped;
  }

  /** Pattern FFmpeg will read, e.g. `.../cfr/%06d.jpg`. */
  get cfrPattern(): string {
    return path.join(this.cfrDir, `%06d.${this.extension}`);
  }

  /**
   * Materialises exactly `plan.indices.length` files (1-based, matching the
   * `%06d` pattern) and returns how many were hard links instead of copies.
   */
  async materialize(plan: FramePlan): Promise<{ count: number; hardLinks: number; copies: number }> {
    let hardLinks = 0;
    let copies = 0;
    let target = 0;
    for (const run of planToRuns(plan.indices)) {
      const source = this.captured[run.index];
      if (!source) continue;
      for (let repeat = 0; repeat < run.repeat; repeat += 1) {
        target += 1;
        const destination = path.join(this.cfrDir, `${String(target).padStart(6, '0')}.${this.extension}`);
        try {
          await fsp.link(source.file, destination);
          hardLinks += 1;
        } catch {
          await fsp.copyFile(source.file, destination);
          copies += 1;
        }
      }
    }
    return { count: target, hardLinks, copies };
  }

  async usedBytes(): Promise<number> {
    let total = 0;
    for (const frame of this.captured) {
      try {
        const stat = await fsp.stat(frame.file);
        total += stat.size;
      } catch {
        // A frame may already have been removed by a cleanup; ignore.
      }
    }
    return total;
  }

  async cleanup(): Promise<void> {
    await fsp.rm(this.root, { recursive: true, force: true });
    this.captured = [];
  }
}

/** Free space of the volume that holds `target`, in bytes (null when unavailable). */
export async function freeSpaceBytes(target: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(target);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
