import type { Match } from "../match/Match.js";
import { MONSTER_TARGET_ID, MONSTER_KINDS } from "../match/GameState.js";
import type {
  FieldEntityStatus,
  GameState,
  MonsterKind,
  MonsterState,
} from "../match/GameState.js";
import type { PlayerState } from "../match/playerState.js";
import { MONSTER, TICK } from "../data/balance.js";
import { param } from "./parameters.js";
import { applyDamage } from "./combat.js";
import { addModifier } from "./modifiers.js";
import { standingCentrepiece } from "./centrepiece.js";
import type { StatusEffectDefinition } from "./status.js";

/**
 * The monster.
 *
 * Ninety seconds into a match the field starts rolling, once every thirty
 * seconds, on a chance of `living kingdoms / 10`. When it comes up, something
 * that belongs to nobody plants itself in the middle of the battlefield with
 * 2,000 health per living kingdom and starts hitting the whole table.
 *
 * ⚠️ IT IS THE ONLY CENTREPIECE WITH NO CLOCK. Every other thing that owns the
 * middle of the field — the volcano, the butterfly, the black hole, the disc —
 * leaves on its own. This one leaves when it is dead. That is the entire
 * design: a timer makes waiting a strategy, and waiting is exactly what this
 * mechanic exists to punish. While it stands, the four centre-of-the-field
 * ultimates are locked out (see `centrepiece.ts`) and every seven to ten
 * seconds the table takes another hit, harder than the last one.
 *
 * KILLING IT PAYS TWO KINGDOMS, and deliberately not the same one twice by
 * accident:
 *
 *   • whoever lands the finishing blow, and
 *   • whoever dealt the most damage to it.
 *
 * One kingdom taking both is possible and pays both, but the split is what
 * makes the mechanic safe for the kingdoms that cannot win a damage race.
 * Water and Love will not out-damage Fire on a 14,000 health target; anybody
 * can take the last swing. A single "most damage" prize would have handed this
 * entire subsystem to the highest-DPS kits and given the rest a bill.
 */

/** True while a monster is standing. */
export function monsterIsAlive(match: Match): boolean {
  const m = match.gameState?.monster;
  return !!m && m.hp > 0;
}

/** Seconds → ticks, through the parameter gate so the sim can retune both. */
function ticksFor(id: string, seconds: number): number {
  return Math.max(1, Math.round(param(id, seconds) * TICK.RATE));
}

