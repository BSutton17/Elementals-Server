# test — Automated Tests

Integration/regression tests for the server, run with Node's built-in test
runner via `tsx` (no extra test framework):

```
npm test              # run all *.test.ts
npm run typecheck:test # type-check src + test together
```

## Layout
- `*.test.ts` — test suites (auto-discovered by the runner)
- `fixtures/` — small programs run in isolated child processes to exercise
  environment-dependent behavior (config loading, error handling)
- `helpers/` — shared spawn/connect utilities (`run.ts`, `server.ts`)

## Coverage
- `startup.test.ts` — server boots + real client connect/disconnect (comms)
- `config.test.ts` — environment-aware configuration loading (dev/prod)
- `constants.test.ts` — shared game constants
- `errorHandling.test.ts` — global error safety net keeps the process alive

Env-dependent modules are tested in child processes because config resolves
environment variables once at import time.
