import type { Translator } from '@shared/i18n';
import type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from '@shared/types';

/**
 * Diagnostics are observations, not exceptions: a missing font is a warning,
 * an unloadable page is an error. The collector deduplicates by code + resource
 * so a page that fails the same image fifty times produces one line.
 */
export interface DiagnosticInput {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  detail?: string;
  url?: string;
}

export interface DiagnosticCounts {
  info: number;
  warning: number;
  error: number;
}

let counter = 0;

function nextId(): string {
  counter += 1;
  return `d${counter.toString(36)}`;
}

export class DiagnosticCollector {
  private items: Diagnostic[] = [];
  private seen = new Set<string>();
  private readonly maxItems: number;

  constructor(maxItems = 250) {
    this.maxItems = maxItems;
  }

  add(input: DiagnosticInput, options: { dedupe?: boolean } = {}): Diagnostic | null {
    const key = `${input.code}|${input.url ?? input.message}`;
    if (options.dedupe !== false) {
      if (this.seen.has(key)) return null;
      this.seen.add(key);
    }
    if (this.items.length >= this.maxItems) return null;
    const diagnostic: Diagnostic = {
      id: nextId(),
      code: input.code,
      severity: input.severity,
      message: input.message,
      at: Date.now(),
    };
    if (input.detail) diagnostic.detail = input.detail;
    if (input.url) diagnostic.url = input.url;
    this.items.push(diagnostic);
    return diagnostic;
  }

