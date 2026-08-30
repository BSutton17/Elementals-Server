import { activateAbility, type AbilityDefinition } from "../engine/abilities.js";
import {
  buyCitizen,
  buyShield,
  repairCastle,
  unlockOrUpgradeAbility,
} from "../engine/purchases.js";
import { selectTarget } from "../engine/targeting.js";
import { volcanoIsLive } from "../engine/volcano.js";
import { monsterIsAlive } from "../engine/monster.js";
import { MONSTER_TARGET_ID, VOLCANO_TARGET_ID } from "../match/GameState.js";
import { dispelStatus } from "../engine/purchases.js";
import { TICK } from "../data/balance.js";
import { placeRouletteBet } from "../engine/roulette.js";
import { spinSlotMachine } from "../engine/slotMachine.js";
import { crawlerSwarm, squashCrawler } from "../engine/crawlers.js";
import { abilitiesForKingdom } from "../data/kingdomAbilities.js";
import type { PlayerState } from "../match/playerState.js";
import type { AIContext, AIController, AIFactory } from "./runtime.js";
import type { Rng } from "./runtime.js";
import { ACTION_SIZE, PRIMARY_ACTION_COUNT, WAIT, orderEnemies } from "./actions.js";
import { chargesToSpend, decide, type Decision } from "./decode.js";
import { DEFAULT_DECISION_PERIOD, DIFFICULTY, type Difficulty } from "./difficulty.js";
import { ObservedHistory, knowledgeFor } from "./knowledge.js";
import { createMask, legalActions, type ActionMask } from "./legality.js";
import { OBSERVATION_SIZE, encode } from "./observation.js";
import { randomNetwork, type Network } from "./network.js";

/**
 * The network-driven controller.
 *
 * One of exactly two modules in `ai/` that touch the simulation, and the only
 * one that WRITES to it. Reads go through `knowledge.ts`; writes go through the
 * same six engine functions the live socket handlers call, so this bot is
 * subject to identical validation and can no more cheat than a human can.
 *
 * It has no idea where its network came from. `Network` is the entire contract,
 * so a NEAT phenotype drops in with no change here — which is the point of
 * building the runtime before the algorithm.
 */

/**
 * How long, in seconds, bots leave each other and the table alone at the start
 * of a match.
 *
 * ⚠️ THE OPENING IS THE ECONOMY PHASE, AND A BOT THAT OPENS BY PUNCHING
 * SOMEBODY MAKES IT A RACE. Nobody has a shield, an unlock or a second citizen
 * yet, so the first hit lands into a defenceless castle and the whole table is
 * reacting before it has built anything. Bots simply do not pick a target for
 * this long; with nothing selected they spend the opening the way a person does
 * — buying citizens and unlocking a kit.
 */
const OPENING_TRUCE_SECONDS = 15;

/**
 * Per-second chance a bot commits to whatever holds the middle of the field —
 * a volcano, or a monster.
 *
 * ⚠️ ROLLED ONCE A SECOND, NOT ONCE A DECISION. Hard bots decide several
 * times a second and Easy ones far less often, so a per-decision roll would
 * make difficulty silently decide how fast the table answers "The End of the
 * World". Rolled on the wall clock, every bot commits at the same rate and the
 * mountain gets the same reception whoever is sitting at the table.
 */
const FIELD_LOCK_CHANCE = 0.5;

/**
 * Target ids that mean "a thing in the middle of the field", not a kingdom.
 *
 * Held as a set so the staleness check below cannot silently miss one when a
 * third field entity is added.
 */
const FIELD_TARGET_IDS: ReadonlySet<string> = new Set([
  VOLCANO_TARGET_ID,
  MONSTER_TARGET_ID,
]);

export interface NetworkControllerOptions {
  readonly network: Network;
  readonly rng: Rng;
  readonly difficulty?: Difficulty;
  /** Overrides the difficulty's cadence. Mainly for tests. */
  readonly decisionPeriod?: number;
  /** Overrides the difficulty's sampling temperature. 0 forces a pure argmax. */
  readonly temperature?: number;
}

/** Per-match counters, for proving the pipeline actually did things. */
export interface ControllerStats {
  decisions: number;
  casts: number;
  invests: number;
  citizens: number;
  repairs: number;
  shields: number;
  retargets: number;
  /** Defensive interactions answered: spins, bets, swats. */
  defends: number;
  /** Ransoms paid to clear a dispellable status. */
  dispels: number;
  waits: number;
  /**
   * Engine calls the mask said were legal but the engine refused.
   *
   * Expected to be zero. A nonzero count means `legality.ts` and the engine
   * have drifted, which is a defect rather than a strategy problem — so it is
   * counted rather than swallowed.
   */
  rejected: number;
  /** Rejections keyed by `action:ENGINE_ERROR`, so a drift names itself. */
  rejectedBy: Record<string, number>;
  /** Ticks on which the mask offered nothing but WAIT. */
  forcedWaits: number;
  /**
   * Decisions where the chosen head differed from the previous decision's.
   *
   * The difference between a policy and a constant. A deterministic argmax over
   * an observation that changes slowly can return the SAME head for thousands of
   * consecutive ticks — which is not "learning when to wait", it is a network
   * that cannot express a change of mind. Low switching with a high legal-action
   * count means evolution is being asked to learn timing through a mechanism
   * that cannot represent it.
   */
  actionSwitches: number;
  /** Distinct heads chosen across the match, out of 22. */
  distinctActions: number;
  /** Summed legal actions over all decisions, for the choice-per-decision rate. */
  legalOffered: number;
}

