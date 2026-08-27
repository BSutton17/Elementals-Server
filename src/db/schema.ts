import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Database schema: identity, and the record of finished matches.
 *
 * Scope is deliberately narrow — accounts, the credentials that point at them,
 * and the profile that holds a username. Statistics, XP, coins and inventory
 * are later phases and are NOT stubbed out here: empty columns nothing writes
 * to are just a lie with a migration attached.
 *
 * Conventions:
 *  - snake_case column names (Postgres convention), camelCase in TypeScript
 *  - `timestamptz` everywhere, never naive timestamps: the store's "10:00 CT"
 *    refresh has to survive a daylight-saving shift, and that is only possible
 *    if every stored instant is unambiguous
 *  - deleting an account cascades, so account deletion is one statement
 */

/**
 * One row per person. Deliberately holds almost nothing: the less personal
 * data lives here, the less there is to leak, and the cheaper a deletion
 * request is to honour.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** `active` | `banned` | `deleted`. Text rather than an enum so adding a
     *  state later is a code change and not a migration. */
    status: text("status").notNull().default("active"),
    /**
     * Age BRACKET, never a date of birth.
     *
     * ⚠️ THE DATE ITSELF IS NEVER STORED. We ask for it once, at sign-up, to
     * decide whether an account may exist at all — then keep only the answer.
     * A birth date is a strong identifier and useful to nobody here; the
     * bracket is all any rule needs.
     */
    ageBracket: text("age_bracket"),
    /**
     * When this account self-destructs, or NULL to live forever.
     *
     * ⚠️ ACCOUNTS CREATED OUTSIDE PRODUCTION EXPIRE. Development and test
     * sign-ins share the one database, and the risk is not disk space — an
     * account row is a few hundred bytes. It is POLLUTION: a throwaway account
     * from a local run would otherwise sit in win-rate aggregates forever, and
     * could permanently squat a username somebody real wants.
     *
     * Production accounts are always NULL, so the sweeper can never touch a
     * player. See `db/cleanup.ts`.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  // Partial index: only the rows that CAN expire are indexed, so the sweeper's
  // query is an index scan over a handful of dev rows rather than a table scan
  // over every real player.
  (table) => [
    index("accounts_expires_idx").on(table.expiresAt).where(sql`expires_at is not null`),
  ],
);

/**
 * How someone proves they are an account — one row per sign-in method, so the
 * same person can later attach Apple alongside Google and land on the same
 * account rather than a duplicate one.
 *
 * Keyed by (provider, provider_uid) because that pair is what an OAuth
 * provider guarantees to be unique and stable. Email is stored for support and
 * account recovery ONLY; it is never the identifier, because people change
 * their email address and Google's `sub` never changes.
 */
export const authIdentities = pgTable(
  "auth_identities",
  {
    provider: text("provider").notNull(),
    providerUid: text("provider_uid").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerUid] }),
    index("auth_identities_account_idx").on(table.accountId),
  ],
);

/**
 * The player-facing identity: what other people see.
 *
 * `username` is NULL until the player picks one on first sign-in — that is a
 * real state, not a missing value, and the sign-in response reports it as
 * `needsUsername` so the client knows to ask.
 *
 * `usernameLower` exists so uniqueness is case-INSENSITIVE. Without it
 * "Bryson" and "bryson" are two different players to the database and the same
 * player to every human being reading a lobby.
 */
