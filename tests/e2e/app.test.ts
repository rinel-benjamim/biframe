import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

/**
 * End-to-end: the real Electron application, the real Chromium capture host,
 * the bundled FFmpeg and the real interface. The test opens the bundled
 * example, confirms the live preview, exports a short 720p MP4, reads it with
 * ffprobe, replaces it through the conflict dialog and finally cancels a long
 * render mid-capture.
 */

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const ffprobePath = (require('ffprobe-static') as { path: string }).path;

const projectRoot = path.resolve('.');
const artifacts = path.resolve('.test-out', 'e2e');
const profile = path.join(artifacts, 'profile');
const outputDir = path.join(artifacts, 'output');
const exampleSource = path.join(projectRoot, 'resources', 'example', 'exemplo-biframe.html');

let app: ElectronApplication;
let page: Page;
let exampleHash = '';
const consoleLines: string[] = [];

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function probe(filePath: string): Promise<{
  format: { format_name?: string; duration?: string; size?: string };
  streams: { codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number; nb_frames?: string; r_frame_rate?: string }[];
}> {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return JSON.parse(stdout) as Awaited<ReturnType<typeof probe>>;
}

async function exportCurrentDraft(fileName: string, seconds: number): Promise<void> {
  await page.locator('#export-file-name').fill(fileName);
  await page.locator('#export-output-dir').fill(outputDir);
  await page.locator('#export-resolution').selectOption('720p');
  await page.locator('#export-duration').fill(String(seconds));
  await page.locator('input[name="export-quality"][value="compact"]').check();
  await page.getByRole('button', { name: 'Exportar vídeo' }).click();
}

async function backToStudio(): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('button', { name: 'Estúdio' })
    .click();
  await page.locator('.studio').waitFor({ state: 'visible' });
}

async function captureDesktop(name: string): Promise<void> {
  try {
    await page.bringToFront();
    // WebContentsView surfaces are composited asynchronously; give the stage a
    // beat to paint before the OS screenshot, otherwise it can be captured black.
    await page.waitForTimeout(1200);
    const base64 = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.size.width, height: display.size.height },
      });
      return sources[0]?.thumbnail.toPNG().toString('base64') ?? '';
    });
    if (base64) await fsp.writeFile(path.join(artifacts, name), Buffer.from(base64, 'base64'));
  } catch {
    // Screenshots are evidence for the human reviewer, not an assertion.
  }
}

beforeAll(async () => {
  await fsp.mkdir(outputDir, { recursive: true });
  app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      BIFRAME_USER_DATA_DIR: profile,
      BIFRAME_DISABLE_DEVTOOLS: '1',
    },
  });
  // The first launch after a build can be slow: Windows Defender scans the
  // freshly written bundles before Electron is allowed to paint. 90 s is a
  // cold-start budget, not a performance expectation.
  page = await app.firstWindow({ timeout: 90_000 });
  page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));
  await page.locator('.app').waitFor({ state: 'visible', timeout: 60_000 });
  exampleHash = sha256(await fsp.readFile(exampleSource));
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (process.env['BIFRAME_DEBUG_E2E'] === '1') {
    console.log(consoleLines.slice(-60).join('\n'));
  }
});

