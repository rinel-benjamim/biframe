import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  MAX_DIMENSION,
  MIN_DIMENSION,
  aspectRatioOf,
  defaultRenderSettings,
  estimateOutputBytes,
  findResolutionPreset,
  fitRect,
  isValidFrameSize,
  qualityPreset,
} from '@shared/presets';
import { defaultAppSettings, mergeAppSettings, validateRenderSettings } from '@shared/settings';

describe('fitRect', () => {
  it('fits a 16:9 page exactly into a 16:9 frame', () => {
    expect(fitRect(1920, 1080, 1280, 720)).toEqual({ width: 1280, height: 720, x: 0, y: 0 });
  });

  it('pillarboxes a portrait page inside a landscape frame', () => {
    const rect = fitRect(1080, 1920, 1920, 1080);
    expect(rect).toEqual({ width: 608, height: 1080, x: 656, y: 0 });
  });

  it('letterboxes a landscape page inside a square frame', () => {
    const rect = fitRect(1280, 720, 1080, 1080);
    expect(rect.width).toBe(1080);
    expect(rect.height).toBe(608);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(236);
  });

  it('uses the whole frame for a zero-sized page', () => {
    expect(fitRect(0, 0, 800, 600)).toEqual({ width: 800, height: 600, x: 0, y: 0 });
  });
});

describe('frame sizes and presets', () => {
  it('accepts even sizes within the supported bounds', () => {
    expect(isValidFrameSize(1280, 720)).toBe(true);
    expect(isValidFrameSize(MIN_DIMENSION, MIN_DIMENSION)).toBe(true);
    expect(isValidFrameSize(MAX_DIMENSION, MAX_DIMENSION)).toBe(true);
  });

  it('rejects odd, fractional or out-of-range sizes', () => {
    expect(isValidFrameSize(1281, 720)).toBe(false);
    expect(isValidFrameSize(1280.5, 720)).toBe(false);
    expect(isValidFrameSize(2, 720)).toBe(false);
    expect(isValidFrameSize(5000, 720)).toBe(false);
  });

  it('finds presets by exact dimensions', () => {
    expect(findResolutionPreset(1280, 720)?.id).toBe('720p');
    expect(findResolutionPreset(1080, 1350)?.id).toBe('social-1080');
    expect(findResolutionPreset(1234, 567)).toBeNull();
  });

  it('derives aspect ratios from dimensions and presets', () => {
    expect(aspectRatioOf(1920, 1080)).toBe('16:9');
    expect(aspectRatioOf(1080, 1920)).toBe('9:16');
    expect(aspectRatioOf(1000, 1000)).toBe('1:1');
    expect(aspectRatioOf(1000, 1240)).toBe('custom');
  });

  it('returns the quality preset and rejects unknown ids', () => {
    expect(qualityPreset('balanced')).toMatchObject({ crf: 21, x264Preset: 'medium' });
    expect(() => qualityPreset('bogus' as 'balanced')).toThrow(/Unknown quality preset/);
  });

  it('estimates more bytes for higher quality and longer videos', () => {
    const compact = estimateOutputBytes(1280, 720, 30, 5, 'compact');
    const high = estimateOutputBytes(1280, 720, 30, 5, 'high');
    const longer = estimateOutputBytes(1280, 720, 30, 10, 'compact');
    expect(high).toBeGreaterThan(compact);
    expect(longer).toBeGreaterThan(compact);
  });

  it('builds default render settings with the expected contract', () => {
    const settings = defaultRenderSettings('C:\\out', 'filme.mp4');
    expect(settings).toMatchObject({
      outputDir: 'C:\\out',
      fileName: 'filme.mp4',
      width: 1280,
      height: 720,
      fps: 60,
      quality: DEFAULT_QUALITY,
      container: 'mp4',
      encoder: 'x264',
      fit: 'contain',
    });
    expect(settings.duration).toEqual({ mode: 'manual', seconds: 10 });
  });
});

describe('render settings validation', () => {
  const valid = defaultRenderSettings('C:\\out');

  it('accepts a complete valid configuration', () => {
    const result = validateRenderSettings(valid);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual(valid);
  });

  it('rejects odd, invalid and unsupported dimensions', () => {
    expect(validateRenderSettings({ ...valid, width: 1281 }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, width: 62 }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, height: 1081 }).ok).toBe(false);
  });

  it('rejects unsupported fps, empty names and invalid durations', () => {
    expect(validateRenderSettings({ ...valid, fps: 23 }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, fileName: '   ' }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, duration: { mode: 'manual', seconds: 0.2 } }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, duration: { mode: 'auto', maxSeconds: 0 } }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, quality: 'ultra' }).ok).toBe(false);
    expect(validateRenderSettings({ ...valid, container: 'mov' }).ok).toBe(false);
  });

  it('reports the field path of the first issue', () => {
    const result = validateRenderSettings({ ...valid, width: 1001 });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.path === 'width')).toBe(true);
  });
});

describe('app settings merge', () => {
  it('defaults to the light theme and safe limits', () => {
    const settings = defaultAppSettings('C:\\output');
    expect(settings.theme).toBe('light');
    expect(settings.allowRemoteResources).toBe(false);
    expect(settings.keepTempFiles).toBe(false);
    expect(settings.limits.maxConcurrentJobs).toBe(1);
  });

  it('keeps valid stored values and repairs invalid ones', () => {
    const settings = mergeAppSettings(
      {
        theme: 'dark',
        allowRemoteResources: false,
        keepTempFiles: true,
        limits: { maxZipEntries: 42 },
      },
      'C:\\fallback',
    );
    expect(settings.theme).toBe('dark');
    expect(settings.allowRemoteResources).toBe(false);
    expect(settings.keepTempFiles).toBe(true);
    expect(settings.limits.maxZipEntries).toBe(42);
    expect(settings.limits.maxProjectBytes).toBe(defaultAppSettings('x').limits.maxProjectBytes);
    expect(settings.defaultOutputDir).toBe('C:\\fallback');
  });

  it('falls back field by field for wrong types', () => {
    const settings = mergeAppSettings(
      {
        theme: 'neon',
        defaultOutputDir: 7,
        allowRemoteResources: 'yes',
        limits: { maxZipEntries: 0, pageLoadTimeoutMs: 1 },
      },
      'C:\\fallback',
    );
    expect(settings.theme).toBe('light');
    expect(settings.defaultOutputDir).toBe('C:\\fallback');
    expect(settings.allowRemoteResources).toBe(false);
    expect(settings.limits.maxZipEntries).toBe(defaultAppSettings('x').limits.maxZipEntries);
    expect(settings.limits.pageLoadTimeoutMs).toBe(defaultAppSettings('x').limits.pageLoadTimeoutMs);
  });

  it('returns defaults for non-object input', () => {
    expect(mergeAppSettings(null, 'C:\\x')).toEqual(defaultAppSettings('C:\\x'));
    expect(mergeAppSettings('broken', 'C:\\x')).toEqual(defaultAppSettings('C:\\x'));
  });
});
