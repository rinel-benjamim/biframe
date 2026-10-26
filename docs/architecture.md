# Architecture

Biframe is an Electron desktop application with three deliberately separate worlds:

1. **The interface** — React 19, TypeScript, no Node.js and no direct access to imported content.
2. **The shell** — the Electron main process: windows, services, IPC, protocols and security policy.
3. **The engine** — deterministic, Electron-free logic for capture orchestration, frames, FFmpeg, probing and validation.

The boundaries are enforced by imports, tsconfig project references and dependency direction, not by convention alone. `src/engine` never imports Electron, React or a renderer module. `src/shared` imports neither Electron nor Node built-ins. The renderer imports only `shared`, its own modules and the preload-exposed API.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Electron application                                                │
│                                                                     │
│  ┌────────────────────┐   typed IPC    ┌──────────────────────────┐  │
│  │ Renderer (React)    │ ─────────────▶ │ Main process             │  │
│  │ sandboxed, CSP      │ ◀───────────── │ services / windows / IPC │  │
│  └────────────────────┘   preload API   └───────────┬──────────────┘  │
│                                                     │                 │
│  ┌────────────────────┐   WebContentsView           │                 │
│  │ Preview renderer    │ ◀──────────────────────────┤                 │
│  │ project origin only │                            │                 │
│  └────────────────────┘                            │                 │
│                                                     │                 │
│  ┌────────────────────┐   offscreen Window + CDP    │                 │
│  │ Capture renderer    │ ◀──────────────────────────┤                 │
│  │ project origin only │                            ▼                 │
│  └────────────────────┘                  ┌────────────────────────┐  │
│                                          │ Engine (Electron-free) │  │
│                                          │ pipeline / frames /    │  │
│                                          │ FFmpeg / validation    │  │
│                                          └───────────┬────────────┘  │
└──────────────────────────────────────────────────────┼───────────────┘
                                                       │ child processes
                                              ┌────────▼────────┐
                                              │ ffmpeg / ffprobe│
                                              └─────────────────┘
```

## Process model

### Renderer (untrusted UI process)

- React 19.3, TypeScript strict, Vite 7.
- `BrowserWindow` with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `spellcheck: false`.
- The only API is `window.biframe`, exposed by `src/preload/index.ts` with `contextBridge`.
- A strict Content Security Policy is injected at build time: production scripts are `'self'` only, connections are `'self'`, objects and frames are disallowed. Dev additionally allows Vite's inline bootstrap and websocket.
- The interface never receives a renderer-side path to an imported file. It receives `ProjectInfo`, `RenderResult`, diagnostics and opaque media URLs.

### Main process (trusted shell)

`src/main/index.ts` is the composition root. It creates the logger, paths, stores, services, the content gateway, the capture host, the preview, the render service, the window and the custom protocol, in that order. Nothing in this file implements rendering logic; it wires real services together.

Services:

| Service | Responsibility |
| --- | --- |
| `ProjectService` | Validate an import, copy a single HTML with its local assets, or extract a ZIP safely; serve the result over loopback HTTP. |
| `ContentGateway` | One persistent Electron session for preview and capture; network policy, permissions, downloads, blocked-request diagnostics. |
| `PreviewService` | A `WebContentsView` over the stage, laid out at export geometry and zoomed to fit; re-applies zoom after capture resets it. |
| `RenderService` | Job lifecycle, one render at a time, progress events, cancellation, history, poster pruning. |
| `SettingsStore` / `HistoryStore` | Atomic JSON persistence with defaults and validation. |
| `EngineStatus` | Resolves bundled FFmpeg/FFprobe, checks versions and temporary-space writability. |
| `ElectronCaptureHost` | Implements the engine's `CaptureSessionHost` using offscreen Chromium and CDP. |

### Engine (pure orchestration)

`src/engine/render/pipeline.ts` receives a `CaptureSessionHost`, a `CancellationToken`, an `emit` callback and plain input. It knows nothing about windows, IPC or React. The same pipeline runs in integration tests with a scripted capture host and real FFmpeg.

- `frame-plan.ts` — hold-last-frame resampling to CFR.
- `frame-store.ts` — frame files and materialisation; hardlinks runs when possible.
- `encoding/` — argument construction, progress parsing, ffprobe parsing, validation and blank/still analysis.
- `media/binaries.ts` — bundled/system resolution and child-process execution with timeouts and signals.
- `project/` — archive guard, loopback server, path containment.
- `network/policy.ts` — URL classification, private address ranges, navigation policy.
- `capture/` — the Electron-free session contract and instrumentation sources.

## Data flow of one render

1. The user submits `RenderSettings`; the main process validates them with Zod and checks `OUTPUT_EXISTS` before creating a job.
2. `RenderService` registers a running job and calls `runRenderPipeline`.
3. The pipeline resolves binaries, checks the output directory and free space, and creates a per-job frame store under `userData/temp/frames/<jobId>`.
4. `ElectronCaptureHost` creates a hidden, offscreen `BrowserWindow` at `width × height`, with no preload, shared gateway session, device metrics override and a reload-safe instrumentation script.
5. The page loads once for inspection (fonts, broken images, protocol, media), then the pipeline starts CDP screencast, reloads and waits for the first observable animation activity (`requestAnimationFrame`, timer, paint or DOM content loaded).
6. Frames stream to disk with host timestamps. Frames before the start instant are queued/discarded by the host. Capture runs until the requested duration, the protocol duration, or `biframe:complete`.
7. The plan maps every target CFR instant to the latest available source frame. Missing gaps repeat the last frame; the timeline is never stretched.
8. FFmpeg encodes the JPEG sequence to H.264 High, `yuv420p`, `+faststart`, with CRF and x264 preset from the quality choice.
9. `ffprobe` reads the actual file. Nine checks determine success. Five JPEG stills are extracted from the encoded file for the result view.
10. The result is stored on the job, appended to history (including failures and cancellations), and the active slot is released.

A failed render removes the partially written MP4. A cancelled render follows the same path and reports `RENDER_CANCELLED`. Temporary frames are removed unless **Manter frames intermédios** is enabled.

## IPC contract

`src/shared/channels.ts` declares every channel and the `BiframeApi` shape. The preload calls `ipcRenderer.invoke` and wraps the answer in a discriminated `ApiResult<T>`; handlers in `src/main/ipc.ts` catch and serialise errors, so the renderer never has to handle a rejected bridge promise for expected failures.

Every argument is validated before reaching a service:

- Render settings are validated by `renderSettingsSchema`.
- Preview bounds are finite numbers in window coordinates, with a bounded scale.
- Paths passed to shell operations must resolve inside the application's own user-data/example directories or match a known render/history/project path.
- Theme changes are validated by `appSettingsSchema` inside the settings store.

Progress and completion are pushed events (`render:progress`, `render:completed`), not polling. Preview state is pushed as well. The renderer also receives a full bootstrap payload so a reload reconstructs the real state.

## Files on disk

```text
%APPDATA%/Biframe/
  settings.json                 atomic, defaults merged field by field
  history.json                  last 100 renders, including failures
  logs/biframe.log              timestamped, scoped log; rotates at 4 MB
  temp/
    projects/<projectId>/       copied HTML or extracted ZIP
    frames/<jobId>/             source JPEGs + cfr/ run
    posters/<jobId>/            five stills retained for the result view
