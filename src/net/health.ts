import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config/index.js";
import { verifyGoogleIdToken } from "../auth/google.js";
import {
  issueSessionToken,
  readSessionToken,
  renewSessionToken,
} from "../auth/sessions.js";
import { findOrCreateAccount, getProfile, setUsername } from "../db/accounts.js";
import { getKingdomStats } from "../db/progression.js";
import { levelFromXp, masteryFor } from "../engine/rewards.js";
import { getBalance } from "../db/coins.js";
import { getDailyQuests } from "../db/quests.js";
import { nextResetAt, questDay } from "../engine/quests.js";
import { rerollFeatured, storeFront } from "../engine/store.js";
import { equip, getInventory, getLoadout, purchase } from "../db/cosmetics.js";
import { catalogue } from "../engine/store.js";
import { checkAge } from "../auth/age.js";
import {
  deleteAccount,
  exportAccount,
  hasAgeBracket,
  setAgeBracket,
} from "../db/privacy.js";
import { isDatabaseConfigured } from "../db/client.js";
import { isAdmin } from "../db/admin.js";
import { logger } from "../util/logger.js";

/** Paths that answer the health check. */
const HEALTH_PATHS = new Set(["/health", "/healthz", "/"]);

/** Refuse absurd request bodies rather than buffering them into memory. */
const MAX_BODY_BYTES = 8_000;

/**
 * Cross-origin headers for the plain HTTP routes.
 *
 * Socket.IO configures its OWN cors (see index.ts) and does not cover this
 * listener, so the sign-in endpoint has to say for itself which origins may
 * call it. Reuses the same allow-list rather than a second one, so there is
 * only ever one place to add a deployment origin.
 *
 * `Vary: Origin` matters because the value changes per request — without it a
 * proxy could cache one origin's response and serve it to another.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed =
    origin && config.cors.origins.includes(origin)
      ? origin
      : config.cors.origins[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    // Cross-origin responses hide every header a script did not ask for. The
    // renewal below is worthless unless the client can read it back.
    "Access-Control-Expose-Headers": "X-Session-Token",
    Vary: "Origin",
  };
}

/** Collects a request body, rejecting anything oversized. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Handles `POST /auth/google` — the whole of sign-in.
 *
 * The client sends the ID token Google handed it. We check that token really
 * came from Google and really was issued for THIS app, then hand back a token
 * of our own that the socket handshake understands.
 *
 * ⚠️ The reply never explains WHY a sign-in failed. A caller learning the
 * difference between "malformed", "expired" and "wrong audience" is a caller
 * being helped to probe.
 */
async function handleGoogleSignIn(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  try {
    const raw = await readBody(req);
    const { idToken } = JSON.parse(raw) as { idToken?: unknown };
    if (typeof idToken !== "string" || idToken === "") {
      throw new Error("Missing idToken");
    }

    const profile = await verifyGoogleIdToken(idToken);

    // Google says who they are. Now find (or open) their account with us.
    const account = await findOrCreateAccount({
      provider: "google",
      providerUid: profile.googleId,
      email: profile.email,
    });

    if (!account) {
      // The token was GOOD - we simply cannot record the account right now.
      // 503, not 401: nothing is wrong with the caller and retrying will work.
      // The game itself is unaffected; they can still play as a guest.
      logger.error("Sign-in unavailable", {
        configured: isDatabaseConfigured(),
      });
      res.writeHead(503, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "accounts_unavailable" }));
      return;
    }

    logger.info("Sign-in accepted", { accountId: account.accountId });
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(
      JSON.stringify({
        // The session token now carries OUR account id, not Google's. Every
        // socket, stat and purchase keys off this one value.
        token: issueSessionToken(account.accountId),
        username: account.username,
        // A real state, not a missing value: the client opens the username
        // picker on first sign-in (Phase 2) when this is true.
        needsUsername: account.username === null,
        // The age gate is a separate step from the username: an account can
        // exist (Google verified them) without yet being allowed to keep data.
        needsAge: !(await hasAgeBracket(account.accountId)),
        // Only a suggestion to pre-fill that picker with. Never the identity.
        suggestedName: profile.name ?? null,
      }),
    );
  } catch (error) {
    logger.warn("Sign-in rejected", { message: (error as Error).message });
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "invalid_token" }));
  }
}

