import { defaultTranslator } from './i18n';
import type { SerializedError } from './types';

/**
 * Every failure the engine and the shell can produce is identified by a stable
 * code. The code drives the log line, the tests and the copy shown to the user,
 * so the interface never has to pattern-match on a message.
 */
export const ERROR_CODES = [
  'PROJECT_IMPORT_FAILED',
  'UNSUPPORTED_PROJECT_FORMAT',
  'PROJECT_TOO_LARGE',
  'PROJECT_TOO_MANY_FILES',
  'ARCHIVE_UNSAFE_ENTRY',
  'ARCHIVE_ENTRY_MISSING_HTML',
  'PROJECT_NOT_FOUND',
  'BROWSER_LAUNCH_FAILED',
  'PAGE_LOAD_FAILED',
  'PAGE_LOAD_TIMEOUT',
  'RESOURCE_LOAD_WARNING',
  'PAGE_SCRIPT_ERROR',
  'RENDER_TIMEOUT',
  'RENDER_CANCELLED',
  'FRAME_CAPTURE_FAILED',
  'NO_FRAMES_CAPTURED',
  'ENCODER_MISSING',
  'ENCODING_FAILED',
  'OUTPUT_EXISTS',
  'OUTPUT_VALIDATION_FAILED',
  'OUTPUT_DIRECTORY_INVALID',
  'INSUFFICIENT_DISK_SPACE',
  'PROCESS_CRASHED',
  'RENDER_IN_PROGRESS',
  'INVALID_SETTINGS',
  'INVALID_IPC_ARGUMENT',
  'PREVIEW_UNAVAILABLE',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDefinition {
  /** Title shown in the interface. */
  title: string;
  /** Sentence explaining what happened and what to do next. */
  message: string;
  /** A recoverable error does not prevent retrying with other settings. */
  recoverable: boolean;
}

/**
 * Only the recoverable flag lives here: the sentences themselves are catalog
 * entries, so there is exactly one place to change a wording.
 */
const ERROR_RECOVERABLE: Record<ErrorCode, boolean> = {
  PROJECT_IMPORT_FAILED: true,
  UNSUPPORTED_PROJECT_FORMAT: true,
  PROJECT_TOO_LARGE: true,
  PROJECT_TOO_MANY_FILES: true,
  ARCHIVE_UNSAFE_ENTRY: false,
  ARCHIVE_ENTRY_MISSING_HTML: true,
  PROJECT_NOT_FOUND: true,
  BROWSER_LAUNCH_FAILED: true,
  PAGE_LOAD_FAILED: true,
  PAGE_LOAD_TIMEOUT: true,
  RESOURCE_LOAD_WARNING: true,
  PAGE_SCRIPT_ERROR: true,
  RENDER_TIMEOUT: true,
  RENDER_CANCELLED: true,
  FRAME_CAPTURE_FAILED: true,
  NO_FRAMES_CAPTURED: true,
  ENCODER_MISSING: true,
  ENCODING_FAILED: true,
  OUTPUT_EXISTS: true,
  OUTPUT_VALIDATION_FAILED: true,
  OUTPUT_DIRECTORY_INVALID: true,
  INSUFFICIENT_DISK_SPACE: true,
  PROCESS_CRASHED: true,
  RENDER_IN_PROGRESS: true,
  INVALID_SETTINGS: true,
  INVALID_IPC_ARGUMENT: true,
  PREVIEW_UNAVAILABLE: true,
  UNKNOWN_ERROR: true,
};

/**
 * Definitions in the default language, used by the engine (logs, thrown errors)
 * and as a safety net. The interface re-translates by `code` in the language the
 * application is wearing, so a serialized error always reaches the user in their
 * language even though it was raised deep inside the engine.
 */
export const ERROR_DEFINITIONS: Record<ErrorCode, ErrorDefinition> = Object.fromEntries(
  ERROR_CODES.map((code) => [
    code,
    {
      title: defaultTranslator(`error.${code}.title`),
      message: defaultTranslator(`error.${code}.message`),
      recoverable: ERROR_RECOVERABLE[code],
    },
  ]),
) as Record<ErrorCode, ErrorDefinition>;

export class BiframeError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly recoverable: boolean;

  constructor(code: ErrorCode, options: { detail?: string; cause?: unknown; message?: string } = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.message ?? definition.message);
    this.name = 'BiframeError';
    this.code = code;
    this.detail = options.detail;
    this.recoverable = definition.recoverable;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  get title(): string {
    return ERROR_DEFINITIONS[this.code].title;
  }

  toJSON(): SerializedError {
    const serialized: SerializedError = {
      code: this.code,
      title: this.title,
      message: this.message,
      recoverable: this.recoverable,
    };
    if (this.detail) serialized.detail = this.detail;
    return serialized;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** Normalises anything thrown into a BiframeError with a technical detail. */
export function toBiframeError(error: unknown, fallback: ErrorCode = 'UNKNOWN_ERROR'): BiframeError {
  if (error instanceof BiframeError) return error;
  if (error instanceof Error) {
    return new BiframeError(fallback, {
      detail: error.stack ?? error.message,
      cause: error,
      message: error.message,
    });
  }
  return new BiframeError(fallback, { detail: String(error) });
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof BiframeError) return error.toJSON();
  return toBiframeError(error).toJSON();
}
