/**
 * Optional Biframe protocol.
 *
 * A page can opt in to help the engine by exposing `window.biframe`. Nothing in
 * the engine requires it: plain HTML with no protocol support is captured using
 * the manual duration and real-time capture. The protocol is additive and never
 * injected into the imported file — the always-injected instrumentation only
 * observes the page, it never changes behaviour.
 *
 * Supported (all optional):
 *
 *   window.biframe = {
 *     duration: 36.5,          // seconds; lets the engine use "auto" duration
 *     ready: true,             // page is fully prepared and has not started yet
 *   }
 *
 *   window.dispatchEvent(new CustomEvent('biframe:complete'))
 *     Signals that the animation has finished; ends an automatic capture.
 *
 *   window.biframeCapture = { start: 12.5, end: 36.5 }
 *     Declares the interesting window of a longer page. Read and reported; only
 *     honoured by the deterministic engine, which is not implemented yet.
 *
 * Reserved for the future deterministic engine: `deterministic: true`,
 * `onStart(cb)` and `onSeek(seconds)`. A page that exposes them is still
 * captured in real time and a diagnostic explains that the deterministic path
 * was not used.
 */

export interface BiframePageApi {
  duration?: number;
  ready?: boolean;
  /** Reserved: declares that the page can be driven frame by frame. */
  deterministic?: boolean;
  /** Reserved: the engine would call this when capture is about to begin. */
  onStart?: (callback: () => void) => void;
  /** Reserved: the engine would call this to render an exact instant. */
  onSeek?: (seconds: number) => void;
  capture?: { start?: number; end?: number };
}

export const PROTOCOL_COMPLETE_EVENT = 'biframe:complete';
export const PROTOCOL_GLOBAL = 'biframe';

/** Values read from the page before capture starts. */
export interface ProtocolDescriptor {
  present: boolean;
  durationSeconds: number | null;
  ready: boolean | null;
  deterministic: boolean;
  captureStartSeconds: number | null;
  captureEndSeconds: number | null;
}

export function emptyDescriptor(): ProtocolDescriptor {
  return {
    present: false,
    durationSeconds: null,
    ready: null,
    deterministic: false,
    captureStartSeconds: null,
    captureEndSeconds: null,
  };
}

/** Parses whatever `window.biframe` returned; tolerant of malformed values. */
export function parseProtocolDescriptor(raw: unknown): ProtocolDescriptor {
  const descriptor = emptyDescriptor();
  if (typeof raw !== 'object' || raw === null) return descriptor;
  const candidate = raw as BiframePageApi & { capture?: { start?: unknown; end?: unknown } };
  descriptor.present = true;
  if (typeof candidate.duration === 'number' && Number.isFinite(candidate.duration) && candidate.duration > 0) {
    descriptor.durationSeconds = candidate.duration;
  }
  if (typeof candidate.ready === 'boolean') descriptor.ready = candidate.ready;
  if (candidate.deterministic === true) descriptor.deterministic = true;
  const start = candidate.capture?.start;
  const end = candidate.capture?.end;
  if (typeof start === 'number' && Number.isFinite(start) && start >= 0) descriptor.captureStartSeconds = start;
  if (typeof end === 'number' && Number.isFinite(end) && end > 0) descriptor.captureEndSeconds = end;
  return descriptor;
}
