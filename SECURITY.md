# Security policy

Biframe opens HTML and ZIP files from other people and runs that content in Chromium. Treating the imported page as untrusted is a design requirement, not a feature. This document explains how to report a problem and what the project considers in scope.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes, on a best-effort basis |
| Older / unversioned builds | No |

Biframe is pre-1.0. There is no security SLA and no guaranteed response time. Reports are still welcome and will be taken seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use the repository's **private vulnerability reporting** form (GitHub Security Advisories) when the project is hosted there. If that is unavailable, contact the maintainers through the private channel by which you obtained the source. Include:

- the affected version and commit, if known;
- the platform and Electron/Chromium version;
- a minimal HTML or ZIP reproducer, when safe to share;
- the impact you believe is possible;
- steps to reproduce, and whether the issue requires **Permitir recursos externos** to be enabled.

Do not attach the user's private documents to a report. A reduced reproducer is more useful than a full project.

Please avoid testing against systems you do not own, and do not use a report to exfiltrate another person's data.

## Scope

In scope:

- escaping the sandbox or reaching Node.js, the filesystem or the main process from imported HTML;
- reading files outside the imported project through the loopback server, archive extraction, path handling, the media protocol or shell operations;
- local SSRF or private-network access from imported content, including DNS rebinding attempts;
- ZIP path traversal, absolute paths, drive letters, alternate data streams, symlink/junction tricks or archive resource-limit bypasses;
- bypassing navigation, window-open, download, permission or webview restrictions;
- writing outside the chosen output location, or replacing a file without confirmation;
- leaking a user path, project content or bearer token to remote content or logs;
- remote code execution through the update, packaging or binary-resolution path;
- denial of service that crashes the main process or permanently prevents recovery, rather than merely consuming CPU in the renderer.

Out of scope for 0.1:

- vulnerabilities in Chromium, Electron or FFmpeg itself that are not reachable through Biframe's configuration. Report those upstream; we will update dependencies when practical.
- a page consuming CPU, GPU or memory while it is being rendered. This is inherent in running untrusted animation in real time, although crashes and hangs should still be reported.
- remote fonts or images revealing the user's IP address to their provider **after the user explicitly enables remote resources**.
- a compromised local machine, malicious OS-level software, physical access, or an attacker who can already read `%APPDATA%\Biframe`.
- social engineering of the user into importing a hostile file and exporting it.
- the content of the exported MP4 (for example, a page that displays offensive material).
- Windows SmartScreen warnings caused by the absence of code signing.

## Security model in brief

- **Imported content** runs in sandboxed Electron renderers with `nodeIntegration: false`, `contextIsolation: true`, no preload, no webviews, dialogs disabled and DevTools disabled in capture.
- **Delivery** uses a loopback HTTP server bound to `127.0.0.1` with a random port and a 128-bit bearer token in the URL path. Imported pages are never loaded from `file://`. Only `GET`/`HEAD` are accepted; paths are contained lexically and by real path, so a symlink cannot escape the project.
- **Imports are copies.** The original HTML/ZIP is read-only. ZIP entries are validated before extraction, including traversal, absolute paths, drive letters, alternate data streams, control characters, trailing dots/spaces and symlinks. Single-HTML asset copying is confined to the selected file's folder and also checks real paths.
- **Network policy** allows the project origin, `data:` and `blob:`. Everything else is blocked by default. If the user enables remote resources, only `GET`/`HEAD` over HTTP(S) is allowed, hostnames are pre-resolved and private, loopback, link-local, metadata and special IPv4/IPv6 forms are rejected. Navigation remains restricted to the project origin.
- **The interface is isolated.** The renderer only sees a typed preload API. Paths are opaque or validated against application-owned records. The main process validates IPC input and serialises expected errors.
- **Output is validated.** A successful render is not a process exit code: the produced MP4 must pass `ffprobe` checks. A failed or cancelled render removes the partial file.

Details, including residual risks, are in [docs/security.md](docs/security.md) and [ADR 0002](docs/adr/0002-untrusted-content-boundary.md).

## Third-party components

Biframe bundles FFmpeg 6.1.1 via `ffmpeg-static` (GPL-3.0-or-later, gyan.dev build) and FFprobe via `ffprobe-static` (MIT). The application itself is MIT. Redistributors are responsible for complying with the GPL when they redistribute the bundled FFmpeg binary; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Dependency updates are made when practical and re-tested. `npm audit` is run as part of release preparation; a clean audit is evidence, not a guarantee.

## Disclosure

The project will credit reporters who want credit after a fix is available. If a report affects a released build, the maintainers will describe the impact and the fixed version in the release notes. No bounty programme exists.
