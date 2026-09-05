/**
 * Centralized game-balance constants for Kingdoms.
 *
 * This is the single source of truth for tunable gameplay values (see
 * ARCHITECTURE.md — data declares *what*, systems declare *how*). Nothing here
 * contains logic; systems import these values rather than hardcoding them, so
 * rebalancing is a data-only change. Values are snapshotted into a match's
 * config at start (see DATA_MODELS.md → MatchConfig) so live edits never disturb
 * an in-progress match.
 *
 * NOTE: magnitudes below are initial defaults and are expected to be tuned by
 * later balance tickets.
 */

/** Castle defaults. */
export const CASTLE = {
  /** Starting Castle HP for every player. */
  STARTING_HP: 10_000,
  /** Maximum HP restored by a single repair action. */
  REPAIR_AMOUNT: 1250,
  /** Flat base cost of a repair (before growth scaling). */
  REPAIR_COST: 350,
  /**
   * Multiplicative cost growth per repair already purchased, so repeated
   * repairs get progressively more expensive (500 → 625 → 781).
   */
  REPAIR_COST_GROWTH: 1.25,
  /**
   * Hard cap on purchased repairs per match. Ability-based healing (Riptide,
   * lifesteal, …) is NOT limited — only the shop's repair button.
   */
  MAX_REPAIRS: 4,
} as const;

/** Citizen / economy defaults. */
export const CITIZENS = {
  /** Number of citizens each player begins a match with. */
  STARTING_COUNT: 10,
} as const;

/** Economy tuning. */
export const ECONOMY = {
  /** Money awarded per citizen, per tick (0.05 per tick = 1.00 per second at 20 ticks/sec). */
  INCOME_PER_CITIZEN: 0.06,
  /** Base cost of the first purchased citizen. */
  CITIZEN_COST: 25,
  /**
   * Multiplicative cost growth per citizen already purchased, so each purchase
   * costs more (progressive scaling): cost = CITIZEN_COST × GROWTH^purchased,
   * rounded to whole dollars.
   */
  CITIZEN_COST_GROWTH: 1.10,
} as const;

