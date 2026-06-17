/**
 * A committed option being achieved through plans, following the
 * professor's lab4 pattern: the intention iterates over the applicable
 * plan classes in the PlanLibrary and tries them in order until one
 * succeeds; failures fall through to the next plan (e.g. PDDL plan
 * fails -> BFS plan takes over).
 *
 * Intentions are stoppable: stop() propagates to the running plan and
 * its sub-intentions, making intention revision safe at any point.
 */
export class Intention {
  #stopped = false;
  #started = false;
  #currentPlan = null;

  /**
   * @param {object} option   the option this intention commits to
   * @param {object} context  plan context {beliefs, executor, pathPlanner,
   *                          pddlPlanner, planLibrary, metrics, logger, config}
   * @param {object|null} parent  enclosing plan (for sub-intentions) or null
   */
  constructor(option, context, parent = null) {
    this.option = option;
    this.context = context;
    this.parent = parent;
  }

  get key() {
    return this.option.key;
  }

  get stopped() {
    return this.#stopped;
  }

  stop() {
    this.#stopped = true;
    this.#currentPlan?.stop();
  }

  log(...args) {
    if (this.parent?.log) this.parent.log('  ', ...args);
    else this.context.logger?.log('intention', { msg: args.map(String).join(' ') });
  }

  /**
   * Try every applicable plan until one succeeds.
   * @returns {Promise<boolean>}
   * @throws {{reason: string}} when stopped or no plan succeeded
   */
  async achieve() {
    if (this.#started) return false;
    this.#started = true;

    const planClasses = this.context.planLibrary.plansFor(this.option, this.context);

    for (const PlanClass of planClasses) {
      if (this.#stopped) throw { reason: 'stopped', option: this.option };
      this.#currentPlan = new PlanClass(this.context, this);
      try {
        const result = await this.#currentPlan.execute(this.option);
        return result ?? true;
      } catch (error) {
        // Cancellation is not a plan failure: if we were stopped, do not
        // log plan_failed (the logger may already be closing) and do not
        // try the next plan — propagate the stop immediately.
        if (this.#stopped) throw { reason: 'stopped', option: this.option };
        // Plan failed: log and fall through to the next applicable plan.
        this.context.logger?.log('plan_failed', {
          option: this.option.key,
          plan: PlanClass.name,
          reason: String(error?.reason ?? error?.message ?? error),
        });
      }
    }

    if (this.#stopped) throw { reason: 'stopped', option: this.option };
    throw { reason: 'no-plan-succeeded', option: this.option };
  }
}
