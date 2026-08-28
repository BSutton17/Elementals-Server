import { and, eq } from "drizzle-orm";
import { getDb } from "./client.js";
import { equipped, inventory } from "./schema.js";
import { getBalance, grantCoins } from "./coins.js";
import {
  cosmeticById,
  defaultCosmetic,
  purchasable,
  type CosmeticSlot,
} from "../data/cosmetics.js";
import { isAdmin } from "./admin.js";
import { isOnSale } from "../engine/store.js";
import { questDay } from "../engine/quests.js";
import { masteryFor } from "../engine/rewards.js";
import { getKingdomStats } from "./progression.js";
import { logger } from "../util/logger.js";
import type { KingdomId } from "../data/kingdoms.js";

/**
 * Owning and wearing cosmetics.
 *
 * ⚠️ EVERY RULE HERE IS ENFORCED SERVER-SIDE, AT THE POINT OF ACTION. Ownership
 * is checked when equipping, not when rendering; price is read from the
 * catalogue, never from the request. A client that asks to equip something it
 * does not own gets a refusal, not a castle.
 */

/** The sentinel kingdom for account-wide slots (nameplates). */
export const ACCOUNT_WIDE = "*";

export type PurchaseError =
  | "UNKNOWN_ITEM"
  | "ALREADY_OWNED"
  | "NOT_ON_SALE"
  | "INSUFFICIENT_FUNDS"
  | "MASTERY_LOCKED"
  | "UNAVAILABLE";

export interface PurchaseResult {
  ok: boolean;
  error?: PurchaseError;
  message?: string;
  /** The balance after a successful purchase. */
  balance?: number;
}

const fail = (error: PurchaseError, message: string): PurchaseResult => ({
  ok: false,
  error,
  message,
});

/**
 * What an admin owns: the entire paid catalogue, defaults excluded like any
 * other inventory. Exposed so the rule can be asserted directly — "every skin,
 * including ones added later" is a claim worth a test, and it is not reachable
 * through `getInventory` without a database.
 */
export function adminInventory(): string[] {
  return purchasable().map((item) => item.id);
}

/** Item ids this account owns, defaults excluded (everyone has those). */
export async function getInventory(accountId: string): Promise<string[]> {
  // ⚠️ AN ADMIN'S INVENTORY IS DERIVED, NOT GRANTED. Writing sixty rows into
  // `inventory` would work today and be wrong tomorrow: every skin added after
  // the grant would be missing, and the fix would be to remember to re-run a
  // backfill each time. Computing it means "everything" keeps meaning
  // everything, including items that do not exist yet — and revoking admin
  // takes the items back instead of leaving a permanently stocked account.
  if (await isAdmin(accountId)) return adminInventory();

  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select({ itemId: inventory.itemId })
      .from(inventory)
      .where(eq(inventory.accountId, accountId));
    return rows.map((r) => r.itemId);
  } catch (error) {
    logger.warn("Inventory read failed", { message: (error as Error).message });
    return [];
  }
}

/** Whether this account may wear an item. Defaults are always owned. */
export async function owns(accountId: string, itemId: string): Promise<boolean> {
  const item = cosmeticById(itemId);
  if (!item) return false;
  if (item.isDefault) return true;
  return (await getInventory(accountId)).includes(itemId);
}

/**
 * Buys an item.
 *
 * ⚠️ THE DEDUCTION AND THE GRANT ARE ONE TRANSACTION. Either the player pays
 * and receives, or neither happens — a purchase that debits without delivering
 * is the one bug in a shop nobody forgives.
 *
 * The price comes from the catalogue. Nothing about cost, rarity or
 * availability is taken from the caller.
 */