describe('Biframe desktop application', () => {
  it('starts on an empty studio with the engine ready', async () => {
    await page.getByRole('heading', { name: 'Da web para vídeo.' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Importar HTML' }).count()).toBeGreaterThan(0);
    expect(await page.getByRole('button', { name: 'Importar ZIP' }).count()).toBeGreaterThan(0);
    await page.waitForFunction(
      "document.querySelector('.engine-dot')?.textContent?.includes('Motor pronto') ?? false",
      undefined,
      { timeout: 30_000 },
    );
    await captureDesktop('01-empty-studio.png');
  });

  it('imports the bundled example and shows the live preview at export geometry', async () => {
    await page.getByRole('button', { name: 'Abrir exemplo' }).click();
    await page.locator('.studio').waitFor({ state: 'visible', timeout: 60_000 });

    expect(await page.locator('.rail__project-name').first().textContent()).toContain('exemplo-biframe.html');
    expect(await page.locator('.page-head h1').textContent()).toContain('exemplo-biframe.html');
    // The draft starts at the app default (720p at 60 fps) before any export options are changed.
    expect(await page.locator('.stage__bar').textContent()).toContain('1280 × 720');

    // The preview is a real WebContentsView; the UI marks it live only when it
    // is fully visible and the page has loaded.
    await page.locator('.stage').scrollIntoViewIfNeeded();
    await page.locator('.stage__live[data-live="true"]').waitFor({ state: 'visible', timeout: 45_000 });
    expect(await page.locator('.stage__live').textContent()).toContain('Ao vivo');

    expect(exampleHash).toHaveLength(64);
    await captureDesktop('02-studio-live-preview.png');
  });

  it('exports a validated 720p H.264 MP4 and shows real validation and frames', async () => {
    await exportCurrentDraft('e2e-exemplo.mp4', 1.5);

    await page.locator('.export__progress .progress').waitFor({ state: 'visible', timeout: 20_000 });
    const progressText = await page.locator('.export__progress').textContent();
    expect(progressText).toBeTruthy();

    await page.locator('.result').waitFor({ state: 'visible', timeout: 180_000 });
    expect(await page.locator('.page-head h1').textContent()).toContain('Vídeo pronto.');
    expect(await page.locator('.check').count()).toBe(9);
    expect(await page.locator('.check[data-status="fail"]').count()).toBe(0);
    expect(await page.locator('.result__side').textContent()).toContain('1280 × 720');
    expect(await page.locator('.result__side').textContent()).toContain('H.264');
    expect(await page.locator('.file-path__value--name').textContent()).toBe('e2e-exemplo.mp4');

    await page.waitForFunction(
      "Array.from(document.querySelectorAll('.filmstrip img')).length === 5 && Array.from(document.querySelectorAll('.filmstrip img')).every((image) => image.complete && image.naturalWidth > 0)",
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator('.filmstrip img').count()).toBe(5);

    const outputPath = path.join(outputDir, 'e2e-exemplo.mp4');
    const stat = await fsp.stat(outputPath);
    expect(stat.size).toBeGreaterThan(1000);

    const info = await probe(outputPath);
    const video = info.streams.find((stream) => stream.codec_type === 'video');
    expect(info.format.format_name).toContain('mp4');
    expect(video?.codec_name).toBe('h264');
    expect(video?.pix_fmt).toBe('yuv420p');
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(video?.r_frame_rate).toBe('60/1');
    expect(Number(video?.nb_frames)).toBe(90);
    expect(Number(info.format.duration)).toBeCloseTo(1.5, 1);

    await captureDesktop('03-result.png');
  });

  it('asks before overwriting and replaces the file only after confirmation', async () => {
    const outputPath = path.join(outputDir, 'e2e-exemplo.mp4');
    const firstMtime = (await fsp.stat(outputPath)).mtimeMs;

    await backToStudio();
    await exportCurrentDraft('e2e-exemplo.mp4', 1.5);

    await page.getByRole('button', { name: 'Substituir ficheiro' }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('.notice[role="alert"]').textContent()).toContain('Já existe um ficheiro com este nome');
    // The conflict dialog is a preflight: no job starts and the old file stays.
    expect(await page.locator('.export__progress .progress').count()).toBe(0);
    expect((await fsp.stat(outputPath)).mtimeMs).toBe(firstMtime);

    await page.getByRole('button', { name: 'Substituir ficheiro' }).click();
    await page.locator('.result').waitFor({ state: 'visible', timeout: 180_000 });
    expect(await page.locator('.page-head h1').textContent()).toContain('Vídeo pronto.');

    const secondMtime = (await fsp.stat(outputPath)).mtimeMs;
    expect(secondMtime).toBeGreaterThan(firstMtime);
    const info = await probe(outputPath);
    expect(info.streams.find((stream) => stream.codec_type === 'video')?.width).toBe(1280);
  });

  it('cancels a long render during capture and leaves no file behind', async () => {
    const cancelledPath = path.join(outputDir, 'e2e-cancelado.mp4');
    await backToStudio();
    await exportCurrentDraft('e2e-cancelado.mp4', 8);

    await page.locator('.export__progress .progress').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(700);
    await page.locator('.panel__foot .btn--danger').click();

    await page.getByText('Renderização cancelada').first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: 'Exportar vídeo' }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.locator('.studio').count()).toBe(1);
    await expect(fsp.access(cancelledPath)).rejects.toThrow();

    const files = (await fsp.readdir(outputDir)).filter((name) => name.endsWith('.mp4'));
    expect(files).toEqual(['e2e-exemplo.mp4']);

    // The imported example was copied, never modified in place.
    expect(sha256(await fsp.readFile(exampleSource))).toBe(exampleHash);
    await captureDesktop('04-after-cancel.png');
  });

  it('switches the interface language, persists it and switches back', async () => {
    const rail = page.getByRole('navigation', { name: 'Navegação principal' });
    await rail.getByRole('button', { name: 'Definições' }).click();
    await page.locator('#language-label').waitFor({ state: 'visible' });
    expect(await page.locator('#language-label').textContent()).toBe('Idioma');

    // Portuguese is the shipped default.
    expect(await page.getByRole('button', { name: 'Português', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await page.evaluate('document.documentElement.lang')).toBe('pt-PT');

    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator('#language-label').textContent()).toBe('Language');
    expect(await page.getByRole('button', { name: 'English', exact: true }).getAttribute('aria-pressed')).toBe('true');
    await captureDesktop('05-settings-english.png');

    // The document language follows the interface language, so screen readers
    // pronounce the new copy correctly.
    expect(await page.evaluate('document.documentElement.lang')).toBe('en-US');

    // The choice is a setting: a fresh window load boots in English.
    await page.reload();
    await page.locator('.app').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'visible', timeout: 30_000 });
    expect(await page.evaluate('document.documentElement.lang')).toBe('en-US');

    // Leave the profile in the default language for the next run.
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Português', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegação principal' }).waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator('#language-label').textContent()).toBe('Idioma');
    expect(await page.evaluate('document.documentElement.lang')).toBe('pt-PT');
  });
});
