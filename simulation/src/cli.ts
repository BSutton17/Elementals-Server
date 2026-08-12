import { KINGDOM_IDS, type KingdomId } from "../../src/data/kingdoms.js";
import { TICK } from "../../src/data/balance.js";
import { listParameters } from "../../src/engine/parameterCatalog.js";
import { AnalyticsCollector } from "./analytics.js";
import { runSimulation } from "./runner.js";
import {
  optimize,
  balanceObjective,
  matchDurationObjective,
  type OptimizationAlgorithm,
  type OptimizationObjective,
} from "./optimizer.js";
import {
  buildReport,
  listRuns,
  renderText,
  runMatchupMatrix,
  saveRun,
} from "./report.js";
import { locateParameter } from "./sourceLocator.js";
import { diagnose, renderConcerns } from "./diagnostics.js";
import { telemetryOf } from "./metrics.js";
import { personalityAI, type PersonalityProfile } from "./personality.js";
import { PERSONALITIES, type PersonalityName } from "./personalities.js";
import type { MatchRecord, PlayerSpec } from "./types.js";

/**
 * Balance dashboard CLI (ticket #210) — the designer's entry point.
 *
 *   npm run sim -- simulate  [--kingdoms fire,water] [--matches 50] [--seed s]
 *                            [--personalities balanced,aggressive] [--max-ticks n]
 *   npm run sim -- ffa       [--kingdoms …] [--matches 70] [--seed s]  (seats rotated)
 *   npm run sim -- matrix    [--matches-per-pair 10] [--seed s] [--max-ticks n]
 *   npm run sim -- optimize  [--algorithm hillClimb|annealing|genetic]
 *                            [--iterations 20] [--matches 10]
 *                            [--params id1,id2 | --all]
 *                            [--objective balance|duration:<ticks>]
 *                            [--kingdoms fire,water] [--seed s] [--max-ticks n]
 *   npm run sim -- params    [--filter text]
 *   npm run sim -- history
 *
 * Every command prints a report and persists it under simulation/runs/.
 */

function parseArgs(argv: string[]): { command: string; flags: Map<string, string> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

function kingdomsFlag(flags: Map<string, string>, fallback: KingdomId[]): KingdomId[] {
  const raw = flags.get("kingdoms");
  if (!raw) return fallback;
  const ids = raw.split(",").map((s) => s.trim()) as KingdomId[];
  for (const id of ids) {
    if (!(KINGDOM_IDS as readonly string[]).includes(id)) {
      throw new Error(`Unknown kingdom "${id}" (valid: ${KINGDOM_IDS.join(", ")})`);
    }
  }
  return ids;
}

function seatsFor(
  kingdoms: KingdomId[],
  flags: Map<string, string>,
): PlayerSpec[] {
  const raw = flags.get("personalities");
  const names = raw ? (raw.split(",").map((s) => s.trim()) as PersonalityName[]) : [];
  return kingdoms.map((kingdomId, i) => {
    const name = names[i] ?? names[0];
    if (name && !(name in PERSONALITIES)) {
      throw new Error(
        `Unknown personality "${name}" (valid: ${Object.keys(PERSONALITIES).join(", ")})`,
      );
    }
    const profile: PersonalityProfile | undefined = name
      ? PERSONALITIES[name]
      : undefined;
    return { kingdomId, ai: profile ? personalityAI(profile) : undefined };
  });
}

function objectiveFlag(flags: Map<string, string>): OptimizationObjective {
  const raw = flags.get("objective") ?? "balance";
  if (raw === "balance") return balanceObjective();
  const duration = /^duration:(\d+)$/.exec(raw);
  if (duration) return matchDurationObjective(Number(duration[1]));
  throw new Error(`Unknown objective "${raw}" (use "balance" or "duration:<ticks>")`);
}

const num = (flags: Map<string, string>, key: string, fallback: number) =>
  flags.has(key) ? Number(flags.get(key)) : fallback;

/** A parameter value: whole numbers as-is, fractions trimmed to 3 decimals. */
const fmtValue = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));