/** Combat defaults shared by all abilities unless overridden by ability data. */
export const COMBAT = {
  /** Base chance (0–1) for an attack to critically strike. */
  BASE_CRIT_CHANCE: 0.05,
  /** Damage multiplier applied on a critical strike. */
  BASE_CRIT_MULTIPLIER: 1.5,
  /**
   * "Besieged" comeback bonus — the game's anti-bullying rule.
   *
   * WHY IT EXISTS: this is a party game, and almost nothing about an opponent
   * is public. You cannot see their gold, their economy, or their upgrades
   * (Air's "Bird's Eye View" is an ABILITY precisely because that information
   * is otherwise hidden). So a table cannot identify "whoever is winning" and
   * gang up on them strategically — it can only pick on someone, which is
   * arbitrary and miserable for that player.
   *
   * Besieged makes picking on one kingdom expensive. Every enemy *beyond the
   * first* currently targeting you raises both your outgoing damage and your
   * gold production, so a fair 1v1 is untouched and a pile-on funds the
   * victim's escape.
   *
   * THE CURVE IS EXPONENTIAL, NOT LINEAR, AND THAT IS THE WHOLE POINT. Two
   * kingdoms aiming at you in a seven-player free-for-all is ordinary traffic,
   * not bullying, so the first stack is a nudge. Six is the entire rest of the
   * table, so the last stack is enormous. A linear ramp would leave the brake
   * half-engaged during normal play and too weak when it is actually needed.
   *
   * Indexed by STACK COUNT (attackers beyond the first): index 0 = 1 stack =
   * 2 attackers, index 5 = 6 stacks = 7 attackers = every other kingdom in a
   * full lobby. 0 stacks is always ×1 and is not in the table.
   *
   * Both curves are geometric between their endpoints, so the shape stays
   * smooth if the endpoints are retuned: each step multiplies by a constant
   * ratio (damage ×1.32, income ×1.46). Keep them the same length as
   * `BESIEGED_MAX_STACKS`.
   */
  /**
   * Outgoing attack damage while besieged: 2 attackers → ×1.25, rising to
   * ×5 when all six of the others have turned on you.
   */
  BESIEGED_DAMAGE_CURVE: [1.25, 1.65, 2.18, 2.87, 3.79, 5] as readonly number[],
  /** Cap on besieging attackers that count toward the bonus (beyond the first).
   *  With 7 playing kingdoms, 6 stacks is literally everyone else. */
  BESIEGED_MAX_STACKS: 6,
  /**
   * Besieged also rallies your economy: each besieging attacker beyond the
   * first grants this many extra gold PER SECOND (your citizens work harder to
   * fund the defense). Uses the same capped stack count as the damage bonus.
   *
   * Deliberately still FLAT and linear, unlike the multiplier below. It is the
   * early-game half of the comeback: a player who has been picked on before
   * building an economy has little for a multiplier to multiply, and this pays
   * them anyway.
   */
  BESIEGED_INCOME_PER_ATTACKER: 4,
  /**
   * "Besieged" income MULTIPLIER: gold production while ganged up on. Unlike
   * the flat top-up above, this scales with the economy you actually built, so
   * it still matters late — which is when a comeback has to happen.
   *
   * 2 attackers → ×1.5, all six → ×10. The stack cap is what keeps this
   * bounded rather than open-ended.
   *
   * ⚠️ The boosted curve below is derived from this one and must stay strictly
   * above it, or Space's "Vast Universe" loses the trait that defines it —
   * `besieged.test.ts` asserts it.
   */
  BESIEGED_INCOME_CURVE: [1.5, 2.19, 3.2, 4.68, 6.84, 10] as readonly number[],
  /**
   * For the kingdom whose passive profits from being ganged up on (Space's
   * "Vast Universe"), the income BONUS — the part above ×1 — is multiplied by
   * this. At 2, "the same, doubled" is the relationship, exactly as it was
   * before the curve replaced the old flat rate: ×1.5 becomes ×2, ×10 becomes
   * ×19.
   *
   * Expressed as a factor on the bonus rather than as a second table so the two
   * cannot drift apart when the base curve is retuned. Space's own passive
   * multiplier still stacks on top — being everyone's target IS Space's economy.
   */
  BESIEGED_INCOME_BOOST_FACTOR: 2,

  // --- Persistent-siege escalation ----------------------------------------
  //
  // The exponential curve above is deliberately gentle at the bottom, because
  // two kingdoms aiming at you at the same moment is usually coincidence. But
  // coincidence does not LAST. If the same small group is still on you a minute
  // later, that is a team, and the victim needs more than the two-attacker
  // nudge.
  //
  // So a coalition that holds gets the victim extra besieged STAGES on top of
  // the raw attacker count: one after `SIEGE_ESCALATION_TIER_SECONDS[0]`,
  // another after `[1]`, and no more. Stages are the same units as the curve
  // index, so an escalated 2-attacker siege pays what a 3-attacker one pays.
  /**
   * Seconds the SAME coalition must hold before each additional stage. Two
   * entries = at most two extra stages, ever.
   */
  SIEGE_ESCALATION_TIER_SECONDS: [60, 180] as readonly number[],
  /**
   * Coalition sizes this applies to. Below the minimum there is no siege at
   * all; above the maximum the whole table is already on one kingdom and the
   * raw curve is doing the work — a deliberate team of five is just a
   * free-for-all.
   */
  SIEGE_ESCALATION_MIN_MEMBERS: 2,
  SIEGE_ESCALATION_MAX_MEMBERS: 4,
  /**
   * How long an attacker may look away before it counts as leaving.
   *
   * ⚠️ THIS IS THE ANTI-ABUSE RULE. Without it a coalition drops one member for
   * a single tick every 59 seconds and the timer never fires. Inside the grace
   * window the timer PAUSES rather than resets: leave for 5 s and come back and
   * you resume from where you left off, so a brief dip costs the attackers the
   * time they were away and nothing more.
   */
  SIEGE_ABSENCE_GRACE_SECONDS: 10,
} as const;

/**
 * Perk magnitudes. Every player picks `PERKS.PER_PLAYER` perks in the lobby;
 * each is a pure data point the engine multiplies/adds in at one place, and
 * they stack with kingdom passives and abilities rather than replacing them
 * (see `data/perks.ts` for the catalogue and `engine/perks.ts` for wiring).
 */