/**
 * How close a telegraphed strike must be before the reflex spends 300 gold.
 *
 * Light Show's fuse is 3.25 s; a shield bought at the very start of a longer
 * fuse can be broken by ordinary attacks before the strike ever lands, so the
 * reflex waits until the blow is genuinely imminent.
 */
/**
 * How long a bot takes to notice a defensive threat, in ticks.
 *
 * Half a second to a second and a half — roughly the span of a person seeing
 * something appear and getting a click out. Answering on the tick it lands
 * refunds the attention these abilities are designed to cost, which is most of
 * what makes them abilities at all rather than just damage.
 *
 * Rolled per occurrence rather than per decision, so a seat cannot re-roll
 * every 5 ticks and effectively take the shortest draw of many.
 */
const REACTION_MIN_TICKS = Math.round(0.5 * TICK.RATE);
const REACTION_MAX_TICKS = Math.round(1.5 * TICK.RATE);

const SHIELD_REFLEX_WINDOW = 3.25 * TICK.RATE;

/**
 * How much better a play must be than what is already payable before this seat
 * will skip a cast to bank for it.
 *
 * The heuristic controller's value, deliberately unchanged: it solves the same
 * problem in `simulation/src/personality.ts`, and two different answers to
 * "is this worth saving for" in one game would be two behaviours to reason
 * about with nothing to choose between them.
 */
const SAVINGS_MARGIN = 1.25;

/**
 * How far ahead the shortfall may be, in ticks of current income, for a play to
 * count as reachable. 500 ticks is 25 seconds.
 *
 * ⚠️ THIS IS THE GUARD AGAINST A SEAT SAVING FOREVER. A bank with no horizon
 * lets a poor kingdom pick the most expensive thing it owns and stop attacking
 * for the rest of the match, which is a worse failure than the spam it is meant
 * to fix.
 */
const SAVINGS_LOOKAHEAD_TICKS = 500;

/**
 * How hard it must hit, as a share of current HP, to be worth blocking.
 *
 * Light Show is 2000 against a 10,000 castle, so a tenth clears this
 * comfortably while ordinary chip damage does not trigger it.
 */
const SHIELD_REFLEX_FRACTION = 0.1;

export class NetworkController implements AIController {
  private readonly network: Network;
  private readonly rng: Rng;
  private readonly period: number;
  private readonly secondBestRate: number;
  private readonly buckets: number;
  private readonly temperature: number;

  /** Buffers owned for the life of the controller — see observation.ts. */
  private readonly obs = new Float32Array(OBSERVATION_SIZE);
  private readonly out = new Float32Array(ACTION_SIZE);
  private readonly mask: ActionMask = createMask();
  private readonly altMask: ActionMask = createMask();

  private readonly history = new ObservedHistory();
  /**
   * When each defensive threat may be answered, keyed by threat.
   *
   * ⚠️ A BOT THAT REACTS ON THE SAME TICK IS NOT PLAYING THE GAME A PERSON
   * PLAYS. Shielding a telegraphed strike three ticks after it is announced, or
   * pulling the lever the instant the machine lands, is a reaction no human
   * gives — the whole cost of these abilities is the moment of attention they
   * take, and answering instantly refunds it.
   *
   * A value of `null` means answer as soon as possible with NO delay. That is
   * the case where the seat could not afford the response when the threat
   * arrived: it has already been made to wait by circumstance, and adding more
   * on top would punish it twice for being poor.
   */
  private readonly answerAt = new Map<string, number | null>();

  private readonly kit: readonly AbilityDefinition[];
  private readonly phase: number;
  private subscribed = false;

  /**
   * The thing in the middle of the field this bot has committed to — the
   * volcano's or the monster's sentinel id — or null when it is playing the
   * ordinary game. No swapping off until that thing is gone.
   *
   * ⚠️ THE LOCK IS THE BOT'S OWN RULE, NOT THE ENGINE'S. `selectTarget`
   * would happily let it wander off — a human can. What makes a volcano a
   * crisis is that the table stays on it, and a bot that re-thought its target
   * twice a second would drift back to whichever kingdom looked weakest and
   * leave the mountain to erupt on everybody.
   *
   * The monster inherits this wholesale, and needs it more: the volcano at
   * least leaves on its own after twenty seconds, while a monster the table
   * drifts away from stands there permanently, hitting everybody harder every
   * cycle. Holding the id rather than a boolean is what lets one lock serve
   * both — they can never be standing at the same time (`centrepiece.ts`), so
   * there is only ever one thing it could mean.
   */
  private fieldLock: string | null = null;
  /** The last whole second the field-commitment roll was made in. */
  private lastFieldRollSecond = -1;

