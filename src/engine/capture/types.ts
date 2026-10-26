import type { Diagnostic } from '@shared/types';
import type { ProtocolDescriptor } from '@shared/protocol';
import type { PageInspection } from '../diagnostics';
import type { CancellationToken } from '../render/token';

export interface CaptureSessionOptions {
  width: number;
  height: number;
  /** Origin of the loopback project server; navigation is restricted to it. */
  origin: string;
  allowRemote: boolean;
  label: string;
}

export interface LoadOutcome {
  ok: boolean;
  loadMs: number;
  url: string;
  errorDetail?: string;
}

export interface FramePacket {
  /** Host clock timestamp in ms. */
  t: number;
  /** Base64 JPEG bytes exactly as delivered by Chromium. */
  base64: string;
}

export interface MarkStartResult {
  /** Host clock instant that maps to t=0 of the animation. */
  startMs: number;
  protocol: ProtocolDescriptor;
  pageUrl: string;
}

export interface CaptureSession {
  load(url: string, options: { timeoutMs: number }): Promise<LoadOutcome>;
  inspect(): Promise<PageInspection>;
  startFrameStream(options: { fps: number; onFrame: (frame: FramePacket) => void }): Promise<void>;
  stopFrameStream(): Promise<void>;
  /**
   * Reloads the page while capture is running and returns the host-clock
   * instant of the animation's first observable activity. Frames captured
   * before that instant are discarded by the pipeline.
   */
  reloadAndMarkStart(options: { timeoutMs: number }): Promise<MarkStartResult>;
  waitForCompletion(timeoutMs: number, token: CancellationToken): Promise<'signalled' | 'timeout' | 'cancelled'>;
  screenshot(): Promise<Buffer | null>;
  diagnostics(): Diagnostic[];
  close(): Promise<void>;
}

export interface CaptureSessionHost {
  createSession(options: CaptureSessionOptions): Promise<CaptureSession>;
}
