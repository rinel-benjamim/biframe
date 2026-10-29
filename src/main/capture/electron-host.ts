import { BrowserWindow, screen, type Rectangle, type WebContents } from 'electron';
import { BiframeError } from '@shared/errors';
import { createTranslator, type Language, type Translator } from '@shared/i18n';
import { parseProtocolDescriptor, type ProtocolDescriptor } from '@shared/protocol';
import type { Diagnostic } from '@shared/types';
import {
  COMPLETION_SOURCE,
  INSPECT_SOURCE,
  INSTRUMENTATION_SOURCE,
  READ_PROBE_SOURCE,
  READ_PROTOCOL_SOURCE,
  READY_SOURCE,
} from '../../engine/capture/instrumentation';
import type {
  CaptureSession,
  CaptureSessionHost,
  CaptureSessionOptions,
  FramePacket,
  LoadOutcome,
  MarkStartResult,
} from '../../engine/capture/types';
import {
  DiagnosticCollector,
  consoleDiagnosticInput,
  emptyInspection,
  type PageInspection,
} from '../../engine/diagnostics';
import { classifyNavigation } from '../../engine/network/policy';
import { delay, type CancellationToken } from '../../engine/render/token';
import type { ContentGateway } from '../content-session';
import type { Logger } from '../log';

/**
 * The production capture implementation: a sandboxed BrowserWindow whose
 * compositor output is streamed to disk through CDP `Page.startScreencast`.
 *
 * On Windows the window uses the native compositor and is placed completely
 * outside the desktop, then shown without activation. Electron's
 * `offscreen: true` path uses software compositing: on the target machine it
 * delivered 27–33 fps at 720p, while native compositing delivered 56–58 fps.
 * The native window is never visible (it is outside the union of every display
 * and has no taskbar entry), never takes focus and ignores the mouse. If the
 * position is rejected, it falls back to a fully transparent window.
 *
 * Why screencast and not `paint` events: measured on the target machine, paint
 * events block the main process (p95 main-loop jitter 252 ms, which visibly
 * stretches the animation), while screencast keeps jitter low. See
 * docs/adr/0004-capture-strategy.md.
 *
 * The window has no preload, no Node integration, remote modules disabled at
 * the session level and every navigation outside the loopback project origin
 * cancelled, so an imported page behaves like any web page in a sandbox and
 * nothing else.
 */

interface ProbeSnapshot {
  installed: boolean;
  firstRaf: number | null;
  firstTimer: number | null;
  domContentLoadedAt: number | null;
  rafCount: number;
  timerCount: number;
  errors: string[];
  complete: boolean;
  firstPaint: number | null;
  firstContentfulPaint: number | null;
  pageNow: number;
  timeOrigin: number;
  readyState: string;
  visibility: string;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

interface ScreencastFrameParams {
  data: string;
  sessionId: number;
  metadata?: { timestamp?: number };
}

interface ProtocolSnapshot {
  present: boolean;
  duration: number | null;
  ready: boolean | null;
  deterministic: boolean;
  captureStart: number | null;
  captureEnd: number | null;
}

const MAX_QUEUED_FRAMES = 400;
const PROBE_POLL_INTERVAL_MS = 80;
const PROBE_WAIT_MS = 2500;

/**
 * Electron's `offscreen: true` windows are composited on the CPU. On the
 * target machine that caps CDP screencast at 27–33 fps at 1280×720, while a
 * real window driven by the native compositor reaches 56–58 fps. Windows is
 * therefore captured with a native window parked outside the desktop; other
 * platforms keep the old, software-composited window until they can be
 * measured the same way.
 */
const USE_NATIVE_COMPOSITOR = process.platform === 'win32';

function isDetailsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && 'errorCode' in (value as Record<string, unknown>);
}

function intersectsDisplay(bounds: Rectangle, display: Rectangle): boolean {
  return (
    bounds.x < display.x + display.width &&
    bounds.x + bounds.width > display.x &&
    bounds.y < display.y + display.height &&
    bounds.y + bounds.height > display.y
  );
}

