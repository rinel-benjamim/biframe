import { describe, expect, it } from 'vitest';
import {
  emptyDescriptor,
  parseProtocolDescriptor,
  PROTOCOL_COMPLETE_EVENT,
  PROTOCOL_GLOBAL,
} from '@shared/protocol';
import {
  BiframeError,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  isErrorCode,
  serializeError,
  toBiframeError,
} from '@shared/errors';

describe('Biframe page protocol', () => {
  it('exposes stable protocol names', () => {
    expect(PROTOCOL_COMPLETE_EVENT).toBe('biframe:complete');
    expect(PROTOCOL_GLOBAL).toBe('biframe');
  });

  it('returns an empty descriptor for malformed values', () => {
    expect(parseProtocolDescriptor(null)).toEqual(emptyDescriptor());
    expect(parseProtocolDescriptor('ready')).toEqual(emptyDescriptor());
    expect(parseProtocolDescriptor(undefined)).toEqual(emptyDescriptor());
  });

  it('reads duration, readiness, determinism and capture window', () => {
    expect(
      parseProtocolDescriptor({
        duration: 12.5,
        ready: true,
        deterministic: true,
        capture: { start: 1, end: 12 },
      }),
    ).toEqual({
      present: true,
      durationSeconds: 12.5,
      ready: true,
      deterministic: true,
      captureStartSeconds: 1,
      captureEndSeconds: 12,
    });
  });

  it('tolerates negative or non-finite values', () => {
    const descriptor = parseProtocolDescriptor({
      duration: -2,
      ready: 'yes',
      deterministic: false,
      capture: { start: -1, end: Number.POSITIVE_INFINITY },
    });
    expect(descriptor).toMatchObject({
      present: true,
      durationSeconds: null,
      ready: null,
      deterministic: false,
      captureStartSeconds: null,
      captureEndSeconds: null,
    });
  });
});

describe('BiframeError', () => {
  it('defines a title, message and recoverability for every code', () => {
    for (const code of ERROR_CODES) {
      const definition = ERROR_DEFINITIONS[code];
      expect(definition.title.length, code).toBeGreaterThan(0);
      expect(definition.message.length, code).toBeGreaterThan(0);
      expect(typeof definition.recoverable, code).toBe('boolean');
    }
  });

  it('serialises its stable code, title and detail', () => {
    const error = new BiframeError('OUTPUT_EXISTS', { detail: 'C:\\out\\filme.mp4' });
    expect(error.toJSON()).toEqual({
      code: 'OUTPUT_EXISTS',
      title: 'Já existe um ficheiro com este nome',
      message: ERROR_DEFINITIONS.OUTPUT_EXISTS.message,
      detail: 'C:\\out\\filme.mp4',
      recoverable: true,
    });
    expect(error.recoverable).toBe(true);
  });

  it('normalises unknown exceptions and preserves details', () => {
    const original = new Error('boom');
    const normalized = toBiframeError(original);
    expect(normalized).toBeInstanceOf(BiframeError);
    expect(normalized.code).toBe('UNKNOWN_ERROR');
    expect(normalized.detail).toContain('boom');
    expect(serializeError('plain string')).toMatchObject({ code: 'UNKNOWN_ERROR', detail: 'plain string' });
    expect(serializeError(new BiframeError('RENDER_CANCELLED')).code).toBe('RENDER_CANCELLED');
  });

  it('guards error codes at runtime', () => {
    expect(isErrorCode('OUTPUT_EXISTS')).toBe(true);
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});