export const profiles = pgTable("profiles", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  username: text("username"),
  usernameLower: text("username_lower").unique(),
  /**
   * LIFETIME xp. The level is DERIVED from this, never stored.
   *
   * That way the ladder can be retuned without migrating anybody: change the
   * curve and every player's level recomputes from the same total. Storing the
   * level would freeze today's curve into every row, and a rebalance would
   * either strand players mid-level or hand out free ones.
   */
  xp: integer("xp").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Account = typeof accounts.$inferSelect;
export type AuthIdentity = typeof authIdentities.$inferSelect;
export type Profile = typeof profiles.$inferSelect;


/**
 * One finished match. Written once, at the end, and never updated.
 *
 * This is the raw material for two different things: a player's record, and
 * the per-kingdom win rates that turn balance from an argument into a
 * measurement.
 */
export const matches = pgTable("matches", {
  /** Generated when the result is built, so recording twice is a no-op. */
  id: uuid("id").primaryKey(),
  roomCode: text("room_code").notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  durationTicks: integer("duration_ticks").notNull(),
  tickRate: integer("tick_rate").notNull(),
  /** Every seat, bots included. */
  playerCount: integer("player_count").notNull(),
  /** ⚠️ Humans only. Reward rules read THIS, never `playerCount`, or a lobby
   *  padded with bots would pay like a full house. */
  humanCount: integer("human_count").notNull(),
  /** The winning seat's in-match player id, or null for a draw. */
  winnerPlayerId: text("winner_player_id"),
  /**
   * The balance numbers this match was played under. Without it, a rebalance
   * silently poisons every historical win rate — old and new matches would be
   * averaged together as though they were the same game.
   */
  balanceVersion: text("balance_version").notNull(),
});

/**
 * One seat in one match.
 *
 * ⚠️ `account_id` is ON DELETE SET NULL, not CASCADE. Deleting an account must
 * erase the person, not the history: the row survives with its identity
 * removed, so it stops being personal data while the kingdom's win rate stays
 * intact. Cascading here would mean every deletion request quietly corrupted
 * the balance record.
 */
export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** The in-match seat id — lets a client match a row to a player. */
    playerId: text("player_id").notNull(),
    /** The name as it was AT THE TIME. A later rename must not rewrite history. */
    name: text("name").notNull(),
    kingdomId: text("kingdom_id"),
    placement: integer("placement").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
    botDifficulty: text("bot_difficulty"),
    eliminatedAtTick: integer("eliminated_at_tick"),
    survivedTicks: integer("survived_ticks").notNull(),
    damageDealt: integer("damage_dealt").notNull().default(0),
    damageTaken: integer("damage_taken").notNull().default(0),
    healingDone: integer("healing_done").notNull().default(0),
    goldEarned: integer("gold_earned").notNull().default(0),
    goldSpent: integer("gold_spent").notNull().default(0),
    abilitiesCast: integer("abilities_cast").notNull().default(0),
    killsCredited: integer("kills_credited").notNull().default(0),
  },
  (table) => [
    // "My matches", the profile's main query.
    index("participants_account_idx").on(table.accountId),
    // "How does this kingdom do?", the balance query.
    index("participants_kingdom_idx").on(table.kingdomId),
  ],
);

export type Match = typeof matches.$inferSelect;
export type Participant = typeof participants.$inferSelect;


/**
 * What one account has done with one kingdom.
 *
 * A rollup, updated as each match is recorded, so the profile's sixteen-row
 * table is a single indexed read instead of an aggregation over every match
 * ever played. The `participants` rows remain the source of truth — this can
 * always be rebuilt from them.
 */
export const kingdomStats = pgTable(
  "kingdom_stats",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    kingdomId: text("kingdom_id").notNull(),
    matches: integer("matches").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    /** Top-three finishes. In a seven-player free-for-all this is a better
     *  measure of doing well than wins alone. */
    top3: integer("top3").notNull().default(0),
    /** Drives kingdom MASTERY, which is about devotion rather than winning. */
    playtimeSeconds: integer("playtime_seconds").notNull().default(0),
    damageDealt: integer("damage_dealt").notNull().default(0),
    /** Summed placements, so an average needs no second query. */
    placementSum: integer("placement_sum").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.kingdomId] })],
);

export type KingdomStats = typeof kingdomStats.$inferSelect;