  readonly stats: ControllerStats = {
    decisions: 0, casts: 0, invests: 0, citizens: 0, repairs: 0,
    shields: 0, retargets: 0, defends: 0, dispels: 0, waits: 0, rejected: 0, rejectedBy: {}, forcedWaits: 0,
    actionSwitches: 0, distinctActions: 0, legalOffered: 0,
  };

  /** Diagnostics only: what was chosen last, and everything chosen so far. */
  private previousAction = -1;
  private readonly actionsSeen = new Set<number>();

  /** Records a rejection under a name that identifies the drift. */
  private reject(action: string, error: string | undefined): void {
    this.stats.rejected += 1;
    const key = `${action}:${error ?? "UNKNOWN"}`;
    this.stats.rejectedBy[key] = (this.stats.rejectedBy[key] ?? 0) + 1;
  }

  constructor(player: PlayerState, options: NetworkControllerOptions) {
    this.network = options.network;
    this.rng = options.rng;
    const config = DIFFICULTY[options.difficulty ?? "hard"];
    this.period = Math.max(1, options.decisionPeriod ?? config.decisionPeriod);
    this.secondBestRate = config.secondBestRate;
    this.buckets = config.observationBuckets;
    this.temperature = options.temperature ?? config.temperature;
    // Same expression knowledge.ts uses, so slot indices agree.
    this.kit = abilitiesForKingdom(player.kingdomId).filter((a) => a.kind !== "passive");
    // Stagger seats so they do not all decide on the same ticks, matching the
    // heuristic controller's behaviour.
    this.phase = Math.floor(this.rng() * this.period);
  }

  /**
   * Gold that must stay in hand for a defensive answer already committed to.
   *
   * ⚠️ WITHOUT THIS THE DELAY CANCELS THE DEFENCE. Measured: a seat holding
   * 2001 gold saw a siege land, and by the time its 1.5 s reaction elapsed it
   * had spent down to 240 against a 300 shield — it never defended at all, and
   * died to a threat it could have answered outright a second earlier. The
   * delay is meant to make the reaction human, not to make it fail.
   *
   * A person who has seen the threat and decided to shield does not spend the
   * money in the intervening second. Reserving models that: once a threat is
   * registered as answerable, the price of the answer stops being spendable.
   */
  private reservedGold(knowledge: ReturnType<typeof knowledgeFor>): number {
    let reserved = 0;
    if (this.answerAt.has("siege") || this.answerAt.has("strike")) {
      reserved = Math.max(reserved, knowledge.self.shieldCost);
    }
    if (this.answerAt.has("dispel") && knowledge.self.dispel !== null) {
      reserved = Math.max(reserved, knowledge.self.dispel.cost);
    }
    return reserved;
  }

  /**
   * The price of the ability this seat is banking toward, or 0 when nothing is
   * worth waiting for.
   *
   * Two guards decide that, and both matter:
   *
   *   • WORTH IT — the candidate must be `SAVINGS_MARGIN` more valuable than
   *     the best thing already payable. Without it a seat banks for a 400-gold
   *     ability that hits no harder than the 120-gold one it already owns, and
   *     buys nothing but silence.
   *
   *   • REACHABLE — the shortfall must close inside `SAVINGS_LOOKAHEAD_TICKS`
   *     at the seat's CURRENT income. Without it a poor seat picks the most
   *     expensive thing in its kit, can never afford it, and stops attacking
   *     for the rest of the match. That failure mode is worse than the spam it
   *     replaces, which is why the reachability test is not optional.
   *
   * Cooldown is deliberately NOT a filter. A kingdom's strongest play carries
   * its longest cooldown, so requiring the target to be castable this instant
   * is exactly how the filler attack drains the treasury between cycles and the
   * expensive ability is unaffordable on the one tick it comes up.
   */
  private savingsTarget(knowledge: ReturnType<typeof knowledgeFor>): number {
    const self = knowledge.self;
    if (self.incomePerTick <= 0) return 0;

    // The bar to beat: the best thing this seat could already cast.
    let payableValue = 0;
    for (const ability of self.kit) {
      if (ability === undefined || !ability.unlocked || !ability.affordable) continue;
      if (ability.kind !== "attack" && ability.kind !== "ultimate") continue;
      if (ability.heuristicValue > payableValue) payableValue = ability.heuristicValue;
    }

    let targetCost = 0;
    let targetValue = payableValue * SAVINGS_MARGIN;
    for (const ability of self.kit) {
      if (ability === undefined || !ability.unlocked || ability.affordable) continue;
      if (ability.kind !== "attack" && ability.kind !== "ultimate") continue;
      if (ability.statusBlocked || ability.needsUnsupportedPayload) continue;
      if (ability.heuristicValue <= targetValue) continue;
      const shortfall = ability.cost - self.currency;
      if (shortfall / self.incomePerTick > SAVINGS_LOOKAHEAD_TICKS) continue;
      targetValue = ability.heuristicValue;
      targetCost = ability.cost;
    }
    return targetCost;
  }

