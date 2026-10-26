import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AppPaths } from '../../src/main/paths';
import type { Logger } from '../../src/main/log';
import { startProjectServer, type ProjectServer } from '@engine/project/server';
import { collectSingleHtmlProject, remoteHostsFromText } from '../../src/main/services/html-assets';
import { ProjectService } from '../../src/main/services/project-service';

/**
 * Integration coverage for the project boundary: the loopback server that
 * serves imported content (token, traversal, ranges, MIME) and the importer
 * that copies a single HTML file together with its local assets or extracts a
 * ZIP. No projection of these rules into mocks: real files, real HTTP.
 */

const root = path.resolve('.test-out', 'integration', 'project');
const serverRoot = path.join(root, 'server');
const outsideFile = path.join(root, 'outside.txt');
const htmlFixture = path.join(root, 'fixture');
const serviceRoot = path.join(root, 'service');
const outputsRoot = path.join(root, 'outputs');
const zipPath = path.join(root, 'project.zip');

let server: ProjectServer;

async function write(relative: string, content: string | Buffer, base = serverRoot): Promise<void> {
  const target = path.join(base, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(
  origin: string,
  rawPath: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const parsed = new URL(origin);
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: rawPath,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function directoryBytes(target: string): Promise<number> {
  let total = 0;
  const entries = await fsp.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else total += (await fsp.stat(full)).size;
  }
  return total;
}

function createLogger(): Logger {
  const logger: Logger = {
    file: 'test.log',
    log: () => undefined,
    child: () => logger,
  };
  return logger;
}

function servicePaths(): AppPaths {
  return {
    userData: serviceRoot,
    tempRoot: path.join(serviceRoot, 'temp'),
    framesRoot: path.join(serviceRoot, 'temp', 'frames'),
    postersRoot: path.join(serviceRoot, 'temp', 'posters'),
    projectsRoot: path.join(serviceRoot, 'temp', 'projects'),
    logsDir: path.join(serviceRoot, 'logs'),
    settingsFile: path.join(serviceRoot, 'settings.json'),
    historyFile: path.join(serviceRoot, 'history.json'),
    exampleDir: path.join(root, 'no-example'),
  };
}

beforeAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(serverRoot, { recursive: true });
  await fsp.mkdir(outputsRoot, { recursive: true });

  await write('index.html', '<!doctype html><title>Raiz</title><p>olá</p>');
  await write('sub/index.html', '<!doctype html><title>Sub</title><p>sub</p>');
  await write('assets/app.css', 'body{color:#123456}');
  await write('data.txt', '0123456789');
  await write('sub folder/page um.html', '<!doctype html><title>Espaços</title>');
  await write('empty-dir/keep.txt', '');
  await fsp.writeFile(outsideFile, 'outside-the-project-root');

  // Single-HTML fixture: CSS imports two levels deep, srcset, inline styles,
  // an external script, a missing image and a reference outside the folder.
  await write(
    'page.html',
    `<!doctype html>
<html lang="pt-PT">
  <head>
    <meta charset="utf-8" />
    <title>Projeto de teste</title>
    <link rel="stylesheet" href="style.css" />
    <style>.hero { background: url('img/bg.jpg') }</style>
  </head>
  <body>
    <img src="img/pic.png" srcset="img/pic.png 1x, img/pic@2x.png 2x" alt="imagem" />
    <img src="missing.png" alt="em falta" />
    <video poster="img/poster.jpg"></video>
    <script src="https://cdn.example.com/app.js"></script>
    <a href="../outside.txt">fora</a>
    <a href="#top">topo</a>
    <a href="mailto:hi@example.com">email</a>
  </body>
</html>`,
    htmlFixture,
  );
  await write(
    'style.css',
    `@import "nested/deep.css";
@font-face { font-family: Teste; src: url('font.woff2') format('woff2'); }
body { background-image: url(img/bg.jpg); }`,
    htmlFixture,
  );
  await write('nested/deep.css', '@import "deeper.css";\n.deep { background: url(deeper.png); }', htmlFixture);
  await write('nested/deeper.css', '.deeper { color: #333; }', htmlFixture);
  await write('font.woff2', Buffer.alloc(64, 1), htmlFixture);
  await write('img/pic.png', Buffer.alloc(48, 2), htmlFixture);
  await write('img/pic@2x.png', Buffer.alloc(52, 3), htmlFixture);
  await write('img/bg.jpg', Buffer.alloc(40, 4), htmlFixture);
  await write('nested/deeper.png', Buffer.alloc(36, 5), htmlFixture);

  server = await startProjectServer({ root: serverRoot });

  const zip = new AdmZip();
  zip.addFile('site/index.html', Buffer.from('<!doctype html><title>ZIP</title><p>zip</p>'));
  zip.addFile('site/css/app.css', Buffer.from('body{background:#fff}'));
  zip.addFile('site/img/logo.png', Buffer.alloc(32, 9));
  zip.writeZip(zipPath);
});

afterAll(async () => {
  await server?.close();
});