/**
 * The account id behind an `Authorization: Bearer <token>` header, or null.
 *
 * Same token the socket handshake reads, same rule: an absent or bad token is
 * "we do not know who this is", never an error worth explaining.
 */
function bearerAccountId(
  req: IncomingMessage,
  res: ServerResponse,
): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  const accountId = readSessionToken(token);
  if (!accountId) return null;

  // Every authenticated request slides the session forward. `setHeader` before
  // `writeHead` survives, because writeHead merges rather than replaces.
  const renewed = renewSessionToken(token);
  if (renewed) res.setHeader("X-Session-Token", renewed);
  return accountId;
}

/** `GET /profile` — who am I? */
async function handleGetProfile(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  const profile = await getProfile(accountId);
  if (!profile) {
    // A valid token for an account we cannot read. Either the database is down
    // or the account was swept/deleted; the client treats both as signed out.
    res.writeHead(503, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "accounts_unavailable" }));
    return;
  }

  const [kingdoms, coins, quests, loadout, owned, ageAnswered, admin] =
    await Promise.all([
      getKingdomStats(accountId),
      getBalance(accountId),
      getDailyQuests(accountId),
      getLoadout(accountId),
      getInventory(accountId),
      hasAgeBracket(accountId),
      isAdmin(accountId),
    ]);
  const progress = levelFromXp(profile.xp);

  res.writeHead(200, { "Content-Type": "application/json", ...cors });
  res.end(
    JSON.stringify({
      username: profile.username,
      needsUsername: profile.username === null,
      // ⚠️ ONBOARDING IS RESUMABLE, so both gates have to be answerable from
      // the profile and not only from the sign-in response. Someone who closed
      // the tab between signing in and answering used to be asked once, never
      // again — an account with no age on file that we then kept data for.
      needsAge: !ageAnswered,
      // ⚠️ A RENDERING HINT, NOT A PERMISSION. It exists so the profile can
      // show the admin tools; every admin route re-asks the database. Nothing
      // is authorised by this field.
      admin,
      // Level is derived here rather than stored, so a retuned curve applies to
      // everyone at once (see engine/rewards.levelFromXp).
      level: progress.level,
      xp: profile.xp,
      xpIntoLevel: progress.xpIntoLevel,
      xpForNext: progress.xpForNext,
      kingdoms: kingdoms.map((k) => {
        const mastery = masteryFor(k.playtimeSeconds);
        return {
          kingdomId: k.kingdomId,
          matches: k.matches,
          wins: k.wins,
          top3: k.top3,
          playtimeSeconds: k.playtimeSeconds,
          damageDealt: k.damageDealt,
          // Averages are sent ready-made: the client should not have to know
          // that `placementSum` exists to show "avg place 3.2".
          averagePlacement: k.matches > 0 ? k.placementSum / k.matches : null,
          mastery: mastery.tier,
          masteryName: mastery.name,
        };
      }),
      coins,
      // What is worn, per kingdom, and what is owned — the profile is where
      // skins are assigned, so it needs both to render the picker.
      loadout,
      owned,
      // The catalogue travels with the profile so the picker can name and paint
      // an item without a second request. It is small (parameter sets, not art).
      catalogue: catalogue(),
      quests: quests.map((q) => ({
        questId: q.questId,
        tier: q.tier,
        description: q.description,
        progress: q.progress,
        target: q.target,
        completed: q.completed,
        xp: q.xp,
        coins: q.coins,
      })),
      questsResetAt: nextResetAt().toISOString(),
      totals: {
        matches: kingdoms.reduce((sum, k) => sum + k.matches, 0),
        wins: kingdoms.reduce((sum, k) => sum + k.wins, 0),
        playtimeSeconds: kingdoms.reduce((sum, k) => sum + k.playtimeSeconds, 0),
      },
    }),
  );
}

