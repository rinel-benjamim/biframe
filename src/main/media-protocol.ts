import { protocol } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AppPaths } from './paths';
import type { Logger } from './log';
import type { HistoryStore } from './services/history-store';
import type { RenderService } from './services/render-service';

/**
 * The media protocol serves exactly two kinds of files to the interface:
 * poster stills produced by a render, and the encoded MP4s recorded in a render
 * job or in history. Paths never come from the URL: the URL carries an id, and
 * the id is resolved through the application's own records.
 *
 * Range requests are implemented by hand so the `<video>` element can seek in a
 * finished MP4, and so a 4K file is never loaded whole into memory.
 */

export const MEDIA_SCHEME = 'biframe-media';

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

export interface MediaProtocolOptions {
  paths: AppPaths;
  render: RenderService;
  history: HistoryStore;
  logger: Logger;
}

interface ByteRange {
  start: number;
  end: number;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart.length === 0 && rawEnd.length === 0) return null;
  let start: number;
  let end: number;
  if (rawStart.length === 0) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd.length === 0 ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end };
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function badRequest(): Response {
  return new Response('Bad request', {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serveStream(
  filePath: string,
  contentType: string,
  request: Request,
  cacheControl: string,
): Promise<Response> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();
  const size = stat.size;
  const rangeHeader = request.headers.get('Range');
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
  };

  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    const body = Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0];
    return new Response(body, { status: 206, headers });
  }

  headers['Content-Length'] = String(size);
  const stream = fs.createReadStream(filePath);
  const body = Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0];
  return new Response(body, { status: 200, headers });
}

async function servePoster(
  options: MediaProtocolOptions,
  posterRoot: string,
  segments: string[],
  request: Request,
): Promise<Response> {
  const jobId = decodeURIComponent(segments[0] ?? '');
  const index = Number(segments[1] ?? '');
  if (!jobId || !Number.isInteger(index) || index < 0) return badRequest();
  const job = options.render.get(jobId);
  const poster = job?.result?.posterFrames[index];
  if (!poster || !isInside(posterRoot, poster)) return notFound();
  return serveStream(poster, 'image/jpeg', request, 'public, max-age=31536000, immutable');
}

async function serveOutput(
  options: MediaProtocolOptions,
  id: string,
  request: Request,
): Promise<Response> {
  if (!id) return badRequest();
  const job = options.render.get(id);
  let outputPath = job?.result?.outputPath;
  if (!outputPath) {
    const entry = options.history.list().find((candidate) => candidate.id === id);
    if (entry && entry.status === 'completed') outputPath = entry.outputPath;
  }
  if (!outputPath || !path.isAbsolute(outputPath)) return notFound();
  return serveStream(outputPath, 'video/mp4', request, 'no-store');
}

export function installMediaProtocol(options: MediaProtocolOptions): void {
  const posterRoot = path.resolve(options.paths.postersRoot);
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
      if (url.hostname === 'poster') {
        return await servePoster(options, posterRoot, segments, request);
      }
      if (url.hostname === 'output') {
        return await serveOutput(options, decodeURIComponent(segments[0] ?? ''), request);
      }
      return notFound();
    } catch (error) {
      options.logger.log('warn', 'media request failed', { error: String(error), url: request.url.slice(0, 300) });
      return notFound();
    }
  });
}