describe('loopback project server', () => {
  it('serves only paths behind the random token', async () => {
    const noToken = await request(server.origin, '/index.html');
    expect(noToken.status).toBe(404);

    const wrongToken = await request(server.origin, '/deadbeef/index.html');
    expect(wrongToken.status).toBe(404);

    const ok = await request(server.origin, `/${server.token}/index.html`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.body.toString('utf8')).toContain('Raiz');
  });

  it('resolves directory indexes and encodes entry URLs', async () => {
    const index = await request(server.origin, `/${server.token}/sub`);
    expect(index.status).toBe(200);
    expect(index.body.toString('utf8')).toContain('Sub');

    const rootDirectory = await request(server.origin, `/${server.token}/`);
    expect(rootDirectory.status).toBe(404);

    const encodedUrl = server.entryUrl('sub folder/page um.html');
    expect(encodedUrl).toContain('sub%20folder/page%20um.html');
    const withSpaces = await request(server.origin, new URL(encodedUrl).pathname);
    expect(withSpaces.status).toBe(200);
    expect(withSpaces.body.toString('utf8')).toContain('Espaços');
  });

  it('returns correct MIME types, HEAD and Range responses', async () => {
    const css = await request(server.origin, `/${server.token}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');

    const head = await request(server.origin, `/${server.token}/data.txt`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('10');
    expect(head.body.length).toBe(0);

    const range = await request(server.origin, `/${server.token}/data.txt`, {
      headers: { Range: 'bytes=2-5' },
    });
    expect(range.status).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 2-5/10');
    expect(range.headers['content-length']).toBe('4');
    expect(range.body.toString('utf8')).toBe('2345');

    const suffix = await request(server.origin, `/${server.token}/data.txt`, {
      headers: { Range: 'bytes=-3' },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.body.toString('utf8')).toBe('789');
  });

  it('rejects methods other than GET and HEAD', async () => {
    const post = await request(server.origin, `/${server.token}/index.html`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('never resolves outside the project root', async () => {
    const encodedTraversal = await request(server.origin, `/${server.token}/..%2Foutside.txt`);
    expect(encodedTraversal.status).toBe(403);
    expect(encodedTraversal.body.toString('utf8')).not.toContain('outside-the-project-root');

    const driveLetter = await request(server.origin, `/${server.token}/C:%5CWindows%5Cwin.ini`);
    expect(driveLetter.status).toBe(403);

    const nullByte = await request(server.origin, `/${server.token}/%00evil.txt`);
    expect(nullByte.status).toBe(403);

    const normalised = await request(server.origin, `/${server.token}/../outside.txt`);
    expect(normalised.status).not.toBe(200);

    const missing = await request(server.origin, `/${server.token}/nao-existe.txt`);
    expect(missing.status).toBe(404);

    expect(server.stats.denied).toBeGreaterThanOrEqual(3);
    expect(server.stats.notFound).toBeGreaterThanOrEqual(1);
    expect(server.stats.served).toBeGreaterThan(0);
    expect(server.stats.bytesServed).toBeGreaterThan(0);
  });
});

describe('collectSingleHtmlProject', () => {
  it('copies local assets recursively and reports what it could not follow', async () => {
    const destination = path.join(root, 'html-copy');
    const result = await collectSingleHtmlProject({
      htmlPath: path.join(htmlFixture, 'page.html'),
      destinationRoot: destination,
      limits: { maxFiles: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 64 * 1024 },
    });

    expect(result.entryRelative).toBe('page.html');
    expect(result.copiedFiles).toBe(8);
    expect(result.copiedBytes).toBe(64 + 48 + 52 + 40 + 36 + (await fsp.stat(path.join(htmlFixture, 'style.css'))).size + (await fsp.stat(path.join(htmlFixture, 'nested/deep.css'))).size + (await fsp.stat(path.join(htmlFixture, 'nested/deeper.css'))).size);
    expect(result.remoteHosts).toEqual(['cdn.example.com']);

    const copied = [
      'page.html',
      'style.css',
      'nested/deep.css',
      'nested/deeper.css',
      'nested/deeper.png',
      'img/pic.png',
      'img/pic@2x.png',
      'img/bg.jpg',
      'font.woff2',
    ];
    for (const relative of copied) {
      const stat = await fsp.stat(path.join(destination, relative));
      expect(stat.size).toBeGreaterThan(0);
    }

    expect(result.missing.sort()).toEqual(['img/poster.jpg', 'missing.png']);
    expect(result.skipped).toContain('../outside.txt');
    expect(result.diagnostics.some((item) => item.code === 'MISSING_RESOURCE')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'REMOTE_RESOURCES')).toBe(true);
    expect(result.diagnostics.some((item) => item.code === 'HTML_ONLY_PROJECT')).toBe(true);

    // The user's original directory is untouched: only the copy was written.
    await expect(fsp.access(path.join(htmlFixture, 'nested/deeper.png'))).resolves.toBeUndefined();
  });

  it('skips assets above the configured limits but still copies the entry file', async () => {
    const destination = path.join(root, 'html-copy-limited');
    const result = await collectSingleHtmlProject({
      htmlPath: path.join(htmlFixture, 'page.html'),
      destinationRoot: destination,
      limits: { maxFiles: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 10 },
    });

    expect(result.copiedFiles).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((item) => item.code === 'ZIP_ENTRY_SKIPPED')).toBe(true);
    expect((await fsp.stat(path.join(destination, 'page.html'))).size).toBeGreaterThan(0);
  });

  it('refuses assets that escape the HTML folder through a symlink or junction', async () => {
    const fixture = path.join(root, 'html-linked');
    const outside = path.join(root, 'html-linked-outside');
    const destination = path.join(root, 'html-linked-copy');
    await fsp.mkdir(fixture, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'must not be copied');
    await fsp.writeFile(
      path.join(fixture, 'page.html'),
      '<!doctype html><img src="linked/secret.txt" alt="fora" />',
    );
    await fsp.symlink(outside, path.join(fixture, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = await collectSingleHtmlProject({
      htmlPath: path.join(fixture, 'page.html'),
      destinationRoot: destination,
      limits: { maxFiles: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 64 * 1024 },
    });

    expect(result.copiedFiles).toBe(0);
    expect(result.skipped).toContain('linked/secret.txt');
    expect(
      result.diagnostics.some(
        (item) => item.code === 'HTML_ONLY_PROJECT' && item.detail?.includes('resolve fora da pasta'),
      ),
    ).toBe(true);
    await expect(fsp.access(path.join(destination, 'linked', 'secret.txt'))).rejects.toThrow();
    await expect(fsp.access(path.join(destination, 'page.html'))).resolves.toBeUndefined();
  });

  it('deduplicates and normalises remote hosts in text', () => {
    const hosts = remoteHostsFromText(
      'https://fonts.googleapis.com/css?family=X and https://FONTS.googleapis.com/other and http://cdn.example.com/a',
    );
    expect(hosts).toEqual(['fonts.googleapis.com', 'cdn.example.com']);
  });
});

describe('ProjectService', () => {
  it('imports a single HTML project with its assets and reports its full size', async () => {
    const service = new ProjectService({
      paths: servicePaths(),
      logger: createLogger(),
      limits: () => ({ maxProjectBytes: 5 * 1024 * 1024, maxZipEntries: 200 }),
    });

    const project = await service.importPath(path.join(htmlFixture, 'page.html'));

    expect(project.kind).toBe('html');
    expect(project.htmlFileCount).toBe(1);
    expect(project.assetCount).toBe(8);
    expect(project.entryPath).toBe(path.join(project.rootPath, 'page.html'));
    expect(project.remoteResourceHosts).toEqual(['cdn.example.com']);
    expect(project.warnings.some((warning) => warning.code === 'MISSING_RESOURCE')).toBe(true);

    // Regression: the project size includes the entry HTML, not just assets.
    expect(project.sizeBytes).toBe(await directoryBytes(project.rootPath));
    expect(project.sizeBytes).toBeGreaterThan((await fsp.stat(path.join(htmlFixture, 'page.html'))).size);

    const url = service.entryUrl();
    expect(url).not.toBeNull();
    const parsedUrl = new URL(url as string);
    const response = await request(parsedUrl.origin, parsedUrl.pathname);
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toContain('Projeto de teste');

    await service.close();
    expect(service.current()).toBeNull();
    await expect(fsp.access(project.rootPath)).rejects.toThrow();
  });

  it('imports a ZIP project and picks the HTML entry inside a folder', async () => {
    const service = new ProjectService({
      paths: servicePaths(),
      logger: createLogger(),
      limits: () => ({ maxProjectBytes: 5 * 1024 * 1024, maxZipEntries: 200 }),
    });

    const project = await service.importPath(zipPath);

    expect(project.kind).toBe('zip');
    expect(project.htmlFileCount).toBe(1);
    expect(project.assetCount).toBe(2);
    expect(project.entryPath).toBe(path.join(project.rootPath, 'site', 'index.html'));
    expect(project.sizeBytes).toBe(await directoryBytes(project.rootPath));
    expect(project.sizeBytes).toBeGreaterThan(0);

    const entry = await fsp.readFile(project.entryPath, 'utf8');
    expect(entry).toContain('ZIP');
    expect((await fsp.stat(path.join(project.rootPath, 'site/img/logo.png'))).size).toBe(32);

    await service.close();
  });

  it('rejects unsupported files and missing sources with stable codes', async () => {
    const service = new ProjectService({
      paths: servicePaths(),
      logger: createLogger(),
      limits: () => ({ maxProjectBytes: 5 * 1024 * 1024, maxZipEntries: 200 }),
    });
    const textFile = path.join(root, 'notes.txt');
    await fsp.writeFile(textFile, 'not a project');

    await expect(service.importPath(textFile)).rejects.toMatchObject({ code: 'UNSUPPORTED_PROJECT_FORMAT' });
    await expect(service.importPath(path.join(root, 'missing.html'))).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
