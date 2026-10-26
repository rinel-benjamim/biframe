# The optional Biframe page protocol

Biframe does not require any change to the page. A plain HTML animation with a manual duration and real-time capture works as-is. The protocol is an **optional** way for a page to declare how long it runs and when it is finished, so exports do not depend on the user guessing a duration.

The protocol is read-only from the page's perspective: Biframe never injects `window.biframe` into the imported file, never rewrites the HTML, and never requires the page to expose it. Pages without it are first-class citizens.

## Declaring a duration

```html
<script>
  window.biframe = {
    duration: 36.5
  };
</script>
```

When **Duração: Automática** is selected, the engine uses `36.5` seconds, clamped to the configured maximum (600 s by default). The page is still captured in real time; the declaration tells the engine when to stop, not how fast to render.

The value must be a finite number greater than zero. Anything else is ignored and treated as absent, with a diagnostic when the descriptor is present but unusable.

## Signalling completion

```html
<script>
  window.biframe = { duration: 36.5 };
  window.addEventListener('animationend', () => {
    window.dispatchEvent(new CustomEvent('biframe:complete'));
  });
</script>
```

- The event name is exactly `biframe:complete`.
- It is observed before the page's own scripts run, so it cannot be missed by listener ordering.
- In automatic mode **without** a declared duration, the engine waits for this event, up to the configured maximum. The actual capture duration is measured from the first animation activity to the event.
- If the event never arrives within the ceiling, the render fails with `RENDER_TIMEOUT`. The interface recommends a manual duration. No partial file is left behind.
- If both a declared duration and the event exist, the declared duration wins; the event is not needed.

A completion dispatch after the declared duration has no effect.

## `ready` (accepted, not a gate)

```js
window.biframe = { ready: true, duration: 12 };
```

`ready` is parsed and reported for compatibility. Version 0.1 starts capture from the first observable animation activity after the page reloads; it does **not** wait for `ready` to become true. Do not rely on `ready` to delay the start. For pages with asynchronous setup, complete that setup before the first `requestAnimationFrame`/timer that starts the animation, or use the initial page load to prepare assets.

## Reserved: deterministic capture

The following fields are **reserved and not used** by version 0.1:

```js
window.biframe = {
  deterministic: true,
  onStart(callback) { /* would be called when capture begins */ },
  onSeek(seconds) { /* would render an exact instant */ }
};
```

If a page declares `deterministic: true`, Biframe records a diagnostic explaining that this version captured it in real time and did not call `onSeek`. This is deliberate: the field exists so a future deterministic engine has a stable contract, not to imply support today.

A deterministic engine would seek the page to each target timestamp and capture a frame without depending on wall-clock speed. That would make 60 fps reliable on slow machines and eliminate duplicate frames. It requires page cooperation; it is not part of 0.1.

## Reserved: capture window

```js
window.biframeCapture = { start: 12.5, end: 36.5 };
```

The pair is read and reported, but the current engine captures from `0` to the selected duration. It does **not** crop to this window; a diagnostic says so. Use the protocol only if you are comfortable with that limitation, or trim the output in another tool.

## Practical example

This is the pattern used by the bundled example:

```html
<!doctype html>
<html lang="pt">
  <head>
    <meta charset="utf-8" />
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: #0b0b0c; color: #f4f4f0;
             font-family: system-ui, sans-serif; overflow: hidden; }
      .scene { position: absolute; inset: 0; display: grid; place-content: center;
               text-align: center; opacity: 0; }
      .scene[data-active="true"] { opacity: 1; }
    </style>
  </head>
  <body>
    <main id="stage">
      <section class="scene" data-active="true"><h1>Uma página.</h1></section>
      <section class="scene"><h1>Um vídeo.</h1></section>
    </main>
    <script>
      window.biframe = { duration: 6 };
      const scenes = [...document.querySelectorAll('.scene')];
      let index = 0;
      const show = () => {
        scenes.forEach((scene, i) => scene.dataset.active = String(i === index));
      };
      const timer = setInterval(() => {
        index += 1;
        if (index >= scenes.length) {
          clearInterval(timer);
          window.dispatchEvent(new CustomEvent('biframe:complete'));
          return;
        }
        show();
      }, 3000);
    </script>
  </body>
</html>
```

With `duration: 6`, the export uses six seconds even though the completion event is also dispatched. Remove `duration` and keep the event to exercise automatic completion, or remove both and use a manual duration.

## Semantics and edge cases

| Situation | Behaviour |
| --- | --- |
| No `window.biframe`, manual duration | Works normally. No protocol diagnostic. |
| `duration` only, automatic | Capture stops at the declared duration. |
| Event only, automatic | Capture stops when the event is observed; `RENDER_TIMEOUT` after 600 s otherwise. |
| Duration and event | Duration wins. |
| Invalid duration (`0`, negative, `NaN`, string) | Treated as absent; diagnostic when the descriptor exists. |
| Page throws while reading the protocol | The error is contained; the protocol is treated as absent. |
| Page dispatches the event before capture starts | The probe records it; automatic completion sees it immediately. |
| Page reloads itself | Not supported during capture. The navigation resets the frame queue; later frames are not consumed. Keep the animation in one document. |
| Page freezes | Polling and capture stop at their bounds; `PAGE_UNRESPONSIVE`/`RENDER_TIMEOUT` diagnostics explain the outcome. |

## Security

The protocol is data, not a privileged API. Biframe reads `window.biframe` and `window.biframeCapture` inside the sandboxed page. It never passes a function across the bridge, never calls page functions in 0.1, and never grants the page access to Node.js, the filesystem or the network beyond the normal page policy. A hostile getter or a malformed object is caught and ignored.

The instrumentation is injected with `Page.addScriptToEvaluateOnNewDocument` and is observation-only. It wraps `requestAnimationFrame` and `setTimeout` to record the first call, adds listeners for errors and the completion event, and stores a plain probe object. It does not alter timing or content. If a page freezes the prototypes, observation degrades to a navigation-time approximation with a diagnostic.

## Testing the protocol

`tests/unit/protocol-errors.test.ts` covers descriptor parsing, invalid values and error serialisation. `tests/integration/pipeline.test.ts` exercises automatic duration end-to-end with real Chromium and real FFmpeg.

The bundled `resources/example/exemplo-biframe.html` declares `duration: 8`, `ready: true` and `deterministic: true`, and dispatches `biframe:complete` after eight seconds. It intentionally demonstrates both the useful part of the protocol and the current deterministic fallback: when opened with automatic duration it uses eight seconds; the preview/export also receives the diagnostic that `onSeek` was not used. The default export panel uses a manual duration, so the example still works if the protocol is removed.
