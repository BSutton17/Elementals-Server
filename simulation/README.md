# Kingdoms — Simulation Framework

> Internal developer tool for balancing Kingdoms. **Not part of the live game**
> and never deployed: it is gitignored inside the Server package and excluded
> from the production build (`tsconfig.json` includes only `src/`).

The framework runs complete **headless matches** through the **production
gameplay engine**, drives players with configurable AI controllers, and runs
under **candidate balance configurations** — the foundation for large-scale
analytics and automated balance optimization.

---

## 1. The one rule

**Gameplay logic exists exactly once.**

The simulation never re-implements combat, economy, statuses, cooldowns,
targeting, abilities, or victory. A simulated match *is* a live match minus the
transport:

| Live match | Simulated match |
|---|---|
| `new Match(roomCode)` + `createMatchConfig` | same |
| `tickMatch(match, tick)` driven by `GameLoop` (setInterval) | same `tickMatch`, driven by a tight `for` loop |
| Humans emit intents over Socket.IO → handlers call engine functions | AI controllers call the **same engine functions** directly |
| `Math.random` | seeded RNG streams injected through the engine's existing `rng` options |

If the engine changes, simulations inherit the change with zero framework
edits. The test `headless execution matches the live fixed-timestep loop
exactly` (test/simulation.test.ts) locks this equivalence in: the same seeded
match driven by the production `GameLoop` and by the simulation loop must land
on identical state, tick for tick.

## 2. Package layout

```
Server/simulation/
├── README.md            ← this document
└── src/
    ├── index.ts         ← public API (the only import surface consumers use)
    ├── types.ts         ← SimulationConfig, MatchRecord, observer/AI contracts
    ├── rng.ts           ← mulberry32 seeded RNG + seed derivation
    ├── headless.ts      ← match construction + single-match execution pipeline
    ├── ai.ts            ← BaselineAI: metadata-driven controller (no kingdom knowledge)
    └── runner.ts        ← runSimulation: N matches, lifecycle, observers
```

Engine access is by direct relative import (`../../src/engine/...`), the same
pattern the Server's own tests use. Tests live in `Server/test/simulation.test.ts`
and `Server/test/parameters.test.ts`, so `npm test` covers the framework.

## 3. Simulation lifecycle

```
runSimulation(config)
 ├─ normalize master seed (strings hash to 32-bit ints)
 ├─ activate config.parameters (scoped; see §6) ── never mutates production data
 └─ for each match index i:
     ├─ matchSeed = deriveSeed(baseSeed, i)      ── match #i replays standalone
     ├─ createHeadlessMatch(players)             ── real Match, real MatchConfig
     ├─ one AIController + RNG stream per seat   ── deriveSeed(matchSeed, seat)
     ├─ loop t = 1..maxTicks:
     │    ├─ each living controller .act()       ── the "drain intents" phase
     │    ├─ tickMatch(match, t)                 ── the production tick phases
     │    └─ observers.onTick
     ├─ record winner / timeout / final player states → MatchRecord
     └─ observers.onMatchStart / onMatchEnd / onComplete
```