/** An inclusive integer roll in [min, max]. */
function rollBetween(rng: () => number, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/** How long until the monster's next swing, rolled fresh every cycle. */
function rollAttackDelay(match: Match): number {
  const min = ticksFor(
    "monster.attackIntervalMinSeconds",
    MONSTER.ATTACK_INTERVAL_MIN_SECONDS,
  );
  const max = ticksFor(
    "monster.attackIntervalMaxSeconds",
    MONSTER.ATTACK_INTERVAL_MAX_SECONDS,
  );
  return rollBetween(match.rng, min, Math.max(min, max));
}

/**
 * Advances the spawn clock and rolls when it comes due.
 *
 * ⚠️ THE CLOCK IS FROZEN, NOT MERELY CHECKED, WHILE THE FIELD IS OCCUPIED.
 * A volcano, a butterfly, a black hole, a light show or a monster already
 * standing all stop it dead — the middle of the field holds one thing at a
 * time, so a monster cannot arrive on top of one. Freezing rather than
 * skipping matters: a checked-and-skipped roll would silently consume the
 * table's thirty seconds, and a match with a lot of ultimates in it would face
 * far fewer monsters than a quiet one, which is backwards.
 */
export function tickMonsterSpawn(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  // Switched off for this room: no clock, no rolls, nothing to clean up later.
  // Checked before the clock is armed rather than at the roll, so a room that
  // has monsters off never carries spawn state at all.
  if (!match.monstersEnabled) return;

  if (state.monsterSpawn === null) {
    state.monsterSpawn = {
      ticksUntilRoll: ticksFor("monster.firstRollSeconds", MONSTER.FIRST_ROLL_SECONDS),
      skipNextRoll: false,
    };
  }
  const clock = state.monsterSpawn;

  // Anything in the middle of the field — a monster included — holds the clock.
  if (standingCentrepiece(match) !== null) return;

  clock.ticksUntilRoll -= 1;
  if (clock.ticksUntilRoll > 0) return;

  clock.ticksUntilRoll = ticksFor(
    "monster.rollIntervalSeconds",
    MONSTER.ROLL_INTERVAL_SECONDS,
  );

  // The breather a table earns by killing one: the first roll afterwards is
  // thrown away rather than rolled.
  if (clock.skipNextRoll) {
    clock.skipNextRoll = false;
    return;
  }

  const living = state.getPlayers().filter((p) => !p.eliminated).length;
  const divisor = Math.max(
    1,
    param("monster.spawnChanceDivisor", MONSTER.SPAWN_CHANCE_DIVISOR),
  );
  if (match.rng() < living / divisor) spawnMonster(match);
}

/**
 * Rolls which creature turns up, never the same one twice running.
 *
 * Uses the match's own `rng` like every other roll in the engine, so a seeded
 * match still replays identically.
 */
function rollMonsterKind(match: Match): MonsterKind {
  const state = match.gameState!;
  const pool = MONSTER_KINDS.filter((k) => k !== state.lastMonsterKind);
  return pool[Math.min(pool.length - 1, Math.floor(match.rng() * pool.length))]!;
}

/**
 * Puts a monster on the field. Sized off the kingdoms actually still playing,
 * so a late-game duel does not face a wall built for seven — and a little
 * bigger every time, because the table it is interrupting is a little richer.
 */
export function spawnMonster(match: Match): void {
  const state = match.gameState!;
  const living = state.getPlayers().filter((p) => !p.eliminated).length;

  // Every monster after the first is worth more health per kingdom than the one
  // before it. Counted BEFORE the sum so the first one is the base rate.
  state.monsterSpawnCount += 1;
  const hpPerPlayer =
    param("monster.hpPerPlayer", MONSTER.HP_PER_PLAYER) +
    param("monster.hpPerPlayerStep", MONSTER.HP_PER_PLAYER_STEP) *
      (state.monsterSpawnCount - 1);
  const maxHp = hpPerPlayer * living;

  const kind = rollMonsterKind(match);
  state.lastMonsterKind = kind;

  const monster: MonsterState = {
    kind,
    hp: maxHp,
    maxHp,
    damage: {},
    lastHitBy: null,
    // It does not swing the instant it lands: the table gets one interval to
    // notice it and start hitting back.
    nextAttackTick: match.tick + rollAttackDelay(match),
    attackDamage: param("monster.attackDamage", MONSTER.ATTACK_DAMAGE),
    statuses: [],
  };
  state.monster = monster;

  if (state.events.enabled) {
    state.events.emit({
      type: "monsterSpawned",
      tick: match.tick,
      kind,
      hp: maxHp,
      maxHp,
      attackDamage: monster.attackDamage,
      nextAttackTick: monster.nextAttackTick,
    });
  }
}

/**
 * Lands a hit on the monster. Returns how much it actually absorbed — capped at
 * what was left, so overkill does not inflate anyone's damage score.
 */
export function damageMonster(match: Match, attackerId: string, amount: number): number {
  const state = match.gameState!;
  const monster = state.monster;
  if (!monster || monster.hp <= 0) return 0;

  const dealt = Math.min(monster.hp, Math.max(0, Math.round(amount)));
  if (dealt <= 0) return 0;

  monster.hp -= dealt;
  monster.damage[attackerId] = (monster.damage[attackerId] ?? 0) + dealt;
  // Whoever touched it last holds the finishing blow. Recorded on every hit
  // rather than worked out at death, because by the time it dies the only
  // thing that knows who swung last is this field.
  monster.lastHitBy = attackerId;

  if (state.events.enabled) {
    state.events.emit({
      type: "monsterDamaged",
      tick: match.tick,
      attackerId,
      amount: dealt,
      hp: monster.hp,
      maxHp: monster.maxHp,
    });
  }
  return dealt;
}

/**
 * Lays a status on the monster — a burn, a freeze, whatever the attack carried.
 *
 * Same rule as the volcano: an attack is not split into "the part that works on
 * a monster" and "the part that is thrown away". What a status then DOES is
 * another matter — it has no stats to modify and takes no actions to interrupt,
 * so only tick damage moves its health bar and everything else rides inert.
 */
export function applyMonsterStatus(
  match: Match,
  sourceId: string,
  definition: StatusEffectDefinition,
  durationTicks: number,
  stacks = 1,
): FieldEntityStatus | null {
  const monster = match.gameState?.monster;
  if (!monster || monster.hp <= 0) return null;

  const existing = monster.statuses.find((s) => s.id === definition.id);
  if (existing) {
    switch (definition.stacking) {
      case "stack":
        existing.stacks = Math.min(
          definition.maxStacks ?? Number.POSITIVE_INFINITY,
          existing.stacks + stacks,
        );
        existing.remainingTicks = Math.max(existing.remainingTicks, durationTicks);
        break;
      case "extend":
        existing.remainingTicks += durationTicks;
        break;
      case "none":
        return existing; // first application wins; nothing to refresh
      default: // "refresh" | "replace"
        existing.remainingTicks = durationTicks;
        existing.stacks = stacks;
        break;
    }
    existing.sourceId = sourceId;
    return existing;
  }

  const instance: FieldEntityStatus = {
    id: definition.id,
    sourceId,
    remainingTicks: durationTicks,
    stacks,
    tickEffects: definition.tickEffects?.map((t) => ({ ...t })),
  };
  monster.statuses.push(instance);

  const bus = match.gameState!.events;
  if (bus.enabled) {
    bus.emit({
      type: "statusApplied",
      tick: match.tick,
      targetId: MONSTER_TARGET_ID,
      sourceId,
      statusId: instance.id,
      durationTicks: instance.remainingTicks,
      stacks: instance.stacks,
    });
  }
  return instance;
}

/**
 * Runs the monster's own statuses for one tick. Damage-over-time chips it and
 * is CREDITED to whoever applied it, so a burn counts toward both rewards
 * exactly as swinging does — including, on its final tick, the finishing blow.
 */
export function tickMonsterStatuses(match: Match): void {
  const monster = match.gameState?.monster;
  if (!monster || monster.hp <= 0) return;
  const bus = match.gameState!.events;

  for (let i = monster.statuses.length - 1; i >= 0; i--) {
    const status = monster.statuses[i]!;

    for (const effect of status.tickEffects ?? []) {
      if (effect.type !== "damage") continue; // nothing else can touch it
      const amount = effect.perStack ? effect.amount * status.stacks : effect.amount;
      if (amount > 0) damageMonster(match, status.sourceId, amount);
    }

    if (status.remainingTicks > 0) {
      status.remainingTicks -= 1;
      if (status.remainingTicks <= 0) {
        monster.statuses.splice(i, 1);
        if (bus.enabled) {
          bus.emit({
            type: "statusExpired",
            tick: match.tick,
            playerId: MONSTER_TARGET_ID,
            statusId: status.id,
          });
        }
      }
    }
  }
}

/**
 * Runs the monster's attack cycle.
 *
 * ⚠️ ONE ROLL FOR THE WHOLE TABLE. The three-in-four chance is rolled once per
 * cycle, not once per kingdom: when it swings it hits everybody, and when it
 * misses it hits nobody. A per-kingdom roll would average out into a steady
 * drain that nobody reacts to; a shared roll makes each cycle a moment the
 * table watches together — which is what a party game wants from a monster.
 *
 * The escalation follows the same rule and for the same reason: a landed cycle
 * raises the damage ONCE, not once per castle it hit. Per-hit escalation would
 * scale the ramp with the table size and have a seven-player game taking
 * four-figure hits inside two minutes.
 */
export function runMonsterAttacks(match: Match): void {
  const state = match.gameState;
  const monster = state?.monster;
  if (!state || !monster || monster.hp <= 0) return;
  if (match.tick < monster.nextAttackTick) return;

  monster.nextAttackTick = match.tick + rollAttackDelay(match);
  const bus = state.events;

  if (match.rng() >= param("monster.attackChance", MONSTER.ATTACK_CHANCE)) {
    if (bus.enabled) {
      bus.emit({
        type: "monsterAttacked",
        tick: match.tick,
        landed: false,
        amount: 0,
        targetIds: [],
        nextAttackTick: monster.nextAttackTick,
      });
    }
    return;
  }

  const amount = monster.attackDamage;
  const struck: string[] = [];
  for (const victim of state.getPlayers()) {
    if (victim.eliminated) continue;
    struck.push(victim.id);

    // ⚠️ IT CANNOT PUNCH THROUGH A SHIELD. A shielded castle spends its shield
    // and takes NOTHING on its HP, however small the shield was; an unshielded
    // one takes the hit in full and can die to it. So a shield is a complete
    // answer to one cycle rather than a partial one, which is what makes
    // "everyone buy a shield" a real, coordinated response to the thing in the
    // middle of the field — and what stops a monster from grinding down a table
    // that IS answering it.
    const shielded = victim.castle.shield > 0;
    const applied = applyDamage(victim, amount, {
      tick: match.tick,
      shieldOnly: shielded,
    });
    if (bus.enabled) {
      bus.emit({
        type: "damage",
        tick: match.tick,
        sourceId: MONSTER_TARGET_ID,
        targetId: victim.id,
        amount: applied.absorbedByShield + applied.dealtToHp,
        absorbedByShield: applied.absorbedByShield,
        dealtToHp: applied.dealtToHp,
        overkill: applied.incoming - applied.absorbedByShield - applied.dealtToHp,
        crit: false,
        cause: "monster",
      });
    }
  }

  // It learns. One escalation for the cycle, whoever it caught.
  monster.attackDamage += rollBetween(
    match.rng,
    param("monster.attackEscalationMin", MONSTER.ATTACK_ESCALATION_MIN),
    param("monster.attackEscalationMax", MONSTER.ATTACK_ESCALATION_MAX),
  );

  if (bus.enabled) {
    bus.emit({
      type: "monsterAttacked",
      tick: match.tick,
      landed: true,
      amount,
      targetIds: struck,
      nextAttackTick: monster.nextAttackTick,
    });
  }
}

/**
 * The kingdom that dealt the most damage to it, or null if nobody did.
 *
 * Ties go to the earlier seat in player order rather than to whoever the object
 * key iteration happens to reach first — a shared kill in a seeded simulation
 * has to resolve the same way every replay.
 */
function topDamageDealer(state: GameState, monster: MonsterState): string | null {
  let best: string | null = null;
  let bestAmount = 0;
  for (const player of state.getPlayers()) {
    const dealt = monster.damage[player.id] ?? 0;
    if (dealt > bestAmount) {
      best = player.id;
      bestAmount = dealt;
    }
  }
  return best;
}

/**
 * Hands a kingdom one share of the spoils: its gold production multiplied for
 * thirty seconds.
 *
 * ONE MODIFIER PER REWARD EARNED, which is what makes the "both" case fall out
 * on its own — a kingdom that out-damaged the field AND landed the killing blow
 * carries two ×1.5 modifiers and produces at ×2.25. Writing the double case as
 * its own constant would let the two drift apart.
 */
function grantReward(
  match: Match,
  player: PlayerState,
  reason: "lastHit" | "mostDamage",
): void {
  const multiplier = param("monster.rewardMultiplier", MONSTER.REWARD_MULTIPLIER);
  const durationTicks = ticksFor(
    "monster.rewardDurationSeconds",
    MONSTER.REWARD_DURATION_SECONDS,
  );
  addModifier(player, {
    id: `monster-reward-${reason}-${match.nextSeq()}`,
    stat: "income",
    op: "mult",
    value: multiplier,
    sourceId: MONSTER_TARGET_ID,
    remainingTicks: durationTicks,
  });
}

/**
 * Resolves a monster that has been killed. Run once per tick from the game
 * loop, before death detection so a castle that fell to the same tick's attack
 * cycle settles alongside it.
 */
export function resolveMonster(match: Match): void {
  const state = match.gameState;
  if (!state) return;
  const monster = state.monster;
  if (!monster || monster.hp > 0) return;

  state.monster = null;
  // The breather: the next roll is thrown away, so the table gets a clear
  // minute rather than the possibility of another one landing immediately.
  if (state.monsterSpawn !== null) state.monsterSpawn.skipNextRoll = true;

  const lastHitId = monster.lastHitBy;
  const topDamageId = topDamageDealer(state, monster);

  const rewarded: { playerId: string; reasons: ("lastHit" | "mostDamage")[] }[] = [];
  for (const [playerId, reason] of [
    [lastHitId, "lastHit"] as const,
    [topDamageId, "mostDamage"] as const,
  ]) {
    if (playerId === null) continue;
    const player = state.getPlayer(playerId);
    // An eliminated kingdom collects nothing — a burn it set before it died can
    // land the finishing blow, but multiplied production on a dead castle is
    // not a reward. The share is simply not paid; there is no runner-up.
    if (!player || player.eliminated) continue;
    grantReward(match, player, reason);
    const existing = rewarded.find((r) => r.playerId === playerId);
    if (existing) existing.reasons.push(reason);
    else rewarded.push({ playerId, reasons: [reason] });
  }

  if (state.events.enabled) {
    state.events.emit({
      type: "monsterDefeated",
      tick: match.tick,
      lastHitBy: lastHitId,
      mostDamageBy: topDamageId,
      damage: { ...monster.damage },
      rewards: rewarded.map((r) => ({
        playerId: r.playerId,
        reasons: [...r.reasons],
        // What their production is actually multiplied by, so a consumer never
        // has to know that two rewards means squaring the constant.
        multiplier:
          param("monster.rewardMultiplier", MONSTER.REWARD_MULTIPLIER) ** r.reasons.length,
        durationTicks: ticksFor(
          "monster.rewardDurationSeconds",
          MONSTER.REWARD_DURATION_SECONDS,
        ),
      })),
    });
  }
}

export { MONSTER_TARGET_ID };
