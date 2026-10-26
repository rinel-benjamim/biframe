import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Diagnostic, RenderProgress, RenderSettings, ResourceLimits } from '@shared/types';
import type {
  CaptureSession,
  CaptureSessionHost,
  CaptureSessionOptions,
  FramePacket,
  LoadOutcome,
  MarkStartResult,
} from '@engine/capture/types';
import { resolveOutputPath, runRenderPipeline } from '@engine/render/pipeline';
import { CancellationToken, delay } from '@engine/render/token';
import { emptyInspection, type PageInspection } from '@engine/diagnostics';
import { emptyDescriptor, type ProtocolDescriptor } from '@shared/protocol';
import { runBinary, resolveFfmpeg } from '@engine/media/binaries';

/**
 * These tests exercise the real render pipeline: real FFmpeg, real frame files
 * on disk, real ffprobe validation and poster extraction. Only Chromium is
 * replaced by a scripted capture host, because launching a second Electron
 * instance from Vitest is covered by the Playwright suite.
 */

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string;
const ffprobePath = (require('ffprobe-static') as { path: string }).path;

const root = path.resolve('.test-out', 'integration', 'pipeline');
const framesSource = path.join(root, 'source-frames');
const outputs = path.join(root, 'outputs');
const tempRoot = path.join(root, 'temp');
const posterRoot = path.join(root, 'posters');

const limits: ResourceLimits = {
  maxProjectBytes: 40 * 1024 * 1024,
  maxZipEntries: 200,
  maxDurationSeconds: 20,
  maxConcurrentJobs: 1,
  pageLoadTimeoutMs: 20_000,
  browserLaunchTimeoutMs: 20_000,
};

const ENTRY_URL = 'http://127.0.0.1:9/index.html';
const FPS = 24;

let jpegs: Buffer[] = [];

interface FakeSessionOptions {
  protocol?: ProtocolDescriptor;
  inspection?: Partial<PageInspection>;
  frameIntervalMs?: number;
}

class FakeSession implements CaptureSession {
  readonly options: CaptureSessionOptions;
  readonly frames: FakeSessionOptions;
  readonly diagnosticsList: Diagnostic[] = [];
  private onFrame: ((frame: FramePacket) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private cursor = 0;
  private startedAt = 0;
  closed = false;
  loadCount = 0;
  stopCount = 0;
  markCount = 0;

  constructor(options: CaptureSessionOptions, frames: FakeSessionOptions) {
    this.options = options;
    this.frames = frames;
  }

  private emitFrame(): void {
    if (!this.onFrame || jpegs.length === 0) return;
    const jpeg = jpegs[this.cursor % jpegs.length] as Buffer;
    this.cursor += 1;
    this.onFrame({ t: Date.now(), base64: jpeg.toString('base64') });
  }

  async load(_url: string, _options: { timeoutMs: number }): Promise<LoadOutcome> {
    this.loadCount += 1;
    return { ok: true, loadMs: 12, url: _url };
  }

  async inspect(): Promise<PageInspection> {
    return emptyInspection({
      readyState: 'complete',
      title: 'Fake project',
      fontsStatus: 'loaded',
      protocolDurationSeconds: this.frames.protocol?.durationSeconds ?? null,
      protocolPresent: this.frames.protocol?.present ?? false,
      ...this.frames.inspection,
    });
  }

  async startFrameStream(options: { fps: number; onFrame: (frame: FramePacket) => void }): Promise<void> {
    this.onFrame = options.onFrame;
    // Deliver a little faster than the target rate so the resampler always has
    // a real frame for each output instant.
    const interval = this.frames.frameIntervalMs ?? Math.max(20, Math.floor(1000 / (options.fps * 1.6)));
    this.emitFrame();
    this.timer = setInterval(() => this.emitFrame(), interval);
  }

  async stopFrameStream(): Promise<void> {
    this.stopCount += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onFrame = null;
  }

  async reloadAndMarkStart(_options: { timeoutMs: number }): Promise<MarkStartResult> {
    this.markCount += 1;
    // Give the stream two pre-start frames, as a real reload does.
    await delay(90);
    this.startedAt = Date.now();
    return {
      startMs: this.startedAt,
      protocol: this.frames.protocol ?? emptyDescriptor(),
      pageUrl: ENTRY_URL,
    };
  }

  async waitForCompletion(timeoutMs: number, token: CancellationToken): Promise<'signalled' | 'timeout' | 'cancelled'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (token.cancelled) return 'cancelled';
      if (!(await delay(25, token))) return 'cancelled';
    }
    return 'timeout';
  }

  async screenshot(): Promise<Buffer | null> {
    return null;
  }

  diagnostics(): Diagnostic[] {
    return this.diagnosticsList;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onFrame = null;
  }
}

