import type { Match } from "../match/Match.js";
import { isGhost, partyFreezesBots, partyOccupiesBot } from "../engine/party/index.js";
import type { BotDifficulty } from "../match/types.js";
import { NetworkController } from "./controller.js";
import { loadModel } from "./modelStore.js";
import { mulberry32, type AIController } from "./runtime.js";

/**
 * Drives every bot seat in a live match.
 *
 * ⚠️ THE ONE ARCHITECTURAL RULE: this is not a privileged path. A bot reaches
 * the game through `NetworkController`, which reads state only via
 * `knowledge.ts` (the visibility projection) and writes only by calling the same
 * six engine functions the socket handlers call — `activateAbility`,
 * `buyCitizen`, `buyShield`, `repairCastle`, `unlockOrUpgradeAbility`,
 * `selectTarget`. Every one of them runs its own validation. A bot therefore
 * cannot do anything a person in that seat could not do, and cannot see anything
 * they could not see. There is deliberately no "bot API" into the match.
 *
 * Determinism: each seat gets its own stream seeded from the match room code and
 * the player id, so the same match replays the same way and two bots in one
 * match never share a stream.
 */

export class BotRunner {
  /** Controllers by player id, built once per match. */
  private readonly controllers = new Map<string, AIController>();
  /** Per-seat RNG streams, so a seat's randomness is one continuous sequence. */
  private readonly streams = new Map<string, () => number>();
  private started = false;

  constructor(private readonly match: Match) {}

  /**
   * Builds a controller per bot seat. Idempotent, and safe to call before the
   * match has players — it simply builds nothing.
   *
   * Model failures are contained to the seat: a bot that cannot load its model
   * is left without a controller and stands still, rather than throwing inside
   * the tick loop and taking the whole match down with it.
   */
  start(): { ready: number; failed: { id: string; error: string }[] } {
    const failed: { id: string; error: string }[] = [];
    let ready = 0;

    for (const player of this.match.getPlayers()) {
      if (!player.isBot || player.spectator) continue;
      if (this.controllers.has(player.id)) continue;

      const state = this.match.gameState?.getPlayer(player.id);
      if (!state) continue; // no castle yet; nothing to drive

      try {
        const difficulty: BotDifficulty = player.botDifficulty ?? "hard";
        const { network } = loadModel(difficulty);
        // Seeded per seat, so replays are reproducible and no two bots in the
        // same match draw from the same stream. Stored, not just used: the
        // controller keeps a reference for its own draws AND `tick` hands the
        // same stream back every tick, so a seat's randomness is one continuous
        // sequence rather than restarting each tick.
        const rng = mulberry32(hash(`${this.match.roomCode}:${player.id}`));
        this.streams.set(player.id, rng);
        this.controllers.set(
          player.id,
          new NetworkController(state, { network, rng, difficulty }),
        );
        ready += 1;
      } catch (error) {
        failed.push({ id: player.id, error: (error as Error).message });
      }
    }

    this.started = true;
    return { ready, failed };
  }

  /**
   * One decision pass, called before the tick advances.
   *
   * The controller decides its own cadence — `difficulty.ts` gives each level a
   * decision period, so this is called every tick and most calls return
   * immediately. Eliminated and disconnected-irrelevant seats are skipped by the
   * controller itself.
   */
  tick(tick: number): void {
    if (!this.started || this.match.phase !== "active") return;
    // ⚠️ DON'T MOVE MEANS THE BOTS TOO. That minigame bills a human five
    // thousand health for touching anything for six seconds; a bot has no hands
    // to hold still, so without this it spends those six seconds buying shields
    // and attacking a table that is obeying the rules. Gated here rather than
    // inside each controller because this is the one place bot decisions are
    // made, so there is no path around it.
    if (partyFreezesBots(this.match)) return;

    for (const [id, controller] of this.controllers) {
      const state = this.match.gameState?.getPlayer(id);
      if (!state) continue;
      // ⚠️ A BOT PLAYING A MINIGAME IS BUSY PLAYING IT. Every heads-down game —
      // the maze above all — takes a human's eyes off the board completely,
      // while the bots carried on buying, repairing and casting throughout. The
      // maze even rolls each bot a plausible solve time already; it just had no
      // bearing on anything except the minigame's own result. Now it does: this
      // seat sits out until it has finished, which is what "solving the maze"
      // is supposed to cost. Per seat, so a bot that finishes early is back in
      // the fight immediately, exactly like the human who finished early.
      if (partyOccupiesBot(this.match, id)) continue;
      // ⚠️ A GHOST IS ELIMINATED AND MUST STILL PLAY. Haunted raises the dead
      // for a few seconds, and the design keeps `eliminated` TRUE the whole
      // time — that is what stops a ghost winning the match and what makes it
      // untargetable and immune, all for free. The cost is that every "skip the
      // dead" check in the codebase silently skips ghosts too, and this was one
      // of them: in a lobby of bots, Haunted raised nobody who then did
      // anything. The banner announced a haunting and the graveyard stood
      // still.
      if (state.eliminated && !isGhost(this.match, id)) continue;
      const rng = this.streams.get(id);
      if (!rng) continue;
      try {
        controller.act({ match: this.match, player: state, tick, rng });
      } catch {
        // A single misbehaving seat must never stop a live match for everyone
        // else. The seat simply does nothing this tick.
      }
    }
  }

  get size(): number {
    return this.controllers.size;
  }
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
