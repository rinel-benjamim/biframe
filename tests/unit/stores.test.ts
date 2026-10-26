import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../../src/main/services/history-store';
import { SettingsStore } from '../../src/main/services/settings-store';
import type { Logger } from '../../src/main/log';
import type { HistoryEntry } from '@shared/types';

function silentLogger(): Logger {
  const logger: Logger = {
    file: '',
    log: () => undefined,
    child: () => logger,
  };
  return logger;
}

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'biframe-store-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('writes defaults on first load', async () => {
    const file = path.join(root, 'settings.json');
    const store = new SettingsStore(file, 'C:\\out', silentLogger());
    const settings = await store.load();
    expect(settings.theme).toBe('light');
    expect(settings.defaultOutputDir).toBe('C:\\out');
    const persisted = JSON.parse(await fsp.readFile(file, 'utf8')) as { theme: string };
    expect(persisted.theme).toBe('light');
  });

  it('persists updates and reloads them', async () => {
    const file = path.join(root, 'settings.json');
    const first = new SettingsStore(file, 'C:\\out', silentLogger());
    await first.load();
    await first.update({ theme: 'dark', allowRemoteResources: false });

    const second = new SettingsStore(file, 'C:\\out', silentLogger());
    const settings = await second.load();
    expect(settings.theme).toBe('dark');
    expect(settings.allowRemoteResources).toBe(false);
  });

  it('rejects invalid patches and keeps the previous settings', async () => {
    const file = path.join(root, 'settings.json');
    const store = new SettingsStore(file, 'C:\\out', silentLogger());
    await store.load();
    await store.update({ theme: 'dark' });
    await expect(store.update({ theme: 'neon' })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(store.get().theme).toBe('dark');
  });

  it('recovers from corrupt JSON by restoring defaults', async () => {
    const file = path.join(root, 'settings.json');
    await fsp.writeFile(file, '{not valid json', 'utf8');
    const store = new SettingsStore(file, 'C:\\out', silentLogger());
    const settings = await store.load();
    expect(settings).toEqual(expect.objectContaining({ theme: 'light', defaultOutputDir: 'C:\\out' }));
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toMatchObject({ theme: 'light' });
  });

  it('repairs a partially valid stored document', async () => {
    const file = path.join(root, 'settings.json');
    await fsp.writeFile(
      file,
      JSON.stringify({ theme: 'system', keepTempFiles: true, limits: { maxDurationSeconds: 20 } }),
      'utf8',
    );
    const store = new SettingsStore(file, 'C:\\fallback', silentLogger());
    const settings = await store.load();
    expect(settings.theme).toBe('system');
    expect(settings.keepTempFiles).toBe(true);
    expect(settings.defaultOutputDir).toBe('C:\\fallback');
    expect(settings.limits.maxDurationSeconds).toBe(20);
    expect(settings.limits.maxZipEntries).toBeGreaterThan(0);
  });
});

function historyEntry(id: string, status: HistoryEntry['status'] = 'completed'): HistoryEntry {
  return {
    id,
    projectName: 'projeto.html',
    fileName: `${id}.mp4`,
    outputPath: `C:\\out\\${id}.mp4`,
    sizeBytes: 1234,
    durationSeconds: 2,
    width: 1280,
    height: 720,
    fps: 30,
    status,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_002_000,
  };
}

describe('HistoryStore', () => {
  it('starts empty and persists entries newest first', async () => {
    const file = path.join(root, 'history.json');
    const store = new HistoryStore(file, silentLogger());
    expect(await store.load()).toEqual([]);
    await store.add(historyEntry('a'));
    await store.add(historyEntry('b'));
    expect(store.list().map((entry) => entry.id)).toEqual(['b', 'a']);

    const reloaded = new HistoryStore(file, silentLogger());
    expect((await reloaded.load()).map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('replaces an entry with the same id instead of duplicating it', async () => {
    const store = new HistoryStore(path.join(root, 'history.json'), silentLogger());
    await store.load();
    await store.add(historyEntry('a'));
    await store.add({ ...historyEntry('a', 'failed'), error: { code: 'ENCODING_FAILED', title: 'x', message: 'y', recoverable: true } });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.status).toBe('failed');
  });

  it('ignores corrupt files and invalid entries', async () => {
    const file = path.join(root, 'history.json');
    await fsp.writeFile(file, '{broken', 'utf8');
    expect(await new HistoryStore(file, silentLogger()).load()).toEqual([]);

    await fsp.writeFile(file, JSON.stringify([{ id: 'ok', fileName: 'a.mp4', outputPath: '', startedAt: 1, status: 'completed' }, { nope: true }]), 'utf8');
    expect((await new HistoryStore(file, silentLogger()).load()).map((entry) => entry.id)).toEqual(['ok']);
  });

  it('clears the file and the in-memory list', async () => {
    const file = path.join(root, 'history.json');
    const store = new HistoryStore(file, silentLogger());
    await store.load();
    await store.add(historyEntry('a'));
    await store.clear();
    expect(store.list()).toEqual([]);
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual([]);
  });
});
