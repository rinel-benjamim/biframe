# ADR 0002 — Serve imported projects from a tokenised loopback origin

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes:** none
- **Related:** [ADR 0001](0001-electron-process-isolation.md), [ADR 0005](0005-single-html-import.md)

## Context

An imported project is a folder of HTML, CSS, JavaScript, fonts, images and sometimes video. It expects normal web semantics: relative URLs, ES modules, `fetch`, CSS `@import`, fonts, `Range` requests and a real origin. The page can contain hostile JavaScript and malformed assets.

The delivery mechanism must:

- preserve relative paths and normal browser APIs;
- not expose the user's filesystem;
- give the page an origin that is distinct from the Biframe UI;
- allow the application to revoke access when the project changes;
- work offline and not require a public server;
- be testable without special network privileges.

## Decision

Copy the imported project into an application-owned temporary directory and serve it over **HTTP on `127.0.0.1`**, using an OS-assigned port and a **128-bit random token in the URL path**.

Key properties:

- The server binds only to loopback, never `0.0.0.0`.
- Requests must be `GET` or `HEAD`; other methods receive `405`.
- Requests without the exact token prefix receive `404`.
- The URL is decoded, normalised and resolved inside the project root; the resolved real path must also be inside the real root. Directory listing is not implemented.
- A directory request serves `index.html` if present.
- Responses set a conservative MIME type, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Accept-Ranges: bytes`; byte ranges are implemented for media.
- The server's lifetime is the project's lifetime. Closing/replacing a project closes connections and deletes the copied directory.
- The copied project lives under `%APPDATA%/Biframe/temp/projects/<uuid>`. The original source is never the document root.

Imported content runs in a shared, persistent Electron session guarded by `ContentGateway`. That session:

- denies permission requests and device permissions;
- cancels downloads;
- denies `window.open`, webviews and navigation outside the project origin;
- applies a request policy: project origin, `data:` and `blob:` allowed; remote HTTP(S) only if the user opted in; `file:` and every other scheme blocked; remote requests restricted to `GET`/`HEAD` and resolved to public addresses;
- records blocked resources as diagnostics rather than silently ignoring them.

ZIP imports are validated before extraction: traversal, absolute paths, drive letters, alternate data streams, control characters, trailing dots/spaces, over-long names and symlinks are rejected. Each accepted entry is contained again at write time. Single-HTML imports use a narrower static scan and real-path containment; see ADR 0005.

## Options considered

- **`file://`.** Rejected. A file origin has broad read semantics, behaves differently for modules/fetch, and makes path traversal mistakes much more dangerous. It also does not provide a clean project origin for network policy.
- **`data:` or a `blob:` document.** Rejected for the entry page. Relative URLs and normal navigation become awkward, modules and fonts are fragile, and a huge document is loaded into memory.
- **A custom privileged scheme (`biframe-project://`).** Technically viable and attractive for isolation, but it requires reimplementing URL resolution, MIME handling, ranges, module semantics and Chromium quirks. A loopback HTTP server gets those from the platform. It remains an option for a future version if the loopback origin becomes a liability.
- **Serving the user's original folder directly.** Rejected. It would expose every sibling file the user has, and a malicious page could probe them.
- **Reading files through IPC on demand.** Rejected. It would put a path parser in the trust boundary for every image/font request and break normal browser caching and ranges.
- **Bind to all interfaces.** Rejected outright; loopback-only is non-negotiable.

## Consequences

Positive:

- Relative paths, modules, fonts, media ranges and CSS loading behave normally.
- The page gets an origin distinct from the UI, and the project can be swapped by destroying the server and its directory.
- The browser's own MIME, decoding and range handling are reused.
- The boundary is small and testable with real HTTP requests.

Costs and residual risks:

- A loopback HTTP server is visible to other local processes. The 128-bit token and random port make opportunistic access impractical, but a local administrator or malware can inspect the page URL or process memory. Biframe does not claim isolation from a compromised host.
- The token appears in the page's URL and can be read by the page itself (for example, by displaying `location.href`). It grants read access only to the copied project.
- The page must be copied; very large projects consume temporary disk space.
- Remote HTTP(S) resources are an explicit opt-in. Even then, DNS rebinding is a narrow residual gap because the policy pre-resolves the hostname and Chromium resolves again at connect time. See [docs/security.md](../security.md).
- Enabling remote resources lets public scripts run in the page and lets public hosts observe the request.
- No service-worker isolation guarantee is promised; imported pages should not depend on persistent state.

## Verification

- `tests/unit/network-policy.test.ts` covers private IPv4/IPv6, mapped/tunnelled forms, schemes, methods, project origin and navigation.
- `tests/integration/project.test.ts` drives the real server: token enforcement, traversal, MIME, `HEAD`, ranges, method rejection, imports and symlink escape.
- `tests/e2e/app.test.ts` imports the bundled example through the real server and exports a validated file.
- [docs/security.md](../security.md) documents the threat model and residual risks.
