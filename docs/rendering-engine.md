# Rendering engine

The engine turns an imported page into an MP4 by orchestrating three real components: a Chromium capture host, a frame store on disk and FFmpeg/FFprobe child processes. It does not contain a video renderer of its own, and it does not simulate progress or success.

`src/engine/render/pipeline.ts` is the whole orchestration. Its inputs are plain data:

```ts
interface RenderPipelineInput {
  jobId: string;
  entryUrl: string;
  settings: RenderSettings;
  limits: ResourceLimits;
  tempRoot: string;
  posterRoot: string;
  allowRemote: boolean;
  keepTempFiles: boolean;
  overwrite: boolean;
}

interface RenderPipelineEnvironment {
  host: CaptureSessionHost;
  token: CancellationToken;
  emit: (progress: RenderProgress) => void;
  log?: (message: string, detail?: unknown) => void;
}
```

The production host is Electron; integration tests pass a scripted host. Everything downstream is identical, including real FFmpeg and real `ffprobe`.

## Phases

| Phase | What actually happens | Progress |
| --- | --- | --- |
| `preparing` | Resolve FFmpeg/FFprobe, validate output directory, check existing file, estimate disk use, create the frame store. | 0 % |
| `launching` | Create the capture session (off-desktop Chromium window, debugger, device metrics, instrumentation). | 2 % |
| `loading` | Load the entry URL, wait for `load`, wait for fonts/images/layout to settle (bounded to 8 s), inspect the page. | 4–6 % |
| `capturing` | Start CDP screencast, reload, find the first animation activity, capture until the duration ends. | 6–78 % (time-based, with captured/target frame counts) |
| `resampling` | Build the CFR plan and materialise the numbered sequence. | 80 % |
| `encoding` | Run FFmpeg and parse its `-progress pipe:1` output. | 82–95 % (measured frames) |
| `validating` | Probe the file, run nine checks, sample five stills, extract five posters. | 96–100 % |
| `completed` | Return `RenderResult` with metadata, validation, diagnostics and poster paths. | 100 % |

Progress is null where no honest total exists: while waiting for a page completion signal, the UI shows an indeterminate state. It never invents a percentage.

## Choosing t = 0

Real-time capture needs a defensible starting instant. The host injects an observation-only script before the page's own scripts run. It records the first `requestAnimationFrame` call, the first `setTimeout` call, `DOMContentLoaded`, paint timings, page errors and the optional complete event. It does not reorder, skip or rewrite anything.

After the initial load and inspection, the pipeline:

1. starts the screencast and keeps up to 400 pre-start frames in a bounded queue;
2. reloads the page so the animation starts from a known state;
3. waits for `load`, then polls the probe for up to 2.5 s;
4. computes `startMs = performance.timeOrigin + firstActivity`, where first activity is the first rAF, timer, first contentful paint, first paint or DOM content loaded, in that order;
5. arms the host at that host-clock instant and replays only queued frames with `t >= startMs`;
6. discards any earlier frame from the plan.

If the instrumentation is blocked or unavailable, the engine approximates the start from navigation and adds a `PAGE_WARNING` diagnostic. It never silently pretends the timing is exact.

## Duration

**Manual.** Capture runs until `seconds × 1000` has elapsed since `startMs`. The value is clamped to `limits.maxDurationSeconds` (600 s by default) and validated by Zod (minimum 0.5 s).

**Automatic with `window.biframe.duration`.** The declared duration is used immediately, clamped to the limit. No completion wait is needed.

**Automatic with only `biframe:complete`.** The engine polls the page until the event has fired, the token is cancelled, or the 600 s ceiling is reached. The effective duration is measured from `startMs` to the observed completion. A page that never signals produces `RENDER_TIMEOUT` with a clear recommendation to use a manual duration.

`window.biframeCapture` (`start`/`end`) is read and reported in a diagnostic, but this version does not crop the capture window. That limitation is explicit in the UI diagnostic, not hidden.

## Capture

The production capture session is a sandboxed `BrowserWindow` driven by the native compositor on Windows:

