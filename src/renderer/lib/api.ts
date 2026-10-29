import type { ApiResult } from '@shared/channels';
import { defaultTranslator } from '@shared/i18n';
import type { SerializedError } from '@shared/types';

/**
 * Thin, typed access to the preload bridge. Every call answers with an
 * `ApiResult`; `unwrap` turns a failed result into a real exception so screens
 * can use `try`/`catch` and still show the exact error the main process
 * produced, while `toSerializedError` guarantees the interface always has a
 * readable title and message to render.
 *
 * These fallbacks are built with `defaultTranslator` because they are raised
 * before (or without) the settings that carry the interface language; the
 * interface re-renders them through `localizedErrorTitle`/`localizedErrorMessage`
 * whenever the code identifies them in the catalog.
 */

export class ApiError extends Error {
  readonly serialized: SerializedError;

  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = 'ApiError';
    this.serialized = serialized;
  }
}

const bridgeMissing: SerializedError = {
  code: 'BRIDGE_UNAVAILABLE',
  title: defaultTranslator('ui.bridge.unavailable.title'),
  message: defaultTranslator('ui.bridge.unavailable.message'),
  recoverable: false,
};

export function getBridge(): Window['biframe'] {
  if (typeof window === 'undefined' || !window.biframe) {
    throw new ApiError(bridgeMissing);
  }
  return window.biframe;
}

export function unwrap<T>(result: ApiResult<T>): T {
  if (!result.ok) {
    throw new ApiError(result.error ?? {
      code: 'UNKNOWN',
      title: defaultTranslator('ui.error.unexpected.title'),
      message: defaultTranslator('ui.error.unexpected.message'),
      recoverable: true,
    });
  }
  return result.data as T;
}

export function toSerializedError(error: unknown): SerializedError {
  if (error instanceof ApiError) return error.serialized;
  if (error instanceof Error) {
    return {
      code: 'RENDERER_ERROR',
      title: defaultTranslator('ui.error.unexpected.title'),
      message: error.message,
      recoverable: true,
    };
  }
  return {
    code: 'UNKNOWN',
    title: defaultTranslator('ui.error.unexpected.title'),
    message: typeof error === 'string' ? error : defaultTranslator('ui.error.unknown'),
    recoverable: true,
  };
}