export interface CaptureHostOptions {
  gateway: ContentGateway;
  logger: Logger;
  /** Resolved on every session so policy changes apply to the next render. */
  policy: () => { projectOrigin: string; allowRemote: boolean };
  /** Language of every diagnostic this host produces. */
  getLanguage: () => Language;
}

export class ElectronCaptureHost implements CaptureSessionHost {
  constructor(private readonly options: CaptureHostOptions) {}

  async createSession(sessionOptions: CaptureSessionOptions): Promise<CaptureSession> {
    const session = new ElectronCaptureSession(this.options, sessionOptions);
    await session.initialize();
    return session;
  }
}

class ElectronCaptureSession implements CaptureSession {
  private readonly collector = new DiagnosticCollector(400);
  private readonly logger: Logger;
  private readonly gateway: ContentGateway;
  private readonly options: CaptureSessionOptions;
  private readonly getLanguage: () => Language;
  private window: BrowserWindow | null = null;
  private streaming = false;
  private armed = false;
  private startMs = 0;
  private queue: FramePacket[] = [];
  private frameSink: ((frame: FramePacket) => void) | null = null;
  private lastFrameMs = 0;
  private debuggerAttached = false;
  private crashed = false;
  private title = '';
  private closed = false;

  constructor(host: CaptureHostOptions, options: CaptureSessionOptions) {
    this.options = options;
    this.gateway = host.gateway;
    this.logger = host.logger.child(`capture:${options.label}`);
    this.getLanguage = host.getLanguage;
  }

  /** Copy is produced per event, so a language change applies to new renders. */
  private t(): Translator {
    return createTranslator(this.getLanguage());
  }

  private get contents(): WebContents {
    if (!this.window) throw new BiframeError('FRAME_CAPTURE_FAILED', { detail: 'capture window is not available' });
    return this.window.webContents;
  }