- a frameless window parked left of the union of every display, non-focusable, mouse-transparent, shown without activation (`paintWhenInitiallyHidden: true`); if the OS rejects the position it falls back to full transparency. `disable-features=CalculateNativeWinOcclusion` keeps Chromium from throttling an off-desktop window. Other platforms use `offscreen: true` with software compositing, which measured 27–33 fps against the native compositor's 56–58 fps on the target machine;
- `backgroundThrottling: false`;
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`;
- no preload, no webviews, dialogs disabled, DevTools disabled;
- audio muted;
- shared persistent content session guarded by `ContentGateway`;
- CDP `Emulation.setDeviceMetricsOverride` at exactly the requested width and height, `deviceScaleFactor: 1`;
- zoom forced to 1 because Chromium stores zoom per origin in the shared session and the preview zooms the page to fit its stage.

Frames arrive through `Page.startScreencast` (`format: 'jpeg'`, quality 92, `fromSurface: true`) as JPEG quality 92. Each frame is acknowledged immediately, and the frame is stamped with the **presentation timestamp from the CDP metadata** (accepted only within 5 s of the host clock, kept monotonic); host arrival time is the fallback. Arrival time alone is wrong exactly when it matters: after a main-process stall, a burst of frames arrives stamped with nearly the same instant and the resampler would repeat one frame through a fast transition. JPEG was chosen over PNG because it is the codec Chromium's screencast produces natively and the quality/size trade-off is appropriate for an intermediate that is immediately re-encoded. See [ADR 0004](adr/0004-capture-strategy.md).

### Why not deterministic seek?

The protocol reserves `deterministic`, `onStart(cb)` and `onSeek(seconds)` for a future engine that would render each frame at an exact page time, independent of wall-clock speed. Implementing that correctly requires cooperation from the page and is not part of 0.1. Today, a page that declares deterministic support is captured in real time and receives a diagnostic saying so.

### Frame rate reality

CDP screencast does not guarantee the requested FPS. The engine measures the delivered rate from frame timestamps. If it is below 90 % of the requested rate (below 54 fps for a 60 fps request), it emits `CAPTURE_RATE_LOW` with the measured value and the number of repeated frames. A page that takes 100 ms to paint a frame cannot be made to produce 60 unique frames per second by asking FFmpeg for 60 fps.

## Frame resampling

`buildFramePlan` picks the source frame **nearest** to each target instant:

```text
targetFrames = max(1, round(fps × durationMs / 1000))
for each target index i:
    targetTime = startMs + i × 1000 / fps
    choose the source frame with t nearest to targetTime (ties keep the earlier frame)
