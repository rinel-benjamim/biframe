import fsp from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveWithinRoot } from './archive-guard';

/**
 * Serves an imported project over a loopback HTTP server.
 *
 * Imported pages are never loaded from `file://`: a file URL would let the page
 * read any file the user can read. The server exposes exactly one directory,
 * behind an unguessable path prefix, and rejects anything that resolves outside
 * that directory (including through symbolic links).
 */

export interface ProjectServerStats {
  total: number;
  served: number;
  notFound: number;
  denied: number;
  bytesServed: number;
}

export interface ProjectServer {
  origin: string;
  token: string;
  root: string;
  stats: ProjectServerStats;
  entryUrl(relativePath: string): string;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function isInsideRealRoot(realRoot: string, candidate: string): Promise<boolean> {
  try {
    const real = await fsp.realpath(candidate);
    const relative = path.relative(realRoot, real);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

export async function startProjectServer(options: { root: string }): Promise<ProjectServer> {
  const root = path.resolve(options.root);
  const realRoot = await fsp.realpath(root);
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}`;
  const stats: ProjectServerStats = { total: 0, served: 0, notFound: 0, denied: 0, bytesServed: 0 };

  const server = http.createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    stats.total += 1;
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      stats.denied += 1;
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    if (!pathname.startsWith(prefix)) {
      stats.denied += 1;
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const relative = pathname.slice(prefix.length).replace(/^\/+/, '');
    if (relative.length === 0) {
      stats.notFound += 1;
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const target = resolveWithinRoot(root, relative);
    if (!target) {
      stats.denied += 1;
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    let resolvedTarget = target;
    try {
      const stat = await fsp.stat(target);
      if (stat.isDirectory()) {
        const indexCandidate = path.join(target, 'index.html');
        await fsp.stat(indexCandidate);
        resolvedTarget = indexCandidate;
      }
    } catch {
      stats.notFound += 1;
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    if (!(await isInsideRealRoot(realRoot, resolvedTarget))) {
      stats.denied += 1;
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    let size: number;
    try {
      const stat = await fsp.stat(resolvedTarget);
      if (!stat.isFile()) {
        stats.notFound += 1;
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      size = stat.size;
    } catch {
      stats.notFound += 1;
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': mimeTypeFor(resolvedTarget),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };

    const range = parseRange(request.headers.range, size);
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      response.writeHead(206, headers);
      if (method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(resolvedTarget, { start: range.start, end: range.end });
      stream.on('data', (chunk) => {
        stats.bytesServed += chunk.length;
      });
      stream.pipe(response);
      stats.served += 1;
      return;
    }

    headers['Content-Length'] = String(size);
    response.writeHead(200, headers);
    if (method === 'HEAD') {
      response.end();
      stats.served += 1;
      return;
    }
    const stream = fs.createReadStream(resolvedTarget);
    stream.on('data', (chunk) => {
      stats.bytesServed += chunk.length;
    });
    stream.pipe(response);
    stats.served += 1;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('Project server did not bind to a loopback port');
  }

  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    token,
    root,
    stats,
    entryUrl(relativePath: string): string {
      const cleaned = relativePath.replace(/^\/+/, '').split('\\').join('/');
      const encoded = cleaned
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      return `${origin}${prefix}/${encoded}`;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
