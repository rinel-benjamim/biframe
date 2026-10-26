/**
 * Instrumentation injected into every document before the page's own scripts
 * run. It observes only: no animation behaviour is changed, no timers are
 * skipped, no page content is rewritten. It exists to answer two questions the
 * engine cannot answer otherwise:
 *
 *  - when did the animation start (first rAF/timer call after the document),
 *  - did the page signal completion through the optional Biframe protocol.
 */
export const INSTRUMENTATION_SOURCE = `(() => {
  try {
    if (window.__biframeProbe) return;
    const now = () => performance.now();
    const probe = {
      firstRaf: null,
      firstTimer: null,
      domContentLoadedAt: null,
      rafCount: 0,
      timerCount: 0,
      errors: [],
      complete: false,
      installedAt: now()
    };
    try {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = function (callback) {
        if (probe.firstRaf === null) probe.firstRaf = now();
        probe.rafCount += 1;
        return raf(callback);
      };
    } catch (error) { /* a page may freeze the prototype; observation is optional */ }
    try {
      const setTimeoutOriginal = window.setTimeout.bind(window);
      window.setTimeout = function (callback, delay) {
        if (probe.firstTimer === null) probe.firstTimer = now();
        probe.timerCount += 1;
        const args = Array.prototype.slice.call(arguments, 2);
        return setTimeoutOriginal.apply(null, [callback, delay].concat(args));
      };
    } catch (error) { /* ignore */ }
    document.addEventListener('DOMContentLoaded', function () {
      if (probe.domContentLoadedAt === null) probe.domContentLoadedAt = now();
    }, true);
    window.addEventListener('error', function (event) {
      const message = event && (event.message || (event.error && event.error.message));
      if (message) probe.errors.push(String(message).slice(0, 300));
    }, true);
    window.addEventListener('unhandledrejection', function (event) {
      probe.errors.push('promise: ' + String(event && event.reason).slice(0, 300));
    }, true);
    window.addEventListener('biframe:complete', function () {
      probe.complete = true;
    }, true);
    window.__biframeProbe = probe;
  } catch (error) {
    // Instrumentation must never break the imported page.
  }
})();`;

export const READ_PROBE_SOURCE = `(() => {
  const probe = window.__biframeProbe;
  const paints = performance.getEntriesByType('paint');
  const findPaint = (name) => {
    for (const entry of paints) { if (entry.name === name) return entry.startTime; }
    return null;
  };
  return {
    installed: Boolean(probe),
    firstRaf: probe ? probe.firstRaf : null,
    firstTimer: probe ? probe.firstTimer : null,
    domContentLoadedAt: probe ? probe.domContentLoadedAt : null,
    rafCount: probe ? probe.rafCount : 0,
    timerCount: probe ? probe.timerCount : 0,
    errors: probe ? probe.errors.slice(0, 20) : [],
    complete: probe ? probe.complete === true : false,
    firstPaint: findPaint('first-paint'),
    firstContentfulPaint: findPaint('first-contentful-paint'),
    pageNow: performance.now(),
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    visibility: document.visibilityState,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  };
})();`;

export const INSPECT_SOURCE = `(() => {
  const brokenImages = [];
  for (const image of Array.from(document.images)) {
    if (!image.complete || image.naturalWidth === 0) {
      brokenImages.push({ src: (image.currentSrc || image.src || '').slice(0, 500), alt: (image.alt || '').slice(0, 120) });
    }
  }
  const resources = performance.getEntriesByType('resource');
  const hosts = new Set();
  for (const entry of resources) {
    try {
      const url = new URL(entry.name);
      if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.host);
    } catch (error) { /* ignore malformed entries */ }
  }
  const protocol = window.biframe;
  const captureWindow = window.biframeCapture;
  let protocolDuration = null;
  let protocolPresent = false;
  let captureStart = null;
  let captureEnd = null;
  try {
    if (protocol && typeof protocol === 'object') {
      protocolPresent = true;
      if (typeof protocol.duration === 'number' && isFinite(protocol.duration) && protocol.duration > 0) {
        protocolDuration = protocol.duration;
      }
    }
    if (captureWindow && typeof captureWindow === 'object') {
      if (typeof captureWindow.start === 'number' && isFinite(captureWindow.start)) captureStart = captureWindow.start;
      if (typeof captureWindow.end === 'number' && isFinite(captureWindow.end)) captureEnd = captureWindow.end;
    }
  } catch (error) { /* ignore */ }
  const probe = window.__biframeProbe;
  const bodyStyle = getComputedStyle(document.body);
  const mediaElements = document.querySelectorAll('video, audio');
  let playingMedia = 0;
  for (const element of Array.from(mediaElements)) {
    if (!element.paused && !element.ended) playingMedia += 1;
  }
  return {
    readyState: document.readyState,
    title: document.title ? document.title.slice(0, 200) : '',
    fontsStatus: document.fonts ? document.fonts.status : 'n/a',
    brokenImages: brokenImages.slice(0, 20),
    failedImageCount: brokenImages.length,
    resourceCount: resources.length,
    hasRemoteResources: hosts.size > 0,
    remoteHosts: Array.from(hosts).slice(0, 20),
    scriptErrorCount: probe && probe.errors ? probe.errors.length : 0,
    rafCalls: probe ? probe.rafCount : 0,
    timerCalls: probe ? probe.timerCount : 0,
    protocolDurationSeconds: protocolDuration,
    protocolPresent,
    captureStartSeconds: captureStart,
    captureEndSeconds: captureEnd,
    mediaElementCount: mediaElements.length,
    playingMediaCount: playingMedia,
    bodyBackground: bodyStyle ? bodyStyle.backgroundColor : null
  };
})();`;

/** In-page promise that resolves when fonts, images and layout are settled. */
export const READY_SOURCE = `(async () => {
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (error) {}
  const images = Array.from(document.images);
  await Promise.race([
    Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    }))),
    new Promise((resolve) => setTimeout(resolve, 8000))
  ]);
  await settle();
  return {
    readyState: document.readyState,
    images: images.length,
    fontsStatus: document.fonts ? document.fonts.status : 'n/a'
  };
})();`;

export const COMPLETION_SOURCE = `(() => {
  const probe = window.__biframeProbe;
  return Boolean(window.__biframeComplete || (probe && probe.complete));
})();`;

/** Reads `window.biframe` / `window.biframeCapture`; tolerant of malformed values. */
export const READ_PROTOCOL_SOURCE = `(() => {
  const result = { present: false, duration: null, ready: null, deterministic: false, captureStart: null, captureEnd: null };
  try {
    const api = window.biframe;
    if (api && typeof api === 'object') {
      result.present = true;
      if (typeof api.duration === 'number' && isFinite(api.duration) && api.duration > 0) result.duration = api.duration;
      if (typeof api.ready === 'boolean') result.ready = api.ready;
      result.deterministic = api.deterministic === true;
    }
    const capture = window.biframeCapture;
    if (capture && typeof capture === 'object') {
      if (typeof capture.start === 'number' && isFinite(capture.start) && capture.start >= 0) result.captureStart = capture.start;
      if (typeof capture.end === 'number' && isFinite(capture.end) && capture.end > 0) result.captureEnd = capture.end;
    }
  } catch (error) { /* the page may define a hostile getter; the protocol is optional */ }
  return result;
})();`;