/** Ticks → "12m 05s" (matches run at TICK.RATE ticks/second). */
const fmtDuration = (ticks: number): string => {
  const total = Math.round(ticks / TICK.RATE);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
};

const fmtPct = (rate: number): string => `${Math.round(rate * 100)}%`;

const titleKingdom = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

function commandSimulate(flags: Map<string, string>): void {
  const kingdoms = kingdomsFlag(flags, ["fire", "water", "earth"]);
  const matches = num(flags, "matches", 25);
  const seed = flags.get("seed") ?? `sim-${Date.now()}`;

  console.log(`Simulating ${matches} matches: ${kingdoms.join(" vs ")} (seed "${seed}")…`);
  const collector = new AnalyticsCollector();
  const started = performance.now();
  runSimulation({
    matches,
    seed,
    players: seatsFor(kingdoms, flags),
    maxTicks: flags.has("max-ticks") ? num(flags, "max-ticks", 0) : undefined,
    observers: [collector],
  });
  const elapsed = performance.now() - started;

  const report = buildReport({
    title: `Simulation — ${kingdoms.join(" vs ")}`,
    analytics: collector.snapshot(),
  });
  console.log("\n" + renderText(report));
  console.log(`(${matches} matches in ${(elapsed / 1000).toFixed(1)}s — ${(matches / (elapsed / 1000)).toFixed(1)}/s)`);
  console.log(`Saved: ${saveRun(report)}`);
}

function commandFfa(flags: Map<string, string>): void {
  const kingdoms = kingdomsFlag(flags, [...KINGDOM_IDS]);
  const n = kingdoms.length;
  const matches = num(flags, "matches", 70);
  const seed = flags.get("seed") ?? `ffa-${Date.now()}`;

  console.log(
    `Free-for-all: ${n} kingdoms on one battlefield × ${matches} matches, seats rotated (seed "${seed}")…`,
  );
  if (matches % n !== 0) {
    console.log(
      `  note: ${matches} isn't a multiple of ${n}; use --matches ${Math.ceil(matches / n) * n} for exactly even seat coverage.`,
    );
  }

  const collector = new AnalyticsCollector();
  const started = performance.now();
  const result = runSimulation({
    matches,
    seed,
    players: seatsFor(kingdoms, flags),
    rotateSeats: true, // every kingdom plays every seat — cancels positional bias
    maxTicks: flags.has("max-ticks") ? num(flags, "max-ticks", 0) : undefined,
    observers: [collector],
  });
  const elapsed = performance.now() - started;

  const report = buildReport({
    title: `Free-for-all — ${n} kingdoms`,
    analytics: collector.snapshot(),
  });
  console.log("\n" + renderText(report));
  console.log(
    `(${matches} matches in ${(elapsed / 1000).toFixed(1)}s — ${(matches / (elapsed / 1000)).toFixed(1)}/s)`,
  );

  // Fair share in an N-way FFA is 1/N (not 50%). Same records drive the table
  // and the recommendations.
  const diag = diagnose(telemetryOf(result.records), { fairWinRate: 1 / n });
  console.log("\n" + renderConcerns(diag));

  console.log(`\nSaved: ${saveRun(report)}`);
}

