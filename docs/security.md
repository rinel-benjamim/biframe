# Security model

This document describes the boundary around imported pages, the controls that enforce it, and the risks that remain. It is a companion to [SECURITY.md](../SECURITY.md), not a guarantee.

## The asset being protected

An imported HTML page or ZIP is **untrusted input**. It may contain arbitrary JavaScript, network requests, misleading UI, malformed markup, huge files, path tricks or code designed to probe the machine. The user's documents, browser profile, credentials and local network must not become reachable because they opened a project in Biframe.

The application also has to keep a second promise: **the original file is never modified**. A render reloads the page and observes it; it does not patch the HTML to add instrumentation or save over the source.

## Trust boundary

```text
Untrusted                              Trusted
─────────────────────────────────────  ─────────────────────────────────
Imported HTML / JS / assets            Electron main process
Preview renderer (sandboxed)           Preload bridge (context-isolated)
Capture renderer (sandboxed)           Engine orchestration
Remote HTTP(S) responses               node:fs / child_process
ZIP entries                            Application-owned records
```

The renderer that draws the Biframe interface is trusted application code, but it is still sandboxed. It cannot read files or launch processes directly. Only the main process does that, and it accepts commands through a typed, validated IPC surface.

## Threats and controls

| Threat | Control | Where |
| --- | --- | --- |
| Page reaches Node.js or the main process | Sandboxed renderer, no Node integration, context isolation, no preload in imported content, no webviews | `src/main/window.ts`, `electron-host.ts`, `preview-service.ts` |
| Page reads arbitrary local files | Never `file://`; loopback project origin; network policy blocks other schemes; no path IPC to content windows | `project/server.ts`, `network/policy.ts` |
| ZIP path traversal or symlink escape | Entry validation before writing; lexical containment plus real-path checks; symlinks rejected | `archive-guard.ts`, `project-service.ts` |
| Single-HTML asset escape | References confined to the HTML folder; real path of each asset checked; symlink/junction escapes rejected; entry copied last | `html-assets.ts` |
| Page navigates away or opens a window | Navigation restricted to the project origin; `window.open` denied; webviews denied; downloads blocked; permissions denied | `content-session.ts`, `electron-host.ts`, `preview-service.ts` |
| SSRF to router, metadata service or other local port | Private IPv4/IPv6 and special names rejected; remote resources disabled by default; only `GET`/`HEAD` to pre-resolved public hosts | `network/policy.ts`, `content-session.ts` |
| Page reaches a different loopback service | Only the exact project origin is allowed. The project server token is unguessable and bound to a random port | `network/policy.ts`, `project/server.ts` |
| Token leaks through the UI or logs | The token lives in the project server URL, which is not exposed as a renderer field; URLs in logs are truncated | `project-service.ts`, `content-session.ts` |
| Partial or corrupt output is presented as success | FFprobe validation, nine checks, removal of failed output | `encoding/probe.ts`, `render/pipeline.ts` |
| A second render distorts or overwrites the first | One active job; `RENDER_IN_PROGRESS`; overwrite requires explicit confirmation and preflight | `render-service.ts`, `ipc.ts` |
| Renderer sends a path to a shell | Shell handlers resolve IDs or known paths; arbitrary paths are rejected | `ipc.ts` |
| Golden MP4 is overwritten silently | `OUTPUT_EXISTS` preflight before a job exists; explicit replacement confirmation | `render-service.ts`, UI |

## Process and window configuration

Main window and preview view:

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInSubFrames: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `spellcheck: false`
- no preload in the preview view
- `setWindowOpenHandler` returns `deny`
- navigation is classified against the project origin
- DevTools disabled in content windows; Electron security warnings are not part of the user-facing diagnostics

The capture window is additionally:

- off-desktop: on Windows a native window parked outside every display, non-focusable and mouse-transparent (it falls back to full transparency if the OS rejects the position); elsewhere offscreen, framed off; skipped from the taskbar either way;
- audio muted;
- dialogs disabled;
- no Node integration in sub-frames;
- CDP attached only to its own `webContents`;
- device metrics forced to the requested output size, zoom reset to 1.

The main window keeps a preload and thus the application API; it loads only the built renderer, not imported content.

## Project delivery

`startProjectServer` binds to `127.0.0.1` on port `0` (the OS chooses a free port) and generates 16 random bytes as a path prefix. Requests:

