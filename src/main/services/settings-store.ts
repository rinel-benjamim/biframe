import fsp from 'node:fs/promises';
import path from 'node:path';
import { BiframeError } from '@shared/errors';
import { mergeAppSettings, validateAppSettings } from '@shared/settings';
import type { AppSettings } from '@shared/types';
import type { Logger } from '../log';

/**
 * Settings persisted as a single JSON document. Writes are atomic (temp file +
 * rename) and every read is merged against defaults field by field, so a
 * hand-edited or half-written file degrades to defaults instead of breaking the
 * application.
 */
export class SettingsStore {
  private readonly file: string;
  private readonly defaultOutputDir: string;
  private readonly logger: Logger;
  private current: AppSettings;

  constructor(file: string, defaultOutputDir: string, logger: Logger) {
    this.file = file;
    this.defaultOutputDir = defaultOutputDir;
    this.logger = logger.child('settings');
    this.current = mergeAppSettings(undefined, defaultOutputDir);
  }

  async load(): Promise<AppSettings> {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.current = mergeAppSettings(JSON.parse(raw) as unknown, this.defaultOutputDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.log('warn', 'settings file could not be read; defaults restored', { error: String(error) });
      }
      this.current = mergeAppSettings(undefined, this.defaultOutputDir);
      await this.persist();
    }
    return this.current;
  }

  get(): AppSettings {
    return this.current;
  }

  async update(patch: unknown): Promise<AppSettings> {
    const candidate = { ...this.current, ...(typeof patch === 'object' && patch !== null ? patch : {}) };
    const validated = validateAppSettings(candidate);
    if (!validated.ok || !validated.value) {
      this.logger.log('warn', 'settings patch rejected', { issues: validated.issues });
      throw new BiframeError('INVALID_SETTINGS', {
        detail: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      });
    }
    this.current = validated.value;
    await this.persist();
    return this.current;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.file}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(temporary, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8');
      await fsp.rename(temporary, this.file);
    } catch (error) {
      this.logger.log('error', 'settings could not be written', { error: String(error) });
      try {
        await fsp.rm(temporary, { force: true });
      } catch {
        // Nothing else to do.
      }
    }
  }
}