function commandMatrix(flags: Map<string, string>): void {
  const kingdoms = kingdomsFlag(flags, [...KINGDOM_IDS]);
  const matchesPerPair = num(flags, "matches-per-pair", 10);
  const seed = flags.get("seed") ?? `matrix-${Date.now()}`;

  console.log(
    `Round-robin: ${kingdoms.length} kingdoms × ${matchesPerPair} matches/pair (seed "${seed}")…`,
  );

  // The competitive duels feed the kingdom table AND the diagnostics, so the
  // recommendations explain the exact matches that produce the matrix (unified
  // pipeline: matrix → telemetry → analytics → diagnostics).
  const collector = new AnalyticsCollector();
  const matchup = runMatchupMatrix({
    kingdoms,
    matchesPerPair,
    seed,
    maxTicks: flags.has("max-ticks") ? num(flags, "max-ticks", 0) : undefined,
    observers: [collector],
  });

  const report = buildReport({
    title: "Matchup Matrix",
    analytics: collector.snapshot(),
    matchup,
  });
  console.log("\n" + renderText(report));

  // Part 4: automatic balance recommendations, driven by the matrix's own
  // duels. Each 1v1 is 50/50 when balanced, so fair share is 0.5.
  const diag = diagnose(telemetryOf(matchup.records), { fairWinRate: 0.5 });
  console.log("\n" + renderConcerns(diag));

  console.log(`\nSaved: ${saveRun(report)}`);
}

function commandDiagnose(flags: Map<string, string>): void {
  const kingdoms = kingdomsFlag(flags, [...KINGDOM_IDS]);
  const matches = num(flags, "matches", 30);
  const seed = flags.get("seed") ?? `diagnose-${Date.now()}`;

  console.log(
    `Diagnosing ${kingdoms.join(", ")} — ${matches} matches (seed "${seed}")…`,
  );
  const records: MatchRecord[] = runSimulation({
    matches,
    seed,
    players: seatsFor(kingdoms, flags),
    maxTicks: flags.has("max-ticks") ? num(flags, "max-ticks", 0) : undefined,
  }).records;

  console.log("\n" + renderConcerns(diagnose(telemetryOf(records))));
}