  /**
   * Whether a threat has been on screen long enough to answer.
   *
   * The delay is rolled ONCE per occurrence and held, so a seat does not
   * re-roll its reaction time every decision and effectively race itself to the
   * shortest draw. Cleared when the threat is gone, so the next one gets a
   * fresh roll.
   */
  private mayAnswer(key: string, tick: number, present: boolean, affordable: boolean): boolean {
    if (!present) {
      this.answerAt.delete(key);
      return false;
    }
    if (!this.answerAt.has(key)) {
      this.answerAt.set(
        key,
        affordable
          ? tick +
            REACTION_MIN_TICKS +
            Math.floor(this.rng() * (REACTION_MAX_TICKS - REACTION_MIN_TICKS + 1))
          : null,
      );
    }
    const at = this.answerAt.get(key)!;
    // `null` — unaffordable when it landed — answers the moment it can.
    return at === null ? affordable : affordable && tick >= at;
  }

  act(ctx: AIContext): void {
    const { match, player, tick } = ctx;
    if ((tick + this.phase) % this.period !== 0) return;
    if (match.phase !== "active" || player.eliminated) return;

    // The observed-damage memory is fed from the gameplay event stream rather
    // than by diffing enemy state, because diffing enemy state would BE the
    // leak this whole subsystem exists to prevent. Subscribed lazily: the
    // controller factory does not receive the match.
    if (!this.subscribed) {
      const bus = match.gameState!.events;
      const seatId = player.id;
      bus.on((event) => this.history.observe(seatId, event));
      this.subscribed = true;
    }

    const knowledge = knowledgeFor(match, player, this.history);
    encode(knowledge, this.obs);
    this.degrade();
    this.network.activate(this.obs, this.out);
    legalActions(knowledge, this.mask);

    if (onlyWaitIsLegal(this.mask)) this.stats.forcedWaits += 1;
    for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
      if (this.mask[i] === 1) this.stats.legalOffered += 1;
    }

    let decision = decide(this.out, this.mask, {
      temperature: this.temperature,
      rng: this.rng,
    });
    if (this.secondBestRate > 0 && this.rng() < this.secondBestRate) {
      decision = this.secondBest(decision);
    }
    this.stats.decisions += 1;
    if (this.previousAction >= 0 && decision.primaryIndex !== this.previousAction) {
      this.stats.actionSwitches += 1;
    }
    this.previousAction = decision.primaryIndex;
    this.actionsSeen.add(decision.primaryIndex);
    this.stats.distinctActions = this.actionsSeen.size;