/** `POST /profile/username` — choose or change it. */
async function handleSetUsername(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  try {
    const { username } = JSON.parse(await readBody(req)) as { username?: unknown };
    const result = await setUsername(accountId, username);

    if (!result.ok) {
      // 409 for "taken" (a conflict the player can resolve by picking another),
      // 503 when it is our fault, 400 for everything else. Unlike sign-in, these
      // errors are DETAILED on purpose: the player has to be able to fix them,
      // and none of them leak anything about anyone else's account.
      const status =
        result.error === "TAKEN" ? 409 : result.error === "UNAVAILABLE" ? 503 : 400;
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: result.error, message: result.message }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ username: result.username }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "INVALID_PAYLOAD", message: "Malformed request." }));
  }
}

/** `GET /shop` — what is on sale today, and what this player already owns. */
async function handleShop(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  const front = storeFront(questDay());

  // Guests may browse. They own nothing and have no balance, which the client
  // renders as "sign in to keep what you unlock" rather than as an error.
  const [owned, balance] = accountId
    ? await Promise.all([getInventory(accountId), getBalance(accountId)])
    : [[] as string[], null];

  res.writeHead(200, { "Content-Type": "application/json", ...cors });
  res.end(
    JSON.stringify({
      day: front.day,
      resetsAt: nextResetAt().toISOString(),
      featured: front.featured,
      daily: front.daily,
      owned,
      balance,
      signedIn: accountId !== null,
    }),
  );
}

/** `POST /shop/buy` — spend coins on a cosmetic. */
async function handleBuy(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  try {
    const { itemId } = JSON.parse(await readBody(req)) as { itemId?: unknown };
    if (typeof itemId !== "string") throw new Error("Missing itemId");

    // ⚠️ ONLY THE ITEM ID IS TAKEN FROM THE CALLER. Price, availability and
    // any mastery requirement are read from the catalogue server-side.
    const result = await purchase(accountId, itemId);
    if (!result.ok) {
      const status =
        result.error === "INSUFFICIENT_FUNDS" || result.error === "ALREADY_OWNED"
          ? 409
          : result.error === "UNAVAILABLE"
            ? 503
            : 400;
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: result.error, message: result.message }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ balance: result.balance }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "INVALID_PAYLOAD", message: "Malformed request." }));
  }
}

/**
 * `POST /admin/shop/reroll` — draw a new Featured page.
 *
 * For everyone, not just the admin: Featured is one shop shared by the whole
 * game, so rerolling it changes what every player sees on their next load. That
 * is the intended power of the button, and the reason it is gated on the
 * server rather than on the presence of a flag in a response.
 */
async function handleRerollShop(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }
  if (!(await isAdmin(accountId))) {
    // 403 and not 404: the caller is a real signed-in account that simply may
    // not do this, and saying so is both true and harmless.
    res.writeHead(403, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_admin", message: "Admins only." }));
    return;
  }

  const day = questDay();
  const front = rerollFeatured(day);
  logger.info("Featured shop rerolled", { accountId, day });

  res.writeHead(200, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ day: front.day, featured: front.featured }));
}

/** `POST /profile/equip` — assign a skin to a kingdom. */
async function handleEquip(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  try {
    const { kingdomId, itemId } = JSON.parse(await readBody(req)) as {
      kingdomId?: unknown;
      itemId?: unknown;
    };
    if (typeof kingdomId !== "string" || typeof itemId !== "string") {
      throw new Error("Missing kingdomId or itemId");
    }

    const result = await equip(accountId, kingdomId, itemId);
    if (!result.ok) {
      const status = result.error === "UNAVAILABLE" ? 503 : 400;
      res.writeHead(status, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: result.error, message: result.message }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ loadout: await getLoadout(accountId) }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "INVALID_PAYLOAD", message: "Malformed request." }));
  }
}

/**
 * `POST /profile/age` — the age gate.
 *
 * ⚠️ THE DATE OF BIRTH IS NEVER STORED. It is checked, converted to a bracket,
 * and discarded. See `auth/age.ts` for why the question is a date rather than
 * a yes/no.
 */