class FakeHost implements CaptureSessionHost {
  readonly sessions: FakeSession[] = [];

  constructor(private readonly options: FakeSessionOptions = {}) {}

  async createSession(options: CaptureSessionOptions): Promise<CaptureSession> {
    const session = new FakeSession(options, this.options);
    this.sessions.push(session);
    return session;
  }
}

function settingsFor(overrides: Partial<RenderSettings> = {}): RenderSettings {
  return {
    fileName: 'pipeline-test.mp4',
    outputDir: outputs,
    width: 320,
    height: 180,
    fps: FPS,
    duration: { mode: 'manual', seconds: 1 },
    quality: 'compact',
    container: 'mp4',
    encoder: 'x264',
    fit: 'contain',
    ...overrides,
  };
}

async function probe(outputPath: string): Promise<{
  streams: { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; nb_frames?: string }[];
  format: { duration?: string; size?: string; format_name?: string };
}> {
  const result = await runBinary(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    outputPath,
  ]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as {
    streams: { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; nb_frames?: string }[];
    format: { duration?: string; size?: string; format_name?: string };
  };
}

function render(
  jobId: string,
  host: FakeHost,
  options: {
    settings?: Partial<RenderSettings>;
    token?: CancellationToken;
    overwrite?: boolean;
    allowRemote?: boolean;
    onProgress?: (progress: RenderProgress) => void;
    keepTempFiles?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof runRenderPipeline>>> {
  return runRenderPipeline(
    {
      jobId,
      entryUrl: ENTRY_URL,
      settings: settingsFor(options.settings),
      limits,
      tempRoot,
      posterRoot,
      allowRemote: options.allowRemote ?? false,
      keepTempFiles: options.keepTempFiles ?? false,
      overwrite: options.overwrite ?? false,
    },
    {
      host,
      token: options.token ?? new CancellationToken(),
      emit: options.onProgress ?? (() => undefined),
    },
  );
}

beforeAll(async () => {
  if (!ffmpegPath || !ffprobePath) throw new Error('bundled media binaries are missing');
  // engine/media/binaries.ts uses require(); under Vitest's ESM runtime the
  // explicit overrides are the supported path (documented for tests).
  process.env.BIFRAME_FFMPEG_PATH = ffmpegPath;
  process.env.BIFRAME_FFPROBE_PATH = ffprobePath;

  const resolved = await resolveFfmpeg();
  expect(resolved.source).toBe('bundled');

  for (const directory of [framesSource, outputs, tempRoot, posterRoot]) {
    await fsp.rm(directory, { recursive: true, force: true });
    await fsp.mkdir(directory, { recursive: true });
  }

  const generated = await runBinary(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=320x180:rate=${FPS}:duration=1`,
    '-frames:v',
    String(FPS),
    '-q:v',
    '3',
    path.join(framesSource, 'frame-%03d.jpg'),
  ]);
  expect(generated.code).toBe(0);
  const names = (await fsp.readdir(framesSource)).filter((name) => name.endsWith('.jpg')).sort();
  expect(names.length).toBe(FPS);
  jpegs = await Promise.all(names.map((name) => fsp.readFile(path.join(framesSource, name))));
  expect(jpegs[0]?.length).toBeGreaterThan(100);
}, 60_000);

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('runRenderPipeline', () => {
  it('produces a validated H.264 MP4 and real posters from a capture stream', async () => {
    const host = new FakeHost();
    const progress: RenderProgress[] = [];
    const jobId = 'success';
    const outputPath = resolveOutputPath(settingsFor());

    const result = await render(jobId, host, { onProgress: (item) => progress.push(item) });

    expect(result.outputPath).toBe(outputPath);
    expect(result.fileName).toBe('pipeline-test.mp4');
    expect(result.metadata.codec).toBe('h264');
    expect(result.metadata.width).toBe(320);
    expect(result.metadata.height).toBe(180);
    expect(result.metadata.fps).toBe(FPS);
    expect(result.metadata.pixFmt).toBe('yuv420p');
    expect(result.metadata.frames).toBe(FPS);
    expect(result.metadata.durationSeconds).toBeCloseTo(1, 1);
    expect(result.sizeBytes).toBeGreaterThan(1000);
    expect(result.validation.ok).toBe(true);
    expect(result.validation.checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(result.posterFrames).toHaveLength(5);
    for (const poster of result.posterFrames) {
      expect((await fsp.stat(poster)).size).toBeGreaterThan(100);
    }

    const phases = progress.map((item) => item.phase);
    expect(phases[0]).toBe('preparing');
    for (const expected of ['launching', 'loading', 'capturing', 'resampling', 'encoding', 'validating', 'completed']) {
      expect(phases).toContain(expected);
    }
    const final = progress[progress.length - 1];
    expect(final?.percent).toBe(100);
    expect(final?.frames).toEqual({ captured: FPS, target: FPS });
    for (const item of progress) {
      if (item.percent !== null) {
        expect(item.percent).toBeGreaterThanOrEqual(0);
        expect(item.percent).toBeLessThanOrEqual(100);
      }
    }

    // One session per render, closed after the result was produced.
    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0]?.closed).toBe(true);
    expect(host.sessions[0]?.markCount).toBe(1);

    const info = await probe(outputPath);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(video?.codec_name).toBe('h264');
    expect(video?.pix_fmt).toBe('yuv420p');
    expect(video?.width).toBe(320);
    expect(video?.height).toBe(180);
    expect(info.format.format_name).toContain('mp4');

    // The temporary frames are removed when keepTempFiles is false.
    await expect(fsp.access(path.join(tempRoot, jobId))).rejects.toThrow();
  });

  it('uses the duration declared by the page protocol in automatic mode', async () => {
    const protocol: ProtocolDescriptor = { ...emptyDescriptor(), present: true, durationSeconds: 0.75, ready: true };
    const host = new FakeHost({ protocol, inspection: { protocolDurationSeconds: 0.75, protocolPresent: true } });
    const progress: RenderProgress[] = [];
    const settings = settingsFor({
      fileName: 'auto-protocol.mp4',
      duration: { mode: 'auto', maxSeconds: 10 },
      fps: 24,
    });

    const result = await render('auto', host, {
      settings,
      onProgress: (item) => progress.push(item),
    });

    expect(result.metadata.durationSeconds).toBeCloseTo(0.75, 1);
    expect(result.metadata.frames).toBe(18);
    expect(result.validation.ok).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'PAGE_WARNING' && item.detail === '0.75 s')).toBe(true);
    // The protocol duration means the pipeline never waits for completion.
    expect(progress.some((item) => item.message.includes('sinalize o fim'))).toBe(false);
  });

  it('reports OUTPUT_EXISTS without creating a session or touching the file', async () => {
    const fileName = 'exists.mp4';
    const settings = settingsFor({ fileName });
    const outputPath = resolveOutputPath(settings);
    await fsp.writeFile(outputPath, 'do-not-replace');
    const host = new FakeHost();

    await expect(render('exists', host, { settings })).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });

    expect(host.sessions).toHaveLength(0);
    expect(await fsp.readFile(outputPath, 'utf8')).toBe('do-not-replace');
  });

  it('replaces an existing file when overwrite is explicit', async () => {
    const fileName = 'overwrite.mp4';
    const settings = settingsFor({ fileName });
    const outputPath = resolveOutputPath(settings);
    await fsp.writeFile(outputPath, 'stale');
    const host = new FakeHost();

    const result = await render('overwrite', host, { settings, overwrite: true });

    expect(result.validation.ok).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(1000);
    expect((await fsp.readFile(outputPath, 'utf8')).slice(0, 4)).not.toBe('stal');
  });

  it('cancels during capture, produces no MP4 and removes temporary frames', async () => {
    const token = new CancellationToken();
    const host = new FakeHost();
    const jobId = 'cancel';
    const settings = settingsFor({ fileName: 'cancelled.mp4', duration: { mode: 'manual', seconds: 5 } });
    const outputPath = resolveOutputPath(settings);

    const pending = render(jobId, host, { settings, token });
    setTimeout(() => token.cancel('test cancellation'), 450);

    await expect(pending).rejects.toMatchObject({ code: 'RENDER_CANCELLED' });

    await expect(fsp.access(outputPath)).rejects.toThrow();
    await expect(fsp.access(path.join(tempRoot, jobId))).rejects.toThrow();
    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0]?.closed).toBe(true);
  });
});