    this.apply(ctx, knowledge, decision);
  }

  /**
   * Applies the difficulty's observation degradation.
   *
   * Only the four revealed-enemy slots are quantized, and only when they were
   * legitimately revealed in the first place — degradation makes a bot read the
   * board less carefully, it never grants information.
   */
  private degrade(): void {
    if (this.buckets <= 0) return;
    if (this.obs[21] !== 1) return; // nothing was revealed; nothing to blur
    for (let i = 26; i <= 29; i++) {
      this.obs[i] = Math.round(this.obs[i]! * this.buckets) / this.buckets;
    }
  }

  /**
   * The slot holding the biggest single hit this seat can pay for right now,
   * or null when nothing is ready.
   *
   * ⚠️ ONLY WHAT THE VOLCANO ACCEPTS. It takes attacks and ultimates, and
   * only their plain damage — statuses, heals and utilities are refused
   * outright by the engine, and an attack whose damage is zero at this tier is
   * refused too. Ranking on the declared damage rather than the effective
   * number is deliberate: the ordering is what matters and the tier only ever
   * scales it up.
   */
  private hardestHitFor(knowledge: ReturnType<typeof knowledgeFor>): number | null {
    let best: number | null = null;
    let bestDamage = 0;
    for (let slot = 0; slot < this.kit.length; slot++) {
      const ability = this.kit[slot];
      const known = knowledge.self.kit[slot];
      if (ability === undefined || known === undefined) continue;
      if (ability.kind !== "attack" && ability.kind !== "ultimate") continue;
      if (
        !known.unlocked ||
        known.cooldownRemaining > 0 ||
        !known.affordable ||
        !known.meterReady ||
        known.statusBlocked ||
        known.centrepieceBlocked ||
        known.needsUnsupportedPayload ||
        (known.charges !== null && known.charges.available <= 0)
      ) {
        continue;
      }
      const damage = ability.effects
        .filter((e) => e.type === "damage")
        .reduce((sum, e) => sum + (e.params.amount ?? 0), 0);
      if (damage <= 0) continue; // the engine refuses these against a rock
      if (damage > bestDamage) {
        bestDamage = damage;
        best = slot;
      }
    }
    return best;
  }

  /**
   * What is standing in the middle of the field for THIS bot to swing at, or
   * null when there is nothing.
   *
   * At most one can ever be standing — the centrepiece rule guarantees it — so
   * this returns an id rather than a list. Magma is the one exception in the
   * whole system: it is the kingdom its own eruption spares, so helping the
   * field break its own volcano would be pure downside and it is not offered
   * the target. The monster has no owner and therefore no exemption; everybody
   * is on the hook for it equally, which is the point of it.
   */
  private fieldTargetFor(match: AIContext["match"], player: PlayerState): string | null {
    if (monsterIsAlive(match)) return MONSTER_TARGET_ID;
    const volcano = match.gameState?.volcano ?? null;
    if (volcanoIsLive(match) && volcano !== null && volcano.ownerId !== player.id) {
      return VOLCANO_TARGET_ID;
    }
    return null;
  }

  /** Re-decides with the chosen head suppressed. */
  private secondBest(first: Decision): Decision {
    this.altMask.set(this.mask);
    this.altMask[first.primaryIndex] = 0;
    this.altMask[WAIT] = 1; // the floor survives suppression
    return decide(this.out, this.altMask, { temperature: this.temperature, rng: this.rng });
  }

  /** The only place in `ai/` that mutates the match. */
  private apply(
    ctx: AIContext,
    knowledge: ReturnType<typeof knowledgeFor>,
    decision: Decision,
  ): void {
    const { match, player } = ctx;

    // ── the middle of the field, and the opening truce ────────────────
    //
    // Both are rules rather than learned behaviour, for the same reason the
    // shield reflex below is: neither has a trade-off worth weighing, and
    // neither is reachable through a network that has no idea a volcano exists.
    const standing = this.fieldTargetFor(match, player);

    if (standing === null) {
      // Broken, erupted, killed, or Magma's own: the lock means nothing now.
      this.fieldLock = null;
      // ⚠️ AND THE SELECTION MUST GO WITH IT, or the seat keeps aiming at a
      // corpse. Dropping the lock only stops this controller from RE-imposing
      // the target; `player.target` still holds the sentinel, and every
      // single-target cast against a dead field entity is refused
      // INVALID_TARGET. Nothing else clears it either — the network only moves
      // the selection when it happens to pick the retarget head, which can be
      // many seconds of doing nothing.
      //
      // Measured on the shipped champion before this: seats spent 13,227 of
      // 32,240 seat-ticks — 41% of the match — aimed at a monster that was
      // already dead, unable to attack anything for the whole of it.
      //
      // Latent for the volcano since the lock was written; it simply never
      // showed, because a volcano is rare and lasts twenty seconds. A monster
      // arrives every half-minute and leaves a corpse every time.
      if (player.target !== null && FIELD_TARGET_IDS.has(player.target)) {
        selectTarget(match, player, null);
      }
    } else if (this.fieldLock === standing) {
      // Something else moved the selection — an elimination clearing it, a
      // Supernova forcing it, a Caprice scramble. Put it back.
      if (player.target !== standing) {
        selectTarget(match, player, standing);
      }
    } else {
      const second = Math.floor(match.tick / TICK.RATE);
      if (second !== this.lastFieldRollSecond) {
        this.lastFieldRollSecond = second;
        if (this.rng() < FIELD_LOCK_CHANCE) {
          if (selectTarget(match, player, standing).ok) {
            this.fieldLock = standing;
            this.stats.retargets += 1;
          }
        }
      }
    }

    // Retargeting, so a cast made this decision uses the new target — the same
    // order a player clicking a castle then an ability produces. Held back
    // while the truce runs, and while this bot is committed to the middle of
    // the field.
    const truceHolds = match.tick < OPENING_TRUCE_SECONDS * TICK.RATE;
    if (this.fieldLock === null && !truceHolds) {
      const wanted =
        decision.retargetSlot !== null
          ? orderEnemies(knowledge)[decision.retargetSlot]
          : undefined;

      if (wanted !== undefined) {
        const result = selectTarget(match, player, wanted.id);
        if (result.ok) this.stats.retargets += 1;
        else this.reject("target", result.error);
      } else if (player.target === null) {
        // ── the floor: a seat always has somebody to hit ──────────────
        //
        // ⚠️ A BOT WITH NO TARGET CANNOT PLAY AT ALL, and nothing in the policy
        // guarantees it ever gets one. The targeting head only fires when its
        // gate output happens to be positive, and the gate is masked off the
        // moment there is nobody it is not already aimed at — so in a duel a
        // seat has exactly one window, and if the network does not use it the
        // seat spends the whole match with every single-enemy cast masked
        // illegal. Measured on the current champion: two-minute duels finishing
        // with 0 retargets and 0 casts, seats making four hundred decisions of
        // which 86% had nothing legal but WAIT.
        //
        // So this is a rule, in the same family as the shield reflex: not a
        // preference the policy should have discovered, but a floor under a
        // state that is never correct. It only ever fires when the seat is
        // pointing at NOBODY — the moment it has a target, the network has the
        // wheel back and decides every switch from then on.
        const enemy = orderEnemies(knowledge).find(
          (e) => !e.eliminated && !e.targetBanned && e.targetable,
        );
        if (enemy !== undefined && selectTarget(match, player, enemy.id).ok) {
          this.stats.retargets += 1;
        }
      }
    }
    if (match.phase !== "active") return;

    // ── the shield reflex ─────────────────────────────────────
    //
    // ⚠️ A RULE, DELIBERATELY, BECAUSE THIS ONE IS NOT WORTH DISCOVERING.
    //
    // Two situations have exactly one correct answer and no trade-off worth
    // weighing. Old Friends carries `endsOnShieldPurchase` with no duration:
    // there is no clock and no ransom, so waiting is not counterplay, it is
    // losing slowly at 3 damage a tick. Light Show announces 2000 damage 3.25 s
    // ahead precisely so the field can put a shield up.
    //
    // Measured across three full training runs, the AI never learned either.
    // Exposure was not the problem for the siege — 0.74 land on a seat per
    // self-play match — it simply never connected them, and stood there taking
    // the full 1800. Light Show it has never once seen, because no genome in
    // self-play ever affords a 340-gold ultimate to cast it.
    //
    // `shieldAvailable` already carries every precondition the engine checks:
    // no shield up, no swarm barring one, off the break cooldown, and the gold
    // in hand. So this only decides WHEN, and spends the decision like any
    // other defensive act.
    {
      const strike = knowledge.self.incomingStrike;
      // Only a blow big enough to be worth 300 gold, and only once it is close
      // enough that the shield will still be standing when it lands.
      const worthBlocking =
        strike !== null &&
        strike.ticksUntil <= SHIELD_REFLEX_WINDOW &&
        strike.amount >= knowledge.self.hp * SHIELD_REFLEX_FRACTION;
      // Each threat carries its own reaction clock: a siege noticed late and a
      // strike noticed late are separate events, not one shared timer.
      const siegeReady = this.mayAnswer(
        "siege",
        ctx.tick,
        knowledge.self.siegeEndsOnShield,
        knowledge.self.shieldAvailable,
      );
      const strikeReady = this.mayAnswer(
        "strike",
        ctx.tick,
        worthBlocking,
        knowledge.self.shieldAvailable,
      );
      // ⚠️ REGISTERED BEFORE AFFORDABILITY IS CHECKED, and that ordering is the
      // whole point. Gating the calls above behind `shieldAvailable` meant a
      // seat that could not pay never SAW the threat, so its reaction clock
      // started when the gold arrived rather than when the siege landed — and
      // it then waited out a full delay on top. Measured: 13 to 28 ticks after
      // affording, where the rule says answer at once.
      if (knowledge.self.shieldAvailable && (siegeReady || strikeReady)) {
        const bought = buyShield(match, player);
        if (bought.ok) {
          this.stats.shields += 1;
          return;
        }
        this.reject("shield", bought.error);
      }
    }

    // ── defence, BEFORE the primary action and INSTEAD of it ───────────
    //
    // ⚠️ SPENDING THE DECISION IS THE POINT. Roulette, the Slot Machine and
    // Creepy Crawlers cost a human their ATTENTION — clicking a bug is time not
    // spent playing — and resolving them for free would give the AI an edge no
    // player has. So these return early: the seat answers the board this
    // decision and casts on the next one.
    //
    // Ordered ransom-first because a firefly swarm also bars a shield, so it
    // gates a defensive option the other two do not.
    // ⚠️ AFFORDABILITY IS CHECKED HERE, NOT LEFT TO THE ENGINE TO REFUSE.
    // The gate defaults OPEN, so a seat under a swarm it cannot pay for would
    // otherwise attempt the ransom on every single decision and be refused
    // every time — 27 rejections in one joker-vs-light match. A rejected
    // action is a wasted decision and it teaches the policy nothing except
    // that the slot is broken.
    if (
      decision.dispel &&
      this.mayAnswer(
        "dispel",
        ctx.tick,
        knowledge.self.dispel !== null,
        knowledge.self.dispel !== null &&
          knowledge.self.currency >= knowledge.self.dispel.cost,
      )
    ) {
      const result = dispelStatus(match, player);
      if (result.ok) {
        this.stats.dispels += 1;
        return;
      }
      this.reject("dispel", result.error);
    }
    if (decision.defend) {
      if (this.mayAnswer("bet", ctx.tick, knowledge.self.betOwed, true)) {
        // No safe bet exists, so the colour is a real choice rather than a
        // formality: green is a 1-in-37 jackpot against a 1.5x beating.
        const colors = ["red", "black", "green"] as const;
        const index = Math.min(colors.length - 1, Math.floor(decision.betPick * colors.length));
        if (placeRouletteBet(match, player, colors[Math.max(0, index)]!) !== null) {
          this.stats.defends += 1;
          return;
        }
      }
      if (this.mayAnswer("spin", ctx.tick, knowledge.self.spinOwed, true)) {
        if (spinSlotMachine(match, player) !== null) {
          this.stats.defends += 1;
          return;
        }
      }
      if (this.mayAnswer("crawlers", ctx.tick, knowledge.self.crawlers > 0, true)) {
        // Always swat the first bug still alive. Each drains independently and
        // killing one takes two hits, so CONCENTRATING hits strictly beats
        // spreading them — the bleed only eases when a bug actually dies. That
        // makes the index a solved question, not one worth a head.
        const swarm = crawlerSwarm(player);
        const needed = swarm?.hitsToKill ?? 1;
        const index = swarm?.bugHits?.findIndex((h) => h < needed) ?? -1;
        if (index >= 0 && squashCrawler(match, player, index) !== null) {
          this.stats.defends += 1;
          return;
        }
      }
    }

    const action = decision.primary;

    // ── honour the reservation ────────────────────────────────────
    //
    // A purchase that would leave the seat unable to pay for a defence it has
    // already committed to becomes a wait. Only while a reaction is actually
    // pending, so ordinary play is untouched: `reservedGold` is zero whenever
    // no threat is being answered.
    const reserved = this.reservedGold(knowledge);
    if (reserved > 0) {
      const price =
        action.kind === "cast"
          ? (knowledge.self.kit[action.slot]?.cost ?? 0)
          : action.kind === "invest"
            ? (knowledge.self.kit[action.slot]?.investCost ?? 0)
            : action.kind === "buyCitizen"
              ? knowledge.self.citizenCost
              : action.kind === "repair"
                ? knowledge.self.repairCost
                : action.kind === "buyShield"
                  ? knowledge.self.shieldCost
                  : 0;
      // The shield purchase itself is exactly what the reservation is FOR, so
      // it is never blocked by it.
      if (price > 0 && action.kind !== "buyShield" && knowledge.self.currency - price < reserved) {
        this.stats.waits += 1;
        return;
      }
    }
    // ── the centrepiece reflex ────────────────────────────────────────
    //
    // ⚠️ AIMING AT THE MOUNTAIN WAS NOT ENOUGH, AND COULD NEVER HAVE BEEN.
    // The network has never seen a volcano: no genome in self-play has ever
    // faced one, and nothing in the observation describes it. Committed bots
    // held the target and then went on buying citizens — measured at four to
    // eight casts across four seats over a thirty-second eruption window, with
    // the mountain reaching its timer untouched every single time.
    //
    // So the swinging is a rule, exactly like the shield reflex above and for
    // exactly the same reason: there is no trade-off worth weighing while a
    // volcano is standing, and it is not learnable from a board the policy
    // cannot see. It picks the hardest thing it can currently pay for, which is
    // what "actively try to defeat it" means with a clock running.
    //
    // The monster runs on the same rule. The observation DOES describe it
    // (inputs 87–90) so a trained network can weigh it, but the rule stays for
    // the same reason the shield reflex does: a monster nobody commits to never
    // dies, and "everyone keeps hitting it" is not a strategy worth
    // rediscovering from scratch every training run.
    //
    // Falls THROUGH rather than returning when nothing is ready, so a bot on
    // cooldown still spends the decision on its economy instead of standing
    // still for thirty seconds.
    if (this.fieldLock !== null && player.target === this.fieldLock) {
      const slot = this.hardestHitFor(knowledge);
      if (slot !== null) {
        const ability = this.kit[slot]!;
        const charges = knowledge.self.kit[slot]?.charges ?? null;
        const result = activateAbility(match, player, ability, {
          targetId: this.fieldLock,
          // Everything it has: a volcano is a wall on a timer, and holding
          // charges back for a kingdom that may not be there in thirty seconds
          // is not a trade worth making. A monster has no timer, but it does
          // have an escalating bill for every cycle it survives, which prices
          // the held charge the same way.
          chargesToUse: charges
            ? chargesToSpend(1, charges.available, charges.costPerCharge, knowledge.self.currency)
            : undefined,
        });
        if (result.ok) {
          this.stats.casts += 1;
          return;
        }
        this.reject("cast", result.error);
      }
    }

    // ── banking for something worth casting ───────────────────────────
    //
    // ⚠️ THE NETWORK CANNOT SAVE, AND NOTHING IN THE ACTION SPACE LETS IT.
    // It picks one head per decision from what is legal RIGHT NOW, and a cast
    // it can afford is always legal, so the treasury is spent the moment it
    // covers the cheapest attack in the kit. It never arrives at the price of
    // anything else.
    //
    // Measured over three matches before this rule: 2,648 decision samples at
    // an average of 106 gold. The three cheapest abilities took 65% of all
    // casts, and every ability priced at 412 or above was affordable in 0% of
    // samples and cast exactly zero times across the whole run. That is not a
    // policy preferring cheap attacks — it is a policy that has never once been
    // solvent enough to see an expensive one offered.
    //
    // So the saving is a rule, for the same reason the shield reflex is: there
    // is no trade-off worth weighing in "spend your last 120 gold on the
    // weakest thing you own while the strong one is 30 seconds away", and it is
    // not reachable through an action space with no bank-this-tick head.
    //
    // Deliberately the same shape and the same constants as the heuristic
    // controller's savings logic, which already solves this — a play must be
    // SAVINGS_MARGIN better than what is already payable, and reachable inside
    // SAVINGS_LOOKAHEAD_TICKS, so a seat never freezes hoarding for something
    // its economy cannot reach.
    //
    // Placed AFTER the centrepiece reflex on purpose: a seat committed to a
    // monster swings with whatever it has, and must never stand in front of one
    // saving up.
    if (action.kind === "cast") {
      const target = this.savingsTarget(knowledge);
      const price = knowledge.self.kit[action.slot]?.cost ?? 0;
      if (target > 0 && price > 0 && knowledge.self.currency - price < target) {
        this.stats.waits += 1;
        return;
      }
    }

    switch (action.kind) {
      case "wait":
        this.stats.waits += 1;
        return;
      case "buyCitizen": {
        const result = buyCitizen(match, player);
        if (result.ok) this.stats.citizens += 1;
        else this.reject("citizen", result.error);
        return;
      }
      case "repair": {
        const result = repairCastle(match, player);
        if (result.ok) this.stats.repairs += 1;
        else this.reject("repair", result.error);
        return;
      }
      case "buyShield": {
        const result = buyShield(match, player);
        if (result.ok) this.stats.shields += 1;
        else this.reject("shield", result.error);
        return;
      }
      case "invest": {
        const ability = this.kit[action.slot];
        if (ability === undefined) return;
        const result = unlockOrUpgradeAbility(match, player, ability.id);
        if (result.ok) this.stats.invests += 1;
        else this.reject("invest", result.error);
        return;
      }
      case "cast": {
        const ability = this.kit[action.slot];
        if (ability === undefined) return;
        const charges = knowledge.self.kit[action.slot]?.charges ?? null;
        const resolved = knowledge.self.kit[action.slot];
        const primaryId = player.target ?? undefined;

        // ── payloads the engine demands, built from the auxiliary heads ────
        //
        // Each is supplied ONLY when the ability actually takes it. Passing a
        // second target to an ability that does not want one is harmless, but
        // passing none to BFFS is a guaranteed SECOND_TARGET_REQUIRED — the
        // rejection the mask used to avoid by refusing the cast outright.
        // ⚠️ EXCLUDE BANNED AND ELIMINATED SEATS, because the engine does. It
        // validates a second target against `isTargetingBlocked` and refuses
        // the whole cast with INVALID_TARGET otherwise — 19 such refusals in a
        // single seven-seat match before this filter existed. A rejected cast
        // teaches the policy only that the slot is broken.
        const others = orderEnemies(knowledge).filter(
          (e) => e.id !== primaryId && !e.eliminated && !e.targetBanned,
        );
        const pick = (fraction: number, count: number): number =>
          count <= 0 ? -1 : Math.min(count - 1, Math.floor(fraction * count));

        let targetIds: string[] | undefined;
        if (resolved?.needsSecondTarget && others.length > 0) {
          const index = pick(decision.secondTargetPick ?? 0, others.length);
          if (index >= 0 && primaryId) targetIds = [primaryId, others[index]!.id];
        } else if (decision.spread && resolved?.canSpread && primaryId) {
          // Air's Embrace of Winds. The engine caps the count and divides the
          // damage; handing it the ordered enemies lets it take as many as the
          // ability currently allows.
          targetIds = [primaryId, ...others.map((e) => e.id)];
        }

        const choices = resolved?.choices;
        const choice =
          choices && choices.length > 0
            ? choices[Math.max(0, pick(decision.choicePick ?? 0, choices.length))]
            : undefined;

        const result = activateAbility(match, player, ability, {
          targetId: primaryId,
          targetIds,
          choice,
          chargesToUse: charges
            ? chargesToSpend(
                decision.chargeFraction,
                charges.available,
                charges.costPerCharge,
                knowledge.self.currency,
              )
            : undefined,
        });
        if (result.ok) this.stats.casts += 1;
        else this.reject("cast", result.error);
        return;
      }
    }
  }
}

function onlyWaitIsLegal(mask: ActionMask): boolean {
  for (let i = 0; i < PRIMARY_ACTION_COUNT; i++) {
    if (i !== WAIT && mask[i] === 1) return false;
  }
  return true;
}

/**
 * A controller driven by a randomly-drawn network.
 *
 * Its purpose is not to play well — it is to prove that game → visibility →
 * knowledge → 64 observations → network → 22 outputs → mask → legal action →
 * game actually carries current, in real matches, before any NEAT code exists.
 * Deliberately unoptimized.
 */
export function randomNetworkAI(difficulty: Difficulty = "hard"): AIFactory {
  return (player, rng) =>
    new NetworkController(player, { network: randomNetwork(rng), rng, difficulty });
}

/** Binds an existing network to the controller contract. */
export function networkAI(
  network: Network,
  difficulty: Difficulty = "hard",
): AIFactory {
  return (player, rng) => new NetworkController(player, { network, rng, difficulty });
}

export { DEFAULT_DECISION_PERIOD };