- must be `GET` or `HEAD`;
- must carry the exact token prefix;
- are resolved inside the project root and then checked again with `realpath`;
- cannot list directories;
- are served with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Accept-Ranges: bytes`;
- support byte ranges for video/audio playback;
- close with all connections when the project changes or the app exits.

The loopback server is not an authentication boundary against a local administrator or malware that can inspect process memory. It is a boundary against the imported page and opportunistic local requests. The token is not shown to the page; it is in the page's own URL, so a page that displays `location.href` can reveal it. That is acceptable within a single-user desktop session: the token only grants read access to the copied project, not to other files.

## Archive extraction

`normalizeArchivePath` rejects, before extraction:

- empty, absolute or home-relative paths;
- Windows drive letters;
- `..` segments;
- NTFS alternate data streams (`:` in a segment);
- control characters;
- Windows-reserved characters (`< > " | ? *`);
- trailing dots or spaces;
- over-long segments or paths.

Entries with symlink mode bits or Windows reparse attributes are rejected. Each accepted entry is resolved again against the destination root immediately before writing. Limits bound the number of entries (5,000), total bytes (500 MB by default) and per-entry bytes. A malformed archive is rejected as a whole; skippable entries produce diagnostics rather than silently disappearing.

Single-HTML imports are different: the user selected one page next to a folder of assets. The scanner follows static `src`/`href`/`poster`/`data-*` attributes, `srcset`, inline CSS `url()` and `@import`, and linked CSS recursively up to four levels. Every resolved path must stay inside the HTML file's folder **after resolving symlinks and junctions**. Limits apply (2,000 files, 500 MB, 64 MB per file). Scripts that construct URLs at runtime cannot be followed; the UI reports the missing requests and recommends a ZIP.

## Network policy

The policy is deliberately simple:

- `about:blank`, `data:` and `blob:` are allowed (they cannot reach the network by themselves);
- the exact project origin is allowed;
- every other URL must be `http:` or `https:`, and remote resources must be enabled by the user;
- only `GET` and `HEAD` are allowed to remote hosts;
- the hostname is resolved with `dns.lookup({ all: true })` and every returned address must be public;
- private IPv4 ranges, loopback, link-local, CGNAT, multicast, reserved ranges, unique-local IPv6, link-local IPv6, multicast, documentation, NAT64, 6to4, Teredo and IPv4-mapped private forms are rejected;
- `.localhost`, `.local`, `.internal`, `.home.arpa` and common metadata names are rejected;
- navigation is stricter still: only the project origin (or `about:blank`).

### Residual risks in the network policy

- **DNS rebinding is not fully eliminated.** Biframe pre-resolves the hostname, then Chromium resolves it again to make the request. A hostile DNS server can return a public address for the check and a private one for the connection. The window is narrow, the feature is opt-in, and the hostname/address pair is cached only for the check, not pinned at connection time. A future version could route all remote traffic through a controlled proxy with address pinning; 0.1 does not.
- **A public host can still track the user.** When remote resources are enabled, the page can request arbitrary public fonts, images and scripts, revealing the user's IP address and project context to those hosts. This is why the setting is off by default and why blocking is explained in diagnostics.
- **Remote scripts can be hostile.** Enabling remote resources allows arbitrary public JavaScript. It runs inside the same sandbox, but it can consume CPU, make requests and draw. The sandbox is the containment; there is no reputation check.
- **A Chromium zero-day is out of scope.** The renderer is sandboxed by Chromium, but a full sandbox escape would defeat this model. Keep Electron updated and treat unusual crashes as worth investigating.
- **Resource exhaustion is possible.** A page can allocate memory, open many blob URLs, flood the console or loop. Limits and timeouts reduce the blast radius, but a determined page can make a render slow or fail. It cannot silently turn that failure into a successful export.

## Output and filesystem handling

- The output directory is chosen by the user; the filename is sanitised for Windows and the `.mp4` extension is enforced.
- `OUTPUT_EXISTS` is checked before a job is created. Replacement requires an explicit confirmation; the old file is not modified during preflight.
- FFmpeg runs as a child process with an argument array (no shell), a fixed binary path resolved by the application, and a timeout/abort signal.
- A failed or cancelled render removes the partial MP4. Temporary frames are removed unless the user opted to keep them.
- `biframe-media://` serves only opaque job/poster IDs recorded by the application. It does not accept arbitrary paths.
- Logs contain timestamps, codes and truncated details; they avoid file contents and tokens.

## What is not protected

Biframe is a desktop application, not a virtual machine or a security boundary against the local user:

- a user can choose to export a file anywhere they can write;
- a local administrator or malware can read the application's temporary directory, logs and settings;
- the page's rendered output may contain anything the user imported;
- the exported MP4 is not scanned for malware;
- no code signing or automatic update signature verification exists in 0.1;
- macOS and Linux hardening is unverified because those packages have not been tested.

## Reporting and verification

Security-relevant behavior is covered by unit tests for path classification, IPv6 parsing and archive rules, integration tests for the real loopback server and ZIP/single-HTML imports, and end-to-end tests for import, export, overwrite and cancellation. That coverage is evidence, not proof. Report a suspected bypass privately as described in [SECURITY.md](../SECURITY.md).
