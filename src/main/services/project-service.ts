import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BiframeError } from '@shared/errors';
import type { Diagnostic, ProjectInfo } from '@shared/types';
import { classifyArchiveEntries, normalizeArchivePath, pickHtmlEntry, resolveWithinRoot } from '../../engine/project/archive-guard';
import { startProjectServer, type ProjectServer } from '../../engine/project/server';
import { DiagnosticCollector, type DiagnosticInput } from '../../engine/diagnostics';
import type { AppPaths } from '../paths';
import type { Logger } from '../log';
import { collectSingleHtmlProject, remoteHostsFromText } from './html-assets';

/**
 * Import turns a file the user picked (.html, .htm, .xhtml or .zip) into a
 * temporary, self-contained project directory served over loopback HTTP.
 *
 * The user's file is never modified and never loaded in place: the HTML file and
 * its local assets are copied, or the archive is extracted entry by entry with
 * each path re-verified against the destination root. A project that fails the
 * safety guard is rejected whole.
 */

export interface ProjectImportOptions {
  /** Wall-clock budget for the whole import, in ms. */
  timeoutMs?: number;
}

export interface ProjectServiceOptions {
  paths: AppPaths;
  logger: Logger;
  limits: () => { maxProjectBytes: number; maxZipEntries: number };
  onProjectChanged?: (project: ProjectInfo | null) => void;
}

const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);

export class ProjectService {
  private readonly paths: AppPaths;
  private readonly logger: Logger;
  private readonly options: ProjectServiceOptions;
  private project: ProjectInfo | null = null;
  private server: ProjectServer | null = null;

  constructor(options: ProjectServiceOptions) {
    this.paths = options.paths;
    this.logger = options.logger.child('project');
    this.options = options;
  }

  current(): ProjectInfo | null {
    return this.project;
  }

  /** Absolute URL of the imported entry file; null when no project is open. */
  entryUrl(): string | null {
    if (!this.project || !this.server) return null;
    const relative = path.relative(this.project.rootPath, this.project.entryPath).split(path.sep).join('/');
    return this.server.entryUrl(relative);
  }

  get serverOrigin(): string | null {
    return this.server?.origin ?? null;
  }

  async importPath(sourcePath: string, _options: ProjectImportOptions = {}): Promise<ProjectInfo> {
    const resolvedSource = path.resolve(sourcePath);
    let sourceStat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      sourceStat = await fsp.stat(resolvedSource);
    } catch {
      throw new BiframeError('PROJECT_NOT_FOUND', { detail: resolvedSource });
    }
    if (!sourceStat.isFile()) {
      throw new BiframeError('UNSUPPORTED_PROJECT_FORMAT', { detail: 'a file was expected' });
    }

    const extension = path.extname(resolvedSource).toLowerCase();
    const isHtml = HTML_EXTENSIONS.has(extension);
    const isZip = extension === '.zip';
    if (!isHtml && !isZip) {
      throw new BiframeError('UNSUPPORTED_PROJECT_FORMAT', { detail: extension || 'no extension' });
    }

    const limits = this.options.limits();
    if (sourceStat.size > limits.maxProjectBytes) {
      throw new BiframeError('PROJECT_TOO_LARGE', {
        detail: `${sourceStat.size} bytes > ${limits.maxProjectBytes} bytes`,
      });
    }

    await this.close();

    const id = randomUUID();
    const rootPath = path.join(this.paths.projectsRoot, id);
    await fsp.mkdir(rootPath, { recursive: true });

