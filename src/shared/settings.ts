import { z } from 'zod';
import { DEFAULT_LANGUAGE, LANGUAGES } from './i18n';
import { FPS_OPTIONS, MAX_DIMENSION, MAX_DURATION_SECONDS, MIN_DIMENSION, MIN_DURATION_SECONDS } from './presets';
import type { AppSettings, RenderSettings, ResourceLimits } from './types';

export const DEFAULT_LIMITS: ResourceLimits = {
  maxProjectBytes: 500 * 1024 * 1024,
  maxZipEntries: 5_000,
  maxDurationSeconds: MAX_DURATION_SECONDS,
  maxConcurrentJobs: 1,
  pageLoadTimeoutMs: 60_000,
  browserLaunchTimeoutMs: 30_000,
};

const evenDimension = z
  .number()
  .int()
  .min(MIN_DIMENSION)
  .max(MAX_DIMENSION)
  .refine((value) => value % 2 === 0, { message: 'The dimension must be an even number.' });

export const durationSettingSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('manual'),
    seconds: z.number().min(MIN_DURATION_SECONDS).max(MAX_DURATION_SECONDS),
  }),
  z.object({
    mode: z.literal('auto'),
    maxSeconds: z.number().min(1).max(MAX_DURATION_SECONDS),
  }),
]);

export const renderSettingsSchema = z.object({
  fileName: z
    .string()
    .min(1)
    .max(160)
    .refine((value) => value.trim().length > 0, { message: 'The file name cannot be empty.' }),
  outputDir: z.string().min(1),
  width: evenDimension,
  height: evenDimension,
  fps: z.number().int().refine((value) => (FPS_OPTIONS as readonly number[]).includes(value), {
    message: 'Unsupported frame rate.',
  }),
  duration: durationSettingSchema,
  quality: z.enum(['compact', 'balanced', 'high']),
  container: z.literal('mp4'),
  encoder: z.literal('x264'),
  fit: z.literal('contain'),
});

export const resourceLimitsSchema = z.object({
  maxProjectBytes: z.number().int().min(1024).max(4 * 1024 * 1024 * 1024),
  maxZipEntries: z.number().int().min(1).max(200_000),
  maxDurationSeconds: z.number().min(1).max(MAX_DURATION_SECONDS),
  maxConcurrentJobs: z.number().int().min(1).max(4),
  pageLoadTimeoutMs: z.number().int().min(5_000).max(300_000),
  browserLaunchTimeoutMs: z.number().int().min(5_000).max(120_000),
});

export const appSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  language: z.enum(LANGUAGES),
  defaultOutputDir: z.string(),
  allowRemoteResources: z.boolean(),
  openResultAfterRender: z.boolean(),
  keepTempFiles: z.boolean(),
  limits: resourceLimitsSchema,
});

export function defaultAppSettings(defaultOutputDir: string): AppSettings {
  return {
    theme: 'light',
    language: DEFAULT_LANGUAGE,
    defaultOutputDir,
    allowRemoteResources: false,
    openResultAfterRender: false,
    keepTempFiles: false,
    limits: { ...DEFAULT_LIMITS },
  };
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: { path: string; message: string }[];
}

function toResult<T>(parsed: z.ZodSafeParseResult<T>): ValidationResult<T> {
  if (parsed.success) return { ok: true, value: parsed.data, issues: [] };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

export function validateRenderSettings(input: unknown): ValidationResult<RenderSettings> {
  return toResult(renderSettingsSchema.safeParse(input));
}

export function validateAppSettings(input: unknown): ValidationResult<AppSettings> {
  return toResult(appSettingsSchema.safeParse(input));
}

/** Merges stored settings with defaults, dropping anything invalid field by field. */
export function mergeAppSettings(stored: unknown, defaultOutputDir: string): AppSettings {
  const defaults = defaultAppSettings(defaultOutputDir);
  if (typeof stored !== 'object' || stored === null) return defaults;
  const candidate = stored as Partial<AppSettings>;
  const merged: AppSettings = {
    theme: candidate.theme === 'light' || candidate.theme === 'dark' || candidate.theme === 'system' ? candidate.theme : defaults.theme,
    language: candidate.language === 'pt' || candidate.language === 'en' ? candidate.language : defaults.language,
    defaultOutputDir: typeof candidate.defaultOutputDir === 'string' && candidate.defaultOutputDir ? candidate.defaultOutputDir : defaults.defaultOutputDir,
    allowRemoteResources: typeof candidate.allowRemoteResources === 'boolean' ? candidate.allowRemoteResources : defaults.allowRemoteResources,
    openResultAfterRender: typeof candidate.openResultAfterRender === 'boolean' ? candidate.openResultAfterRender : defaults.openResultAfterRender,
    keepTempFiles: typeof candidate.keepTempFiles === 'boolean' ? candidate.keepTempFiles : defaults.keepTempFiles,
    limits: { ...defaults.limits, ...(typeof candidate.limits === 'object' && candidate.limits ? candidate.limits : {}) },
  };
  const validated = validateAppSettings(merged);
  if (validated.ok && validated.value) {
    const limits = resourceLimitsSchema.safeParse(merged.limits);
    return limits.success ? { ...validated.value, limits: limits.data } : { ...validated.value, limits: defaults.limits };
  }
  return defaults;
}