function commandOptimize(flags: Map<string, string>): void {
  const kingdoms = kingdomsFlag(flags, ["fire", "water"]);
  const algorithm = (flags.get("algorithm") ?? "hillClimb") as OptimizationAlgorithm;
  const iterations = num(flags, "iterations", 20);
  const matchesPerBatch = num(flags, "matches", 10);
  const seed = flags.get("seed") ?? `optimize-${Date.now()}`;
  const objective = objectiveFlag(flags);
  const parameterIds = flags.has("all")
    ? undefined
    : flags.get("params")?.split(",").map((s) => s.trim());

  // Guard against a degenerate balance run: the balance objective measures
  // win-rate parity ACROSS distinct kingdoms. With fewer than two distinct
  // kingdoms (e.g. a fire-vs-fire mirror) there is no imbalance to remove — the
  // objective is asking one kingdom to win 100% of its own mirror, the score is
  // constant, and every candidate looks equally (un)good. Warn loudly instead
  // of letting it churn through pointless iterations.
  // Matrix mode: score each candidate on the full round-robin (recommended for
  // balancing a kingdom that dominates the FIELD rather than one matchup — the
  // same data the matrix and diagnostics use). Reuses --matches as matches/pair.
  const useMatrix = flags.has("matrix");
  const matrix = useMatrix
    ? { kingdoms, matchesPerPair: matchesPerBatch }
    : undefined;

  const isBalance = (flags.get("objective") ?? "balance") === "balance";
  const distinctKingdoms = new Set(kingdoms).size;
  if (!useMatrix && isBalance && distinctKingdoms < 2) {
    console.log(
      [
        "WARNING",
        "",
        "  The balance objective needs at least two DISTINCT kingdoms — it",
        "  optimizes win-rate parity between them. This matchup is:",
        "",
        `      ${kingdoms.join(" vs ")}`,
        "",
        "  With one distinct kingdom the objective is degenerate: the score",
        "  cannot change no matter what you tune, and every iteration will be",
        "  accepted sideways. Either:",
        "",
        "    • use different kingdoms:  --kingdoms fire,water",
        "    • or optimize pacing only: --objective duration:<ticks>",
        "",
      ].join("\n"),
    );
  }

  const objectiveName = useMatrix ? "matrix win-rate parity" : objective.name;
  console.log(
    `Optimizing (${algorithm}) — ${iterations} iterations × ${matchesPerBatch} ${useMatrix ? "matches/pair (MATRIX mode)" : "matches"}, objective "${objectiveName}", ` +
      `${parameterIds ? parameterIds.length + " parameters" : "FULL catalog"} (seed "${seed}")\n`,
  );

  // The score line reads "Balance score" for the default/matrix objective, plain
  // "Score" for any custom one.
  const scoreLabel =
    useMatrix || (flags.get("objective") ?? "balance") === "balance" ? "Balance score" : "Score";
  const COL = 26; // label column width for the aligned "before → after" rows

  const result = optimize({
    seed,
    algorithm,
    iterations,
    matchesPerBatch,
    mutationScale: flags.has("mutation-scale") ? num(flags, "mutation-scale", 0.3) : undefined,
    players: seatsFor(kingdoms, flags),
    matrix,
    // FFA (non-matrix) evaluation rotates seats so the candidate is judged on
    // kingdom strength, not seat luck — the same fairness the `ffa` command uses.
    rotateSeats: !useMatrix,
    maxTicks: flags.has("max-ticks") ? num(flags, "max-ticks", 0) : undefined,
    objective,
    parameterIds,
    onIteration: (r) => {
      // Rejected candidates get one dim line; accepted ones (the improvements
      // worth reading) get the full before/after breakdown.
      if (!r.accepted) {
        const names = r.changes.map((c) => c.label).join(", ") || "no change";
        console.log(
          `  iter ${String(r.iteration).padStart(3)}  · rejected   ${scoreLabel.toLowerCase()} ${r.score.toFixed(4)} (best ${r.bestScore.toFixed(4)})  [${names}]`,
        );
        return;
      }

      const lines: string[] = ["", `Iteration ${r.iteration}`, "", "  Changed:"];
      if (r.changes.length === 0) {
        lines.push(`    ${"(population reshuffled)"}`);
      }
      for (const c of r.changes) {
        lines.push(`    ${c.label.padEnd(COL)} ${fmtValue(c.from)} → ${fmtValue(c.to)}`);
      }

      lines.push("", "  Results:");
      for (const kingdomId of Object.keys(r.metrics.winRates)) {
        const before = r.previous.winRates[kingdomId];
        const after = r.metrics.winRates[kingdomId];
        const beforeStr = before === undefined ? "—" : fmtPct(before);
        lines.push(
          `    ${(titleKingdom(kingdomId) + " win rate").padEnd(COL)} ${beforeStr} → ${fmtPct(after)}`,
        );
      }
      lines.push(
        `    ${"Avg match length".padEnd(COL)} ${fmtDuration(r.previous.averageDurationTicks)} → ${fmtDuration(r.metrics.averageDurationTicks)}`,
      );
      lines.push(
        `    ${scoreLabel.padEnd(COL)} ${r.previous.score.toFixed(4)} → ${r.metrics.score.toFixed(4)}`,
      );
      // Distinguish a genuine improvement from a sideways move (identical score,
      // adopted anyway) or an accepted regression (annealing exploring). Lower
      // score is better, so "improved" means the score went down.
      const delta = r.metrics.score - r.previous.score;
      const verdict =
        delta < -1e-9
          ? "↑ Improved"
          : delta > 1e-9
            ? "↓ Accepted (annealing explore)"
            : "→ Sideways (equal score)";
      lines.push("", `  ${verdict}`);
      console.log(lines.join("\n"));
    },
  });

  const report = buildReport({
    title: `Optimization — ${kingdoms.join(useMatrix ? ", " : " vs ")} (${algorithm}${useMatrix ? ", matrix" : ""})`,
    analytics: result.analytics,
    optimization: result,
    objectiveName,
  });
  console.log("\n" + renderText(report));
  const dir = saveRun(report, { candidate: result.best });
  console.log(`Saved (report + candidate.json): ${dir}`);
  console.log(
    "\nThe candidate is a REVIEW artifact — apply changes by editing the listed file:line locations.",
  );
}