    try {
      const imported = isHtml
        ? await this.importHtml(resolvedSource, rootPath, limits)
        : await this.importZip(resolvedSource, rootPath, limits);

      const server = await startProjectServer({ root: rootPath });
      this.server = server;
      const project: ProjectInfo = {
        id,
        name: path.basename(resolvedSource),
        kind: isHtml ? 'html' : 'zip',
        entryPath: path.join(rootPath, imported.entryRelative),
        rootPath,
        sourcePath: resolvedSource,
        sizeBytes: imported.bytes,
        importedAt: Date.now(),
        htmlFileCount: imported.htmlCount,
        assetCount: imported.assetCount,
        remoteResourceHosts: imported.remoteHosts,
        warnings: imported.warnings,
      };
      this.project = project;
      this.options.onProjectChanged?.(project);
      this.logger.log('info', 'project imported', {
        id,
        kind: project.kind,
        files: imported.htmlCount + imported.assetCount,
        bytes: imported.bytes,
      });
      return project;
    } catch (error) {
      await fsp.rm(rootPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async importHtml(
    sourcePath: string,
    rootPath: string,
    limits: { maxProjectBytes: number; maxZipEntries: number },
  ): Promise<{
    entryRelative: string;
    bytes: number;
    htmlCount: number;
    assetCount: number;
    remoteHosts: string[];
    warnings: Diagnostic[];
  }> {
    const result = await collectSingleHtmlProject({
      htmlPath: sourcePath,
      destinationRoot: rootPath,
      limits: {
        maxFiles: Math.min(limits.maxZipEntries, 2000),
        maxTotalBytes: limits.maxProjectBytes,
        maxFileBytes: 64 * 1024 * 1024,
      },
    });
    const collector = new DiagnosticCollector(60);
    collector.addAll(toDiagnostics(result.diagnostics));
    const entryBytes = (await fsp.stat(sourcePath)).size;
    return {
      entryRelative: result.entryRelative,
      // The imported project includes the entry file itself; copiedBytes only
      // counts the assets next to it.
      bytes: result.copiedBytes + entryBytes,
      htmlCount: 1,
      assetCount: result.copiedFiles,
      remoteHosts: result.remoteHosts,
      warnings: collector.all,
    };
  }

  private async importZip(
    sourcePath: string,
    rootPath: string,
    limits: { maxProjectBytes: number; maxZipEntries: number },
  ): Promise<{
    entryRelative: string;
    bytes: number;
    htmlCount: number;
    assetCount: number;
    remoteHosts: string[];
    warnings: Diagnostic[];
  }> {
    let archive: AdmZip;
    try {
      archive = new AdmZip(sourcePath);
    } catch (error) {
      throw new BiframeError('PROJECT_IMPORT_FAILED', { detail: `not a readable zip: ${String(error)}` });
    }

    const rawEntries = archive.getEntries().map((entry) => {
      const attr = entry.header.attr ?? 0;
      return {
        path: entry.entryName,
        sizeBytes: entry.header.size,
        isDirectory: entry.isDirectory,
        unixMode: (attr >>> 16) & 0xffff,
        dosAttributes: attr & 0xffff,
      };
    });

    const plan = classifyArchiveEntries(rawEntries, {
      maxEntries: limits.maxZipEntries,
      maxTotalBytes: limits.maxProjectBytes,
      maxEntryBytes: limits.maxProjectBytes,
    });

    const unsafe = plan.rejected.filter((entry) => entry.reason === 'caminho inválido' || entry.reason === 'link simbólico');
    if (unsafe.length > 0 && plan.accepted.length === 0) {
      throw new BiframeError('ARCHIVE_UNSAFE_ENTRY', {
        detail: unsafe.slice(0, 5).map((entry) => `${entry.path}: ${entry.reason}`).join('; '),
      });
    }

    const collector = new DiagnosticCollector(80);
    for (const rejected of plan.rejected.slice(0, 12)) {
      collector.add({
        code: 'ZIP_ENTRY_SKIPPED',
        severity: rejected.reason === 'link simbólico' || rejected.reason === 'caminho inválido' ? 'warning' : 'info',
        message: 'Uma entrada do arquivo foi ignorada',
        detail: `${rejected.path} — ${rejected.reason}`,
      });
    }
    if (plan.truncated) {
      collector.add({
        code: 'ZIP_ENTRY_SKIPPED',
        severity: 'warning',
        message: 'O arquivo excedeu os limites e parte do conteúdo foi ignorada',
        detail: `Máximo de ${limits.maxZipEntries} entradas e ${limits.maxProjectBytes} bytes.`,
      });
    }

    const acceptedPaths = plan.accepted.map((entry) => entry.path);
    const entryRelative = pickHtmlEntry(acceptedPaths);
    if (!entryRelative) {
      throw new BiframeError('ARCHIVE_ENTRY_MISSING_HTML', {
        detail: `${acceptedPaths.length} entries, none html`,
      });
    }

    let bytes = 0;
    const entryByNormalizedPath = new Map<string, AdmZip.IZipEntry>();
    for (const entry of archive.getEntries()) {
      const normalized = normalizeArchivePath(entry.entryName);
      if (normalized && !entryByNormalizedPath.has(normalized)) entryByNormalizedPath.set(normalized, entry);
    }
    const htmlContents: string[] = [];

    for (const accepted of plan.accepted) {
      if (accepted.isDirectory) continue;
      const destination = resolveWithinRoot(rootPath, accepted.path);
      if (!destination) {
        collector.add({
          code: 'ZIP_ENTRY_SKIPPED',
          severity: 'warning',
          message: 'Uma entrada do arquivo foi ignorada',
          detail: `${accepted.path} — o caminho resolvido sairia da pasta do projeto`,
        });
        continue;
      }
      const entry = entryByNormalizedPath.get(accepted.path);
      if (!entry) continue;
      const data = entry.getData();
      if (accepted.path === entryRelative) htmlContents.push(data.toString('utf8').slice(0, 2 * 1024 * 1024));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, data);
      bytes += data.length;
    }

    const htmlCount = acceptedPaths.filter((candidate) => /\.(html?|xhtml)$/i.test(candidate)).length;
    const assetCount = acceptedPaths.filter((candidate) => !/\.(html?|xhtml)$/i.test(candidate)).length;
    const remoteHosts = new Set<string>();
    for (const content of htmlContents) {
      for (const host of remoteHostsFromText(content)) remoteHosts.add(host);
    }
    if (remoteHosts.size > 0) {
      collector.add({
        code: 'REMOTE_RESOURCES',
        severity: 'info',
        message: 'O projeto usa recursos externos',
        detail: [...remoteHosts].slice(0, 8).join(', '),
      });
    }

    return {
      entryRelative,
      bytes,
      htmlCount,
      assetCount,
      remoteHosts: [...remoteHosts],
      warnings: collector.all,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.project = null;
    if (server) {
      try {
        await server.close();
      } catch (error) {
        this.logger.log('warn', 'project server did not close cleanly', { error: String(error) });
      }
      try {
        await fsp.rm(server.root, { recursive: true, force: true });
      } catch {
        // The startup sweep removes leftovers.
      }
    }
    this.options.onProjectChanged?.(null);
  }
}

function toDiagnostics(inputs: DiagnosticInput[]): Diagnostic[] {
  return inputs.map((input, index) => ({
    id: `p${index + 1}`,
    code: input.code,
    severity: input.severity,
    message: input.message,
    at: Date.now(),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.url ? { url: input.url } : {}),
  }));
}
