# ADR 0004 — Capture with CDP screencast instead of paint events or polling

- **Status:** Accepted
- **Date:** 2026-10-23
- **Related:** [ADR 0002](0002-untrusted-content-boundary.md), [ADR 0003](0003-ffmpeg-distribution.md)

## Context

Biframe must turn an arbitrary animated page into frames. The page is not a video and exposes no seek API. The capture method determines visual fidelity, frame timing, CPU cost and what can honestly be claimed about constant frame rate.

Requirements:

- capture at the exact output geometry, independent of the user's window;
- see the same rendering as Chromium, including CSS animation, canvas and WebGL;
- timestamp frames well enough to resample to CFR;
- work with an offscreen/hidden window;
- not capture other applications or the Biframe UI;
- report real frame counts and capture-rate problems;
- run on a 2016 laptop (Intel i5-6200U) without a discrete GPU.

## Options considered

1. **OS screen recording** (desktopCapturer, Windows Graphics Capture, OBS-style capture).
   - Pros: captures exactly what is on screen, including hardware surfaces.
   - Cons: includes other windows and notifications, depends on display scaling and visibility, requires a real visible window, and would make the export non-deterministic. Rejected.

2. **Repeated `webContents.capturePage()` polling.**
   - Pros: simple, gives a PNG at each call.
   - Cons: the call is expensive, asynchronous and not aligned to compositor frames; a timer loop adds main-process jitter; there is no reliable presentation timestamp. Rejected.

3. **Offscreen `paint` events.**
   - Pros: direct compositor frames, no JPEG intermediate, straightforward buffer API.
   - Cons: the POC measured high main-loop jitter under load. At 60 fps requested, paint delivered 55 fps but p95 main-loop jitter was **252 ms**; the animation was visibly stretched and `requestAnimationFrame` ran fewer times than wall-clock should allow. Unacceptable for a real-time product.

4. **CDP `Page.startScreencast` on a `BrowserWindow`.** **Chosen.**
   - Pros: Chromium generates frames at its own compositor cadence; JPEG is the native payload; each frame carries a session id that can be acknowledged immediately; the output has the requested viewport; each frame carries a presentation timestamp.
   - Cons: no guarantee of the requested FPS; JPEG is lossy; the screencast must be stopped and cleaned up; capture is real time, not deterministic.

   The window itself has two variants, both measured on the target machine (1280×720, requesting 60 fps, example page):

   | Window | Compositor | Achieved FPS |
   | --- | --- | ---: |
   | `offscreen: true` (Chromium software compositing) | CPU | 27–33 |
   | native window parked outside every display | GPU/DWM | **56–58** |

   Software offscreen compositing halves the capture rate on this hardware, which would force visible duplication into every 60 fps export. Windows therefore uses the native variant; other platforms keep the offscreen window until they can be measured the same way.

## Decision

Use a sandboxed `BrowserWindow` with a CDP screencast:

- on Windows, `offscreen: false`: a frameless native window is parked left of the union of every display, made non-focusable and mouse-transparent and shown with `showInactive()` (`paintWhenInitiallyHidden: true` keeps it painting before the first show). If the OS rejects the position and the window would overlap a display, it falls back to `setOpacity(0)`. `disable-features=CalculateNativeWinOcclusion` stops Chromium from classifying the off-desktop window as invisible and throttling it. On other platforms, `offscreen: true` with software compositing;
- `backgroundThrottling: false`, no Node, no preload, sandboxed;
- `Emulation.setDeviceMetricsOverride` at exactly the requested width/height, `deviceScaleFactor: 1`;
- zoom forced to 1 before each load (the preview shares the session and applies zoom);
- `Page.addScriptToEvaluateOnNewDocument` installs observation-only instrumentation;
- `Page.startScreencast({ format: 'jpeg', quality: 92, everyNthFrame: 1, fromSurface: true })`;
- each `Page.screencastFrame` is acknowledged immediately and stamped with the **presentation timestamp from the CDP metadata** (`metadata.timestamp`, host clock fallback), validated within 5 s of the host clock and kept monotonic. Arrival time alone is wrong exactly when it matters: after a main-process stall, a burst of frames arrives stamped with nearly the same instant and the resampler would repeat one frame through a fast transition;
- before the animation start is known, up to 400 frames are queued; the host arms at the computed `startMs` and replays only frames at or after that instant;
- frames are written to disk by the engine (each file number is reserved synchronously, before the write is awaited, so overlapping writes cannot share a path), then resampled with a **nearest-frame** plan to the exact requested FPS.

