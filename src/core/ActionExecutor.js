import { sleep } from '../utils/sleep.js';

/**
 * Serialized executor for game actions (move / pickup / putdown).
 *
 * The server rejects — with a penalty — any action issued while the
 * previous one is still running (ActionMutex). Therefore every action
 * goes through a single promise chain: the next action starts only after
 * the previous ack arrived. Communication (say/ask/shout) is not mutexed
 * server-side and is handled by TeamProtocol, not here.
 *
 * The executor also implements the *movement gate*: a reactive inhibition
 * used by the red-light/green-light mission. When the gate is closed,
 * move() waits (it does not fail), so the current intention freezes and
 * resumes on green — exactly the behavior the mission rewards.
 */
export class ActionExecutor {
  /** Replaceable predicate; wired to beliefs.mission.movementAllowed. */
  movementGate = () => true;

  #queue = Promise.resolve();

  /**
   * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
   * @param {object} [deps]
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [deps.metrics]
   */
  constructor(socket, { metrics = null } = {}) {
    this.socket = socket;
    this.metrics = metrics;
  }

  /** Run `fn` after every previously enqueued action settled. */
  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    // Keep the chain alive even when an action throws (ack timeout).
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Move one tile. Resolves to {x, y} on success, false on failure
   * (wall, locked tile, arrow violation). Ack timeouts count as failure.
   * @param {'up'|'down'|'left'|'right'} direction
   */
  async move(direction) {
    return this.#enqueue(async () => {
      while (!this.movementGate()) await sleep(100); // red light: hold
      try {
        const result = await this.socket.emitMove(direction);
        if (result === false) this.metrics?.increment('failedActions');
        return result;
      } catch {
        this.metrics?.increment('failedActions'); // ack timeout
        return false;
      }
    });
  }

  /** Pick up all free parcels on the current tile. Resolves to [{id}]. */
  async pickup() {
    return this.#enqueue(async () => {
      try {
        return (await this.socket.emitPickup()) ?? [];
      } catch {
        this.metrics?.increment('failedActions');
        return [];
      }
    });
  }

  /**
   * Put down parcels. An empty/omitted list drops everything; missions
   * with selective deliveries must pass explicit id lists.
   * @param {string[]} [parcelIds]
   */
  async putdown(parcelIds = []) {
    return this.#enqueue(async () => {
      try {
        return (await this.socket.emitPutdown(parcelIds)) ?? [];
      } catch {
        this.metrics?.increment('failedActions');
        return [];
      }
    });
  }
}
