import { Intention } from './Intention.js';
import { sleep } from '../utils/sleep.js';

/**
 * Intention revision with a replace policy and hysteresis.
 *
 * Policy (lab4 "Replace" refined into "Revise"):
 *  - the agent commits to ONE intention at a time;
 *  - a newly proposed option replaces the current intention only when its
 *    utility exceeds the current one by `hysteresisMargin` (additive, in
 *    utility/reward units) — this prevents target thrashing when two
 *    parcels have near-identical value;
 *  - re-proposing the same option refreshes its utility (so comparisons
 *    use up-to-date numbers) without restarting the intention;
 *  - intentions that became invalid are aborted via abortCurrent(),
 *    triggered by the AgentLoop's validity check.
 */
export class IntentionRevision {
  #current = null;
  #candidate = null;
  #running = false;

  /**
   * @param {object} deps
   * @param {object} deps.context plan context (see Intention)
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [deps.metrics]
   * @param {import('../metrics/RunLogger.js').RunLogger} [deps.logger]
   * @param {number} [deps.hysteresisMargin]
   * @param {(intention: Intention) => void} [deps.onIntentionChange]
   * @param {() => void} [deps.onIdle] called after an intention ends
   */
  constructor({ context, metrics = null, logger = null, hysteresisMargin = 5, onIntentionChange = null, onIdle = null }) {
    this.context = context;
    this.metrics = metrics;
    this.logger = logger;
    this.hysteresisMargin = hysteresisMargin;
    this.onIntentionChange = onIntentionChange;
    this.onIdle = onIdle;
  }

  /** The intention currently being achieved (or null). */
  get current() {
    return this.#current;
  }

  /**
   * Propose the strategy's best option. Returns true when it (re)places
   * the agenda, false when the current intention is kept.
   */
  push(option) {
    const current = this.#current;

    if (current && !current.stopped) {
      if (current.key === option.key) {
        current.option.utility = option.utility; // refresh, keep going
        return false;
      }
      const currentUtility = current.option.utility ?? -Infinity;
      if ((option.utility ?? -Infinity) <= currentUtility + this.hysteresisMargin) {
        return false; // not better enough: hysteresis keeps the commitment
      }
      current.stop(); // better option found: revise
    }

    // Replace any pending candidate — it came from an older deliberation.
    this.#candidate = option;
    return true;
  }

  /** Abort the current intention (it became invalid or impossible). */
  abortCurrent(reason = 'invalidated') {
    if (this.#current && !this.#current.stopped) {
      this.logger?.log('intention_aborted', { key: this.#current.key, reason });
      this.#current.stop();
    }
  }

  /** Consume candidates forever; call stop() to terminate. */
  async loop() {
    this.#running = true;
    while (this.#running) {
      const option = this.#candidate;
      if (!option) {
        await sleep(50);
        continue;
      }
      this.#candidate = null;

      const intention = new Intention(option, this.context);
      this.#current = intention;
      this.metrics?.increment('intentionChanges');
      this.logger?.log('intention_started', { key: option.key, utility: option.utility });
      this.onIntentionChange?.(intention);

      try {
        await intention.achieve();
        this.logger?.log('intention_done', { key: option.key });
      } catch (error) {
        this.metrics?.increment('failedIntentions');
        this.logger?.log('intention_failed', {
          key: option.key,
          reason: String(error?.reason ?? error?.message ?? error),
        });
      }

      if (this.#current === intention) this.#current = null;
      this.onIdle?.();
    }
  }

  stop() {
    this.#running = false;
    this.abortCurrent('shutdown');
  }
}
