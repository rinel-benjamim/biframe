# ADR 0001 — Keep Electron's process isolation and a typed preload

- **Status:** Accepted
- **Date:** 2026-10-23
- **Decision owners:** Biframe maintainers

## Context

Biframe is an Electron desktop application that renders untrusted HTML. Electron makes it easy to give a renderer direct access to Node.js, and equally easy to accidentally expose that capability to imported content. The interface also needs a responsive React UI, native window controls, filesystem access and child processes.

A single process model would be simpler in the short term, but one cross-site scripting bug in an imported page could become arbitrary code execution with the user's permissions. The project needs a boundary that survives mistakes in page code and in the UI.

## Decision

Use Electron's standard three-part split:

1. **Main process** — owns windows, services, filesystem access, child processes, protocols, persistence and IPC handlers. It is the only process trusted with Node.js.
2. **Renderer** — React 19 + TypeScript, loaded from the built application, with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no remote module and a strict Content Security Policy. It talks to the application through a preload-exposed API only.
3. **Preload** — a context-isolated bridge that exposes a small, typed `window.biframe` object. It forwards commands with `ipcRenderer.invoke` and wraps the answer in a discriminated `ApiResult<T>`; it does not expose `ipcRenderer`, `require` or arbitrary channels.
4. **Imported content** — a separate `WebContentsView` for preview and an offscreen `BrowserWindow` for capture. Both run with the same locked-down preferences, **no preload**, no Node.js and no webviews.
5. **Engine** — `src/engine` contains no Electron imports. It is orchestration over plain data, a capture-host interface, FFmpeg and disk. This keeps the pipeline testable without a second Electron instance and prevents the render path from acquiring ambient main-process privileges by accident.

All IPC input is validated in the main process. Paths for shell operations are resolved against application-owned records; render settings are validated by Zod; preview bounds are finite and clamped. Expected failures are serialised as `{ ok: false, error }` rather than leaving the renderer to interpret a rejected bridge promise.

## Options considered

- **Node integration in the renderer.** Simplest plumbing, unacceptable for a window that may display imported content and encourages accidental exposure.
- **Remote module / direct main access from the UI.** Removed from modern Electron and functionally the same mistake.
- **A local HTTP API instead of preload IPC.** Larger attack surface and an unnecessary local server; IPC already provides process isolation and origin control.
- **Put the engine in the main process as an Electron-aware module.** Would make integration tests launch Electron and blur the trust boundary. The typed host interface is a better seam.
- **Disable the sandbox to make preview composition easier.** Rejected; the UI gains convenience at the cost of the main security property.

## Consequences

Positive:

- Imported JavaScript cannot `require`, read files or call Electron APIs directly.
- The renderer cannot open arbitrary paths; a compromised UI has a narrow command surface.
- The engine can be exercised with a fake capture host and real FFmpeg in Vitest.
- The renderer can be sandboxed without losing native window controls (hidden title bar + overlay).

Costs:

- Every new capability needs a channel, preload method, validation and serialisation.
- The UI cannot use Node libraries; formatting and presets that both processes need live in `src/shared`.
- Debugging crosses process boundaries and needs scoped logs (`logger.child`).
- The preview is a native `WebContentsView`, so it is not part of the renderer DOM and cannot be captured by an ordinary page screenshot.

## Verification

- `src/main/window.ts` sets the sandbox, context isolation and Node preferences.
- `src/main/services/preview-service.ts` and `src/main/capture/electron-host.ts` set them again for imported content.
- `tests/e2e/app.test.ts` drives the real app; an imported example renders, exports and is validated.
- `npm run typecheck` enforces separate Node/Web TypeScript projects; `src/engine` has no Electron types in its import graph.