```

- The nearest-frame rule keeps motion evenly spaced. The previous hold-last rule put every target one whole capture interval behind the page — during a fast transition each target fell just short of the next real frame and repeated the previous one, which is what visible stutter looks like. Ties keep the earlier frame, so the timeline never plays content from the future.
- Gaps still repeat the nearest frame. Content is duplicated, never interpolated, and the output duration stays exact.
- Source frames are ordered by presentation timestamp and each plan index points back at the original position, so a stream whose disk writes finish out of order still resamples against a monotonic timeline.
- Frames older than `startMs` are excluded, unless no frame qualifies; then the earliest pool is used so the render fails later with a real diagnostic rather than producing zero frames.
- `planToRuns` groups consecutive duplicates so the frame store can hardlink instead of copying. The encoder still sees one file per CFR frame.

`FrameStore` writes source frames during capture — reserving each file number synchronously, before the write is awaited, so two frames in flight cannot share a path — then materialises the plan as `cfr/%06d.jpg`. Duplicate runs are hardlinked where the filesystem permits, falling back to copies. Source frames remain on disk unless `keepTempFiles` is enabled. Only paths and timestamps stay in memory, so a long 4K capture does not grow the heap with image data.

## Encoding

`buildEncodeArgs` is the only place an FFmpeg command is constructed:

```text
-hide_banner -nostdin -loglevel error (-y|-n)
-framerate <fps> -start_number 1 -i <frames>/%06d.jpg
-an -c:v libx264 -preset <medium|slow> -crf <26|21|17>
-profile:v high -pix_fmt yuv420p -g <2×fps>
-movflags +faststart -r <fps>
-progress pipe:1 -nostats -f mp4 <output>
```

| Quality | CRF | x264 preset | Intended use |
| --- | --- | --- | --- |
| Ficheiro mais pequeno | 26 | medium | quick sharing, smaller files |
| Equilibrada | 21 | medium | default; good text and graphics |
| Alta qualidade | 17 | slow | dense type, gradients, detailed motion |

`-an` is deliberate: the capture path has no audio graph and the MVP does not mux page audio. `+faststart` moves the moov atom for progressive playback. `-g` at two seconds is conventional for web playback.

The output path is sanitised: the file name is stripped of illegal characters, the `.mp4` extension is enforced, and the destination is resolved before the process starts. `overwrite` is false unless the user confirmed the conflict.

## Validation

A zero exit code is not success. After encoding, `ffprobe` reads the file and `validateOutput` produces nine checks:

| Check | Pass condition |
| --- | --- |
| `file-size` | File exists and is non-empty |
| `container` | Format name includes `mp4` |
| `codec` | Video codec is `h264` |
| `resolution` | Width and height exactly match the request |
| `fps` | Average frame rate within 0.05 fps of the request |
| `pixel-format` | `yuv420p` |
| `duration` | Within `max(0.35 s, 2/fps)` of the requested duration |
| `frames` | Within 3 frames of the plan (warn, not fail) |
| `audio` | No audio stream (warn if present; the MVP does not add audio) |

Any `fail` throws `OUTPUT_VALIDATION_FAILED`, removes the produced MP4 and records the failed checks in the technical detail. Warnings are surfaced but do not invalidate a file.

Validation is followed by five 320×180 grey-pixel samples at 8 %, 28 %, 50 %, 72 % and 92 % of the final duration. If every sample is nearly uniform, `BLANK_FRAMES` warns; if all hashes match, `STATIC_FRAMES` warns. These are warnings because a deliberately black or still video is legitimate.

Finally, five JPEG posters are extracted from the **encoded** file at 10/30/50/70/90 %, written at 320 px wide. The result screen shows these stills, not the source frames, so the user inspects what was actually delivered.

## Diagnostics

Diagnostics are structured records (`code`, `severity`, `message`, optional `detail`/`url`) collected from:

- page inspection: remote hosts, broken images, missing resources, font status, media elements, script errors, protocol duration/window;
- network gateway: blocked remote resources, private-network requests, permissions, downloads, failed fonts;
- capture host: load failures, renderer crashes, unresponsive pages, blocked navigation/windows/webviews, console errors, low capture rate;
- output analysis: blank/still samples;
- pipeline: protocol notes and environment warnings.

They are deduplicated by `code|url|message` when combined. Settings and other technical detail stay in the log; the interface shows the human sentence and keeps the technical tail available in diagnostics.

## Failure and cancellation

- Every await point checks the `CancellationToken`.
- FFmpeg is killed through an `AbortSignal`; `runBinary` also has a timeout for probes/samples.
- A cancelled or failed render removes a partially written output file if one was created.
- Temporary frames are removed in `finally` unless the user chose to keep them.
- The capture session is always closed and its debugger detached.
- `RenderService` records cancelled and failed jobs in history with a serialised error code, so the history is truthful about attempts, not only successes.

Cancellation is tested end-to-end: during an 8-second capture, the test cancels after 700 ms, waits for the Portuguese cancellation notice, asserts that no MP4 exists and that the original example is byte-identical.

## Performance characteristics

Measured on the target development machine (Windows 10, Intel i5-6200U, 8 GB RAM, 1366×768 display):

- 3 s 1080p example: exported and validated (9/9 checks). At 1080p the native compositor reaches ≈26.5 fps, so 60 fps output would need visible duplication — 720p is the default for that reason and 1080p stays one click away.
- Full 36.5 s 1280×720 acceptance page at 60 fps: 2,190 frames, 2.29 MB output at CRF 17 (High), all nine checks green, no `CAPTURE_RATE_LOW` (capture sustained ≥54 fps). `mpdecimate` counts 1,098 distinct moments versus 361 in the previous 30 fps export.
- Packaged 1.5 s 720p smoke clip: 90 frames at 60 fps, 33 KB, 9/9 checks.

These are observations, not guarantees. Rendering is real time by design; a 36-second animation always takes at least 36 seconds to capture, plus encoding. The in-app capture rate of the bundled example varies with system load (28–49 fps observed); when it falls below 90 % of the requested rate the UI reports `CAPTURE_RATE_LOW` and the duplicate count honestly.