export const PERKS = {
  /** Perks each player must select before they can ready up. */
  PER_PLAYER: 2,
  /** "Sharper Swords": outgoing ability damage. */
  ATTACK_PCT: 0.1,
  /** "Sharper Axes": extra outgoing damage against a shielded castle. */
  SHIELD_ATTACK_PCT: 0.15,
  /** "Extra Guards": all incoming damage. */
  DAMAGE_REDUCTION_PCT: 0.1,
  /** "Extra Medics": incoming damage-over-time (status tick) damage. */
  DOT_REDUCTION_PCT: 0.5,
  /** "Extra Repairs": every ability cooldown. */
  COOLDOWN_REDUCTION_PCT: 0.1,
  /** "Deep Pockets": gold in the bank at match start. */
  STARTING_GOLD: 250,
  /** "Great Merchants": discount on ability unlock prices. */
  UNLOCK_DISCOUNT_PCT: 0.75,
  /** "Better Construction": extra health on every shield gained. */
  SHIELD_BONUS_HP: 500,

  // --- Boosted magnitudes (Dark's "Black Magic") ---------------------------
  // Dark runs every perk it picked at these values instead of the base ones
  // above. Each `*_BOOSTED` entry MUST stay paired with its base entry; the
  // perk engine picks between the two and nothing else reads them.
  ATTACK_PCT_BOOSTED: 0.15,
  SHIELD_ATTACK_PCT_BOOSTED: 0.2,
  DAMAGE_REDUCTION_PCT_BOOSTED: 0.15,
  DOT_REDUCTION_PCT_BOOSTED: 0.2,
  COOLDOWN_REDUCTION_PCT_BOOSTED: 0.15,
  STARTING_GOLD_BOOSTED: 200,
  UNLOCK_DISCOUNT_PCT_BOOSTED: 0.2,
  SHIELD_BONUS_HP_BOOSTED: 750,
} as const;

/** Lobby / room defaults. */
export const LOBBY = {
  /** Number of characters in a generated room code. */
  ROOM_CODE_LENGTH: 4,
} as const;

/** Match / player-count rules. */
export const MATCH = {
  /** Minimum players required to start a match. */
  MIN_PLAYERS: 2,
  /** Maximum total seats in a room (players + spectators). */
  MAX_PLAYERS: 8,
  /** Maximum kingdom-playing participants; the remaining seat(s) up to
   *  MAX_PLAYERS may only join as spectators. */
  MAX_ACTIVE_PLAYERS: 7,
} as const;

/** Game-loop timing. */
export const TICK = {
  /** Server ticks per second (see GAME_TICK.md). */
  RATE: 20,
  /** Broadcast a game-state sync every N ticks (20/2 = ~10 Hz). */
  SYNC_EVERY_TICKS: 2,
} as const;

/** Shield defaults. */
/**
 * How a bigger table changes what a castle can take.
 *
 * ⚠️ MORE PLAYERS MEANS MORE INCOMING DAMAGE, not more time. In a 7-player
 * free-for-all a castle can be the target of six kingdoms at once while still
 * only earning one kingdom's income, so a health pool sized for a duel is spent
 * far faster than the match can be won. These scale the pool with the table
 * rather than asking every ability to be tuned twice.
 *
 * Counted from TWO, so a duel is unchanged: at `n` players a castle starts with
 * `1 + HP_PER_EXTRA_PLAYER * (n - 2)` times its base health.
 */
export const PLAYER_SCALING = {
  /** Extra starting castle HP per player above the second. */
  HP_PER_EXTRA_PLAYER: 0.1,
  /**
   * Extra starting SHIELD per player above the second.
   *
   * Half the health rate on purpose: a shield is a burst of protection that
   * arrives once, and scaling it as hard as the health pool would make the
   * opening of a large game swingier rather than longer.
   */
  SHIELD_PER_EXTRA_PLAYER: 0.05,
  /**
   * The same rate again for the perk that reinforces a shield, so a buff bought
   * in a seven-player game is worth what it is worth in a duel RELATIVE to the
   * shield it reinforces. Without it the reinforcement would shrink as a share
   * of a scaled shield every time the table grew.
   */
  SHIELD_BONUS_PER_EXTRA_PLAYER: 0.05,
} as const;

export const SHIELD = {
  /** Health of the standard purchasable shield. */
  STANDARD_HP: 1750,
  /** Cost of the first shield (matches the client's shop display). */
  COST: 300,
  /**
   * Multiplier applied per shield already bought this match, so each shield
   * costs a little more than the last (400 → 420 → 441 → …). Only one shield
   * can be active at a time, so this scales with cumulative purchases.
   */
  COST_GROWTH: 1.05,
  /**
   * After a shield is broken by damage, this many ticks must pass before a new
   * one can be bought (7.5 s) — you can't instantly re-wall mid-assault.
   */
  BREAK_COOLDOWN_TICKS: 7.5 * 20,
} as const;