**Determinism (ticket #203):** identical seeds ⇒ identical runs, byte for
byte — engine-generated ids included. Every `Match` carries a match-level RNG
(`match.rng`, defaulting to `Math.random` for live games); the simulation
seeds it with stream 0 of the match seed, and EVERY gameplay dice roll —
crits, proc chances, redirects, deflections, status ticks — draws from it.
Engine-generated ids use `match.nextSeq()` (a per-match counter) instead of
`Math.random`/`Date.now`. Per-match seeds are derived from the master seed
*by index*, so match #7 is the same match whether the run has 8 matches or
800,000 — which also makes sharding across worker processes trivial later
(split the index range; results are unchanged).

**Safety:** `maxTicks` (default 24 000 = 20 game-minutes) caps every match;
stalemates record `timedOut: true` instead of hanging a million-match run.

## 4. AI decision framework & personalities (tickets #205–#206)

`AIController.act(ctx)` is called once per tick with the live `Match`, the
player's authoritative `PlayerState`, and the seat's RNG stream. Controllers
act by calling the exact engine functions the socket handlers call
(`activateAbility`, `buyCitizen`, `repairCastle`, `buyShield`, `selectTarget`,
`unlockOrUpgradeAbility`) — the engine validates everything, so a controller
cannot cheat any more than a human can.

**One decision engine, many personalities.** `PersonalityAI`
(`personality.ts`) is the single generic controller; a *personality* is a
`PersonalityProfile` — pure data: targeting strategy, spending priority,
budget thresholds, ultimate-timing windows, and a seeded `chaos` factor.
Adding a playstyle means adding a profile; the engine and simulator never
change. The engine is fully **kingdom-agnostic**: it enumerates its kit from
`KINGDOM_ABILITIES` data and judges abilities purely by metadata (kind, cost,
targeting mode, charge system, upgrade tiers).

Key framework concepts:
- **`spendPriority`** — the order categories claim gold (defense / economy /
  abilities / cast). The abilities category *reserves* the factor-scaled price
  of its next unlock/upgrade against lower-priority spending, so casting can
  never permanently starve kit progression ("saves for upgrades" vs "dumps
  everything into attacks" is pure data).
- **Ultimate timing** — judged from targeting metadata: enemy-targeted
  ultimates wait for the target's HP window, self-targeted ones for the
  caster's own.
- **Targeting strategies** — lowestHp / strongest / richest / highestIncome /
  random, all computed from live state.
- **Per-seat assignment** — `PlayerSpec.ai` lets one match pit personalities
  against each other; `SimulationConfig.createAI` sets the run default
  (balanced when omitted).

Shipped profiles (`personalities.ts`, also in the `PERSONALITIES` registry):
**aggressive** (casts first, hunts the weakest, barely defends), **defensive**
(early shields, eager repairs, deep reserve), **economic** (citizens before
swords, strangles rich rivals), **opportunistic** (holds ultimates for the
kill window), **balanced** (the baseline), and **random** (seeded chaos —
reproducible dice-goblin).

## 5. Extension points & gameplay events

`SimulationObserver` hooks (`onMatchStart` / `onTick` / `onEvent` /
`onMatchEnd` / `onComplete`) are where later tickets plug in without touching
the pipeline:

- **Event recording** — capture gameplay events for analytics and replays.
- **Balance analytics** — win rates per kingdom, match length distributions,
  gold curves, ability usage.
- **Optimization** — evaluate candidate parameter sets and search the space.
- **Reporting** — human-readable balance reports.

Observers are read-only by contract: they must never mutate gameplay state.

**Gameplay events (ticket #204):** the engine publishes every significant
occurrence on the match's `EventBus` (`src/engine/events.ts`): ability casts,
damage (with shield/HP breakdown and crit flags), heals, status
apply/tick/expiry, shield gain/destruction, purchases and citizen changes,
resource transfers, eliminations, cooldown/charge readiness, and match end.
`SimulationObserver.onEvent` receives the full stream; the live `evt:*`
network layer, replays, and animations will consume the same bus, so no
consumer ever re-derives gameplay facts. Emission is guarded on
`bus.enabled` — a match nobody observes allocates nothing — and listener
exceptions are swallowed so events can never affect gameplay.

## 6. Balance parameters (ticket #202)

Every tunable gameplay value reads through the **parameter registry**
(`src/engine/parameters.ts`):

- `param(id, base)` — the single read gate. With **no active set** (the live
  game) it returns `base` untouched: production behavior is bit-for-bit
  identical and the cost is one null check.
- `withParameterSet(set, fn)` / `setActiveParameterSet(set)` — activate a
  candidate configuration. `SimulationConfig.parameters` does this scoped
  around a run.
- `listParameters()` (`src/engine/parameterCatalog.ts`) — enumerates the whole
  tunable space `{ id, base }` by walking the same data registries the engine
  executes: global balance, every ability (damage, cooldowns, costs, healing,
  durations, chances, charges, unlock and upgrade prices), and every kingdom
  passive. New content appears in the catalog automatically.

Parameter ids are opaque dot-paths (`ability.fireball.effects.0.amount`,
`castle.repairCost`, `passive.water.0.amount`), so an optimizer can search the
space **without knowing any kingdom or ability by name** — and it emits
candidate `ParameterSet`s for human review; it never writes production data.

v1 scope note: upgrade-tier *deltas* (a tier's `effectParams` changes) are not
individually parameterized; base values are, and tiers layer on top. Tier
purchase costs are parameterized.

## 6.5 Analytics (ticket #207)

`AnalyticsCollector` (`analytics.ts`) is a SimulationObserver that derives
every statistic from the gameplay-event stream plus final MatchRecords — it
never re-implements gameplay math. Attach one instance to any number of runs
and it **aggregates automatically across the whole batch (and across
batches)**; `snapshot()` returns the `BatchAnalytics` so far.

Per-kingdom aggregates: win rate, average placement (winner = 1, then death
order), eliminations, damage dealt/taken, critical hits, healing received,
shields gained/lost, gold spent on casts vs purchases, citizens
bought/final, per-ability usage (`usageByKind` slices by metadata),
multi-charge combo casts, unlocks/upgrades purchased, per-status uptime in
ticks, and target-selection behavior (switch counts + who gets targeted, via
the `targetChanged` event added to the engine bus). Batch-level: match count,
timeouts, and the duration distribution.

## 6.6 Balance optimizer (tickets #208–#209)

`optimize()` (`optimizer.ts`): **generate** a candidate, **execute** a
simulation batch under it via the registry, **evaluate** with the configured
`OptimizationObjective` (lower is better), **preserve** improvements,
**repeat**. Two objectives ship: `balanceObjective` (kingdom win-rate parity
+ duration band + timeout penalty — the canonical goal) and
`matchDurationObjective`.

Three interchangeable algorithms (`algorithm:` config):
- **hillClimb** — (1+1) greedy; accepts only improvements.
- **annealing** — simulated annealing; early regressions may be accepted
  (temperature-scaled) to escape local optima; the best-seen candidate is
  always preserved.
- **genetic** — elitist population with uniform crossover + mutation;
  `iterations` are generations.

Constraints (#209) hold for EVERY evaluated candidate — mutated, crossed-over,
or user-supplied baselines are all clamped by one shared core:
- per-parameter `min` / `max` hard limits (defaults: base × 0.25 … base × 4,
  ordered by value so negative bases behave);
- `locked: true` — never touched;
- `priority` — mutation-selection weight (0 removes the parameter).

Design properties:
- **Common random numbers**: every candidate is evaluated on the same derived
  batch seed, so score differences come from parameters, not luck.
- **Deterministic per seed**, mutation stream included.
- **Kingdom-blind & scalable**: the search space defaults to the full catalog
  (hundreds of parameters); narrowing `parameterIds` to the levers under
  review converges dramatically faster.
- **Never writes production data**: the result is a candidate `ParameterSet`
  (+ per-iteration history + the best batch's analytics) for human review.

## 6.7 Dashboard, reports & CLI (ticket #210)

`report.ts` turns analytics + optimization output into designer-facing
reports: kingdom win rates, the matchup matrix (`runMatchupMatrix`
round-robin), ability & upgrade usage, economy tables, optimization progress,
and **recommended balance changes that state exactly where to apply them** —
`sourceLocator.ts` maps every parameter id to the file + line of its
production value by scanning the live `src/data/` sources at report time (so
locations never drift from the engine). Exports: text, self-contained HTML,
JSON, and CSV. `saveRun`/`listRuns` persist every run under
`simulation/runs/` for history.

The CLI (`cli.ts`, `npm run sim -- <command>`) is the launcher:

```
npm run sim -- simulate  --kingdoms fire,water,earth --matches 50 --seed nightly
npm run sim -- matrix    --matches-per-pair 10
npm run sim -- optimize  --algorithm genetic --iterations 30 --matches 10 \
                         --params castle.repairCost,shield.cost --objective balance
npm run sim -- params    --filter fireball
npm run sim -- history
```

`optimize` prints live per-iteration progress and saves `candidate.json`
alongside the report — the reviewable configuration that a human applies by
editing the listed file:line locations.

## 6.8 Balance evaluation system (Step 4)

`simulation/src/evaluation/` is the **measuring instrument** the Balance AI will
sit on top of. It answers one question — *given this engine and this balance
configuration, how balanced is the game?* — and deliberately stops there. It
reports; it never judges, and it never writes production data.

### The one rule

**A reading is taken over a POPULATION of strategies, never a single
personality.** A deterministic policy replays essentially the same match on
every seed (measured duration spread 1.6–2.3%), so one profile's "win rate" is
not a probability but a boolean — 40/40 or 0/40 — and it flips wholesale when
the profile changes. Aggregated over all 36 **ordered** pairings of the six
profiles, the same measurement is stable to within **4.6 percentage points**
across disjoint seed pools. That aggregate is the balance signal.

Pairings are ordered, not combinations: A-vs-B is not B-vs-A, because the two
controllers decide differently and seat index drives intent order and RNG
streams. Mirrors are kept as a diagnostic for controller-induced asymmetry.

### Layout

```
evaluation/
├── index.ts        ← public surface
├── evaluator.ts    ← evaluate(): duels, 4-FFA, 7-FFA
├── population.ts   ← StrategyPopulation, ordered pairings (versioned)
├── seeds.ts        ← training / validation / final pools, provably disjoint
├── samplers.ts     ← FFA composition sampling (exhaustive, coverage-balanced)
├── provenance.ts   ← engine SHA, balance hashes, comparability
├── stats.ts        ← Wilson intervals, placement distributions, spread
├── compare.ts      ← baseline vs candidate deltas
└── report.ts       ← JSON (for the optimizer) + text (for a designer)
```

### Properties that make a reading trustworthy

- **Reproducible.** Same engine, balance, population, pool and counts ⇒ byte-identical
  reading (timestamp and wall-clock duration aside). Locked by test.
- **Disjoint seed pools.** Training, validation and final occupy separate regions of
  the seed space *by construction*, so a search can never be judged on the dice it
  trained against.
- **Honest sample sizes.** Every rate carries its counts and a 95% Wilson interval, so
  45% from 100 matches is distinguishable from 45% from 10,000. Wilson rather than the
  normal approximation because 0-win matchups are exactly what needs describing.
- **Provenance.** Every reading records the engine SHA, whether the tree was dirty, and
  a hash of the whole tunable space. Comparing readings from different engines is
  **refused**, not silently averaged — a balance result is only valid for the engine
  that produced it.
- **Coverage-balanced FFA sampling.** Kingdom appearances stay within one of each other,
  so no kingdom's FFA numbers are quietly noise.

Profile disagreement and mirror skew are recorded as **diagnostics**. A wide
spread means a matchup is strategy-sensitive, which is information about the
game rather than necessarily a defect — so nothing optimises against it.

### Usage

```
npm run sim -- evaluate                        # full baseline, validation pool
npm run sim -- evaluate --quick                # 6 matchups, tiny FFA sample
npm run sim -- evaluate --seeds 3 --ffa4 32    # deeper reading
npm run sim -- evaluate --candidate cand.json --baseline runs/<dir>/evaluation.json
```

Each run writes `evaluation.json` (the optimizer's input — never scrape console
output) and `report.txt` under `simulation/runs/`.

## 7. Performance notes

One match is pure synchronous computation — no timers, no I/O, no rendering.
Current throughput is roughly 15–20 full matches/second single-threaded
(baseline AI, duels). The scaling path to millions of matches is horizontal:
seed-by-index derivation means worker processes can shard the match range with
no coordination, an intentional property of the seeding scheme. Do not add
per-tick allocations to the hot path without measuring.

## 8. Usage

```ts
import { runSimulation, listParameters } from "../simulation/src/index.js";

const result = runSimulation({
  matches: 1000,
  seed: "nightly-balance-check",
  players: [
    { kingdomId: "fire" },
    { kingdomId: "water" },
    { kingdomId: "ice" },
  ],
  // Optional: a candidate balance configuration under review.
  parameters: { "castle.repairCost": 800 },
});

for (const record of result.records) {
  console.log(record.winnerKingdom, record.endedAtTick);
}
```
