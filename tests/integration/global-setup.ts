import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Integration tests are allowed to leave artifacts only under .test-out.
 * Starting from an empty directory makes a failed run easy to inspect.
 */
export default async function setup(): Promise<void> {
  const root = path.resolve('.test-out', 'integration');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
}
