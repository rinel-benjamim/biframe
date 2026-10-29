import { WebContentsView, type BrowserWindow } from 'electron';
import { serializeError } from '@shared/errors';
import { createTranslator, type Language, type Translator } from '@shared/i18n';
import type { PreviewBounds, PreviewState } from '@shared/types';
import { DiagnosticCollector, consoleDiagnosticInput } from '../../engine/diagnostics';
import { classifyNavigation } from '../../engine/network/policy';
import type { ContentGateway } from '../content-session';
import type { Logger } from '../log';

/**
 * The live preview: a `WebContentsView` attached to the application window and
 * positioned by the interface over the stage.
 *
 * The page is laid out at the export geometry (the same width/height the render
 * will use) and scaled down with the page zoom factor, so what the user sees is
 * what the encoder will read — same viewport, same layout, same font sizes.
 *
 * The preview is a convenience: it runs in the same locked-down gateway as the
 * capture window, and if it cannot be created the export still works.
 */
export class PreviewService {
  private readonly collector = new DiagnosticCollector(200);
  private readonly gateway: ContentGateway;
  private readonly logger: Logger;
  private readonly getLanguage: () => Language;
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private listeners = new Set<(state: PreviewState) => void>();
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private state: PreviewState = {
    loading: false,
    url: null,
    projectId: null,
    lastReloadAt: null,
    diagnostics: [],
    error: null,
  };

  constructor(options: { gateway: ContentGateway; logger: Logger; getLanguage: () => Language }) {
    this.gateway = options.gateway;
    this.logger = options.logger.child('preview');
    this.getLanguage = options.getLanguage;
  }

  /** Copy is produced on demand, so a language change applies to new diagnostics. */
  private t(): Translator {
    return createTranslator(this.getLanguage());
  }

