import dns from 'node:dns/promises';
import { session as electronSession, type Session } from 'electron';
import { createTranslator, type Language, type Translator } from '@shared/i18n';
import type { DiagnosticInput } from '../engine/diagnostics';
import { classifyResource, hostFromUrl, isPrivateAddressList, isPrivateHost } from '../engine/network/policy';
import type { Logger } from './log';

/**
 * The single network gateway used by every window that displays imported
 * content (preview and capture).
 *
 * Both windows share one persistent session so a font or asset is fetched once
 * and the render sees exactly what the preview saw. Everything the page requests
 * passes through `classifyResource` (loopback project origin, `data:`/`blob:` and,
 * when the user allows it, public remote hosts) and remote hosts are additionally
 * resolved before the request is allowed, so a page cannot reach the machine's
 * own network by rebinding a hostname to a private address.
 */

export interface ContentPolicy {
  /** Origin of the loopback server that serves the imported project. */
  projectOrigin: string;
  allowRemote: boolean;
}

export interface BlockedRequest {
  url: string;
  host: string | null;
  reason: string;
  detail: string;
}

export type ContentDiagnosticSink = (input: DiagnosticInput) => void;

const DNS_TIMEOUT_MS = 4000;

export class ContentGateway {
  readonly session: Session;
  private readonly logger: Logger;
  private readonly sinks = new Map<number, ContentDiagnosticSink>();
  private readonly dnsCache = new Map<string, Promise<boolean>>();
  private policy: ContentPolicy = { projectOrigin: '', allowRemote: true };
  private readonly getLanguage: () => Language;
  private readonly reportedHosts = new Set<string>();
  private requestCount = 0;
  private blockedCount = 0;
  private failureCount = 0;

  constructor(name: string, logger: Logger, getLanguage: () => Language) {
    this.logger = logger.child('content');
    this.getLanguage = getLanguage;
    this.session = electronSession.fromPartition(`persist:biframe-${name}`);
    this.session.setSpellCheckerEnabled(false);
    this.session.setPermissionRequestHandler((_contents, permission, callback) => {
      this.report(undefined, {
        code: 'PERMISSION_BLOCKED',
        severity: 'info',
        message: this.t()('diag.permissionDenied'),
        detail: permission,
      });
      callback(false);
    });
    this.session.setPermissionCheckHandler(() => false);
    this.session.setDevicePermissionHandler(() => false);
    this.session.on('will-download', (event, item) => {
      event.preventDefault();
      item.cancel();
      this.report(undefined, {
        code: 'DOWNLOAD_BLOCKED',
        severity: 'info',
        message: this.t()('diag.downloadBlocked'),
        url: item.getURL().slice(0, 300),
      });
    });
    this.registerRequestHandlers();
  }

  /** Copy is produced per event, so a language change applies immediately. */
  private t(): Translator {
    return createTranslator(this.getLanguage());
  }

  setPolicy(policy: ContentPolicy): void {
    this.policy = policy;
  }

  get currentPolicy(): ContentPolicy {
    return this.policy;
  }

  /** Diagnostics for blocked requests are routed to the window that asked. */
  addSink(webContentsId: number, sink: ContentDiagnosticSink): void {
    this.sinks.set(webContentsId, sink);
  }

  removeSink(webContentsId: number): void {
    this.sinks.delete(webContentsId);
  }

  get stats(): { requests: number; blocked: number; failures: number } {
    return { requests: this.requestCount, blocked: this.blockedCount, failures: this.failureCount };
  }

  async clearData(): Promise<void> {
    this.dnsCache.clear();
    this.reportedHosts.clear();
    await Promise.allSettled([this.session.clearCache(), this.session.clearStorageData(), this.session.clearAuthCache()]);
  }

  private report(webContentsId: number | undefined, input: DiagnosticInput): void {
    if (webContentsId !== undefined) {
      const sink = this.sinks.get(webContentsId);
      if (sink) {
        sink(input);
        return;
      }
    }
    this.logger.log('info', 'content diagnostic', { code: input.code, message: input.message, detail: input.detail });
  }

