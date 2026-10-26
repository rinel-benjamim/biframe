import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Smoke test for the unpacked Windows build.
 *
 * It launches release/win-unpacked/Biframe.exe (not the source tree), connects
 * over the Chrome DevTools Protocol, imports the example from
 * resources/example, renders a short MP4 and probes it with the bundled
 * ffprobe. Run after `npm run build:unpack`.
 *
 * The app is launched directly instead of through Playwright's Electron
 * helper. On a warm start the window can be created before Playwright attaches,
 * which makes its first-window detector wait forever. A CDP connection sees the
 * real page regardless of that race.
 */

const run = promisify(execFile);
const root = process.cwd();
const artifacts = path.join(root, '.test-out', 'package');
const profile = path.join(artifacts, 'profile');
const outputDir = path.join(artifacts, 'output');
const exe = path.join(root, 'release', 'win-unpacked', 'Biframe.exe');
const ffprobe = path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe');

await fs.rm(profile, { recursive: true, force: true });
await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.access(exe);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

const port = await freePort();
const app = spawn(exe, [`--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const appLog = [];
app.stdout.on('data', (chunk) => appLog.push(chunk.toString()));
app.stderr.on('data', (chunk) => appLog.push(chunk.toString()));

const deadline = Date.now() + 120_000;
let browser;
try {
  let page = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const targets = await response.json();
      const target = targets.find((candidate) => /renderer[\\/]index\.html/.test(candidate.url ?? ''));
      if (target) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0];
        page = context?.pages().find((candidate) => /renderer[\\/]index\.html/.test(candidate.url()));
        if (page) break;
      }
    } catch {
      // The port is not open yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!browser || !page) {
    const text = appLog.join('');
    throw new Error(`packaged window did not become available over CDP\n${text}`);
  }

  const logs = [];
  page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

  await page.locator('.app').waitFor({ state: 'visible', timeout: 90_000 });
  const engine = await page.locator('.engine-dot').textContent();
  console.log('engine:', engine);
  assert.match(engine ?? '', /Motor pronto/);

  await page.getByRole('button', { name: 'Abrir exemplo' }).click();
  await page.locator('.studio').waitFor({ state: 'visible', timeout: 60_000 });
  const projectName = await page.locator('.page-head h1').textContent();
  console.log('project:', projectName);
  assert.match(projectName ?? '', /exemplo-biframe\.html/);

  await page.locator('.stage__live[data-live="true"]').waitFor({ state: 'visible', timeout: 45_000 });

  await page.locator('#export-output-dir').fill(outputDir);
  await page.locator('#export-file-name').fill('packaged-smoke.mp4');
  await page.locator('#export-resolution').selectOption('720p');
  await page.locator('#export-duration').fill('1.5');
  await page.locator('input[name="export-quality"][value="compact"]').check();
  await page.getByRole('button', { name: 'Exportar vídeo' }).click();

  await page.locator('.result').waitFor({ state: 'visible', timeout: 180_000 });
  const heading = await page.locator('.page-head h1').textContent();
  const passed = await page.locator('.check[data-status="pass"]').count();
  const failed = await page.locator('.check[data-status="fail"]').count();
  console.log('result:', heading, `${passed} passed, ${failed} failed`);
  assert.match(heading ?? '', /Vídeo pronto/);
  assert.equal(failed, 0);
  assert.ok(passed >= 8);

  const output = path.join(outputDir, 'packaged-smoke.mp4');
  const stat = await fs.stat(output);
  assert.ok(stat.size > 1000);

  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', output,
  ]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  console.log('ffprobe:', JSON.stringify({
    codec: video?.codec_name,
    profile: video?.profile,
    pixFmt: video?.pix_fmt,
    width: video?.width,
    height: video?.height,
    fps: video?.r_frame_rate,
    frames: video?.nb_frames,
    duration: info.format.duration,
    size: info.format.size,
  }));
  assert.equal(video?.codec_name, 'h264');
  assert.equal(video?.pix_fmt, 'yuv420p');
  assert.equal(video?.width, 1280);
  assert.equal(video?.height, 720);
  assert.equal(video?.nb_frames, '90');

  console.log('packaged smoke test passed');
  if (logs.length > 0) console.log(logs.slice(-20).join('\n'));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (app.pid) {
    await run('taskkill', ['/pid', String(app.pid), '/T', '/F']).catch(() => undefined);
  }
}