/** Space kingdom — the Supernova charge meter (Shooting Star / Saturn's Rings /
 *  Orion's Belt misses fill it; Supernova fires at the current level). */
/**
 * Party Mode.
 *
 * ⚠️ THE ROLL IS THE MONSTER'S ROLL, DELIBERATELY. Same `living / 10` shape,
 * same freeze while a centrepiece stands. Two different curves for "the field
 * interrupts the match" would need two explanations and drift apart.
 *
 * Rewards on games the spec left open (the maze, memory's win, the lock) are
 * set here rather than inside the games, so a balance pass is one file.
 */
export const PARTY = {
  /** How long into a match the first roll happens. */
  FIRST_ROLL_SECONDS: 25,
  /** Seconds between rolls after that. */
  ROLL_INTERVAL_SECONDS: 25,
  /** Chance per roll is `living kingdoms / this`. */
  CHANCE_DIVISOR: 10,
  /** How long a result banner stays up before the session clears. */
  RESULT_SECONDS: 4,

  /** Maze: a 10x10 grid, fifteen seconds, gold for getting out. */
  MAZE_SIZE: 10,
  MAZE_SECONDS: 15,
  MAZE_REWARD: 400,

  /** Spot the difference: how many ornaments, and how forgiving a tap is. */
  SPOT_ORNAMENTS: 7,
  /** Castle viewBox units. Generous on purpose — half the table has a thumb. */
  SPOT_TAP_RADIUS: 16,
  SPOT_MAX_SECONDS: 30,

  /** Blackjack: the floor on a broke player's stake, and how far a split goes. */
  BLACKJACK_MIN_STAKE: 100,
  BLACKJACK_MAX_HANDS: 4,
  BLACKJACK_MAX_SECONDS: 40,
  /**
   * How long the table stays up after the dealer turns over.
   *
   * ⚠️ THE HAND SETTLED THE INSTANT YOU STOOD, AND THE PANEL LEFT WITH IT — so
   * the dealer's hole card, the cards they drew to it and whether you won were
   * all decided on a screen nobody saw. The money is not in question here; this
   * is only the difference between being told the result and watching it.
   */
  BLACKJACK_REVEAL_SECONDS: 3.5,

  /** Memory: the countdown, the flash rate, and what it pays. */
  MEMORY_COUNTDOWN_SECONDS: 3,
  /**
   * How long each symbol holds before the next one.
   *
   * Slowed by a quarter from 650ms. Everything else about the game is derived
   * from this — when the question may be asked, how long the round can run —
   * so it is the only number that moves.
   */
  MEMORY_FLASH_MS: 813,
  MEMORY_REWARD: 500,
  MEMORY_PENALTY: 1000,
  MEMORY_MAX_SECONDS: 35,

  /** Lockpick: five locks, and the window they are picked in. */
  LOCK_TARGET: 5,
  LOCK_ZONE_DEGREES: 46,
  LOCK_SPEED_DEGREES: 150,
  LOCK_REWARD: 400,
  LOCKPICK_MAX_SECONDS: 35,

  /** Don't Move: how long to sit still, and what a twitch costs. */
  DONT_MOVE_SECONDS: 6,
  DONT_MOVE_PENALTY: 5000,

  /**
   * Kingdom Swap: how long a borrowed kit lasts.
   *
   * Long enough to actually cast something twice — a swap shorter than a
   * cooldown is a swap the player never gets to use.
   */
  SWAP_SECONDS: 30,

  /** Haunted: how long the dead walk, and what they walk with. */
  HAUNTED_SECONDS: 25,
  GHOST_CITIZENS: 45,

  /** Gold Party: ten seconds of rain, and what each coin is worth. */
  GOLD_PARTY_SECONDS: 10,
  COINS_PER_SECOND: 4,
  COIN_BRONZE: 25,
  COIN_SILVER: 50,
  COIN_GOLD: 100,

  /**
   * Clean Up: how long the mess lasts and how much of it there is.
   *
   * Twenty seconds is the longest event in the mode by some way, and it can be
   * because it takes nothing: no damage, no gold, no penalty for ignoring it.
   */
  CLEAN_UP_SECONDS: 20,
  MESS_SPLATS: 7,

  /**
   * The barrier games (Kingdom Thief, Pick a Chest): how long the table has to
   * commit, and how late the countdown appears.
   *
   * ⚠️ THE COUNTDOWN IS HIDDEN UNTIL THE LAST THREE SECONDS ON PURPOSE. A
   * timer running the whole time turns a decision into a stopwatch — everyone
   * waits for it and nobody thinks — and in a game whose point is reading the
   * table, ten seconds of ticking clock is ten seconds of pressure with nothing
   * to spend it on. Three seconds is a prompt to decide, not a metronome.
   */
  CHOICE_SECONDS: 10,
  COUNTDOWN_VISIBLE_SECONDS: 3,

  /**
   * How long after the first kingdom finishes a minigame before the middle of
   * the field can be claimed again.
   *
   * ⚠️ ATTACKS COME BACK IMMEDIATELY; CENTREPIECES DO NOT. A volcano, a black
   * hole or a monster arriving on the same beat a minigame releases the table
   * means the players still finishing look up from a maze into an ultimate they
   * had no chance to answer. Three and a half seconds is the width of that
   * unfairness: long enough for the rest of the table to be back on the board,
   * short enough that nobody notices a pause.
   */
  CENTREPIECE_GRACE_SECONDS: 3.5,

  /** Kingdom Thief: what cooperation pays, what mutual theft costs. */
  THIEF_KEEP_REWARD: 1000,
  THIEF_ALL_STEAL_DAMAGE: 2500,
  THIEF_STEAL_REWARD: 2000,

  /** Pick a Chest: the good one, the poor one, and the trap. */
  CHEST_BIG: 500,
  CHEST_SMALL: 150,
  CHEST_TRAP: 2000,

  /**
   * Reaction: the wait before the button turns, and what coming last costs.
   *
   * Three seconds minimum, not two: the button has to APPEAR before it can be
   * waited for, and a player whose panel is still sliding in has not started
   * watching yet. Anything shorter turns "react" into "already be looking".
   */
  REACTION_MIN_DELAY_SECONDS: 3,
  REACTION_MAX_DELAY_SECONDS: 7,
  REACTION_PENALTY: 2000,
  REACTION_MAX_SECONDS: 20,

  /** Quick Math: what the slowest correct answer costs. */
  QUICK_MATH_PENALTY: 1500,
  QUICK_MATH_MAX_SECONDS: 30,

  /**
   * Button Mash: five seconds, and the ceiling on a believable click rate.
   *
   * ⚠️ THE CAP IS AN ANTI-CHEAT, NOT A REFEREE. Clicks are batched over the
   * wire, so the count is a number the client chose; twenty a second is well
   * past what anybody can actually manage (a good masher does twelve), which
   * makes lying pointless without ever capping honest play.
   */
  MASH_SECONDS: 5,
  MASH_MAX_PER_SECOND: 20,
  MASH_HEAL: 1000,
  MASH_PENALTY: 2000,

  /** Bomb Attack: how long it runs, and what it does to whoever held it most. */
  BOMB_SECONDS: 20,
  BOMB_DAMAGE: 3000,

  /**
   * Bot standard lives in `engine/party/bots.ts`, not here.
   *
   * ⚠️ DELIBERATELY NOT A BALANCE CONSTANT. How well a bot plays depends on
   * the DIFFICULTY of its seat (easy 50%, medium 75%, hard 90%) and on the
   * game, so a single number here was wrong the moment difficulty was honoured
   * — and a leftover constant that nothing reads is worse than no constant,
   * because the next person tunes it and nothing happens.
   */
} as const;