  attach(window: BrowserWindow): void {
    if (this.view) return;
    this.window = window;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        devTools: false,
        disableDialogs: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        session: this.gateway.session,
      },
    });
    this.view = view;
    window.contentView.addChildView(view);
    view.setBounds({ x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height });
    view.setVisible(false);
    view.setBackgroundColor('#0b0b0c');
    view.webContents.setAudioMuted(true);
    this.gateway.addSink(view.webContents.id, (input) => {
      this.collector.add(input);
      this.emit();
    });
    this.registerEvents(view);
  }

  private registerEvents(view: WebContentsView): void {
    const contents = view.webContents;
    contents.on('did-start-loading', () => {
      this.state = { ...this.state, loading: true, error: null };
      this.emit();
    });
    contents.on('did-finish-load', () => {
      this.state = {
        ...this.state,
        loading: false,
        url: contents.getURL(),
        lastReloadAt: Date.now(),
      };
      this.applyZoom();
      this.emit();
    });
    contents.on('did-fail-load', (...args: unknown[]) => {
      const legacy = args as [unknown, number, string, string, boolean];
      const details = args[1] && typeof args[1] === 'object' && 'errorCode' in (args[1] as Record<string, unknown>)
        ? (args[1] as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean })
        : { errorCode: legacy[1], errorDescription: legacy[2], validatedURL: legacy[3], isMainFrame: legacy[4] };
      if (!details.isMainFrame || details.errorCode === -3) return;
      this.state = {
        ...this.state,
        loading: false,
        error: serializeError(new Error(`${details.errorCode} ${details.errorDescription}`)),
      };
      this.emit();
    });
    contents.on('console-message', (...args: unknown[]) => {
      const first = args[0];
      if (first && typeof first === 'object' && 'message' in (first as Record<string, unknown>)) {
        const details = first as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string };
        const input = consoleDiagnosticInput(this.t(), details.level ?? 1, details.message ?? '', details.sourceId, details.lineNumber);
        if (input && this.collector.add(input)) this.emit();
        return;
      }
      const [, level, message, line, sourceId] = args as [unknown, string | number, string, number, string];
      const input = consoleDiagnosticInput(this.t(), level ?? 1, message ?? '', sourceId, line);
      if (input && this.collector.add(input)) this.emit();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.collector.add({
        code: 'RENDER_PROCESS_GONE',
        severity: 'error',
        message: this.t()('preview.processGone'),
        detail: `${details.reason} (exitCode ${details.exitCode})`,
      });
      this.emit();
    });
    contents.on('will-navigate', (event, url) => {
      const decision = classifyNavigation(url, { projectOrigin: this.gateway.currentPolicy.projectOrigin });
      if (decision.action === 'block') {
        event.preventDefault();
        this.collector.add({
          code: 'NAVIGATION_BLOCKED',
          severity: 'warning',
          message: this.t()('preview.navigationBlocked'),
          detail: this.t()('preview.navigationBlockedDetail'),
          url: url.slice(0, 300),
        });
        this.emit();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      this.collector.add({
        code: 'WINDOW_OPEN_BLOCKED',
        severity: 'info',
        message: this.t()('diag.windowOpen'),
        url: url.slice(0, 300),
      });
      this.emit();
      return { action: 'deny' };
    });
  }

  private applyZoom(): void {
    const view = this.view;
    if (!view) return;
    const factor = this.bounds.scale && this.bounds.scale > 0 ? this.bounds.scale : 1;
    try {
      view.webContents.setZoomFactor(Math.min(4, Math.max(0.05, factor)));
    } catch (error) {
      this.logger.log('warn', 'could not apply the preview zoom', { error: String(error) });
    }
  }

  async show(url: string, projectId: string): Promise<void> {
    const view = this.view;
    if (!view) {
      this.state = {
        ...this.state,
        projectId,
        error: serializeError(new Error('preview view unavailable')),
      };
      this.emit();
      return;
    }
    if (this.state.projectId !== projectId) this.collector.clear();
    this.state = { ...this.state, loading: true, projectId, url: null, error: null };
    this.emit();
    this.setVisible(this.visible);
    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      this.logger.log('warn', 'preview load failed', { error: String(error) });
    }
  }

  async reload(): Promise<void> {
    const view = this.view;
    const url = this.state.url;
    if (!view || !url) return;
    this.state = { ...this.state, loading: true, error: null };
    this.emit();
    try {
      view.webContents.reload();
    } catch (error) {
      this.logger.log('warn', 'preview reload failed', { error: String(error) });
    }
  }

  setBounds(bounds: PreviewBounds): void {
    this.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
      ...(bounds.scale !== undefined ? { scale: bounds.scale } : {}),
    };
    const view = this.view;
    if (!view) return;
    view.setBounds({ x: this.bounds.x, y: this.bounds.y, width: this.bounds.width, height: this.bounds.height });
    this.applyZoom();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.view?.setVisible(visible);
    // The render window shares this session and resets zoom to 1 for capture;
    // re-apply the stage scale whenever the preview comes back on screen.
    if (visible) this.applyZoom();
  }

  clearDiagnostics(): void {
    this.collector.clear();
    this.emit();
  }

  getState(): PreviewState {
    return { ...this.state, diagnostics: this.collector.all };
  }

  onChange(listener: (state: PreviewState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reset(): Promise<void> {
    this.collector.clear();
    this.state = { loading: false, url: null, projectId: null, lastReloadAt: null, diagnostics: [], error: null };
    this.emit();
  }

  async close(): Promise<void> {
    const view = this.view;
    this.view = null;
    this.listeners.clear();
    if (!view) return;
    try {
      this.gateway.removeSink(view.webContents.id);
      this.window?.contentView.removeChildView(view);
      view.webContents.close();
    } catch (error) {
      this.logger.log('warn', 'preview view did not close cleanly', { error: String(error) });
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        this.logger.log('warn', 'preview listener failed', { error: String(error) });
      }
    }
  }
}
