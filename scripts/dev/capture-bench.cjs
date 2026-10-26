/**
 * Capture-rate benchmark for the real Electron runtime.
 *
 * This isolates Page.startScreencast from the render pipeline: it loads the
 * same moving-box fixture, captures for N seconds and reports arrival and
 * presentation timestamps, duplicate payloads, main-loop jitter and rAF rate.
 *
 * Usage:
 *   npx electron scripts/dev/capture-bench.cjs --label offscreen --offscreen 1
 *   npx electron scripts/dev/capture-bench.cjs --label visible --offscreen 0 --show 1
 */
const { app, BrowserWindow, session } = require('electron');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const offscreen = String(arg('offscreen', '1')) === '1';
const show = String(arg('show', '0')) === '1';
const quality = Number(arg('quality', 92));
const ackMode = String(arg('ack', 'immediate'));
const frameRate = Number(arg('set-frame-rate', 0));
const writeFrames = String(arg('write', '1')) === '1';
const hashFrames = String(arg('hash', '1')) === '1';
const opacity = Number(arg('opacity', 1));
const position = String(arg('position', ''));
const noOcclusion = String(arg('no-occlusion', '0')) === '1';
const saveLast = String(arg('save-last', '0')) === '1';
const durationMs = Number(arg('duration', 8)) * 1000;
const width = Number(arg('width', 1280));
const height = Number(arg('height', 720));
const label = String(arg('label', `bench-${offscreen ? 'offscreen' : 'visible'}-q${quality}-${ackMode}`));
const htmlPath = path.resolve(String(arg('html', 'tests/fixtures/basic-animation.html')));
const outDir = path.resolve('.test-out', 'capture-bench');

if (noOcclusion) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

const RAF_INSTRUMENT = `(() => {
  if (window.__bench) { window.__bench.raf = 0; return; }
  window.__bench = { raf: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__bench.raf += 1; return raf(cb); };
})();`;

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  const ses = session.fromPartition(`bench-${label}-${Date.now()}`);
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#000000',
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
  if (frameRate > 0) win.webContents.setFrameRate(frameRate);
  if (position) {
    const [x, y] = position.split(',').map(Number);
    win.setPosition(x, y);
  }
  if (opacity < 1) win.setOpacity(opacity);
  if (show) win.showInactive();

  const frames = [];
  let debuggerAttached = false;
  const debuggerEvents = [];
  let writes = Promise.resolve();
  let metadataSample = null;
  let lastBuffer = null;

  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    const received = Date.now();
    if (ackMode === 'immediate') {
      void win.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
    const buffer = Buffer.from(params.data, 'base64');
    if (!metadataSample) metadataSample = params.metadata ?? null;
    const record = {
      t: received,
      meta: typeof params.metadata?.timestamp === 'number' ? params.metadata.timestamp * 1000 : null,
      hash: hashFrames ? crypto.createHash('sha1').update(buffer).digest('hex') : String(frames.length),
      bytes: buffer.length,
    };
    frames.push(record);
    lastBuffer = buffer;
    if (writeFrames) {
      writes = writes.then(() => fsp.writeFile(path.join(outDir, `${label}-${frames.length}.jpg`), buffer)).catch(() => {});
    }
    if (ackMode === 'after') {
      writes.finally(() => {
        void win.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      });
    }
  });

  win.webContents.on('console-message', (...args) => {
    debuggerEvents.push(args.map(String).join(' ').slice(0, 200));
  });

  await win.loadFile(htmlPath);
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  debuggerAttached = true;
  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await win.webContents.executeJavaScript(RAF_INSTRUMENT, true);
  await dbg.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality,
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  const startedAt = Date.now();
  const jitter = [];
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    jitter.push(now - last - 5);
    last = now;
  }, 5);

  const before = await win.webContents.executeJavaScript(
    '({ raf: window.__bench.raf, visibility: document.visibilityState, innerWidth, innerHeight })',
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  const endedAt = Date.now();
  clearInterval(timer);
  const after = await win.webContents.executeJavaScript('({ raf: window.__bench.raf })', true);

  await dbg.sendCommand('Page.stopScreencast').catch(() => {});
  await writes;
  if (saveLast && lastBuffer) {
    await fsp.writeFile(path.join(outDir, `${label}-last.jpg`), lastBuffer);
  }
  if (debuggerAttached) {
    try { dbg.detach(); } catch {}
  }

  const times = frames.map((frame) => frame.t);
  const arrivals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
  const metaTimes = frames.filter((frame) => frame.meta !== null).map((frame) => frame.meta);
  const metas = metaTimes.slice(1).map((time, index) => time - metaTimes[index]).sort((a, b) => a - b);
  const uniqueHashes = new Set(frames.map((frame) => frame.hash)).size;
  const sizes = frames.map((frame) => frame.bytes).sort((a, b) => a - b);
  const jitterSorted = [...jitter].sort((a, b) => a - b);

  const summary = {
    label,
    offscreen,
    show,
    quality,
    ackMode,
    setFrameRate: frameRate || null,
    durationMs,
    requested: { width, height },
    frames: frames.length,
    uniqueFrames: uniqueHashes,
    duplicatePayloads: frames.length - uniqueHashes,
    captureFps: Number((((frames.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0])).toFixed(2)),
    rafFps: Number((((after.raf - before.raf) * 1000) / (endedAt - startedAt)).toFixed(2)),
    pageVisibility: before.visibility,
    pageSize: [before.innerWidth, before.innerHeight],
    arrivalDeltaMs: {
      median: percentile(arrivals, 0.5),
      p90: percentile(arrivals, 0.9),
      p95: percentile(arrivals, 0.95),
      p99: percentile(arrivals, 0.99),
      max: arrivals.length ? arrivals[arrivals.length - 1] : null,
    },
    metaDeltaMs: metas.length
      ? {
          median: percentile(metas, 0.5),
          p90: percentile(metas, 0.9),
          p95: percentile(metas, 0.95),
          p99: percentile(metas, 0.99),
          max: metas[metas.length - 1],
        }
      : null,
    metaFirst: metadataSample,
    payloadBytes: {
      median: percentile(sizes, 0.5),
      p95: percentile(sizes, 0.95),
      total: sizes.reduce((sum, size) => sum + size, 0),
    },
    mainLoopJitterMs: {
      median: percentile(jitterSorted, 0.5),
      p95: percentile(jitterSorted, 0.95),
      max: jitterSorted.length ? jitterSorted[jitterSorted.length - 1] : null,
    },
    console: debuggerEvents.slice(0, 5),
  };

  console.log(JSON.stringify(summary, null, 2));
  win.destroy();
  app.exit(0);
}

setTimeout(() => {
  console.error('bench hard timeout');
  app.exit(2);
}, 120_000);

app.whenReady().then(main).catch((error) => {
  console.error('BENCH FAILED', error);
  app.exit(1);
});