export const SPACE = {
  /**
   * Cumulative meter "xp" required to reach Supernova levels 1, 2, and 3. The
   * cost per level ramps: 50 to reach L1, +100 for L2 (150 total), +200 for L3
   * (250 total). The last entry doubles as the full-charge cap.
   */
  SUPERNOVA_LEVEL_THRESHOLDS: [50, 150, 250],
  /**
   * Seconds between a Black Hole collapsing and its pooled damage landing.
   *
   * ⚠️ THIS NUMBER BELONGS TO THE ANIMATION, and the animation is on the other
   * side of the wire. The collapse plays as implosion → a 2.6s crackling
   * singularity hold → a 0.5s beam charge → the Judgment Beam, so nothing
   * actually touches the victim's castle until 3.1 seconds after the event
   * (`BLACK_HOLE_CONFIG` in the client's `render/effects.ts`). Dealing the
   * damage on the collapse tick killed kingdoms three seconds before the beam
   * that killed them existed — and an eliminated castle is removed, so the beam
   * then fired at nothing.
   *
   * The extra half second past 3.1 puts the number on screen while the beam is
   * pouring into the castle rather than at the instant it arrives.
   *
   * If the client's collapse timings change, this changes with them.
   */
  BLACK_HOLE_DUMP_DELAY_SECONDS: 3.6,
} as const;