The start instant is based on the page's `performance.timeOrigin` plus the first observed activity: `requestAnimationFrame`, timer, first contentful paint, first paint or `DOMContentLoaded`, in that order. If instrumentation is unavailable, navigation time is used and a diagnostic is emitted.

## Evidence

The POC (`scripts/poc/poc-capture.cjs`, `npm run poc`) ran on the target machine at 1280×720, requesting 60 fps for 6 s:

| Mode | Frames | Achieved FPS | p95 inter-frame | p95 main-loop jitter |
| --- | ---: | ---: | ---: | ---: |
| screencast, offscreen | 265 | 42.9 | 39 ms | 31 ms |
| paint, offscreen | 430 | 55.0 | 42 ms | **252 ms** |

On the 36.5-second Brisa acceptance page, offscreen screencast originally delivered 1,402 frames at ~34.4 fps with p95 inter-frame 55 ms and p95 jitter 46 ms. With the native compositor and presentation timestamps, the same page at 720p sustained ≥54 fps and the 60 fps export passed all nine checks with **2,190 frames** and no `CAPTURE_RATE_LOW`. `mpdecimate` counts the distinct moments in each file: the old 30 fps export contained **361** unique frames; the new 60 fps export contains **1,098** — roughly three times the motion samples.

Other measurements on the same machine (720p unless noted, `scripts/dev/capture-bench.cjs`):

| Configuration | Achieved FPS |
| --- | ---: |
| native compositor, example page | 56–58 |
| native compositor, 1080p | ≈26.5 |
| native compositor, `setFrameRate(60)` forced | 43.6 (worse — leave Chromium alone) |
| native compositor, `setOpacity(0)` fallback | 51 |
| native compositor, example page, isolated re-run | 48.1 (`rafFps` 57.4) |

The frame plan reports `CAPTURE_RATE_LOW` only when the measured rate is below 90 % of the target (i.e. below 54 fps for a 60 fps request), so the warning means real duplication, not statistical noise.

These numbers are observations, not guarantees. A slower page or machine will deliver fewer unique frames, and the example page's in-app capture rate varies between 28 and 49 fps with system load. Biframe is honest about that: the video duration is exact, but duplicate frames are possible and are reported.

## Consequences

Positive:

- The captured image is the page's real compositor output, including canvas/WebGL.
- The capture window lives outside the desktop, so the export does not depend on the desktop being visible or the app being focused, and the user never sees it.
- Frame pacing is better than offscreen paint events on the target hardware.
- Timestamped GIF-like JPEGs are cheap to write and immediately re-encoded to H.264.
- The same host interface can be replaced by a fake in integration tests.

Costs:

- **Real-time only.** A 36-second animation takes at least 36 seconds to capture.
- **No deterministic seeking.** The protocol reserves `deterministic`, `onStart` and `onSeek`, but 0.1 does not call them. A future engine could seek and capture frame-by-frame; that is a different architecture.
- **No audio.** Screencast carries pixels; there is no audio graph.
- **JPEG is lossy.** Quality 92 is an intermediate; the H.264 output is what the user inspects.
- **The capture rate is not the requested FPS.** CFR is produced by resampling, not by forcing Chromium to paint faster.
- **Self-navigating pages are unsupported.** A page that reloads during capture resets the host's queue and is not re-armed.
- **CDP is a debugging protocol.** It is stable enough for this use, but it is not a public web API; Electron upgrades require re-testing capture.

## Alternatives for a future version

A deterministic renderer would ask the page to render an exact time (through `onSeek`), capture one frame per target instant and remove the wall-clock dependency. That would make 60 fps reliable and eliminate duplicates, but requires page cooperation and a much larger protocol. It is explicitly out of scope for 0.1 and is documented as such in [docs/page-protocol.md](../page-protocol.md).

## Verification

- `tests/integration/pipeline.test.ts` exercises the frame plan and encoding with real files.
- `tests/e2e/app.test.ts` runs the real Chromium capture and validates a 90-frame 1.5 s 60 fps 720p file with ffprobe (`r_frame_rate 60/1`).
- The 36.5 s Brisa acceptance export is documented in the README and the final report, including visual inspection of all five scenes.
- The POC manifests remain under `.poc-out/` locally (git-ignored) and are not shipped.
