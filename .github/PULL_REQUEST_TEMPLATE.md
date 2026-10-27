## What changed

Describe the problem this solves and the user-visible effect.

## How it was verified

List the commands you ran and their results, for example:

```bash
npm run lint
npm run typecheck
npm run test:unit
npx vitest run --project ui
npm run test:integration
npm run test:e2e
```

If a suite could not run in your environment, say so explicitly instead of
omitting it silently.

## Checklist

- [ ] `npm run lint` and `npm run typecheck` pass with no errors
- [ ] Tests cover the change (a bug fix includes a test that fails before the fix)
- [ ] No generated output is committed (`out/`, `release/`, `.test-out/`, MP4s)
- [ ] Documentation and ADRs updated where behaviour, limits or decisions changed
- [ ] Architectural rules in CONTRIBUTING.md are respected (engine stays Electron-free, renderer never sees a path, IPC input validated)

## Known limitations

What is not covered, or what remains true after this change?
