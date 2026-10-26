# Testing

Biframe's tests are layered by what they can actually prove. Pure logic is tested without Electron. Boundaries that involve real files, real HTTP or real media binaries are tested with those components. The application is tested by driving the real Electron binary.

The guiding rule is: **do not mock the thing under test**. The capture host is the one deliberate exception: integration tests use a scripted host that emits real JPEG frames, so FFmpeg, ffprobe, resampling and validation are real without launching a second Electron instance. The Chromium path is covered by the E2E suite instead.

## Commands

```bash
npm run lint
npm run typecheck
npm run test:unit
npx vitest run --project ui
npm run test:integration
npm run test:e2e
```

`npm run test` is an alias for the unit suite. `npm run test:all` runs every Vitest project, including E2E, in one process; the per-layer commands are easier to diagnose.

Last full verification on **24 October 2026** (Windows 10, Node 26.10.0, Electron 44.9.3):

| Layer | Tests | Result |
| --- | ---: | --- |
| Unit | 131 | 131 passed |
| UI (React Testing Library) | 12 | 12 passed |
| Integration | 17 | 17 passed |
| End-to-end (Playwright + Electron) | 5 | 5 passed |

`npm run lint` and `npm run typecheck` completed with no errors. The packaged smoke test and the 36.5-second acceptance export are reported separately in the README and the final project report because they are not part of the routine suite.

Counts are a snapshot. Add tests with behavior changes; do not preserve a count for its own sake.

## What each layer covers

### Unit — pure logic, no Electron, no binaries

`tests/unit/` (10 files):

- **Frame planning** — hold-last-frame resampling, start offsets, late streams, empty captures, duplicate runs, measured capture rate, `CAPTURE_RATE_LOW`.
- **Encoding** — exact FFmpeg argument construction, overwrite/start number, progress-line parsing, ffprobe JSON parsing, nine validation checks, duration tolerance, blank/still frame analysis.
- **Network policy** — IPv4 and IPv6 private ranges, mapped/compatible/NAT64/6to4/Teredo forms, special hostnames, project origin, remote opt-in, method and scheme rules, navigation policy.
- **Archive guard** — path normalisation, traversal, ADS, Windows-hostile names, symlink mode bits and reparse attributes, size budgets, entry selection, containment.
- **Diagnostics** — deduplication, severity counts, caps, console mapping, page inspection, still-frame warnings, merging.
- **Protocol and errors** — descriptor parsing, invalid values, reserved fields, stable `BiframeError` codes and serialisation.
- **Presets and settings** — geometry, aspect fitting, validation, defaults, field-by-field repair of stored settings.
- **Stores** — atomic settings/history persistence, corrupt JSON recovery, item replacement and clearing.
- **Formatting and theme** — Portuguese number/date/byte formatting, filename sanitation, pluralisation, theme resolution and titlebar palette.

Unit tests do not spawn FFmpeg and do not open a window.

### UI — presentational behaviour

`tests/ui/components.test.tsx` renders the shared components with jsdom and React Testing Library:

- notice roles and dismissal;
- validation checklist labelling;
- diagnostic sorting, summaries and empty state;
- real `<progress>` semantics, indeterminate state, cancel state;
- switch accessibility and toggling;
- engine status labels.

These tests assert accessible roles, text and state, not CSS classes or pixel layout. Screens are visually inspected separately through the captured E2E screenshots.

### Integration — real binaries and real boundaries

`tests/integration/` (2 files):

**Pipeline** (`pipeline.test.ts`) uses a scripted `CaptureSessionHost` that emits real JPEG frames and measures time from the real clock, then runs the actual pipeline:

- builds a CFR sequence, encodes with the bundled FFmpeg, probes with ffprobe and validates the MP4;
- extracts five real posters and reports measured progress;
- reads a duration declared by the page protocol;
- rejects an existing output without creating a session or touching the file (`OUTPUT_EXISTS`);
- replaces an existing file only when `overwrite` is explicit;
- cancels during capture, produces no MP4 and removes temporary frames.

Integration requires real FFmpeg and FFprobe. In Vitest's ESM environment, `pipeline.test.ts` sets `BIFRAME_FFMPEG_PATH` and `BIFRAME_FFPROBE_PATH` using `createRequire` before resolving binaries. This is a test-environment accommodation, not an application requirement; the packaged app resolves its bundled binaries itself.

**Project boundary** (`project.test.ts`) starts a real loopback server and writes real archives:

- token enforcement, directory indexes, encoded URLs, MIME types, `HEAD`, Range responses, method rejection and traversal refusal;
- single-HTML asset copying, CSS recursion, `srcset`, missing files, limits and remote-host reporting;
- rejection of assets that escape the HTML folder through a symlink or junction;
- ZIP import and entry selection inside a folder;
- `ProjectService` size accounting, temporary cleanup and stable error codes.

The integration global setup empties `.test-out/integration` before the run. Files left behind after a failure are there for inspection.

### End-to-end — the real application

`tests/e2e/app.test.ts` launches the built Electron app with `_electron` from Playwright:

1. the empty studio loads and the engine reports ready;
2. the bundled example imports, the live `WebContentsView` is active at 1920×1080, and a desktop screenshot is captured for evidence;
3. a 720p, 1.5 s export is produced, checked with ffprobe (H.264, yuv420p, 1280×720, 30/1, 45 frames, duration 1.5) and inspected on the result screen with five loaded posters;
4. a second export with the same name shows the overwrite confirmation, does **not** start a job, leaves the old file untouched, then replaces it after confirmation;
5. an 8 s export is cancelled at about 700 ms, the Portuguese cancellation notice appears, no MP4 is left, and the original example is byte-identical.

The suite builds `out/` once in `global-setup.ts`. To reuse an existing build:

```powershell
$env:BIFRAME_SKIP_E2E_BUILD = '1'
npm run test:e2e
```

The build step uses `npm run build` (typecheck plus electron-vite). On Windows with Node 26, the setup invokes npm through a shell because Node no longer launches `.cmd` shims directly.

E2E profiles and outputs live under `.test-out/e2e/`. Screenshots (`01`–`04`) are evidence, not assertions; on a headless or locked machine they may be black even when the assertions pass. `BIFRAME_DEBUG_E2E=1` prints the last collected renderer console lines when the app closes.

## Packaged smoke test

After `npm run build:unpack`:

```bash
node scripts/dev/smoke-package.mjs
```

This launches `release/win-unpacked/Biframe.exe` with an isolated profile, opens the packaged example from `resources/example/`, exports a 1.5 s 720p clip and probes it with the bundled ffprobe. It verifies that `app.asar.unpacked` FFmpeg/FFprobe resolution works outside the source tree. It does not test the NSIS installer.

The script spawns the executable directly with a loopback DevTools port and connects over CDP. On a warm start the window can be created before Playwright's Electron launcher attaches, which makes its first-window wait time out even though the app is healthy. Driving the packaged page over CDP avoids that race; the main process is not evaluated.

## Acceptance export

The development acceptance case is the five-scene, 36.5-second 1280×720 `Brisa · Vídeo de produto.html` at the workspace root. It is not copied into the repository. Its Google Fonts request requires **Permitir recursos externos**, which the harness enables before importing. The final verified run, repeated after the single-HTML real-path hardening and the secure network default, produced 1,095 frames, H.264 High, `yuv420p`, 1,786,764 bytes, 36.500000 s and nine of nine checks; frames at 2, 6, 14, 24, 31 and 35.5 seconds were visually inspected. The source file's size and SHA-256 were identical before and after. See the final report for the exact commands and evidence.

## What is not tested

- No CI workflow is committed. The suites are run locally; a Windows CI job would be a welcome contribution.
- No coverage percentage or coverage threshold is enforced.
- The NSIS installer, macOS packages, Linux AppImage, code signing and automatic updates are not tested.
- No test drives a physical display capture, an actual GPU failure, a system sleep/resume or a full disk.
- Remote-resource behavior is covered by policy unit tests, not by an E2E request to a public host; relying on the public internet would make the suite non-deterministic.
- Browser zoom, OS display scaling and multiple monitors are not automated. The preview applies a deterministic zoom factor and the E2E window is the primary display.
- Audio, alpha and deterministic page seeking do not exist, so there is nothing to test.

## Debugging failures

- Keep `.test-out/` after a failure; it contains the isolated profile, outputs, frame stores and screenshots.
- For E2E, run with `BIFRAME_DEBUG_E2E=1` and inspect `%APPDATA%` only if the profile was not isolated; normally use the profile under `.test-out/e2e/profile`.
- For integration, run a single test with `npx vitest run --project integration -t "cancels during capture"`.
- If FFmpeg cannot be found under Vitest, check that the test passed `BIFRAME_FFMPEG_PATH`; outside Vitest, the packaged resolution order is override → bundled → `PATH`.
- If the E2E build fails with `spawnSync npm.cmd EINVAL`, update the global setup to invoke npm through the platform shell. Node 26 does not spawn `.cmd` files directly.
- Screenshots are evidence only. A black preview in a screenshot does not by itself mean the live view failed; assert `data-live="true"` and the output file instead.