/** Dark kingdom — the Unlimited Rage meter. */
export const DARK = {
  /**
   * Total damage Dark must absorb for Unlimited Rage to reach full charge.
   * The meter fills by exactly the damage taken, so a big hit is worth
   * proportionally more than a poke — but the total is all that matters.
   *
   * Lowered from 2000 so the meter fills roughly a third sooner; Unlimited
   * Rage's payload is deliberately unchanged at 1500, so this makes the
   * ability reachable more often rather than stronger when it lands.
   */
  RAGE_FULL: 1250,
} as const;

/** Kitsune kingdom — the "Ancient Memory" meter ("Swift Tails"). */
export const KITSUNE = {
  /**
   * A full Ancient Memory meter — what Kitsune Rush costs. Never shown as a
   * number: the HUD renders progress toward it, because "how full" is the only
   * part a player needs.
   */
  MEMORY_FULL: 6000,
  /**
   * Filled passively, per second, whatever Kitsune is doing. Set so a Kitsune
   * that does NOTHING at all still reaches a full meter in exactly three
   * minutes — that is the floor the ultimate is paced against, and everything
   * else (attacks, Old Friends, Azure Guidance) only brings it forward.
   */
  MEMORY_PER_SECOND: 6000 / 180,
  /** Plus this share of every point of damage Kitsune deals: acting fills it
   *  several times faster than waiting, without waiting ever being useless. */
  MEMORY_PER_DAMAGE: 0.15,
  /** Azure Guidance: how much faster Memory accrues while it holds. */
  AZURE_GUIDANCE_MULTIPLIER: 2,
  /** How long Azure Guidance lasts. */
  AZURE_GUIDANCE_DURATION_SECONDS: 12,
  /** Kitsune Rush: cooldowns run at this rate (0.5 = twice as fast). */
  RUSH_COOLDOWN_RATE: 0.5,
  /** Kitsune Rush: gold production multiplier. */
  RUSH_INCOME_MULTIPLIER: 2,
  /** How long Kitsune Rush lasts. */
  RUSH_DURATION_SECONDS: 15,
} as const;

/** Magma kingdom — "Hot ash". */
/**
 * Fire's "Ignited" (Scorching Sun). Not a burn — a long-lived mark that keeps
 * ROLLING for one. The victim is never sure whether the next quarter-minute
 * costs them anything, which is what makes covering for it a real decision.
 */
export const FIRE = {
  /** How long the mark lasts. */
  IGNITED_SECONDS: 60,
  /** How often it rolls for a burn. */
  IGNITED_ROLL_SECONDS: 15,
  /** Odds of each roll catching. */
  IGNITED_BURN_CHANCE: 0.25,
  /** How long a burn it lights lasts. */
  IGNITED_BURN_SECONDS: 5,
} as const;

/**
 * Insects. Both passives reward not being the kingdom everyone is hitting:
 * one turns a share of what does land into income, the other pays out for
 * being left alone.
 */
export const INSECTS = {
  /** "Cocoon": odds that an incoming ATTACK is partly cocooned. Rolled once
   *  per attack, never per damage-over-time tick — a 5% roll twenty times a
   *  second would fire constantly and mean nothing. */
  COCOON_CHANCE: 0.05,
  /** How much of a cocooned hit becomes gold instead of damage. */
  COCOON_GOLD_PCT: 0.1,
  /** "Fruit Fly": how long Insects must go untouched before it starts to heal.
   *  Long enough that it is a reward for being ignored rather than something
   *  that ticks between the beats of a fight. */
  FRUIT_FLY_IDLE_SECONDS: 15,
  /** Regeneration once idle, as a fraction of MAX castle HP per second. A
   *  percentage rather than a flat figure so it scales with whatever a castle
   *  is worth. */
  FRUIT_FLY_REGEN_PCT_PER_SECOND: 0.002,

  /** "Venom Shot": odds the basic attack leaves poison behind. */
  VENOM_CHANCE: 0.35,
  /** Venom's damage per tick, per stack. */
  VENOM_TICK: 6,
  /** How long venom lasts. */
  VENOM_SECONDS: 6,

  /** "Butterflies": how much of the target's damage reduction it strips, as a
   *  multiplier on the damage they take. */
  BUTTERFLIES_DAMAGE_TAKEN: 1.1,
  /** …and the chance their OWN attacks now miss. Half of everything they throw
   *  for the duration — crippling on its own, and the reason Infected is worth
   *  paying for, since every one of those whiffs then rebounds onto them. */
  BUTTERFLIES_MISS_CHANCE: 0.5,
  /** How long both halves of the debuff last. */
  BUTTERFLIES_SECONDS: 10,

  /** "Infected": how long a victim keeps deflecting their own misses. */
  INFECTED_SECONDS: 15,

  /** "Creepy Crawlers": how many bugs are sent. */
  CRAWLER_COUNT: 3,
  /** Clicks needed to squash ONE of them. */
  CRAWLER_HITS_TO_KILL: 2,
  /** Gold drained per second, by EACH bug still alive. The drain therefore
   *  falls as the victim swats them, so squashing one is worth something
   *  immediately rather than only on the last one. */
  CRAWLER_DRAIN_PER_SECOND: 22,
  /** How long they stay if the victim never swats them. */
  CRAWLER_SECONDS: 20,

  /** "Caprice": how long the butterfly holds the field. */
  CAPRICE_SECONDS: 25,
  /** How often it re-rolls everyone's target. */
  CAPRICE_SCRAMBLE_SECONDS: 1,
} as const;

