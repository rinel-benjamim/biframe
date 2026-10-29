import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createTranslator } from '@shared/i18n';
import {
  archiveReasonMessage,
  classifyArchiveEntries,
  isSymlinkEntry,
  normalizeArchivePath,
  pickHtmlEntry,
  resolveWithinRoot,
  type ArchiveEntryInfo,
} from '@engine/project/archive-guard';

function entry(partial: Partial<ArchiveEntryInfo> & { path: string }): ArchiveEntryInfo {
  return { sizeBytes: 10, isDirectory: false, ...partial };
}

describe('normalizeArchivePath', () => {
  it('normalises separators and redundant segments', () => {
    expect(normalizeArchivePath('assets\\img\\logo.png')).toBe('assets/img/logo.png');
    expect(normalizeArchivePath('./a//b/./c.css')).toBe('a/b/c.css');
  });

  it('rejects absolute paths, drive letters and parent traversal', () => {
    expect(normalizeArchivePath('/etc/passwd')).toBeNull();
    expect(normalizeArchivePath('C:\\Windows\\win.ini')).toBeNull();
    expect(normalizeArchivePath('../secret.txt')).toBeNull();
    expect(normalizeArchivePath('a/../../secret.txt')).toBeNull();
    expect(normalizeArchivePath('..\\secret.txt')).toBeNull();
  });

  it('rejects alternate data streams and Windows-hostile names', () => {
    expect(normalizeArchivePath('file.txt:stream')).toBeNull();
    expect(normalizeArchivePath('file.txt.')).toBeNull();
    expect(normalizeArchivePath('file.txt ')).toBeNull();
    expect(normalizeArchivePath('a<b.txt')).toBeNull();
    expect(normalizeArchivePath('a\u0000b.txt')).toBeNull();
    expect(normalizeArchivePath('a\u007fb.txt')).toBeNull();
  });

  it('rejects empty, overly long and home-relative paths', () => {
    expect(normalizeArchivePath('')).toBeNull();
    expect(normalizeArchivePath('/')).toBeNull();
    expect(normalizeArchivePath('~/.ssh/id_rsa')).toBeNull();
    expect(normalizeArchivePath(`${'x'.repeat(121)}.txt`)).toBeNull();
    expect(normalizeArchivePath(`${'a/'.repeat(130)}x.txt`)).toBeNull();
  });
});

describe('isSymlinkEntry', () => {
  it('detects posix symlinks from the mode bits', () => {
    expect(isSymlinkEntry(entry({ path: 'link', unixMode: 0o120777 }))).toBe(true);
    expect(isSymlinkEntry(entry({ path: 'file', unixMode: 0o100644 }))).toBe(false);
  });

  it('detects windows reparse points from the DOS attributes', () => {
    expect(isSymlinkEntry(entry({ path: 'link', dosAttributes: 0x0400 }))).toBe(true);
    expect(isSymlinkEntry(entry({ path: 'file', dosAttributes: 0x0020 }))).toBe(false);
  });
});

describe('classifyArchiveEntries', () => {
  const limits = { maxEntries: 10, maxTotalBytes: 100, maxEntryBytes: 60 };

  it('accepts safe entries and normalises their paths', () => {
    const plan = classifyArchiveEntries(
      [entry({ path: 'index.html', sizeBytes: 30 }), entry({ path: 'assets\\app.js', sizeBytes: 20 })],
      limits,
    );
    expect(plan.accepted.map((item) => item.path)).toEqual(['index.html', 'assets/app.js']);
    expect(plan.totalBytes).toBe(50);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.truncated).toBe(false);
  });

  it('rejects unsafe entries but keeps the rest of the archive', () => {
    const plan = classifyArchiveEntries(
      [entry({ path: 'index.html' }), entry({ path: '../evil.sh' }), entry({ path: 'link', unixMode: 0o120777 })],
      limits,
    );
    expect(plan.accepted.map((item) => item.path)).toEqual(['index.html']);
    expect(plan.rejected.map((item) => item.reason)).toEqual(['invalid-path', 'symlink']);
  });

  it('rejects oversized entries and total-budget overflows', () => {
    const plan = classifyArchiveEntries(
      [
        entry({ path: 'big.bin', sizeBytes: 61 }),
        entry({ path: 'a.bin', sizeBytes: 60 }),
        entry({ path: 'b.bin', sizeBytes: 50 }),
      ],
      limits,
    );
    expect(plan.accepted.map((item) => item.path)).toEqual(['a.bin']);
    expect(plan.rejected.map((item) => item.reason)).toEqual([
      'entry-too-large',
      'total-limit',
    ]);
    expect(plan.truncated).toBe(true);
  });

  it('marks the plan truncated when there are more entries than the limit', () => {
    const plan = classifyArchiveEntries(
      [entry({ path: 'a.html' }), entry({ path: 'b.html' }), entry({ path: 'c.html' })],
      { ...limits, maxEntries: 2 },
    );
    expect(plan.accepted).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });

  it('treats non-finite sizes as zero instead of trusting them', () => {
    const plan = classifyArchiveEntries([entry({ path: 'a.bin', sizeBytes: Number.NaN })], limits);
    expect(plan.accepted[0]?.sizeBytes).toBe(0);
    expect(plan.totalBytes).toBe(0);
  });
});

describe('resolveWithinRoot', () => {
  const root = path.resolve('C:\\projects\\demo');

  it('resolves safe relative paths inside the root', () => {
    expect(resolveWithinRoot(root, 'assets/logo.png')).toBe(path.join(root, 'assets', 'logo.png'));
  });

  it('refuses traversal and absolute paths', () => {
    expect(resolveWithinRoot(root, '../secret.txt')).toBeNull();
    expect(resolveWithinRoot(root, 'C:\\Windows\\win.ini')).toBeNull();
  });
});

describe('pickHtmlEntry', () => {
  it('prefers index.html at the root', () => {
    expect(pickHtmlEntry(['docs/index.html', 'index.html', 'page.html'])).toBe('index.html');
  });

  it('prefers the shallowest, then alphabetical HTML file', () => {
    expect(pickHtmlEntry(['pages/about.html', 'main.html', 'a.html'])).toBe('a.html');
    expect(pickHtmlEntry(['b.html', 'a.html'])).toBe('a.html');
  });

  it('returns null when there is no HTML', () => {
    expect(pickHtmlEntry(['style.css', 'image.png'])).toBeNull();
  });
});

describe('archiveReasonMessage', () => {
  it('renders each rejection reason in the interface language', () => {
    expect(archiveReasonMessage('invalid-path', createTranslator('pt'))).toBe('caminho inválido');
    expect(archiveReasonMessage('invalid-path', createTranslator('en'))).toBe('invalid path');
    expect(archiveReasonMessage('symlink', createTranslator('en'))).toBe('symbolic link');
    expect(archiveReasonMessage('entry-too-large', createTranslator('en'))).toBe('file too large');
    expect(archiveReasonMessage('total-limit', createTranslator('en'))).toBe('total limit exceeded');
  });
});