  async initialize(): Promise<void> {
    this.gateway.setPolicy(this.optionsPolicy());
    const window = new BrowserWindow({
      show: false,
      // Keep painting as soon as content loads, even before the first show.
      paintWhenInitiallyHidden: true,
      width: this.options.width,
      height: this.options.height,
      useContentSize: true,
      frame: false,
      backgroundColor: '#000000',
      skipTaskbar: true,
      // A native capture window must never steal focus from the studio.
      ...(USE_NATIVE_COMPOSITOR ? { focusable: false } : {}),
      webPreferences: {
        // Native compositing on Windows; software offscreen elsewhere.
        offscreen: !USE_NATIVE_COMPOSITOR,
        backgroundThrottling: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        devTools: false,
        disableDialogs: true,
        autoplayPolicy: 'no-user-gesture-required',
        session: this.gateway.session,
      },
    });
    this.window = window;
    window.setMenuBarVisibility(false);
    window.webContents.setAudioMuted(true);
    this.registerContentsEvents(window.webContents);
    this.gateway.addSink(window.webContents.id, (input) => {
      this.collector.add(input);
    });
    if (USE_NATIVE_COMPOSITOR) this.showNativeCompositor(window);

    await window.loadURL('about:blank');
    await this.attachDebugger();
    await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION_SOURCE });
    this.resetZoom();
    await this.applyDeviceMetrics();
    this.logger.log('info', 'capture session ready', { width: this.options.width, height: this.options.height });
  }

  private optionsPolicy(): { projectOrigin: string; allowRemote: boolean } {
    return { projectOrigin: this.options.origin, allowRemote: this.options.allowRemote };
  }

  /**
   * Parks the capture window left of the union of every display and shows it
   * without activation. The compositor then runs at refresh rate, but nothing
   * is visible on any screen, there is no taskbar entry and the studio keeps
   * focus. If the OS ignores the position, the window is made fully
   * transparent: it composites a little slower, but it cannot be seen.
   */
  private showNativeCompositor(window: BrowserWindow): void {
    try {
      const displays = screen.getAllDisplays();
      if (displays.length === 0) return;
      const left = Math.min(...displays.map((display) => display.bounds.x));
      const top = Math.min(...displays.map((display) => display.bounds.y));
      window.setIgnoreMouseEvents(true);
      const before = window.getBounds();
      window.setPosition(left - before.width - 64, top, false);
      window.showInactive();
      const placed = window.getBounds();
      const overlaps = displays.some((display) => intersectsDisplay(placed, display.bounds));
      if (overlaps) {
        window.setOpacity(0);
        this.logger.log('warn', 'capture window overlapped a display; using transparency', { placed });
      }
      this.logger.log('info', 'native capture compositor started', {
        placed,
        displays: displays.length,
        transparent: overlaps,
      });
    } catch (error) {
      // The window simply stays hidden: capture still works, only slower.
      this.logger.log('warn', 'could not position the capture window', { error: String(error) });
    }
  }

  private registerContentsEvents(contents: WebContents): void {
    contents.on('console-message', (...args: unknown[]) => {
      const first = args[0];
      if (first && typeof first === 'object' && 'message' in (first as Record<string, unknown>)) {
        const details = first as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string };
        this.addConsole(details.level ?? 1, details.message ?? '', details.sourceId, details.lineNumber);
        return;
      }
      const [, level, message, line, sourceId] = args as [unknown, string | number, string, number, string];
      this.addConsole(level ?? 1, message ?? '', sourceId, line);
    });

    contents.on('did-fail-load', (...args: unknown[]) => {
      const legacy = args as [unknown, number, string, string, boolean];
      const details = isDetailsObject(args[1])
        ? (args[1] as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean })
        : { errorCode: legacy[1], errorDescription: legacy[2], validatedURL: legacy[3], isMainFrame: legacy[4] };
      if (!details.isMainFrame) return;
      this.collector.add({
        code: 'PAGE_LOAD_FAILED',
        severity: 'error',
        message: this.t()('capture.mainFrameFailed'),
        detail: `${details.errorCode} ${details.errorDescription}`,
        ...(details.validatedURL ? { url: details.validatedURL } : {}),
      });
    });

    contents.on('render-process-gone', (_event, details) => {
      this.crashed = true;
      this.collector.add({
        code: 'RENDER_PROCESS_GONE',
        severity: 'error',
        message: this.t()('capture.renderProcessGone'),
        detail: `${details.reason} (exitCode ${details.exitCode})`,
      });
      this.logger.log('error', 'renderer gone', { reason: details.reason, exitCode: details.exitCode });
    });

    contents.on('unresponsive', () => {
      this.collector.add({
        code: 'PAGE_UNRESPONSIVE',
        severity: 'warning',
        message: this.t()('capture.pageUnresponsive'),
        detail: this.t()('capture.pageUnresponsiveDetail'),
      });
    });

    contents.on('page-title-updated', (_event, title) => {
      this.title = title.slice(0, 200);
    });

    contents.on('will-navigate', (event, url) => {
      const decision = classifyNavigation(url, { projectOrigin: this.options.origin });
      if (decision.action === 'block') {
        event.preventDefault();
        this.collector.add({
          code: 'NAVIGATION_BLOCKED',
          severity: 'warning',
          message: this.t()('capture.navigationBlocked'),
          detail: this.t()('capture.navigationBlockedDetail'),
          url: url.slice(0, 300),
        });
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      this.collector.add({
        code: 'WINDOW_OPEN_BLOCKED',
        severity: 'info',
        message: this.t()('capture.windowOpen'),
        detail: this.t()('capture.windowOpenDetail'),
        url: url.slice(0, 300),
      });
      return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      this.collector.add({
        code: 'WEBVIEW_BLOCKED',
        severity: 'info',
        message: this.t()('capture.webviewBlocked'),
        detail: this.t()('capture.webviewBlockedDetail'),
      });
    });

    contents.on('did-start-navigation', () => {
      this.armed = false;
      this.queue = [];
    });
  }

  private addConsole(level: string | number, message: string, sourceId?: string, line?: number): void {
    const input = consoleDiagnosticInput(this.t(), level, message, sourceId, line);
    if (input) this.collector.add(input);
  }

  private async attachDebugger(): Promise<void> {
    const contents = this.contents;
    try {
      contents.debugger.attach('1.3');
      this.debuggerAttached = true;
    } catch (error) {
      throw new BiframeError('BROWSER_LAUNCH_FAILED', {
        detail: `could not attach the CDP debugger: ${String(error)}`,
      });
    }
    contents.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.screencastFrame') this.handleScreencastFrame(params as ScreencastFrameParams);
    });
    contents.debugger.on('detach', (_event, reason) => {
      this.debuggerAttached = false;
      if (!this.closed) {
        this.collector.add({
          code: 'FRAME_CAPTURE_FAILED',
          severity: 'error',
          message: this.t()('capture.connectionLost'),
          detail: reason,
        });
      }
    });
  }

  private async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.debuggerAttached) throw new BiframeError('FRAME_CAPTURE_FAILED', { detail: `CDP not attached for ${method}` });
    return (await this.contents.debugger.sendCommand(method, params)) as T;
  }

  private async applyDeviceMetrics(): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.options.width,
      height: this.options.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: 'landscapePrimary', angle: 0 },
    });
  }

  /**
   * Chromium stores zoom per origin in the session, and the live preview has to
   * zoom the project down to fit its stage. The capture window shares that
   * session, so without this reset it would inherit the preview's zoom and lay
   * the page out at, say, 2340 × 1316 instead of the requested 1280 × 720. The
   * screencast would then downscale that surface, which looks right at a glance
   * but is the wrong viewport and loses the 1:1 correspondence with the preview.
   */
  private resetZoom(): void {
    try {
      this.contents.setZoomFactor(1);
    } catch {
      // The caller applies the device metrics again; zoom is best effort.
    }
  }

  private handleScreencastFrame(params: ScreencastFrameParams): void {
    void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {
      // A dropped ack only costs one frame.
    });
    if (!this.streaming) return;
    const packet: FramePacket = { t: this.frameTimestamp(params), base64: params.data };
    if (!this.armed) {
      this.queue.push(packet);
      if (this.queue.length > MAX_QUEUED_FRAMES) this.queue.shift();
      return;
    }
    if (packet.t >= this.startMs) this.frameSink?.(packet);
  }

  /**
   * Presentation instant of a captured frame.
   *
   * The screencast metadata carries Chromium's own capture time, which is what
   * the animation timeline needs. Host arrival time is only a fallback: when
   * the main process stalls it receives a burst of frames stamped with nearly
   * the same instant, and the resampler would then repeat one frame through a
   * fast transition while the frames after the stall arrive late. The metadata
   * clock is accepted only when it is within five seconds of the host clock,
   * and the sequence is kept monotonic.
   */
  private frameTimestamp(params: ScreencastFrameParams): number {
    const received = Date.now();
    const metadata = params.metadata?.timestamp;
    const metadataMs = typeof metadata === 'number' && Number.isFinite(metadata) ? metadata * 1000 : null;
    const usable = metadataMs !== null && Math.abs(metadataMs - received) < 5_000;
    const t = Math.max(usable ? Math.round(metadataMs) : received, this.lastFrameMs);
    this.lastFrameMs = t;
    return t;
  }

  private arm(startMs: number): void {
    this.startMs = startMs;
    const pending = this.queue.filter((frame) => frame.t >= startMs);
    this.queue = [];
    this.armed = true;
    for (const frame of pending) this.frameSink?.(frame);
    this.logger.log('debug', 'capture armed', { startMs, replayed: pending.length });
  }

  /** Waits for the page `load` event, with a timeout, and reports failures. */
  private waitForLoad(timeoutMs: number, action: () => void): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const contents = this.contents;
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        contents.off('did-finish-load', onFinish);
        contents.off('did-fail-load', onFail);
      };
      const finish = (result: { ok: boolean; detail?: string }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onFinish = (): void => finish({ ok: true });
      const onFail = (...args: unknown[]): void => {
        const legacy = args as [unknown, number, string, string, boolean];
        const details = isDetailsObject(args[1])
          ? (args[1] as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean })
          : { errorCode: legacy[1], errorDescription: legacy[2], validatedURL: legacy[3], isMainFrame: legacy[4] };
        if (!details.isMainFrame) return;
        finish({ ok: false, detail: `${details.errorCode} ${details.errorDescription} — ${details.validatedURL}` });
      };
      const timer = setTimeout(() => finish({ ok: false, detail: `timeout after ${timeoutMs} ms` }), timeoutMs);
      contents.on('did-finish-load', onFinish);
      contents.on('did-fail-load', onFail);
      if (this.crashed) {
        finish({ ok: false, detail: 'the page process crashed' });
        return;
      }
      action();
    });
  }

  private async execute<T>(source: string, timeoutMs = 10_000): Promise<T> {
    const contents = this.contents;
    return (await Promise.race([
      contents.executeJavaScript(source, true) as Promise<T>,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`script timed out after ${timeoutMs} ms`)), timeoutMs).unref?.();
      }),
    ])) as T;
  }

  async load(url: string, options: { timeoutMs: number }): Promise<LoadOutcome> {
    const startedAt = Date.now();
    const outcome = await this.waitForLoad(options.timeoutMs, () => {
      void this.contents.loadURL(url).catch(() => {
        // did-fail-load reports the detail; the promise rejection is redundant.
      });
    });
    if (!outcome.ok) {
      if (outcome.detail?.startsWith('timeout')) {
        throw new BiframeError('PAGE_LOAD_TIMEOUT', { detail: `${outcome.detail} (${url})` });
      }
      return { ok: false, loadMs: Date.now() - startedAt, url, errorDetail: outcome.detail ?? 'load failed' };
    }
    this.resetZoom();
    try {
      await this.execute(READY_SOURCE, 15_000);
    } catch (error) {
      this.collector.add({
        code: 'PAGE_NEVER_IDLE',
        severity: 'warning',
        message: this.t()('capture.slowStabilize'),
        detail: String(error),
      });
    }
    return { ok: true, loadMs: Date.now() - startedAt, url: this.contents.getURL() };
  }

  async inspect(): Promise<PageInspection> {
    try {
      const raw = await this.execute<Partial<PageInspection>>(INSPECT_SOURCE);
      return emptyInspection({ ...raw, title: raw.title || this.title });
    } catch (error) {
      this.collector.add({
        code: 'PAGE_WARNING',
        severity: 'warning',
        message: this.t()('capture.inspectFailed'),
        detail: String(error),
      });
      return emptyInspection({ title: this.title });
    }
  }

  async startFrameStream(options: { fps: number; onFrame: (frame: FramePacket) => void }): Promise<void> {
    this.frameSink = options.onFrame;
    this.queue = [];
    this.armed = false;
    this.lastFrameMs = 0;
    this.streaming = true;
    try {
      await this.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 92,
        maxWidth: this.options.width,
        maxHeight: this.options.height,
        everyNthFrame: 1,
        fromSurface: true,
      });
    } catch (error) {
      this.streaming = false;
      throw new BiframeError('FRAME_CAPTURE_FAILED', { detail: `could not start the screencast: ${String(error)}` });
    }
    this.logger.log('info', 'frame stream started', { fps: options.fps });
  }

  async stopFrameStream(): Promise<void> {
    this.streaming = false;
    this.frameSink = null;
    this.queue = [];
    if (this.debuggerAttached) {
      try {
        await this.send('Page.stopScreencast');
      } catch {
        // The stream may already be closed; nothing to do.
      }
    }
  }

  private async readProbe(): Promise<ProbeSnapshot | null> {
    try {
      return await this.execute<ProbeSnapshot>(READ_PROBE_SOURCE, 5000);
    } catch {
      return null;
    }
  }

  async reloadAndMarkStart(options: { timeoutMs: number }): Promise<MarkStartResult> {
    const outcome = await this.waitForLoad(options.timeoutMs, () => {
      this.contents.reload();
    });
    if (!outcome.ok) {
      throw new BiframeError('PAGE_LOAD_FAILED', { detail: outcome.detail ?? 'reload failed' });
    }

    this.resetZoom();
    await this.applyDeviceMetrics();

    const deadline = Date.now() + PROBE_WAIT_MS;
    let probe = await this.readProbe();
    while (probe && probe.firstRaf === null && probe.firstTimer === null && Date.now() < deadline) {
      await delay(PROBE_POLL_INTERVAL_MS);
      probe = await this.readProbe();
    }

    if (!probe) {
      this.collector.add({
        code: 'PAGE_WARNING',
        severity: 'warning',
        message: this.t()('capture.instrumentationSilent'),
        detail: this.t()('capture.instrumentationSilentDetail'),
      });
    }

    if (probe && probe.installed === false) {
      this.collector.add({
        code: 'PAGE_WARNING',
        severity: 'warning',
        message: this.t()('capture.instrumentationBlocked'),
        detail: this.t()('capture.instrumentationBlockedDetail'),
      });
    }

    if (probe && probe.errors.length > 0) {
      this.collector.add({
        code: 'SCRIPT_ERROR',
        severity: 'warning',
        message: this.t()('capture.scriptErrors'),
        detail: probe.errors.slice(0, 3).join(' | '),
      });
    }

    if (probe && (probe.innerWidth !== this.options.width || probe.innerHeight !== this.options.height)) {
      this.collector.add({
        code: 'PAGE_WARNING',
        severity: 'warning',
        message: this.t()('capture.viewportCorrected'),
        detail: this.t()('capture.viewportCorrectedDetail', {
          reported: `${probe.innerWidth} × ${probe.innerHeight}`,
          requested: `${this.options.width} × ${this.options.height}`,
        }),
      });
      await this.applyDeviceMetrics();
    }

    let protocol: ProtocolDescriptor = parseProtocolDescriptor(undefined);
    try {
      const snapshot = await this.execute<ProtocolSnapshot>(READ_PROTOCOL_SOURCE, 5000);
      protocol = parseProtocolDescriptor(snapshot);
      if (snapshot.deterministic) {
        this.collector.add({
          code: 'PAGE_WARNING',
          severity: 'info',
          message: this.t()('capture.deterministicSupport'),
          detail: this.t()('capture.deterministicSupportDetail'),
        });
      }
    } catch {
      // The protocol is optional; an unreadable one is simply absent.
    }

    const activity = probe
      ? (probe.firstRaf ?? probe.firstTimer ?? probe.firstContentfulPaint ?? probe.firstPaint ?? probe.domContentLoadedAt ?? probe.pageNow)
      : 0;
    const timeOrigin = probe?.timeOrigin ?? Date.now();
    const startMs = Math.round(timeOrigin + activity);
    this.arm(startMs);

    return { startMs, protocol, pageUrl: this.contents.getURL() };
  }

  async waitForCompletion(timeoutMs: number, token: CancellationToken): Promise<'signalled' | 'timeout' | 'cancelled'> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (token.cancelled) return 'cancelled';
      if (this.crashed) return 'timeout';
      if (Date.now() >= deadline) return 'timeout';
      try {
        const complete = await this.execute<boolean>(COMPLETION_SOURCE, 4000);
        if (complete) return 'signalled';
      } catch {
        // A busy renderer can miss one poll; the next one decides.
      }
      if (!(await delay(200, token))) return 'cancelled';
    }
  }

  async screenshot(): Promise<Buffer | null> {
    try {
      const image = await this.contents.capturePage();
      return image.isEmpty() ? null : image.toPNG();
    } catch {
      return null;
    }
  }

  diagnostics(): Diagnostic[] {
    return this.collector.all;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.armed = false;
    this.queue = [];
    try {
      await this.stopFrameStream();
    } catch {
      // Closing is best effort.
    }
    const window = this.window;
    if (window && !window.isDestroyed()) {
      try {
        window.hide();
      } catch {
        // The window may already be gone; nothing to hide.
      }
      this.gateway.removeSink(window.webContents.id);
      if (this.debuggerAttached) {
        try {
          window.webContents.debugger.detach();
        } catch {
          // Already detached.
        }
        this.debuggerAttached = false;
      }
      window.destroy();
    }
    this.window = null;
  }
}