export const MAGMA = {
  /** Extra damage dealt to a kingdom that is currently targeting Magma. */
  HOT_ASH_DAMAGE_PCT: 0.25,
  /**
   * How often the warning fires. Every kingdom currently targeting Magma is
   * marked for `HOT_ASH_MARK_TICKS` — a periodic reminder that aiming at Magma
   * is what makes its attacks hurt more.
   */
  HOT_ASH_INTERVAL_TICKS: 45 * TICK.RATE,
  /** How long the mark stays up. */
  HOT_ASH_MARK_TICKS: 3 * TICK.RATE,
  /** Lava Punch: chance the basic attack also sets the target alight. */
  LAVA_PUNCH_BURN_CHANCE: 0.35,
  /** "Floor is Lava": how much harder EVERY burn on the field hits. */
  /** Eruption's odds of setting a burn. Low: Eruption is the big hit, not the
   *  reliable way to light someone. */
  ERUPTION_BURN_CHANCE: 0.2,
  /** Every Magma attack hits this much harder while the floor is lava. */
  LAVA_FLOOR_ATTACK_MULTIPLIER: 1.1,
  LAVA_FLOOR_BURN_MULTIPLIER: 1.5,
  /**
   * Damage per tick the molten floor itself deals to every kingdom standing on
   * it — which is everyone except Magma, who is immune to its own floor.
   *
   * ⚠️ A NUDGE, NOT A SOURCE OF DAMAGE, AND IT IS NOT A BURN. At 1 a tick
   * over twenty seconds it is 400 across a full table — enough that standing
   * on the floor costs something and a kingdom already at the edge can be
   * finished by it, and far too little to make the ability about its own
   * damage. Its real value is still the multiplier it puts on everyone's burns.
   * (It started at 6 and that was too much of a weapon.) Marking it `isBurn`
   * would have the floor fan its own damage by LAVA_FLOOR_BURN_MULTIPLIER.
   */
  LAVA_FLOOR_TICK_DAMAGE: 1,
  /** How long the floor stays molten, in seconds. */
  LAVA_FLOOR_DURATION_SECONDS: 20,
  /**
   * Magma's burn, per tick per stack, while the victim has a shield up. It
   * still goes THROUGH the shield ("Hotter fire") — just for less, so a shield
   * is worth buying against Magma without shutting it out.
   */
  SHIELDED_BURN_TICK: 4,
  /** Smoke Screen: damage dealt to each kingdom currently targeting Magma. */
  SMOKE_SCREEN_DAMAGE: 200,
  /** How long the smoke blinds them, in seconds. */
  SMOKE_SCREEN_BLIND_SECONDS: 4,
  /**
   * "The End of the World": what the eruption is worth. The field takes this
   * MINUS whatever it managed to chip off the volcano, so breaking it entirely
   * is a clean escape and doing nothing is the full hit.
   */
  VOLCANO_ERUPTION_YIELD: 5000,
  /** How long the field has to break it, in seconds. */
  VOLCANO_TIMER_SECONDS: 20,
} as const;

