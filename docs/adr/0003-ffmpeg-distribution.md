# ADR 0003 — Bundle FFmpeg and FFprobe instead of requiring a system install

- **Status:** Accepted
- **Date:** 2026-10-23

## Context

Biframe's output is an H.264 MP4 validated by FFprobe. The user should not need to install FFmpeg, choose a build, add it to `PATH` or discover why encoding failed. The application must work offline after installation and produce the same result on a clean Windows machine as on the developer's machine.

At the same time, FFmpeg is a large third-party binary with its own licence and update cadence. Bundling it affects package size, licensing and platform packaging.

## Decision

Ship the media binaries with the application:

- **FFmpeg** via `ffmpeg-static` **5.3.0** (FFmpeg 6.1.1, gyan.dev essentials build, `--enable-gpl --enable-version3`, libx264).
- **FFprobe** via `ffprobe-static` **3.1.0**.

Packaging:

- `electron-builder` unpacks both packages from `app.asar` via `asarUnpack`: `node_modules/ffmpeg-static/**` and `node_modules/ffprobe-static/**`.
- The packaged paths are `resources/app.asar.unpacked/node_modules/...`.
- The verified Windows layout is:
  - `resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe`
  - `resources/app.asar.unpacked/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe`

Resolution order in `src/engine/media/binaries.ts`:

1. explicit `BIFRAME_FFMPEG_PATH` / `BIFRAME_FFPROBE_PATH` (tests and advanced users);
2. the bundled package path, translated from `app.asar` to `app.asar.unpacked` when packaged;
3. a system binary on `PATH`, as a last resort.

Every resolved binary is executed with `-version` and reported in Definições (*Settings*). If none exists, `ENCODER_MISSING` is raised with a clear message. Binaries run as child processes with an argument array, `windowsHide`, timeouts, an abort signal and bounded output buffers. No shell is used.

## Options considered

- **Require a system FFmpeg.** Smallest package and simplest licensing, but a terrible first-run experience: version drift, missing libx264, `PATH` problems and no reproducibility. Rejected.
- **Download FFmpeg on first run.** Keeps the installer small but makes the first export depend on the network, introduces a supply-chain endpoint and requires integrity checking, retries and proxy handling. Rejected for 0.1.
- **Bundle LGPL-only FFmpeg.** Would reduce licensing obligations but may exclude libx264, which is the encoder the product relies on. The chosen build is GPL. This is documented rather than hidden.
- **Use a native Node encoder or WebCodecs.** WebCodecs in Chromium offers H.264 on some builds but does not give the same control, validation or cross-machine consistency, and ffprobe would still be needed to verify the result. FFmpeg is the right tool for an MVP that promises validated output.
- **Use a hardware encoder.** Faster on some machines, but quality and availability vary, and headless offscreen capture already uses CPU. Software x264 is predictable. A future quality option could add hardware encoding.

## Licensing

The Biframe source is MIT. The bundled FFmpeg build is **GPL-3.0-or-later** with x264; `ffprobe-static` is MIT. Distributing the Biframe package therefore also distributes a GPL binary.

The project:

- does not link FFmpeg into the application process; it runs as a separate executable;
- ships third-party notices and source links in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md);
- expects redistributors to provide the corresponding FFmpeg source and comply with the GPL when they distribute a build.

This is a practical summary, not legal advice. Anyone shipping Biframe commercially should review the obligations with counsel.

## Consequences

Positive:

- A clean install can export without any external dependency.
- The version used by the app is the version tested by the integration suite.
- The packaged smoke test verifies the real unpacked layout.

Costs:

- The Windows build is tens of megabytes larger.
- The bundled binaries are platform-specific; macOS/Linux need their own binaries and packaging, which are configured but untested.
- Updating FFmpeg means bumping a dependency, re-running the integration suite and repeating the packaged smoke test.
- GPL obligations apply to redistribution of the FFmpeg binary.
- The package may trigger antivirus/SmartScreen heuristics; there is no code signing in 0.1.

## Verification

- `npm run test:integration` uses the real FFmpeg/FFprobe binaries for encoding, probing, validation, posters and cancellation.
- `npm run build:unpack` produces the expected unpacked layout.
- `node scripts/dev/smoke-package.mjs` launches `release/win-unpacked/Biframe.exe`, imports the packaged example, exports a 720p clip and probes it with the bundled ffprobe.
- The 36.5-second acceptance export was encoded by the bundled FFmpeg and validated 9/9.
