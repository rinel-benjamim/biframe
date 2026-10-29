# ADR 0005 — Interface language: Portuguese default, English selectable

- **Status:** Accepted
- **Date:** 2026-10-28
- **Related:** [ADR 0002](0002-untrusted-content-boundary.md)

## Context

Biframe was born in Portuguese: every sentence the engine produced (progress, diagnostics, validation labels) and every word in the interface was pt-PT. The project is now public on GitHub with an international audience, and two different language pressures appeared at once:

- the repository itself (code, commits, docs, issue templates) must be English to be contribution-ready;
- the product must stay Portuguese by default — it is the author's language and the origin of the project — while English-speaking users need a usable interface.

The hard part is not the interface copy. Sentences are produced deep inside the engine and the Electron main process (a diagnostic raised by the capture host, a validation label built by `ffprobe` analysis, a progress line during encoding) and cross IPC as plain strings. Whichever language they are baked in when produced is the language the user reads, even if the interface itself is fully translated.

## Options considered

1. **Translate only the interface.** Engine/main strings stay Portuguese forever.
   - Pros: trivial.
   - Cons: an English user sees an English shell around Portuguese diagnostics and progress. Rejected as half a solution.

2. **Persist a language per serialized payload.** Every string crossing IPC is replaced by `{ key, params }` and the renderer translates at render time.
   - Pros: single source of truth at the edge; a language switch could retroactively translate even past events.
   - Cons: a protocol refactor of every message shape (diagnostics, progress, validation reports, history), with serialization, tests and compatibility cost — for a two-language product where history is short-lived. Rejected as disproportionate.

3. **Translate at production time.** One shared catalog; every process that produces a sentence receives the configured language and builds the sentence in it. The interface additionally re-translates errors by their stable `code`. **Chosen.**

## Decision

- A single shared catalog module `src/shared/i18n/` holds every user-facing sentence:
  - `pt.ts` is the source of truth and defines the key union (`satisfies Record<string, string>`);
  - `en.ts` is typed `Record<keyof typeof pt, string>`, so a missing translation is a **compile error**, not a silent fallback;
  - `index.ts` exports `createTranslator(language)`, `LANGUAGES`, `DEFAULT_LANGUAGE = 'pt'`, `localeFor` and the `Translator` type. Placeholders use `{name}`; an unsupplied placeholder stays visible instead of rendering blank.
- `AppSettings.language: 'pt' | 'en'` (default `'pt'`) is persisted with the other settings. Definições has an "Idioma" selector that applies immediately: services read `settings.get().language` **per operation** through a `getLanguage` callback, so the next render, import or preview already speaks the new language.
- The engine and the main process thread a `Language`/`Translator` into every function that produces copy (`runRenderPipeline`, `consoleDiagnosticInput`, `inspectionDiagnostics`, `validateOutput`, `PreviewService`, `ContentGateway`, `ProjectService`, `ElectronCaptureHost`, IPC dialogs and shortcut list). The wire format is unchanged.
- `EntryVerdict.reason` in the archive guard changed from Portuguese phrases to stable codes (`invalid-path`, `symlink`, `entry-too-large`, `total-limit`); the user-facing wording comes from `archiveReasonMessage(reason, t)`. Comparing sentences in code was a latent bug in any world with more than one language.
- `ERROR_DEFINITIONS` is derived from the catalog via the default translator and keeps only the `recoverable` flag; the interface re-renders any `SerializedError` through `localizedErrorTitle`/`localizedErrorMessage` keyed by `error.code`, so even an error raised deep inside the engine reaches the user in their current language.
- `formatSeconds`, `formatNumber`, `formatDateTime` and `formatRelative` take the language as their last, optional parameter (default Portuguese), switching both the `Intl` locale and the wording.
- Presets expose `localizedAspectRatios`, `localizedResolutionPresets` and `localizedQualityPresets(language)`; the base arrays keep default-language labels for logs and tests.

## Consequences

Positive:

- One source of truth for every user-facing word; adding a language is one catalog file plus a `LANGUAGES` entry, and forgetting a translation breaks the build.
- The engine stays free of Electron and React: the catalog lives in `@shared`, which the engine may import.
- Stable codes (`error.code`, archive reasons) make the interface robust against wording changes, and the tests assert codes instead of sentences.
- Portuguese remains the default; the repository speaks English.

Costs:

- Every new user-facing sentence must be added to two files instead of being inlined; the compile error is the reminder.
- Sentences produced before a language switch (already-collected diagnostics, history entries) keep the language they were produced in. This is accepted: diagnostics are per-session, and re-translating stored history was judged not worth a payload refactor.
- `{name}` interpolation is deliberately minimal (no plurals, no gender); Portuguese and English tolerate it, and a more inflected language would need a real ICU step later.

## Verification

- `tests/unit/i18n.test.ts` asserts identical key sets, identical placeholders, no empty message, full error-code coverage and the interpolation behaviour.
- `tests/unit/format.test.ts` covers the English decimal separator and relative-time wording.
- `tests/unit/archive-guard.test.ts` asserts the stable reason codes and `archiveReasonMessage` in both languages.
- The UI switch is covered in `tests/ui/components.test.tsx` (language change re-renders the interface in English).
