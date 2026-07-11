/**
 * Tracks reconnection grace timers for disconnected players. When a player's
 * socket drops, a timer is scheduled; if they reconnect in time it is cancelled,
 * otherwise the expiry callback runs (typically removing them from the match).
 *
 * Keyed by room code + player id so a player is tracked per match.
 */
export class ReconnectionManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private key(roomCode: string, playerId: string): string {
    return `${roomCode}:${playerId}`;
  }

  /** Starts (or restarts) the grace timer for a player. */
  schedule(
    roomCode: string,
    playerId: string,
    delayMs: number,
    onExpire: () => void,
  ): void {
    this.cancel(roomCode, playerId);
    const key = this.key(roomCode, playerId);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      onExpire();
    }, delayMs);
    // Don't let a pending grace timer keep the process alive on its own.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Cancels a pending grace timer (e.g. on reconnect). Returns true if one existed. */
  cancel(roomCode: string, playerId: string): boolean {
    const key = this.key(roomCode, playerId);
    const timer = this.timers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this.timers.delete(key);
    return true;
  }

  has(roomCode: string, playerId: string): boolean {
    return this.timers.has(this.key(roomCode, playerId));
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}