function commandParams(flags: Map<string, string>): void {
  const filter = flags.get("filter")?.toLowerCase();
  const params = listParameters().filter(
    (p) => !filter || p.id.toLowerCase().includes(filter),
  );
  for (const p of params) {
    const loc = locateParameter(p.id);
    console.log(
      `${p.id.padEnd(50)} ${String(p.base).padStart(10)}   ${loc ? `${loc.file}:${loc.line}` : ""}`,
    );
  }
  console.log(`\n${params.length} parameters`);
}

function commandHistory(): void {
  const runs = listRuns();
  if (runs.length === 0) {
    console.log("No saved runs yet — run `npm run sim -- simulate` first.");
    return;
  }
  console.log("Saved runs (newest first), under Server/simulation/runs/:");
  for (const run of runs) console.log(`  ${run}`);
}

function help(): void {
  console.log(`Kingdoms balance simulator

RECOMMENDED WORKFLOW (balance around the real game format — the free-for-all)

  1. ffa        Run a rotated free-for-all. Who over/under-performs vs 1/N?
  2. diagnose   Read the concerns: WHAT is off and WHERE the lever lives.
  3. matrix     ONLY IF NEEDED — isolate a specific 1v1 the FFA can't explain.
  4. optimize   Tune ONE parameter (--params <id>) toward FFA parity.
  5. ffa        Re-run to confirm the change helped in the real format. Repeat.

  The loop is FFA → diagnose → (matrix?) → optimize one lever → FFA — not a
  matrix-centric search. Change one thing at a time and re-verify in FFA.

Commands:

  simulate   Run a batch and report win rates, usage, and economy.
             --kingdoms fire,water,earth   --matches 25   --seed name
             --personalities balanced,aggressive          --max-ticks 24000
             (fixed seat order — use 'ffa' for trustworthy free-for-all data)

  ffa        Free-for-all: all kingdoms on one battlefield, SEATS ROTATED each
             match so positional bias cancels out. Reports win rate + average
             placement vs fair share (1/N) and balance concerns.
             --kingdoms …(default: all 7)   --matches 70   --seed name
             --personalities …             --max-ticks 24000

  matrix     Round-robin matchup matrix (1v1 duels) + balance recommendations.
             --kingdoms fire,water,…   --matches-per-pair 10   --seed name

  diagnose   Run a brawl and report the top balance concerns (recommendations).
             --kingdoms fire,water,…   --matches 30   --personalities …

  optimize   Search for better balance values; emits a reviewable candidate
             (NEVER auto-applied). FFA-by-default: seats are rotated and each
             candidate is scored on win-rate parity vs 1/N.
             --params <id>   focus ONE lever (recommended) — or id1,id2 | --all
             --kingdoms fire,water,…      the FFA field to balance across
             --algorithm hillClimb|annealing|genetic   --iterations 20
             --matches 10   --seed name   --mutation-scale 0.6
             --matrix   score on the 1v1 round-robin instead (no seat rotation;
                        --matches = per pair). Use only for a duel-specific fix.

  params     List every tunable parameter with its source location.
             --filter fireball

  history    List saved runs (Server/simulation/runs/).

Run via: npm run sim -- <command> [flags]`);
}

const { command, flags } = parseArgs(process.argv.slice(2));
try {
  switch (command) {
    case "simulate":
      commandSimulate(flags);
      break;
    case "ffa":
      commandFfa(flags);
      break;
    case "matrix":
      commandMatrix(flags);
      break;
    case "diagnose":
      commandDiagnose(flags);
      break;
    case "optimize":
      commandOptimize(flags);
      break;
    case "params":
      commandParams(flags);
      break;
    case "history":
      commandHistory();
      break;
    default:
      help();
  }
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
}