  addAll(diagnostics: Diagnostic[]): void {
    for (const diagnostic of diagnostics) {
      if (this.items.length >= this.maxItems) return;
      const key = `${diagnostic.code}|${diagnostic.url ?? diagnostic.message}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.items.push(diagnostic);
    }
  }

  get all(): Diagnostic[] {
    return [...this.items];
  }

  get counts(): DiagnosticCounts {
    const counts: DiagnosticCounts = { info: 0, warning: 0, error: 0 };
    for (const item of this.items) counts[item.severity] += 1;
    return counts;
  }

  get hasErrors(): boolean {
    return this.items.some((item) => item.severity === 'error');
  }

  clear(): void {
    this.items = [];
    this.seen.clear();
  }
}

/** Chromium console levels: 0 verbose, 1 info, 2 warning, 3 error (Electron 30+). */
export function consoleLevelToSeverity(level: string | number): DiagnosticSeverity | null {
  const numeric = typeof level === 'number' ? level : Number(level);
  if (Number.isFinite(numeric)) {
    if (numeric >= 3) return 'error';
    if (numeric === 2) return 'warning';
    return null;
  }
  if (level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  return null;
}

export function consoleDiagnosticInput(
  t: Translator,
  level: string | number,
  message: string,
  source?: string,
  line?: number,
): DiagnosticInput | null {
  // Electron injects its own security advice into development consoles. It is
  // not the page speaking, it appears on every project, and the production
  // build does not show it; keeping it would make the panel cry wolf.
  if (message.includes('Electron Security Warning')) return null;
  const severity = consoleLevelToSeverity(level);
  if (severity === null) return null;
  const location = source ? `${source}${line ? `:${line}` : ''}` : undefined;
  return {
    code: severity === 'error' ? 'CONSOLE_ERROR' : 'PAGE_WARNING',
    severity,
    message: severity === 'error' ? t('diag.consoleError') : t('diag.consoleWarning'),
    detail: location ? `${message} (${location})` : message,
  };
}

export interface ResourceFailure {
  url: string;
  error: string;
  /** Chromium resource type, when known. */
  resourceType?: string;
}

export function resourceFailureInput(t: Translator, failure: ResourceFailure): DiagnosticInput {
  const isFont = /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(failure.url) || failure.resourceType === 'Font';
  const isImage = failure.resourceType === 'Image' || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(failure.url);
  return {
    code: isFont ? 'FONT_FALLBACK' : isImage ? 'MISSING_RESOURCE' : 'MISSING_RESOURCE',
    severity: 'warning',
    message: isFont ? t('diag.fontFallback') : isImage ? t('diag.imageMissing') : t('diag.resourceMissing'),
    detail: `${failure.error}${failure.resourceType ? ` (${failure.resourceType})` : ''}`,
    url: failure.url,
  };
}

export interface PageInspection {
  readyState: string;
  title: string;
  fontsStatus: string;
  brokenImages: { src: string; alt: string }[];
  failedImageCount: number;
  resourceCount: number;
  hasRemoteResources: boolean;
  remoteHosts: string[];
  scriptErrorCount: number;
  /** requestAnimationFrame calls counted by the instrumentation. */
  rafCalls: number;
  /** setTimeout calls counted by the instrumentation. */
  timerCalls: number;
  protocolDurationSeconds: number | null;
  protocolPresent: boolean;
  captureStartSeconds: number | null;
  captureEndSeconds: number | null;
  mediaElementCount: number;
  playingMediaCount: number;
  bodyBackground: string | null;
}

export function emptyInspection(overrides: Partial<PageInspection> = {}): PageInspection {
  return {
    readyState: 'unknown',
    title: '',
    fontsStatus: 'n/a',
    brokenImages: [],
    failedImageCount: 0,
    resourceCount: 0,
    hasRemoteResources: false,
    remoteHosts: [],
    scriptErrorCount: 0,
    rafCalls: 0,
    timerCalls: 0,
    protocolDurationSeconds: null,
    protocolPresent: false,
    captureStartSeconds: null,
    captureEndSeconds: null,
    mediaElementCount: 0,
    playingMediaCount: 0,
    bodyBackground: null,
    ...overrides,
  };
}

export function inspectionDiagnostics(t: Translator, inspection: PageInspection): DiagnosticInput[] {
  const diagnostics: DiagnosticInput[] = [];
  if (inspection.brokenImages.length > 0) {
    for (const image of inspection.brokenImages.slice(0, 12)) {
      diagnostics.push({
        code: 'MISSING_RESOURCE',
        severity: 'warning',
        message: t('diag.imageMissing'),
        detail: image.alt ? `alt="${image.alt}"` : undefined,
        url: image.src,
      });
    }
  }
  if (inspection.fontsStatus !== 'loaded' && inspection.fontsStatus !== 'n/a') {
    diagnostics.push({
      code: 'FONT_FALLBACK',
      severity: 'warning',
      message: t('diag.fontsNotLoaded'),
      detail: `document.fonts.status = ${inspection.fontsStatus}`,
    });
  }
  if (inspection.hasRemoteResources) {
    diagnostics.push({
      code: 'REMOTE_RESOURCES',
      severity: 'info',
      message: t('diag.remoteResources'),
      detail: inspection.remoteHosts.slice(0, 8).join(', '),
    });
  }
  if (inspection.scriptErrorCount > 0) {
    diagnostics.push({
      code: 'SCRIPT_ERROR',
      severity: 'warning',
      message: t('diag.scriptErrors'),
      detail: t('diag.scriptErrorsDetail', { count: inspection.scriptErrorCount }),
    });
  }
  if (inspection.protocolPresent && inspection.protocolDurationSeconds !== null) {
    diagnostics.push({
      code: 'PAGE_WARNING',
      severity: 'info',
      message: t('diag.protocolDuration'),
      detail: `${inspection.protocolDurationSeconds} s`,
    });
  }
  if (inspection.mediaElementCount > 0) {
    diagnostics.push({
      code: 'AUDIO_UNSUPPORTED',
      severity: 'info',
      message: t('diag.mediaElements'),
      detail: t('diag.mediaElementsDetail', {
        elements: inspection.mediaElementCount,
        playing: inspection.playingMediaCount,
      }),
    });
  }
  if (inspection.captureStartSeconds !== null || inspection.captureEndSeconds !== null) {
    diagnostics.push({
      code: 'PAGE_WARNING',
      severity: 'info',
      message: t('diag.captureWindow'),
      detail: t('diag.captureWindowDetail', {
        start: inspection.captureStartSeconds ?? 0,
        end: inspection.captureEndSeconds ?? '—',
      }),
    });
  }
  return diagnostics;
}

export function stillFramesInput(
  t: Translator,
  analysis: { blank: boolean; staticFrames: boolean; samples: { mean: number; stdDev: number }[] },
): DiagnosticInput[] {
  const diagnostics: DiagnosticInput[] = [];
  if (analysis.blank) {
    diagnostics.push({
      code: 'BLANK_FRAMES',
      severity: 'warning',
      message: t('diag.blankFrames'),
      detail: t('diag.blankFramesDetail', {
        means: analysis.samples.map((sample) => sample.mean).join(', '),
      }),
    });
  } else if (analysis.staticFrames) {
    diagnostics.push({
      code: 'STATIC_FRAMES',
      severity: 'warning',
      message: t('diag.staticFrames'),
      detail: t('diag.staticFramesDetail'),
    });
  }
  return diagnostics;
}

/** Aggregates a collector plus transient inputs into the array sent to the UI. */
export function mergeDiagnostics(collector: DiagnosticCollector, extra: DiagnosticInput[]): Diagnostic[] {
  const snapshot = collector.all;
  const items = [...snapshot];
  const seen = new Set(snapshot.map((item) => `${item.code}|${item.url ?? item.message}`));
  for (const input of extra) {
    const key = `${input.code}|${input.url ?? input.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: nextId(),
      code: input.code,
      severity: input.severity,
      message: input.message,
      at: Date.now(),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.url ? { url: input.url } : {}),
    });
  }
  return items;
}
