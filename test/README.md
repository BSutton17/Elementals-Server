# test — Automated Tests

Integration/regression tests for the server, run with Node's built-in test
runner via `tsx` (no extra test framework):

```
npm test              # run all *.test.ts
npm run typecheck:test # type-check src + test together
```

> ⚠️ **Always `npm test`. Never a bare `npx tsx --test`.** The npm script is the
> only thing that passes `--env-file=.env.test`; run the runner directly and the
> suite inherits your `.env` and writes to the **live** database. This has
> happened. If you need to run one file, keep the script:
>
> ```
> npm test -- --test-name-pattern "besieged"
> ```

## Layout
- `*.test.ts` — test suites (auto-discovered by the runner)
- `fixtures/` — small programs run in isolated child processes to exercise
  environment-dependent behavior (config loading, error handling)
- `helpers/` — shared spawn/connect utilities (`run.ts`, `server.ts`)

## Coverage

Roughly 100 suites covering the engine, match lifecycle, networking, data
integrity, and every kingdom's kit. A few landmarks rather than a full listing
(the runner auto-discovers, so this list would only rot):

- `startup.test.ts`, `config.test.ts`, `errorHandling.test.ts` — process, config,
  and the global error safety net
- `besieged.test.ts` — the anti-bullying comeback curve, including the property
  that it is **exponential rather than linear** (see ARCHITECTURE.md §0)
- Per-kingdom suites — each kit's abilities, statuses, passives, and combos

Env-dependent modules are tested in child processes because config resolves
environment variables once at import time.

## Conventions worth keeping

**Derive expectations from the constants, don't write the numbers in.** A test
that hardcodes `441` breaks every time an ability is rebalanced, which teaches
people to edit tests until they pass. Read the value from `data/balance.ts` or
the ability definition, and assert the *relationship* the mechanic is supposed to
have. `besieged.test.ts` is the reference for this — it asserts the curve rises
and accelerates, not that it equals any particular list of numbers.

**Test the design rule, not just the arithmetic.** "Being ganged up on pays more"
is satisfied by a linear ramp that the design specifically rejects; the test that
matters asserts each additional attacker is worth more than the last.

## Three ways this suite lies to you

**A test that passes alone and fails in the full run is almost always unseeded
randomness.** Every gameplay roll goes through `match.rng`, but a *fixture* that
reaches for `Math.random` gets a different draw depending on what ran before it.
Seed the match (`new Match("CODE", { rng })`) rather than re-running until it
goes green.

**A suite that has "gone flaky" is often a pile of leaked runner processes.** An
interrupted `npm test` can leave `node` processes holding ports and memory;
enough of them and files start timing out or failing to be collected at all.
Sweep them before believing the failure:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

**Check the file count, not just the pass count.** "All green" over 68 of 74
files is not all green — a file that fails to load is not a file that passed.

## Writing tests against the ghost rules

A ghost keeps `eliminated: true` plus a `ghostUntilTick`. That is deliberate —
it keeps `resolveWinner` correct and grants untargetability for free — but it
means **every "skip the dead" check skips ghosts too**. Assert the thing that
actually distinguishes them: a ghost that acted has *spent gold*, not merely
"changed gold" (income from loaned citizens satisfies that) and not "has a
target" (a stale target survives the bug).
