import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * E2E runs the real packaged-style renderer/main bundle (`out/`), not the Vite
 * dev server. Building once here keeps every test in the project on the same
 * artifact and catches a broken build before Electron is launched.
 *
 * Set BIFRAME_SKIP_E2E_BUILD=1 when iterating: the suite will reuse the current
 * `out/` directory after checking that the entry point exists.
 */
export default async function setup(): Promise<void> {
  const projectRoot = path.resolve('.');
  const output = path.resolve('.test-out', 'e2e');
  await fsp.rm(output, { recursive: true, force: true });
  await fsp.mkdir(output, { recursive: true });

  if (process.env['BIFRAME_SKIP_E2E_BUILD'] === '1') {
    await fsp.access(path.join(projectRoot, 'out', 'main', 'index.js'));
    return;
  }

  if (process.platform === 'win32') {
    // Node 26 no longer launches .cmd shims directly. Spawn cmd.exe (an .exe)
    // rather than enabling `shell`, which is unnecessary here and deprecated.
    execFileSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
      timeout: 240_000,
      windowsHide: true,
    });
    return;
  }

  execFileSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
    timeout: 240_000,
  });
}