/**
 * The monster: the one thing on the field that nobody summoned.
 *
 * Every ultimate that owns the middle of the battlefield belongs to a kingdom
 * that chose to spend on it. This does not. Ninety seconds in, the field starts
 * rolling for a monster, and once one is standing the table has a shared problem
 * that no single kingdom can solve and none of them asked for.
 *
 * ⚠️ IT HAS NO TIMER. Every other centrepiece leaves on its own; this one leaves
 * when it is dead. That is what makes it a cooperation engine rather than
 * another thing to wait out — waiting costs 250 a head and rising, and the four
 * centre-of-the-field ultimates stay locked out the whole time it stands.
 *
 * The rewards are deliberately split so that the kingdom which hits hardest and
 * the kingdom which lands the final blow are usually not the same seat: Water
 * and Love cannot win a damage race, but anybody can take the last swing.
 */
export const MONSTER = {
  /**
   * How long into a match the field starts rolling, in seconds.
   *
   * Late enough that the economy phase is over and kits are unlocked. A monster
   * arriving while everyone is still buying citizens is not a shared problem,
   * it is a coin flip about who had bought an attack yet.
   */
  FIRST_ROLL_SECONDS: 90,
  /** Seconds between spawn rolls after the first. */
  ROLL_INTERVAL_SECONDS: 30,
  /**
   * Spawn chance per roll is `living kingdoms / this`.
   *
   * Scaled by the table on purpose: a duel faces 20% a roll and a seven-player
   * game 70%, which is the right shape twice over. A big table both wants the
   * interruption more (seven-way free-for-alls stalemate) and can actually pay
   * the 14,000 health bill.
   */
  SPAWN_CHANCE_DIVISOR: 10,
  /** Health per living kingdom, for the FIRST monster of a match. */
  HP_PER_PLAYER: 2000,
  /**
   * How much the per-kingdom health grows with every monster after the first.
   *
   * ⚠️ PER MATCH, NOT PER MONSTER'S LIFETIME. The second monster of a game is
   * 2,500 a kingdom, the third 3,000, and so on. The table is richer and better
   * armed every time one shows up, and a later monster built to the opening
   * number is a free multiplier rather than an interruption — which is the
   * opposite of what this mechanic is for.
   */
  HP_PER_PLAYER_STEP: 500,
  /** Seconds between attack cycles — rolled fresh each time, inclusive range. */
  ATTACK_INTERVAL_MIN_SECONDS: 7,
  ATTACK_INTERVAL_MAX_SECONDS: 10,
  /**
   * Chance an attack cycle lands. ONE roll for the whole table, not one per
   * kingdom: when it swings, everybody is hit, and when it misses, nobody is.
   * A per-player roll would average out into a steady drain; a shared roll makes
   * each cycle an event the whole table watches.
   */
  ATTACK_CHANCE: 0.75,
  /** Damage the first successful cycle deals to each kingdom. */
  ATTACK_DAMAGE: 250,
  /**
   * How much a successful cycle raises the damage of every cycle after it,
   * rolled in this inclusive range.
   *
   * Per CYCLE, not per kingdom hit — a cycle that strikes seven castles raises
   * it once. Escalating per hit would multiply the ramp by the table size, and
   * a seven-player game would be dealing four-figure hits inside two minutes.
   */
  ATTACK_ESCALATION_MIN: 25,
  ATTACK_ESCALATION_MAX: 50,
  /**
   * Gold-production multiplier per reward earned, and how long it lasts.
   *
   * The two rewards MULTIPLY rather than being a separate "both" tier: one
   * reward is ×1.5, and a kingdom that both out-damaged everyone and landed the
   * finishing blow gets ×1.5 twice — ×2.25. Stated as one number so the "both"
   * case cannot drift away from the single case.
   */
  REWARD_MULTIPLIER: 1.5,
  REWARD_DURATION_SECONDS: 30,
} as const;

/** Targeting rules. */
export const TARGETING = {
  /** Anti-spam cooldown between switching targets, in seconds. */
  SWITCH_COOLDOWN_SECONDS: 3.5,
  /** The same cooldown in ticks, derived from the tick rate (3.5 s × 20 = 70). */
  SWITCH_COOLDOWN_TICKS: 3.5 * TICK.RATE,
} as const;

/** Reconnection handling. */
export const RECONNECT = {
  /**
   * Grace period (ms) a disconnected player is kept in their seat before being
   * removed. During this window their slot, position, and kingdom stay reserved
   * so nobody else can take them. Default 60 seconds; overridable via the
   * RECONNECT_GRACE_MS environment variable.
   */
  GRACE_MS: 60_000,
} as const;
