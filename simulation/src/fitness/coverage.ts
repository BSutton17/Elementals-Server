import { KINGDOM_IDS, type KingdomId } from "../../../src/data/kingdoms.js";
import { KINGDOM_ABILITIES } from "../../../src/data/kingdomAbilities.js";
import type { MatchTelemetry } from "../telemetry.js";

/**
 * AI ability coverage — a health check on the measuring instrument, not a
 * balance metric.
 *
 * The Balance AI judges the game through AI-played matches. If the controller
 * never casts an ability, the evaluator sees a game in which that ability does
 * not exist, and may conclude its parameters do not matter. Coverage tells us
 * how much of the game the readings actually cover.
 *
 * It deliberately does NOT feed fitness. Rewarding coverage directly would let
 * the optimizer buy a better score by making abilities cheap enough to spam,
 * trading real balance for a diagnostic number.
 */

export type UsageBand = "never" | "rare" | "occasional" | "regular";

export interface AbilityUsage {
  abilityId: string;
  kingdomId: KingdomId;
  kind: string;
  casts: number;
  /** Casts per match in which this kingdom appeared. */
  perMatch: number;
  band: UsageBand;
}

export interface KingdomCoverage {
  kingdomId: KingdomId;
  used: number;
  total: number;
  unused: string[];
}

export interface CoverageReport {
  used: number;
  total: number;
  fraction: number;
  byKingdom: KingdomCoverage[];
  abilities: AbilityUsage[];
  /** Abilities never cast at all, across every match sampled. */
  unused: string[];
  /** Matches the report was derived from. */
  matches: number;
}

/**
 * Bands, so "used once in 500 matches" is not reported as equivalent to a
 * staple. An ability firing once proves it is reachable, not that the
 * controller understands when to reach for it.
 */
function bandFor(perMatch: number): UsageBand {
  if (perMatch <= 0) return "never";
  if (perMatch < 0.05) return "rare";
  if (perMatch < 0.5) return "occasional";
  return "regular";
}

/** Every activatable ability in the game, keyed by id. */
function allAbilities(): Map<string, { kingdomId: KingdomId; kind: string }> {
  const out = new Map<string, { kingdomId: KingdomId; kind: string }>();
  for (const kingdomId of KINGDOM_IDS) {
    for (const ability of KINGDOM_ABILITIES[kingdomId]) {
      if (ability.kind === "passive") continue;
      out.set(ability.id, { kingdomId, kind: ability.kind });
    }
  }
  return out;
}

/** Total activatable abilities — the denominator of the coverage figure. */
export function totalAbilities(): number {
  return allAbilities().size;
}

/**
 * Builds a coverage report from match telemetry.
 *
 * Derived from telemetry the evaluator already collects, so a checkpoint costs
 * nothing beyond enabling telemetry on the run that produces it.
 */
export function abilityCoverage(telemetry: readonly MatchTelemetry[]): CoverageReport {
  const catalogue = allAbilities();
  const casts = new Map<string, number>();
  const kingdomMatches = new Map<string, number>();

  for (const match of telemetry) {
    for (const seat of match.seats) {
      if (!seat.kingdomId) continue;
      kingdomMatches.set(seat.kingdomId, (kingdomMatches.get(seat.kingdomId) ?? 0) + 1);
      for (const [abilityId, n] of Object.entries(seat.abilities.byAbility)) {
        casts.set(abilityId, (casts.get(abilityId) ?? 0) + n);
      }
    }
  }

  const abilities: AbilityUsage[] = [];
  for (const [abilityId, meta] of catalogue) {
    const n = casts.get(abilityId) ?? 0;
    const appearances = kingdomMatches.get(meta.kingdomId) ?? 0;
    const perMatch = appearances > 0 ? n / appearances : 0;
    abilities.push({
      abilityId,
      kingdomId: meta.kingdomId,
      kind: meta.kind,
      casts: n,
      perMatch,
      band: bandFor(perMatch),
    });
  }
  abilities.sort((a, b) => a.kingdomId.localeCompare(b.kingdomId) || a.abilityId.localeCompare(b.abilityId));

  const byKingdom: KingdomCoverage[] = KINGDOM_IDS.map((kingdomId) => {
    const own = abilities.filter((a) => a.kingdomId === kingdomId);
    const unused = own.filter((a) => a.casts === 0).map((a) => a.abilityId);
    return { kingdomId, used: own.length - unused.length, total: own.length, unused };
  });

  const unused = abilities.filter((a) => a.casts === 0).map((a) => a.abilityId);
  const used = abilities.length - unused.length;
  return {
    used,
    total: abilities.length,
    fraction: abilities.length > 0 ? used / abilities.length : 0,
    byKingdom,
    abilities,
    unused,
    matches: telemetry.length,
  };
}

/** Flags a meaningful drop against a previous checkpoint. */
export function coverageRegression(
  baseline: number,
  current: number,
  tolerance = 4,
): string | null {
  if (current >= baseline - tolerance) return null;
  return `AI coverage regression: ${current}/${totalAbilities()} against a baseline of ${baseline}`;
}

export function coverageText(report: CoverageReport, baselineUsed?: number): string {
  const L: string[] = [];
  L.push("=".repeat(70));
  L.push("AI ABILITY COVERAGE — diagnostic, never part of fitness");
  L.push("=".repeat(70));
  L.push(
    `  ${report.used}/${report.total} = ${(report.fraction * 100).toFixed(1)}%` +
      (baselineUsed !== undefined
        ? `   (baseline ${baselineUsed}/${report.total}, ${report.used - baselineUsed >= 0 ? "+" : ""}${report.used - baselineUsed})`
        : "") +
      `   from ${report.matches} matches`,
  );
  if (baselineUsed !== undefined) {
    const warning = coverageRegression(baselineUsed, report.used);
    if (warning) L.push(`  ⚠ ${warning}`);
  }
  L.push("");
  L.push("  By kingdom");
  for (const k of report.byKingdom) {
    L.push(
      `    ${k.kingdomId.padEnd(13)} ${k.used}/${k.total}` +
        (k.unused.length > 0 ? `   unused: ${k.unused.join(", ")}` : ""),
    );
  }
  // Usage bands matter more than the raw count: an ability cast once is
  // reachable, not understood.
  const bands: Record<UsageBand, number> = { never: 0, rare: 0, occasional: 0, regular: 0 };
  for (const a of report.abilities) bands[a.band] += 1;
  L.push("");
  L.push(
    `  Usage bands: regular ${bands.regular}  ·  occasional ${bands.occasional}  ·  ` +
      `rare ${bands.rare}  ·  never ${bands.never}`,
  );
  return L.join("\n");
}
