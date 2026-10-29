import { describe, expect, it } from 'vitest';
import {
  buildEncodeArgs,
  buildPosterFrameArgs,
  buildProbeArgs,
  buildSampleArgs,
} from '@engine/encoding/args';
import { parseFps, parseFfprobeDocument, validateOutput, analyseGreyFrame, analyseSamples } from '@engine/encoding/probe';
import { parseProgressLine, parseTimestamp } from '@engine/encoding/progress';
import { defaultTranslator } from '@shared/i18n';
import type { RenderSettings, VideoMetadata } from '@shared/types';

const settings: RenderSettings = {
  fileName: 'filme.mp4',
  outputDir: 'C:\\out',
  width: 1280,
  height: 720,
  fps: 30,
  duration: { mode: 'manual', seconds: 5 },
  quality: 'balanced',
  container: 'mp4',
  encoder: 'x264',
  fit: 'contain',
};

const metadata: VideoMetadata = {
  codec: 'h264',
  profile: 'High',
  width: 1280,
  height: 720,
  fps: 30,
  pixFmt: 'yuv420p',
  frames: 150,
  durationSeconds: 5,
  bitrate: 800_000,
};

describe('FFmpeg argument construction', () => {
  it('builds a deterministic H.264 encode command', () => {
    const args = buildEncodeArgs({
      inputPattern: 'C:\\tmp\\%06d.jpg',
      outputPath: 'C:\\out\\filme.mp4',
      fps: 30,
      crf: 21,
      x264Preset: 'medium',
      overwrite: false,
    });
    expect(args).toContain('-n');
    expect(args).not.toContain('-y');
    expect(args).toContain('-framerate');
    expect(args[args.indexOf('-framerate') + 1]).toBe('30');
    expect(args[args.indexOf('-start_number') + 1]).toBe('1');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-preset') + 1]).toBe('medium');
    expect(args[args.indexOf('-crf') + 1]).toBe('21');
    expect(args[args.indexOf('-profile:v') + 1]).toBe('high');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-g') + 1]).toBe('60');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(args[args.indexOf('-f') + 1]).toBe('mp4');
    expect(args[args.length - 1]).toBe('C:\\out\\filme.mp4');
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:1');
  });

  it('switches to -y when overwriting and honours a custom start number', () => {
    const args = buildEncodeArgs({
      inputPattern: 'in-%06d.jpg',
      outputPath: 'out.mp4',
      fps: 60,
      crf: 17,
      x264Preset: 'slow',
      overwrite: true,
      startNumber: 7,
    });
    expect(args).toContain('-y');
    expect(args).not.toContain('-n');
    expect(args[args.indexOf('-start_number') + 1]).toBe('7');
    expect(args[args.indexOf('-g') + 1]).toBe('120');
  });

  it('builds probe, sample and poster commands', () => {
    expect(buildProbeArgs({ inputPath: 'filme.mp4' })).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      'filme.mp4',
    ]);
    const sample = buildSampleArgs({ inputPath: 'filme.mp4', atSeconds: 1.23456, width: 320, height: 180 });
    expect(sample[sample.indexOf('-ss') + 1]).toBe('1.235');
    expect(sample[sample.indexOf('-pix_fmt') + 1]).toBe('gray');
    expect(sample[sample.indexOf('-vf') + 1]).toBe('scale=320:180');
    const poster = buildPosterFrameArgs({
      inputPath: 'filme.mp4',
      atSeconds: 2,
      outputPath: 'poster.jpg',
      width: 1280,
    });
    expect(poster[poster.indexOf('-vf') + 1]).toBe('scale=640:-2');
    expect(poster[poster.indexOf('-q:v') + 1]).toBe('3');
    expect(poster[poster.length - 1]).toBe('poster.jpg');
  });
});

describe('ffmpeg progress parsing', () => {
  it('parses frame, time, speed and completion lines', () => {
    expect(parseProgressLine('frame=42')).toEqual({ frame: 42 });
    expect(parseProgressLine('out_time_ms=1500000')).toEqual({ outTimeSeconds: 1.5 });
    expect(parseProgressLine('out_time_us=2500000')).toEqual({ outTimeSeconds: 2.5 });
    expect(parseProgressLine('out_time=00:00:12.345678')).toEqual({ outTimeSeconds: 12.345678 });
    expect(parseProgressLine('speed=1.25x')).toEqual({ speed: 1.25 });
    expect(parseProgressLine('progress=end')).toEqual({ done: true });
    expect(parseProgressLine('progress=continue')).toEqual({ done: false });
  });

  it('ignores unrelated or non-numeric lines', () => {
    expect(parseProgressLine('bitrate= 1234kbits/s')).toBeNull();
    expect(parseProgressLine('frame=N/A')).toBeNull();
    expect(parseProgressLine('no equals sign')).toBeNull();
    expect(parseProgressLine('out_time_ms=not-a-number')).toBeNull();
  });

  it('parses timestamps and rejects malformed ones', () => {
    expect(parseTimestamp('01:02:03.5')).toBe(3723.5);
    expect(parseTimestamp('00:00:00.000000')).toBe(0);
    expect(Number.isNaN(parseTimestamp('12.5'))).toBe(true);
    expect(Number.isNaN(parseTimestamp('aa:bb:cc'))).toBe(true);
  });
});

