# Contributing to Biframe

Biframe is a small, opinionated desktop application. The most useful contributions are the ones that keep its central promise intact: **turn the page the user imported into a validated file without changing the page, lying about progress or weakening the boundary around untrusted content.**

This document covers setup, the rules that are not negotiable, and what a change is expected to prove before it is merged.

## Before you start

- Biframe 0.1 targets **Windows 10/11 x64** for packaging. The source is platform-neutral, but macOS and Linux builds are not verified.
- The interface defaults to **Portuguese (pt-PT)** and can be switched to English in Definições → Idioma. Every user-facing string in the engine, the main process and the interface lives in the shared catalog in `src/shared/i18n/`; code, comments, commit messages, documentation and identifiers are in **English**.
- Releases are published on the [GitHub Releases page](https://github.com/rinel-benjamim/biframe/releases). Do not claim a feature is shipped, signed or available for download unless it is.
- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security reports do not belong in a public issue. See [SECURITY.md](SECURITY.md).

## Setup

Requirements:

- Node.js **22.12 or newer** (development and CI have used Node 26).
- npm 11 or newer.
- Windows 10/11 for the verified packaging path.
- Network access during `npm install`; Electron, FFmpeg and FFprobe binaries are downloaded by their packages.

```bash
cd biframe
npm install
npm run dev
```

`npm run dev` starts electron-vite and opens the real Electron application. Import `resources/example/exemplo-biframe.html` or press **Abrir exemplo**.

Useful checks while working:

```bash
npm run typecheck
npm run lint
npm run test:unit
npx vitest run --project ui
npm run test:integration
npm run test:e2e
```

The end-to-end suite builds `out/` first. While iterating, build once and reuse it:

```bash
npm run build
$env:BIFRAME_SKIP_E2E_BUILD = '1'   # PowerShell
npm run test:e2e
```

All generated test files must stay under `.test-out/`. It is git-ignored. Do not point tests at the user's Documents, Desktop or Downloads folder.

## Project map

```text
src/
  engine/     Electron-free orchestration: capture contract, frames, FFmpeg, probe, validation
  main/       Electron composition root, IPC, windows, services, protocol, network policy
  preload/    the only bridge exposed to the interface
  renderer/   React 19 interface, screens, state and styles
  shared/     neutral types, schemas, errors, presets and formatting
tests/
  unit/       pure functions and stores; no Electron, no FFmpeg
  integration/ real FFmpeg/ffprobe, real loopback HTTP, fake capture host
  e2e/        real Electron application, real Chromium, real exports
  ui/         React Testing Library presentational tests
docs/
  adr/        decisions and their consequences
```

Read [docs/architecture.md](docs/architecture.md) and [docs/rendering-engine.md](docs/rendering-engine.md) before changing the pipeline.

## Architectural rules

These boundaries are enforced by imports and review, not just custom:

1. **`src/engine` must not import Electron, React or a main-process module.** It receives plain data, a `CaptureSessionHost`, a cancellation token and an emit callback. It must remain runnable in Vitest.
2. **`src/shared` must not import Electron or Node built-ins.** It is shared by the renderer, preload and main process.
3. **Only the main process touches the filesystem, child processes and Electron APIs.** The renderer receives opaque media URLs and structured state.
4. **The renderer never receives a path it can open.** Shell operations take opaque job/project IDs or validated paths from the application's own records.
5. **The preload is the only bridge.** Every channel is declared in `src/shared/channels.ts` and implemented in `src/main/ipc.ts`. Expected failures travel as `ApiResult<T>`, not as rejected bridge promises.
6. **All IPC input is validated.** Render settings use Zod; paths and bounds are checked against the application's own allow-lists. Never add an unvalidated `invoke` handler.
7. **One render at a time.** A second request is rejected with `RENDER_IN_PROGRESS`; it is not queued. Importing and closing are blocked while a render is active.
8. **The imported page is hostile.** It runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload, no webviews, navigation restricted to the project origin and every request passing through `ContentGateway`.
9. **Do not simulate progress or success.** If a value has no honest source, show indeterminate progress. `ffprobe` validation, not a progress bar, decides whether a render succeeded.
10. **Do not mutate imported files.** A render may reload and observe the page; it must not rewrite, inject into, or save over the user's HTML/ZIP.

If a change needs to cross one of these lines, write an ADR first and explain why.

## Testing expectations

Choose the smallest layer that can actually prove the change:

- **Pure logic** (frame plans, FFmpeg arguments, validation, path guards, formatting): unit test. No Electron and no binary process.
- **Real file/process/network behavior** (import, loopback server, FFmpeg, ffprobe, cancellation): integration test. The capture host may be faked; the binaries must be real.
- **Application behavior** (import, live preview, export, overwrite, cancel, packaged smoke): E2E or the packaged smoke harness.
- **Presentational components**: React Testing Library. Assert labels, roles and real state, not CSS implementation details.

A bug fix should include a test that fails before the fix. A security fix must include a regression test whenever the behavior is testable.

Do not add a test that requires a separately installed Chromium, Playwright browser, FFmpeg or FFprobe. The project already ships or depends on everything it needs. Do not weaken a test to make it pass; fix the code or document the limitation.

The suites are described in [docs/testing.md](docs/testing.md).

## TypeScript and code style

- TypeScript is strict. Avoid `any`; `@typescript-eslint/no-explicit-any` is an error.
- Use `import type` for type-only imports.
- Prefer small pure functions in `engine/` and thin orchestration in services.
- Comments explain **why** a non-obvious decision exists, not what the next line does.
- Errors use `BiframeError` with a stable code from `src/shared/errors.ts`. Add the human-readable title and message to both catalogs in `src/shared/i18n/` (`pt.ts` and `en.ts`); never inline copy in the engine or the interface.
- Logs are structured and scoped. Never log file contents, tokens or imported page data.
- Use `path` APIs rather than string concatenation for filesystem paths.
- Run `npm run lint` with zero warnings and `npm run typecheck` before opening a change.

## Interface rules

- The visual direction is documented in the code comments and README: a tinted chrome frame around an inset white sheet, IBM Plex Sans/Mono, one accent, a real filmstrip. Do not turn screens into generic card grids.
- Use the tokens in `src/renderer/styles/tokens.css`; do not hard-code palette values in components.
- Check both light and dark themes, keyboard focus, `prefers-reduced-motion`, empty states, errors, long file names and 1060×700 windows.
- The interface defaults to Portuguese and can be switched to English in Settings. Both languages come from the shared catalog, so new copy must be added to `pt.ts` and `en.ts` (the build fails if a translation is missing). Error messages must say what happened and what the user can do next.
- Buttons must have a real action. A disabled or loading control must reflect actual state.
- Never hide a destructive action behind a silent overwrite. Replacement requires explicit confirmation.
- New screens or components need at least a smoke check in the E2E or UI suite if they affect an export path.

## Security checklist for changes

- Does the change introduce a new IPC channel, URL scheme, network request, child process or file path? If yes, validate and test it.
- Does untrusted page content gain a new capability? It almost never should.
- Does the change weaken `ContentGateway`, `classifyResource`, `classifyNavigation`, the archive guard or path containment?
- Does an error include a token, an absolute user path or page content in a place that is shown publicly or logged?
- Does a ZIP or single-HTML import still reject traversal, absolute paths, drive letters, ADS, control characters, trailing dots/spaces and symlinks?
- Does a failed or cancelled render remove partial MP4s and temporary frames?

See [docs/security.md](docs/security.md) for the threat model.

## Packaging

The verified artifact is the unpacked Windows build:

```bash
npm run build:unpack
node scripts/dev/smoke-package.mjs
```

The smoke test imports the packaged example, exports a 720p clip and probes it with the bundled FFprobe. If you change packaging, binary resolution, the example or the main entry point, run it.

The NSIS installer (`npm run build:win`) is built for releases (`Biframe Setup 0.1.0.exe`, signed with the local signtool certificate chain) but is **not covered by the automated smoke test**, which drives the unpacked build instead. macOS/Linux targets are also unverified. Do not present them as supported.

## Documentation and ADRs

- Update the README when user-visible behaviour, requirements or limits change.
- Update `docs/rendering-engine.md` when the pipeline phases, defaults, limits or validation change.
- Add an ADR for a decision that is expensive to reverse: process model, capture mechanism, binary distribution, import policy, output format, persistent state.
- ADRs are immutable in spirit. If a decision changes, add a new ADR that supersedes the old one rather than silently rewriting history.
- Keep claims evidence-based. Distinguish "verified on this machine" from "designed for" and "not implemented".

## Commits and pull requests

There is no enforced commit format. A useful change description answers:

- What problem does this solve?
- What is the user-visible effect?
- What did you verify, with which command?
- What is not covered or remains a known limitation?

Keep unrelated refactors out of a bug fix. Do not commit generated output (`out/`, `release/`, `.test-out/`, profiles, MP4s) or local screenshots.

Before opening a change:

```bash
npm run lint
npm run typecheck
npm run test:unit
npx vitest run --project ui
npm run test:integration
npm run test:e2e
```

If a suite cannot run in your environment, say so explicitly in the change description instead of omitting it silently.

## Licence

By contributing, you agree that your contribution is licensed under the repository's MIT licence, and that third-party assets you add are compatible with it. Bundled FFmpeg is GPL-3.0-or-later; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
