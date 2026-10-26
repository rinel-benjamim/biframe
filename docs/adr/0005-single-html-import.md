# ADR 0005 — Copy single HTML files with a bounded static asset scan

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0002](0002-untrusted-content-boundary.md)

## Context

Users often have a single `.html` file next to an `assets/` folder, a stylesheet, a font or a poster image. Forcing them to zip the folder before using Biframe would be hostile. Loading the HTML from its original directory, on the other hand, would expose every sibling file the user has and violate the rule that imports are copies.

The importer needs a middle ground that preserves the page's relative URLs without turning Biframe into a general-purpose bundler.

## Decision

When a single HTML file is imported:

1. Copy the HTML entry into a new temporary project directory.
2. Statically scan it for local references:
   - `src`, `href`, `poster`, `data-src`, `data-lazy-src`, `data-background` attributes;
   - every candidate in `srcset`;
   - `url(...)` and `@import` inside inline `<style>` blocks;
   - linked CSS files, recursively, up to four levels.
3. Resolve each reference relative to the file that contains it. Reject references that leave the HTML file's folder, absolute paths, URLs with a scheme, protocol-relative URLs and fragments.
4. Strip query strings and fragments for the filesystem lookup, but keep the original relative layout so the browser resolves the copied file normally.
5. Check the real path of every candidate. A symlink or Windows junction that resolves outside the source folder is skipped, even if its lexical path looks contained.
6. Apply limits: 2,000 files, 500 MB total and 64 MB per file (further bounded by the app's project limits). Files over a limit are skipped with a diagnostic.
7. Copy the entry file last, so a scan failure cannot leave a half-imported project without its HTML.
8. Report missing references, skipped references, remote hosts and the general "single HTML" limitation as diagnostics. The UI offers the ZIP route when a page builds URLs at runtime.

The source file is only read. The browser loads the copy through the same tokenised loopback server as a ZIP project.

## Options considered

- **Load the HTML from its original folder.** Rejected. A `file://` page or a server rooted at the user's folder could read unrelated files, and the original would be live rather than a stable copy.
- **Copy only the HTML file.** Rejected. Most single-file projects depend on sibling assets; the page would render broken with no clear explanation.
- **Require a ZIP always.** Safe but poor usability. The ZIP path remains available and is the right answer for complex projects.
- **Run a real HTML/CSS parser and a bundler.** More correct in theory, but a large dependency and still unable to follow runtime-constructed URLs. It also risks rewriting the page, which the product forbids.
- **Serve the parent folder with a deny-list.** Rejected. Deny-lists are fragile; the copy is a smaller, auditable surface.

## Consequences

Positive:

- The common "one HTML plus assets" case works without zipping.
- The original directory is never served and never modified.
- The scan is deterministic and testable; real-path containment closes the obvious symlink escape.
- Missing assets become visible diagnostics instead of a silently broken export.

Costs and limitations:

- The scan is **best effort**, not a bundler. It cannot follow URLs built by JavaScript (`fetch('/api/' + name)`, dynamic imports with variables, canvas-loaded images), data embedded in scripts, or references created after load. Those need a ZIP with all files.
- Regex-based scanning can over-approximate: a string that looks like `src="..."` in a template may be copied unnecessarily. It will not under-approximate a normal static reference.
- CSS recursion stops at depth four. Deeper `@import` chains are not followed.
- `srcset` parsing is deliberately simple; unusual descriptors may be skipped.
- Only files inside the HTML file's folder are eligible. `../shared/logo.png` is skipped even if it exists.
- Very large projects take time and disk space to copy, bounded by the configured limits.
- Remote hosts are reported but not downloaded during import; the opt-in network policy decides at render time.
- A symlink to an asset **inside** the folder is copied from its real target; a symlink outside is skipped. Directory junctions are treated the same way.

## Verification

- `tests/integration/project.test.ts` covers nested CSS, `srcset`, inline styles, missing files, limits, remote hosts, project size and cleanup.
- A dedicated integration test creates a Windows junction (or a directory symlink on other platforms) and asserts that an asset outside the HTML folder is not copied.
- `tests/e2e/app.test.ts` imports the bundled single-file example and exports it.
- [docs/security.md](../security.md) documents the containment and its residual limits.
