# ai — Bots

The bot subsystem. A bot occupies a normal seat and plays through the **same
intent path a human does** — it has no privileged access to the match, and
`visibility.ts` is what enforces that: a bot only ever sees what a player in
that seat could see.

Behaviour comes from a **trained neural network**, not from hand-written rules.
The network is trained out-of-repo (see *Training*, below) and shipped as JSON.

## Layout

| File | Responsibility |
|------|----------------|
| `observation.ts` | Encodes the world into the input vector (**by index**) |
| `actions.ts` | Decodes the output vector into an intent |
| `legality.ts` | Which actions are *possible* this tick — the action mask |
| `knowledge.ts` | What this seat is allowed to know (`SelfKnowledge`, field, threats) |
| `visibility.ts` | The fog rules knowledge is built through |
| `network.ts` / `phenotype.ts` | Compiling a genome into an executable network |
| `model.ts` / `modelStore.ts` | The on-disk model format, loading, and caching |
| `controller.ts` | One seat's decision for one tick |
| `botRunner.ts` | Drives every bot seat in a match |
| `difficulty.ts` | easy / medium / hard as *configuration*, not three implementations |
| `decode.ts`, `runtime.ts`, `versions.ts`, `index.ts` | Glue and compatibility |

## Three rules that will cost you a day each

**1. The observation vector is addressed by index.** `OBSERVATION_SIZE` is
**87**, `ACTION_SIZE` is **28**, and every model on disk was trained against
those exact offsets (`SELF_BASE`, `FIELD_BASE`, `KIT_BASE`, `KINGDOM_BASE`, …).
Inserting an input in the middle does not "add a feature" — it silently
re-points every later one, and every trained model becomes garbage while still
loading and running perfectly. **Append at the end, bump the version, retrain.**

**2. Legality is masked, not encoded.** What a bot *can* do this tick lives in
`legality.ts` and never enters the observation vector. Illegal actions are
struck from the output before the argmax — the network is not taught to avoid
them by punishment. So a new restriction belongs in the mask, and adding it
costs nothing in retraining.

**3. Anything that skips the dead also skips ghosts.** A ghost is still
`eliminated: true` (with a `ghostUntilTick`), which is what keeps `resolveWinner`
correct and grants untargetability for free — but it means every `if
(eliminated) continue` gate silences a risen player as a side effect. Three
gates in this tree had to learn the difference: `botRunner.tick`,
`controller.act`, and `legality.ts`. Check for a fourth before adding one.

## Models

`modelStore.ts` looks for `<difficulty>.json` in, first match winning:

1. `$ELEMENTALS_AI_MODEL_DIR`
2. `<repo>/models/` ← where `easy.json`, `medium.json`, `hard.json` live
3. one directory above that

A compiled network is **read-only at run time** — `activate` writes only into
the caller's output buffer — so a single instance is shared by every bot seat in
every concurrent match. Don't "helpfully" clone one per seat; a busy server
holds dozens of bots and recompiling ~500 connections each is pure waste.

If bots are behaving like they have no brain, ask the store rather than
guessing: `modelsAvailable()` reports whether the files were found, and
`describeModel(difficulty)` says which file a difficulty actually loaded.

## Training

⚠️ **THIS CODE EXISTS TWICE AND NOTHING SYNCS IT BACK.** Training runs in the
exported standalone repo (`../Simulation`), which carries a **vendored copy** of
this folder. `exportRepo.mjs` copies *outward* only — a fix made in the training
repo will never appear here, and a fix made here will be overwritten there on
the next export. **Any change to the encoding, the mask, or the network must be
made by hand in both places.**

```bash
# From the Server repo — refresh the training repo from this engine
node simulation/tools/exportRepo.mjs --out ../../Simulation

# From the exported repo (Coding Projects/Simulation)
npm run neat:xor        # sanity check: the trainer can learn XOR at all
npm run neat:baseline   # score the scripted baselines to beat
npm run neat:train      # the real run
npm run neat:diagnose   # why a run stalled
```

Drop a finished model into `Server/models/<difficulty>.json` and restart; there
is no hot-reload (call `clearModelCache()` if you need one in a test).

Balance search is a different tool with a different goal — see
[../../simulation/README.md](../../simulation/README.md).