describe('ffprobe parsing', () => {
  it('chooses the video stream and prefers the average frame rate', () => {
    const parsed = parseFfprobeDocument({
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'h264',
          profile: 'High',
          width: 1280,
          height: 720,
          pix_fmt: 'yuv420p',
          avg_frame_rate: '30000/1001',
          r_frame_rate: '30/1',
          nb_frames: '150',
          duration: '5.005',
        },
      ],
      format: { format_name: 'mov,mp4', duration: '5.0', bit_rate: '800000' },
    });
    expect(parsed.audioStreams).toBe(1);
    expect(parsed.formatName).toBe('mov,mp4');
    expect(parsed.metadata).toMatchObject({
      codec: 'h264',
      profile: 'High',
      width: 1280,
      height: 720,
      pixFmt: 'yuv420p',
      frames: 150,
      durationSeconds: 5,
      bitrate: 800_000,
    });
    expect(parsed.metadata.fps).toBeCloseTo(29.97, 2);
  });

  it('falls back to the real frame rate and format duration', () => {
    const parsed = parseFfprobeDocument({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 640,
          height: 360,
          pix_fmt: 'yuv420p',
          r_frame_rate: '25/1',
          nb_frames: '25',
        },
      ],
      format: { format_name: 'mp4', duration: '1' },
    });
    expect(parsed.metadata.fps).toBe(25);
    expect(parsed.metadata.frames).toBe(25);
    expect(parsed.metadata.durationSeconds).toBe(1);
    expect(parsed.audioStreams).toBe(0);
  });

  it('rejects a document without a video stream', () => {
    expect(() => parseFfprobeDocument({ streams: [{ codec_type: 'audio' }] })).toThrow(/video stream/);
  });

  it('parses frame-rate fractions and rejects invalid ones', () => {
    expect(parseFps('30000/1001')).toEqual({ numerator: 30000, denominator: 1001, value: 30000 / 1001 });
    expect(parseFps('30')).toEqual({ numerator: 30, denominator: 1, value: 30 });
    expect(parseFps('0/0')).toBeNull();
    expect(parseFps('abc')).toBeNull();
    expect(parseFps(undefined)).toBeNull();
  });
});

describe('output validation', () => {
  const base = {
    t: defaultTranslator,
    metadata,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    audioStreams: 0,
    sizeBytes: 1_000_000,
    settings,
    requestedDurationSeconds: 5,
    expectedFrames: 150,
  };

  it('passes every check for a matching file', () => {
    const report = validateOutput(base);
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(9);
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('fails codec, resolution, fps, pixel format and duration mismatches', () => {
    const report = validateOutput({
      ...base,
      metadata: {
        ...metadata,
        codec: 'vp9',
        width: 1920,
        height: 1080,
        fps: 25,
        pixFmt: 'yuv444p',
        durationSeconds: 9,
      },
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
    expect(failed).toEqual(expect.arrayContaining(['codec', 'resolution', 'fps', 'pixel-format', 'duration']));
  });

  it('treats audio and frame-count drift as warnings, not failures', () => {
    const report = validateOutput({
      ...base,
      metadata: { ...metadata, frames: 160 },
      audioStreams: 1,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.id === 'frames')?.status).toBe('warn');
    expect(report.checks.find((check) => check.id === 'audio')?.status).toBe('warn');
  });

  it('fails an empty file and a non-MP4 container', () => {
    const report = validateOutput({ ...base, sizeBytes: 0, formatName: 'matroska,webm' });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'file-size')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'container')?.status).toBe('fail');
  });

  it('skips the frame-count check when ffprobe does not report a count', () => {
    const report = validateOutput({ ...base, metadata: { ...metadata, frames: null } });
    expect(report.checks.map((check) => check.id)).not.toContain('frames');
    expect(report.ok).toBe(true);
  });

  it('allows the documented duration tolerance but not more', () => {
    const inTolerance = validateOutput({ ...base, metadata: { ...metadata, durationSeconds: 5.3 } });
    const outOfTolerance = validateOutput({ ...base, metadata: { ...metadata, durationSeconds: 5.5 } });
    expect(inTolerance.ok).toBe(true);
    expect(outOfTolerance.ok).toBe(false);
  });
});

describe('frame analysis', () => {
  it('detects uniform frames', () => {
    const stats = analyseGreyFrame(new Uint8Array(100).fill(7));
    expect(stats.mean).toBe(7);
    expect(stats.stdDev).toBe(0);
    expect(stats.uniform).toBe(true);
    expect(stats.uniqueBytes).toBe(1);
  });

  it('detects a non-uniform gradient', () => {
    const pixels = new Uint8Array(256);
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index;
    const stats = analyseGreyFrame(pixels);
    expect(stats.uniform).toBe(false);
    expect(stats.uniqueBytes).toBe(256);
    expect(stats.mean).toBeCloseTo(127.5, 1);
  });

  it('handles an empty buffer', () => {
    expect(analyseGreyFrame(new Uint8Array())).toEqual({
      mean: 0,
      stdDev: 0,
      uniform: true,
      uniqueBytes: 0,
      hash: '0',
    });
  });

  it('flags blank and static sample sets', () => {
    const uniform = analyseGreyFrame(new Uint8Array(10).fill(0));
    const varying = analyseGreyFrame(new Uint8Array(10).map((_, index) => index * 10));
    expect(analyseSamples([uniform, uniform]).blank).toBe(true);
    expect(analyseSamples([varying, varying]).staticFrames).toBe(true);
    expect(analyseSamples([varying, uniform]).staticFrames).toBe(false);
    expect(analyseSamples([]).blank).toBe(false);
  });
});
