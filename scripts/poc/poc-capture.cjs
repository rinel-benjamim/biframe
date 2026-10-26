/**
 * Biframe capture proof-of-concept.
 *
 * Compares the candidate real-time capture strategies inside the Electron
 * runtime that the app will ship:
 *
 *   paint      – BrowserWindow + webContents 'paint' events (offscreen rendering)
 *   screencast – BrowserWindow + CDP Page.startScreencast
 *
 * Flow: create window -> load page (warm-up) -> attach capture -> measure for
 * N seconds -> report frame rate, main-loop jitter, page animation activity and
 * save a spread of frames for visual inspection.
 *
 * Usage:
 *   npx electron scripts/poc/poc-capture.cjs --html <file> --mode screencast --out <dir>
 *     [--fps 60] [--width 1280] [--height 720] [--duration 8] [--offscreen 1] [--show 0]
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const htmlPath = path.resolve(String(arg('html', path.join(__dirname, '..', '..', 'tests', 'fixtures', 'basic-animation.html'))));
const mode = String(arg('mode', 'screencast'));
const offscreen = String(arg('offscreen', '1')) === '1';
const show = String(arg('show', '0')) === '1';
const label = String(arg('label', `${mode}-${offscreen ? 'offscreen' : 'window'}`));
const outDir = path.resolve(String(arg('out', path.join(process.cwd(), '.poc-out', label))));
const fps = Number(arg('fps', 60));
const width = Number(arg('width', 1280));
const height = Number(arg('height', 720));
const durationMs = Number(arg('duration', 8)) * 1000;
const printFrames = Number(arg('print-frames', 4));
const format = String(arg('format', 'jpeg'));

const RAF_INSTRUMENT = `(() => {
  if (window.__poc) { window.__poc.raf = 0; window.__poc.timeouts = 0; return; }
  window.__poc = { raf: 0, timeouts: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__poc.raf += 1; return raf(cb); };
  const st = window.setTimeout.bind(window);
  window.setTimeout = (cb, ms, ...rest) => { window.__poc.timeouts += 1; return st(cb, ms, ...rest); };
})();`;

function step(message, extra) {
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`[poc ${stamp}] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
}

function withTimeout(promise, ms, labelText) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${labelText} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

setTimeout(() => {
  console.error('[poc] hard timeout reached, exiting');
  app.exit(2);
}, 150_000);

async function main() {
  step('start', { mode, offscreen, show, htmlPath, outDir, width, height, fps, durationMs, format });
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const ses = session.fromPartition(`poc-${label}-${Date.now()}`);
  const diagnostics = { console: [], failedRequests: [], totalRequests: 0 };
  ses.webRequest.onCompleted(() => { diagnostics.totalRequests += 1; });
  ses.webRequest.onErrorOccurred((details) => {
    diagnostics.failedRequests.push({ url: details.url.slice(0, 200), error: details.error });
  });

  const win = new BrowserWindow({
    show,
    width,
    height,
    useContentSize: true,
    backgroundColor: '#000000',
    frame: false,
    webPreferences: {
      offscreen,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      session: ses,
    },
  });

  win.webContents.on('console-message', (event) => {
    diagnostics.console.push({ level: event.level, message: String(event.message).slice(0, 200) });
  });
  win.webContents.on('render-process-gone', (_e, details) => step('render-process-gone', details));
  win.webContents.on('did-fail-load', (_e, code, description) => step('did-fail-load', { code, description }));
  step('window created');

  const frames = [];
  const jitterSamples = [];
  let dbg = null;
  let writeChain = Promise.resolve();

  const onFrame = (extension, data) => {
    const record = { t: Date.now(), size: null, file: null };
    frames.push(record);
    const index = frames.length;
    record.file = path.join(outDir, `frame-${String(index).padStart(6, '0')}.${extension}`);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
    writeChain = writeChain.then(() => fsp.writeFile(record.file, buffer)).catch(() => {});
  };

  if (mode === 'paint') {
    win.webContents.setFrameRate(fps);
    win.webContents.on('paint', (_event, _dirty, image) => {
      if (!image || image.isEmpty()) return;
      const size = image.getSize();
      const record = { t: Date.now(), size, file: null };
      frames.push(record);
      const index = frames.length;
      record.file = path.join(outDir, `frame-${String(index).padStart(6, '0')}.png`);
      const png = image.toPNG();
      writeChain = writeChain.then(() => fsp.writeFile(record.file, png)).catch(() => {});
    });
  }

  const startedAt = Date.now();
  await withTimeout(win.loadFile(htmlPath), 20_000, 'loadFile');
  const loadedAt = Date.now();
  step('page loaded', { loadMs: loadedAt - startedAt });

  if (mode === 'screencast') {
    dbg = win.webContents.debugger;
    try {
      dbg.attach('1.3');
      step('debugger attached');
    } catch (error) {
      step('debugger attach failed', { message: String(error) });
      throw error;
    }
    dbg.on('message', async (_e, method, params) => {
      if (method === 'Page.screencastFrame') {
        onFrame(format === 'png' ? 'png' : 'jpg', params.data);
        try { await dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
      }
      if (method === 'Page.screencastVisibilityChanged') {
        step('screencastVisibilityChanged', params);
      }
    });
    await withTimeout(dbg.sendCommand('Page.enable'), 10_000, 'Page.enable');
    step('Page.enable ok');
    await withTimeout(
      dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      10_000,
      'setDeviceMetricsOverride',
    );
    step('deviceMetrics ok');
    await win.webContents.executeJavaScript(RAF_INSTRUMENT, true);
    await withTimeout(
      dbg.sendCommand('Page.startScreencast', {
        format,
        quality: 92,
        maxWidth: width,
        maxHeight: height,
        everyNthFrame: 1,
      }),
      10_000,
      'startScreencast',
    );
    step('screencast started');
  } else {
    await win.webContents.executeJavaScript(RAF_INSTRUMENT, true);
  }

  // Main-process responsiveness probe: a 5ms interval should not drift much.
  let lastJitter = Date.now();
  const jitterTimer = setInterval(() => {
    const now = Date.now();
    jitterSamples.push(now - lastJitter - 5);
    lastJitter = now;
  }, 5);

  const pageBefore = await win.webContents.executeJavaScript(
    `({ visibility: document.visibilityState, raf: window.__poc ? window.__poc.raf : -1, innerWidth, innerHeight, dpr: devicePixelRatio })`,
    true,
  );

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const endedAt = Date.now();
  clearInterval(jitterTimer);

  const pageAfter = await win.webContents.executeJavaScript(
    `({ raf: window.__poc ? window.__poc.raf : -1, timeouts: window.__poc ? window.__poc.timeouts : -1 })`,
    true,
  );

  if (mode === 'screencast' && dbg) {
    try { await withTimeout(dbg.sendCommand('Page.stopScreencast'), 5000, 'stopScreencast'); } catch {}
    try { dbg.detach(); } catch {}
  }
  await writeChain;

  const times = frames.map((f) => f.t).sort((a, b) => a - b);
  const deltas = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const pick = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
  const sortedJitter = [...jitterSamples].sort((a, b) => a - b);

  const summary = {
    label,
    mode,
    offscreen,
    show,
    requested: { fps, width, height, durationMs },
    actual: {
      frameCount: frames.length,
      achievedFps: Number(((frames.length / (endedAt - startedAt)) * 1000).toFixed(2)),
      captureFps: Number(((frames.length / (endedAt - loadedAt)) * 1000).toFixed(2)),
      loadMs: loadedAt - startedAt,
      firstFrameMs: times.length ? times[0] - loadedAt : null,
      lastFrameMs: times.length ? times[times.length - 1] - loadedAt : null,
      medianDeltaMs: pick(deltas, 0.5),
      p95DeltaMs: pick(deltas, 0.95),
      maxDeltaMs: deltas.length ? deltas[deltas.length - 1] : null,
      firstFrameSize: frames.length ? frames[0].size : null,
      mainLoopJitterMs: {
        median: pick(sortedJitter, 0.5),
        p95: pick(sortedJitter, 0.95),
        max: sortedJitter[sortedJitter.length - 1] ?? null,
        samples: jitterSamples.length,
      },
      page: {
        visibility: pageBefore.visibility,
        rafDuringCapture: pageAfter.raf - pageBefore.raf,
        timeoutsDuringCapture: pageAfter.timeouts,
        innerWidth: pageBefore.innerWidth,
        innerHeight: pageBefore.innerHeight,
        dpr: pageBefore.dpr,
      },
      requests: diagnostics.totalRequests,
      failedRequests: diagnostics.failedRequests.slice(0, 5),
      consoleErrors: diagnostics.console.filter((c) => c.level === 'error' || c.level === 3).slice(0, 5),
    },
  };

  const wanted = [];
  if (frames.length > 0) {
    for (let i = 0; i < printFrames; i += 1) {
      wanted.push(frames[Math.min(frames.length - 1, Math.floor(((i + 1) / (printFrames + 1)) * frames.length))]);
    }
    wanted.push(frames[frames.length - 1]);
  }
  const inspectDir = path.join(outDir, 'inspect');
  await fsp.mkdir(inspectDir, { recursive: true });
  let counter = 0;
  for (const frame of wanted) {
    if (!frame || !frame.file) continue;
    counter += 1;
    const ext = path.extname(frame.file);
    await fsp.copyFile(frame.file, path.join(inspectDir, `inspect-${String(counter).padStart(2, '0')}-t${frame.t - loadedAt}ms${ext}`)).catch(() => {});
  }

  await fsp.writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ summary, frames: frames.map((f) => ({ t: f.t, file: f.file ? path.basename(f.file) : null })) }, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((error) => {
  console.error('POC FAILED', error);
  app.exit(1);
});
