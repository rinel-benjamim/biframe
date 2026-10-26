import type { ApiResult } from '@shared/channels';
import type { SerializedError } from '@shared/types';

/**
 * Thin, typed access to the preload bridge. Every call answers with an
 * `ApiResult`; `unwrap` turns a failed result into a real exception so screens
 * can use `try`/`catch` and still show the exact error the main process
 * produced, while `toSerializedError` guarantees the interface always has a
 * readable title and message to render.
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
  title: 'A ponte da aplicação não está disponível',
  message: 'Esta janela não foi aberta pelo Biframe. Reinicie a aplicação.',
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
      title: 'Algo não correu como esperado',
      message: 'A aplicação não devolveu uma resposta legível.',
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
      title: 'Algo não correu como esperado',
      message: error.message,
      recoverable: true,
    };
  }
  return {
    code: 'UNKNOWN',
    title: 'Algo não correu como esperado',
    message: typeof error === 'string' ? error : 'Erro desconhecido.',
    recoverable: true,
  };
}