async function handleAge(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  try {
    const { birthDate } = JSON.parse(await readBody(req)) as { birthDate?: unknown };
    const check = checkAge(birthDate);

    if (!check.ok || !check.bracket) {
      // ⚠️ TOO YOUNG DELETES THE ACCOUNT rather than leaving it dormant. Google
      // created it the moment they signed in; keeping a row for a child we have
      // just been told is under 13 is exactly what the gate exists to prevent.
      if (check.error === "TOO_YOUNG") {
        await deleteAccount(accountId);
        logger.info("Under-age sign-up refused and removed");
      }
      res.writeHead(check.error === "TOO_YOUNG" ? 403 : 400, {
        "Content-Type": "application/json",
        ...cors,
      });
      res.end(JSON.stringify({ error: check.error, message: check.message }));
      return;
    }

    await setAgeBracket(accountId, check.bracket);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "INVALID_PAYLOAD", message: "Malformed request." }));
  }
}

/** `GET /profile/export` — everything we hold, as a downloadable file. */
async function handleExport(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  const data = await exportAccount(accountId);
  if (!data) {
    res.writeHead(503, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "unavailable" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json",
    // Saves as a file rather than opening as a wall of text.
    "Content-Disposition": 'attachment; filename="elementals-data.json"',
    ...cors,
  });
  res.end(JSON.stringify(data, null, 2));
}

/** `POST /profile/delete` — erase the account permanently. */
async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  cors: Record<string, string>,
): Promise<void> {
  const accountId = bearerAccountId(req, res);
  if (!accountId) {
    res.writeHead(401, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ error: "not_signed_in" }));
    return;
  }

  const done = await deleteAccount(accountId);
  if (!done) {
    res.writeHead(503, {
      "Content-Type": "application/json",
      ...cors,
    });
    res.end(
      JSON.stringify({
        error: "unavailable",
        message: "Could not delete right now. Nothing has been removed — try again.",
      }),
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Creates the Node HTTP request listener for non-Socket.IO traffic.
 *
 * Socket.IO handles its own path (`/socket.io/`) and lets everything else fall
 * through to this listener, which serves:
 *   - `POST /auth/google`      — exchange a Google ID token for a session token
 *   - `GET  /profile`          — the signed-in player's profile
 *   - `POST /profile/username` — choose or change a username
 *   - `POST /profile/equip`    — assign a cosmetic to a kingdom
 *   - `POST /profile/age`      — the age gate (date checked, never stored)
 *   - `GET  /profile/export`   — download everything we hold (GDPR Art. 20)
 *   - `POST /profile/delete`   — erase the account (GDPR Art. 17)
 *   - `GET  /shop`             — today's shop, plus what the caller owns
 *   - `POST /shop/buy`         — spend coins on a cosmetic
 *   - `GET  /health`           — a lightweight liveness check
 * Everything else is a 404.
 */
export function createRequestListener() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? "").split("?")[0];
    const cors = corsHeaders(req.headers.origin);

    // Before a cross-origin POST the browser sends an OPTIONS "preflight"
    // asking permission. Answer it, or the real request is never sent and the
    // console shows a CORS error that looks like the endpoint is broken.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === "POST" && path === "/auth/google") {
      void handleGoogleSignIn(req, res, cors);
      return;
    }

    if (req.method === "GET" && path === "/profile") {
      void handleGetProfile(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/profile/username") {
      void handleSetUsername(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/profile/age") {
      void handleAge(req, res, cors);
      return;
    }

    if (req.method === "GET" && path === "/profile/export") {
      void handleExport(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/profile/delete") {
      void handleDelete(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/profile/equip") {
      void handleEquip(req, res, cors);
      return;
    }

    if (req.method === "GET" && path === "/shop") {
      void handleShop(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/admin/shop/reroll") {
      void handleRerollShop(req, res, cors);
      return;
    }

    if (req.method === "POST" && path === "/shop/buy") {
      void handleBuy(req, res, cors);
      return;
    }

    if (req.method === "GET" && HEALTH_PATHS.has(path)) {
      logger.debug("Health check", { path });
      const body = JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(body);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ status: "not_found" }));
  };
}
