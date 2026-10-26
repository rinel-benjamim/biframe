import { describe, expect, it } from 'vitest';
import {
  DiagnosticCollector,
  consoleDiagnosticInput,
  consoleLevelToSeverity,
  emptyInspection,
  inspectionDiagnostics,
  mergeDiagnostics,
  resourceFailureInput,
  stillFramesInput,
} from '@engine/diagnostics';

describe('DiagnosticCollector', () => {
  it('deduplicates by code and resource', () => {
    const collector = new DiagnosticCollector();
    const first = collector.add({
      code: 'REMOTE_RESOURCES',
      severity: 'info',
      message: 'Recursos externos',
      url: 'https://fonts.googleapis.com/a.css',
    });
    const duplicate = collector.add({
      code: 'REMOTE_RESOURCES',
      severity: 'info',
      message: 'Recursos externos',
      url: 'https://fonts.googleapis.com/a.css',
    });
    const distinct = collector.add({
      code: 'REMOTE_RESOURCES',
      severity: 'info',
      message: 'Recursos externos',
      url: 'https://cdn.example.com/b.js',
    });
    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(distinct).not.toBeNull();
    expect(collector.all).toHaveLength(2);
  });

  it('can add without deduplication and respects the item cap', () => {
    const collector = new DiagnosticCollector(2);
    collector.add({ code: 'PAGE_WARNING', severity: 'warning', message: 'a' }, { dedupe: false });
    collector.add({ code: 'PAGE_WARNING', severity: 'warning', message: 'a' }, { dedupe: false });
    collector.add({ code: 'PAGE_WARNING', severity: 'warning', message: 'b' });
    expect(collector.all).toHaveLength(2);
  });

  it('counts severities, tracks errors and clears', () => {
    const collector = new DiagnosticCollector();
    collector.add({ code: 'PAGE_WARNING', severity: 'info', message: 'info' });
    collector.add({ code: 'PAGE_WARNING', severity: 'warning', message: 'warn' });
    collector.add({ code: 'SCRIPT_ERROR', severity: 'error', message: 'error' });
    expect(collector.counts).toEqual({ info: 1, warning: 1, error: 1 });
    expect(collector.hasErrors).toBe(true);
    collector.clear();
    expect(collector.all).toEqual([]);
    expect(collector.counts).toEqual({ info: 0, warning: 0, error: 0 });
  });

  it('merges existing diagnostics without duplicating them', () => {
    const collector = new DiagnosticCollector();
    const existing = collector.add({
      code: 'MISSING_RESOURCE',
      severity: 'warning',
      message: 'imagem',
      url: 'https://example.com/a.png',
    });
    expect(existing).not.toBeNull();
    collector.addAll([{ ...existing!, id: 'other', at: 1 }]);
    expect(collector.all).toHaveLength(1);
  });
});

describe('console diagnostics', () => {
  it('maps numeric and textual Chromium levels', () => {
    expect(consoleLevelToSeverity(3)).toBe('error');
    expect(consoleLevelToSeverity(2)).toBe('warning');
    expect(consoleLevelToSeverity(1)).toBeNull();
    expect(consoleLevelToSeverity('error')).toBe('error');
    expect(consoleLevelToSeverity('warn')).toBe('warning');
    expect(consoleLevelToSeverity('info')).toBeNull();
  });

  it('creates an error diagnostic with source and line', () => {
    const input = consoleDiagnosticInput(3, 'Uncaught TypeError', 'https://example.com/app.js', 17);
    expect(input).toMatchObject({ code: 'CONSOLE_ERROR', severity: 'error' });
    expect(input?.detail).toContain('Uncaught TypeError');
    expect(input?.detail).toContain('app.js:17');
  });

  it('ignores Electron security warnings injected in development', () => {
    expect(consoleDiagnosticInput(2, 'Electron Security Warning (Insecure Content-Security-Policy)')).toBeNull();
  });
});

describe('resource failures', () => {
  it('classifies fonts and images', () => {
    expect(
      resourceFailureInput({ url: 'https://x.test/font.woff2', error: 'net::ERR_FAILED', resourceType: 'Font' }),
    ).toMatchObject({ code: 'FONT_FALLBACK', severity: 'warning' });
    expect(
      resourceFailureInput({ url: 'https://x.test/picture.png', error: 'net::ERR_FAILED', resourceType: 'Image' }),
    ).toMatchObject({ code: 'MISSING_RESOURCE', severity: 'warning' });
    expect(
      resourceFailureInput({ url: 'https://x.test/data.json', error: 'net::ERR_FAILED' }),
    ).toMatchObject({ code: 'MISSING_RESOURCE' });
  });
});

describe('page inspection', () => {
  it('produces no diagnostics for a clean page', () => {
    expect(inspectionDiagnostics(emptyInspection({ fontsStatus: 'loaded', readyState: 'complete' }))).toEqual([]);
  });

  it('reports broken images, fonts, remote resources and script errors', () => {
    const diagnostics = inspectionDiagnostics(
      emptyInspection({
        brokenImages: [{ src: 'https://x.test/a.png', alt: 'gráfico' }],
        fontsStatus: 'loading',
        hasRemoteResources: true,
        remoteHosts: ['fonts.googleapis.com'],
        scriptErrorCount: 2,
      }),
    );
    expect(diagnostics.map((item) => item.code)).toEqual([
      'MISSING_RESOURCE',
      'FONT_FALLBACK',
      'REMOTE_RESOURCES',
      'SCRIPT_ERROR',
    ]);
    expect(diagnostics[0]?.detail).toContain('gráfico');
    expect(diagnostics[2]?.detail).toContain('fonts.googleapis.com');
  });

  it('reports protocol declarations and media elements', () => {
    const diagnostics = inspectionDiagnostics(
      emptyInspection({
        fontsStatus: 'loaded',
        protocolPresent: true,
        protocolDurationSeconds: 8,
        captureStartSeconds: 1,
        captureEndSeconds: 8,
        mediaElementCount: 2,
        playingMediaCount: 1,
      }),
    );
    expect(diagnostics.map((item) => item.code)).toEqual(['PAGE_WARNING', 'AUDIO_UNSUPPORTED', 'PAGE_WARNING']);
    expect(diagnostics[1]?.detail).toContain('1 em reprodução');
  });
});

describe('still frame diagnostics', () => {
  it('warns about visually uniform samples', () => {
    const diagnostics = stillFramesInput({
      blank: true,
      staticFrames: true,
      samples: [{ mean: 0, stdDev: 0 }],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('BLANK_FRAMES');
  });

  it('warns about identical samples that are not blank', () => {
    const diagnostics = stillFramesInput({
      blank: false,
      staticFrames: true,
      samples: [{ mean: 120, stdDev: 40 }],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('STATIC_FRAMES');
  });

  it('stays quiet for varied samples', () => {
    expect(
      stillFramesInput({ blank: false, staticFrames: false, samples: [{ mean: 120, stdDev: 40 }] }),
    ).toEqual([]);
  });
});

describe('mergeDiagnostics', () => {
  it('appends new inputs after collected diagnostics and skips duplicates', () => {
    const collector = new DiagnosticCollector();
    collector.add({ code: 'REMOTE_RESOURCES', severity: 'info', message: 'externo', url: 'https://x.test/a' });
    const merged = mergeDiagnostics(collector, [
      { code: 'REMOTE_RESOURCES', severity: 'info', message: 'externo', url: 'https://x.test/a' },
      { code: 'SCRIPT_ERROR', severity: 'warning', message: 'erro' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.code).toBe('SCRIPT_ERROR');
  });
});