```

The application sweeps `frames/` and `projects/` on startup. Poster directories are pruned to the 20 most recent successful jobs. The user's original HTML/ZIP is only read; imports are copies under `temp/projects`.

## Window composition

The main window uses a hidden title bar with `titleBarOverlay`, so the native minimise/maximise/close controls remain real Windows controls while the interface draws the tinted frame. `applyTheme` recolours the overlay and window background; `nativeTheme` changes are broadcast to the renderer.

The preview is **not** an iframe or a screenshot. It is a `WebContentsView` attached to the window's content view, positioned over the stage by bounds sent from the UI. The page is laid out at export dimensions and scaled with the page zoom factor. This is why the preview can show the same typography and layout as the encoded file. When the stage is partly out of view, the UI hides the surface and says the preview is suspended rather than cropping the layout silently.

## Media protocol

`biframe-media://` is declared privileged before `app.ready()` and handled after the services exist:

- `biframe-media://poster/<jobId>/<index>` resolves to a poster path recorded on that job.
- `biframe-media://output/<jobId>` resolves to a completed job or history entry.
- Range requests are implemented manually for `<video>` seeking.
- Paths are never accepted from the URL; only opaque IDs are.

## Renderer state

`src/renderer/lib/store.tsx` is a reducer plus async action layer. It holds bootstrap data, project, settings, jobs, history, preview state, notices, busy flags and the current view. It applies real progress events and real completion events, and it is the only place that talks to the bridge. Screens are presentational compositions over that state.

The design system is written in `styles/tokens.css` (three surfaces, two inks, one accent, three status colours) and `styles/app.css` (shell, screens, states). Both light and dark palettes derive from the same tokens. Motion is limited to feedback and disabled under `prefers-reduced-motion`.

## Deliberate constraints

- **One render at a time.** Rendering is real time and shares the compositor/session; concurrent captures would distort each other. A second request is rejected, never queued silently.
- **No renderer-side filesystem.** Even the result video is served through the custom protocol.
- **No hidden mutation of imported pages.** Instrumentation observes `requestAnimationFrame`, timers, errors and the optional completion event; it does not alter the page's logic.
- **No browser download in tests.** Playwright drives the Electron binary that the project already depends on.

See [rendering-engine.md](rendering-engine.md) for the engine in depth and the ADRs for the reasoning behind the major choices.
