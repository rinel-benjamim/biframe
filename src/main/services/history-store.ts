import fsp from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEntry } from '@shared/types';
import type { Logger } from '../log';

const MAX_ENTRIES = 100;

/**
 * Render history. Entries are informational: they make past renders reachable
 * from the interface, they are never used to decide what the engine does.
 */
export class HistoryStore {
  private readonly file: string;
  private readonly logger: Logger;
  private entries: HistoryEntry[] = [];

  constructor(file: string, logger: Logger) {
    this.file = file;
    this.logger = logger.child('history');
  }

  async load(): Promise<HistoryEntry[]> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed.filter(isHistoryEntry).slice(0, MAX_ENTRIES) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.log('warn', 'history file could not be read; starting empty', { error: String(error) });
      }
      this.entries = [];
    }
    return this.entries;
  }

  list(): HistoryEntry[] {
    return [...this.entries];
  }

  async add(entry: HistoryEntry): Promise<HistoryEntry[]> {
    this.entries = [entry, ...this.entries.filter((candidate) => candidate.id !== entry.id)].slice(0, MAX_ENTRIES);
    await this.persist();
    return this.list();
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const temporary = `${this.file}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, 'utf8');
      await fsp.rename(temporary, this.file);
    } catch (error) {
      this.logger.log('error', 'history could not be written', { error: String(error) });
      try {
        await fsp.rm(temporary, { force: true });
      } catch {
        // Nothing else to do.
      }
    }
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HistoryEntry>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.fileName === 'string' &&
    typeof candidate.outputPath === 'string' &&
    typeof candidate.startedAt === 'number' &&
    (candidate.status === 'running' || candidate.status === 'completed' || candidate.status === 'cancelled' || candidate.status === 'failed')
  );
}