/**
 * Every coin a player has ever gained or spent.
 *
 * ⚠️ A BALANCE IS `SUM(delta)`, NEVER A COLUMN. That is the entire design.
 * Every grant carries an `idempotency_key`, so a retry, a double-fired event,
 * a reconnect mid-payout, or a bug that calls the reward path twice all collide
 * on the unique index and become a no-op instead of free money. A balance
 * column has no such defence, and you do not notice it failing until somebody
 * has nine hundred thousand coins.
 *
 * Append-only. Nothing here is ever updated or deleted.
 */
export const coinLedger = pgTable(
  "coin_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Positive to grant, negative to spend. */
    delta: integer("delta").notNull(),
    /** `match` | `quest` | `purchase` | `adjustment`. */
    reason: text("reason").notNull(),
    /** What caused it — a match id, a quest slot, an item id. */
    refId: text("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The whole idempotency guarantee. Built from the cause, never from a
     * timestamp: `match:<matchId>:<accountId>` is the same string however many
     * times the reward path runs.
     */
    idempotencyKey: text("idempotency_key").notNull().unique(),
  },
  (table) => [index("coin_ledger_account_idx").on(table.accountId)],
);

/**
 * One player's daily earnings, for the caps.
 *
 * Kept separately from the ledger so enforcing a cap is a single indexed read
 * rather than a sum over a growing table, and so the XP cap — which has no
 * ledger of its own — has somewhere to live.
 */
export const dailyEarnings = pgTable(
  "daily_earnings",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The quest day, which is the 10:00 CT boundary, not UTC midnight. */
    day: date("day").notNull(),
    coins: integer("coins").notNull().default(0),
    xp: integer("xp").notNull().default(0),
    /** Paid once per day, on the first win. */
    firstWinClaimed: boolean("first_win_claimed").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.day] })],
);

/**
 * A player's three quests for one day, and how far along each is.
 *
 * The three are DERIVED from (account, day) rather than chosen and written at
 * roll time — see `engine/quests.rollDailyQuests`. This table exists only to
 * hold PROGRESS, so a player who never opens the game still has the same three
 * waiting and a restart cannot reroll them.
 */
export const dailyQuests = pgTable(
  "daily_quests",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    slot: integer("slot").notNull(),
    questId: text("quest_id").notNull(),
    progress: integer("progress").notNull().default(0),
    /** Kingdoms already counted, for the "different kingdoms" quests. */
    seenKingdoms: jsonb("seen_kingdoms").$type<string[]>().notNull().default([]),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Set when the reward has been paid, so it is paid exactly once. */
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.day, table.slot] })],
);

export type CoinLedgerEntry = typeof coinLedger.$inferSelect;
export type DailyEarnings = typeof dailyEarnings.$inferSelect;
export type DailyQuest = typeof dailyQuests.$inferSelect;


/**
 * What an account owns.
 *
 * Defaults are NOT stored here — everybody has them, so a row per player per
 * kingdom would be sixteen rows of "yes, you have the standard one". Ownership
 * of a default is answered by the catalogue, not the database.
 */
export const inventory = pgTable(
  "inventory",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    /** `purchase` | `reward` | `grant`. Where it came from, for support. */
    source: text("source").notNull().default("purchase"),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.itemId] })],
);

/**
 * What an account is wearing.
 *
 * ⚠️ KEYED BY KINGDOM, NOT JUST BY SLOT. Skins are assigned per kingdom — your
 * Fire castle and your Water castle are dressed separately — so the key is
 * (account, kingdom, slot). Account-wide items such as nameplates use the
 * sentinel kingdom `*`, which keeps one table instead of two.
 */
export const equipped = pgTable(
  "equipped",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** A kingdom id, or `*` for account-wide slots. */
    kingdomId: text("kingdom_id").notNull(),
    slot: text("slot").notNull(),
    itemId: text("item_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.kingdomId, table.slot] })],
);

export type InventoryRow = typeof inventory.$inferSelect;
export type EquippedRow = typeof equipped.$inferSelect;