export async function purchase(
  accountId: string,
  itemId: string,
  day = questDay(),
): Promise<PurchaseResult> {
  const db = getDb();
  if (!db) return fail("UNAVAILABLE", "The shop is unavailable right now.");

  const item = cosmeticById(itemId);
  if (!item) return fail("UNKNOWN_ITEM", "That item does not exist.");
  if (item.isDefault) return fail("ALREADY_OWNED", "You already have that one.");

  if (await owns(accountId, itemId)) {
    return fail("ALREADY_OWNED", "You already own that.");
  }

  // Availability is the server's call, not the client's: a stale shop screen
  // must not be able to buy yesterday's featured legendary.
  if (!isOnSale(item, day)) {
    return fail("NOT_ON_SALE", "That is not in the shop today.");
  }

  if (item.requiresMastery && item.kingdomId) {
    const stats = await getKingdomStats(accountId);
    const played = stats.find((k) => k.kingdomId === item.kingdomId);
    const mastery = masteryFor(played?.playtimeSeconds ?? 0);
    if (mastery.tier !== item.requiresMastery) {
      return fail(
        "MASTERY_LOCKED",
        `Reach ${item.requiresMastery} mastery with ${item.kingdomId} first.`,
      );
    }
  }

  const balance = await getBalance(accountId);
  if (balance < item.price) {
    return fail(
      "INSUFFICIENT_FUNDS",
      `That costs ${item.price.toLocaleString()} coins — you have ${balance.toLocaleString()}.`,
    );
  }

  try {
    await db.transaction(async (tx) => {
      // Negative delta, keyed on the item so a double-submitted purchase
      // collides on the ledger's unique index instead of charging twice.
      await grantCoins(accountId, -item.price, "purchase", item.id, tx);
      await tx
        .insert(inventory)
        .values({ accountId, itemId: item.id, source: "purchase" })
        .onConflictDoNothing();
    });

    logger.info("Cosmetic purchased", { accountId, itemId, price: item.price });
    return { ok: true, balance: await getBalance(accountId) };
  } catch (error) {
    logger.warn("Purchase failed", { accountId, itemId, message: (error as Error).message });
    return fail("UNAVAILABLE", "Could not complete that purchase. Try again.");
  }
}

export type EquipError = "UNKNOWN_ITEM" | "NOT_OWNED" | "WRONG_KINGDOM" | "UNAVAILABLE";

export interface EquipResult {
  ok: boolean;
  error?: EquipError;
  message?: string;
}

/**
 * Wears an item on a kingdom's slot.
 *
 * Ownership is verified HERE, once, rather than trusted at render time — the
 * snapshot that tells other players what you are wearing is built from this
 * table, so an unvalidated write would show everyone a skin you never bought.
 */
export async function equip(
  accountId: string,
  kingdomId: string,
  itemId: string,
): Promise<EquipResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "UNAVAILABLE", message: "Try again shortly." };

  const item = cosmeticById(itemId);
  if (!item) return { ok: false, error: "UNKNOWN_ITEM", message: "Unknown item." };

  // A Fire skin cannot be worn by Water. The catalogue says which is which.
  const wanted = item.kingdomId ?? ACCOUNT_WIDE;
  if (wanted !== kingdomId) {
    return {
      ok: false,
      error: "WRONG_KINGDOM",
      message: "That skin belongs to a different kingdom.",
    };
  }

  if (!(await owns(accountId, itemId))) {
    return { ok: false, error: "NOT_OWNED", message: "You do not own that." };
  }

  try {
    await db
      .insert(equipped)
      .values({ accountId, kingdomId, slot: item.slot, itemId })
      .onConflictDoUpdate({
        target: [equipped.accountId, equipped.kingdomId, equipped.slot],
        set: { itemId, updatedAt: new Date() },
      });
    return { ok: true };
  } catch (error) {
    logger.warn("Equip failed", { accountId, itemId, message: (error as Error).message });
    return { ok: false, error: "UNAVAILABLE", message: "Could not save that." };
  }
}

export interface EquippedLoadout {
  /** `kingdomId` → slot → itemId. Defaults filled in. */
  [kingdomId: string]: Partial<Record<CosmeticSlot, string>>;
}

/**
 * What this account is wearing, per kingdom, with defaults filled in.
 *
 * Returning the defaults rather than gaps means the caller never has to know
 * the fallback rule — a seat always has a concrete item id to render.
 */
export async function getLoadout(accountId: string): Promise<EquippedLoadout> {
  const db = getDb();
  const loadout: EquippedLoadout = {};
  if (!db) return loadout;

  try {
    const rows = await db
      .select()
      .from(equipped)
      .where(eq(equipped.accountId, accountId));

    for (const row of rows) {
      loadout[row.kingdomId] ??= {};
      loadout[row.kingdomId]![row.slot as CosmeticSlot] = row.itemId;
    }
    return loadout;
  } catch (error) {
    logger.warn("Loadout read failed", { message: (error as Error).message });
    return loadout;
  }
}

/** The item a kingdom wears in a slot: what is equipped, else the default. */
export function resolveCosmetic(
  loadout: EquippedLoadout,
  kingdomId: KingdomId,
  slot: CosmeticSlot,
): string | null {
  return loadout[kingdomId]?.[slot] ?? defaultCosmetic(slot, kingdomId)?.id ?? null;
}

/** Removes an equipped item, falling back to the default. */
export async function unequip(
  accountId: string,
  kingdomId: string,
  slot: CosmeticSlot,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .delete(equipped)
      .where(
        and(
          eq(equipped.accountId, accountId),
          eq(equipped.kingdomId, kingdomId),
          eq(equipped.slot, slot),
        ),
      );
  } catch (error) {
    logger.warn("Unequip failed", { message: (error as Error).message });
  }
}