  private registerRequestHandlers(): void {
    const filter = { urls: ['*://*/*'] };

    this.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      void this.decide(details).then((result) => {
        if (result === 'allow') {
          callback({});
          return;
        }
        callback({ cancel: true });
      });
    });

    this.session.webRequest.onErrorOccurred(filter, (details) => {
      if (details.error === 'net::ERR_BLOCKED_BY_CLIENT' || details.error === 'net::ERR_ABORTED') return;
      // Chromium's font loader probes the HTTP cache before going to the network
      // and reports ERR_CACHE_MISS on the probe; the very same URL is then
      // fetched successfully (observed with Google Fonts). Reporting that probe
      // would warn about a fallback that never happened, so the real font state
      // is judged by `document.fonts.status` after the page settles instead.
      if (details.error === 'net::ERR_CACHE_MISS') return;
      if (details.resourceType === 'mainFrame') return;
      this.failureCount += 1;
      const isFont = details.resourceType === 'font' || /\.(woff2?|ttf|otf)(\?|$)/i.test(details.url);
      this.report(details.webContentsId, {
        code: isFont ? 'FONT_FALLBACK' : 'MISSING_RESOURCE',
        severity: 'warning',
        message: isFont ? this.t()('diag.fontFallback') : this.t()('diag.resourceMissing'),
        detail: `${details.error} (${details.resourceType})`,
        url: details.url.slice(0, 500),
      });
    });
  }

  /** Resolves and caches whether a remote hostname is safe to contact. */
  private async hostIsPublic(host: string): Promise<boolean> {
    if (isPrivateHost(host)) return false;
    const cached = this.dnsCache.get(host);
    if (cached) return cached;
    const lookup = (async (): Promise<boolean> => {
      try {
        const addresses = await Promise.race([
          dns.lookup(host, { all: true, verbatim: true }),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS).unref?.();
          }),
        ]);
        return !isPrivateAddressList(addresses.map((entry) => entry.address));
      } catch {
        return false;
      }
    })();
    this.dnsCache.set(host, lookup);
    return lookup;
  }

  private async decide(details: Electron.OnBeforeRequestListenerDetails): Promise<'allow' | 'block'> {
    this.requestCount += 1;
    const decision = classifyResource(details.url, this.policy);
    if (decision.action === 'allow') return 'allow';

    const host = hostFromUrl(details.url);
    const reportedKey = `${decision.reason}|${host ?? decision.detail}`;

    if (decision.reason === 'remote-disabled') {
      if (!this.reportedHosts.has(reportedKey)) {
        this.reportedHosts.add(reportedKey);
        this.blockedCount += 1;
        this.report(details.webContentsId, {
          code: 'REMOTE_RESOURCE_BLOCKED',
          severity: 'info',
          message: this.t()('diag.remoteDisabled'),
          detail: this.t()('diag.remoteDisabledDetail'),
          url: `${host ?? decision.detail}`,
        });
      }
      return 'block';
    }

    if (decision.reason === 'private-network') {
      if (!this.reportedHosts.has(reportedKey)) {
        this.reportedHosts.add(reportedKey);
        this.blockedCount += 1;
        this.report(details.webContentsId, {
          code: 'PRIVATE_NETWORK_BLOCKED',
          severity: 'warning',
          message: this.t()('diag.privateNetworkBlocked'),
          detail: this.t()('diag.privateNetwork', { host: decision.detail }),
          url: details.url.slice(0, 300),
        });
      }
      return 'block';
    }

    if (decision.reason === 'scheme-not-allowed') {
      if (!this.reportedHosts.has(reportedKey)) {
        this.reportedHosts.add(reportedKey);
        this.blockedCount += 1;
        this.report(details.webContentsId, {
          code: 'REMOTE_RESOURCE_BLOCKED',
          severity: 'info',
          message: this.t()('diag.protocolNotAllowed'),
          detail: decision.detail,
        });
      }
      return 'block';
    }

    // Remaining case: a public http(s) host with remote resources enabled. It must
    // resolve to public addresses, and it may only be read, never written to.
    if (details.method !== 'GET' && details.method !== 'HEAD') {
      this.blockedCount += 1;
      this.report(details.webContentsId, {
        code: 'REMOTE_RESOURCE_BLOCKED',
        severity: 'warning',
        message: this.t()('diag.requestBlocked'),
        detail: this.t()('diag.requestBlockedDetail', { method: details.method }),
        url: details.url.slice(0, 300),
      });
      return 'block';
    }

    if (!host) return 'block';
    const allowed = await this.hostIsPublic(host);
    if (!allowed) {
      if (!this.reportedHosts.has(reportedKey)) {
        this.reportedHosts.add(reportedKey);
        this.blockedCount += 1;
        this.report(details.webContentsId, {
          code: 'PRIVATE_NETWORK_BLOCKED',
          severity: 'warning',
          message: this.t()('diag.privateNetworkBlocked'),
          detail: this.t()('diag.hostResolveFailed', { host }),
          url: details.url.slice(0, 300),
        });
      }
      return 'block';
    }
    return 'allow';
  }
}
