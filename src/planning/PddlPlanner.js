import { keyOf } from '../utils/serialization.js';
import { DELIVEROO_DOMAIN, DOMAIN_NAME, ACTION_TO_DIRECTION } from './pddlDomain.js';

/**
 * Wrapper around the online PDDL solver (@unitn-asa/pddl-client).
 *
 * Role in the architecture: the PDDL planner is a *plan library member*.
 * The `go_to` intention can be served either by the fast BFS plan or by a
 * PDDL plan generated from current beliefs — both produce the same kind
 * of deterministic move sequence, executed by the same ActionExecutor.
 * This keeps PDDL meaningful (it genuinely plans the means of an
 * intention) without putting a slow network call in the outer loop.
 *
 * The integration is optional at runtime: when PDDL_ENABLED is false or
 * the pddl-client package / solver is unavailable, agents silently fall
 * back to BFS. Solver calls are also time-limited, because the online
 * planner can be slower than the live game loop. Every call and failure
 * is logged for the report.
 */
export class PddlPlanner {
  /**
   * @param {object} deps
   * @param {import('../core/BeliefBase.js').BeliefBase} deps.beliefs
   * @param {object} deps.config full runtime config (reads config.pddl)
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [deps.metrics]
   * @param {import('../metrics/RunLogger.js').RunLogger} [deps.logger]
   */
  constructor({ beliefs, config, metrics = null, logger = null }) {
    this.beliefs = beliefs;
    this.config = config;
    this.metrics = metrics;
    this.logger = logger;
    this.#solver = null;
  }

  #solver;

  isEnabled() {
    return !!this.config.pddl?.enabled;
  }

  isDeliveryEnabled() {
    return !!this.config.pddl?.enabled && !!this.config.pddl?.deliveryEnabled;
  }

  /**
   * Plan a move sequence from `from` to `to` using the online solver.
   * @returns {Promise<string[]>} directions ('up'|'down'|'left'|'right')
   * @throws on solver failure / unreachable target / oversized problem
   */
  async planPath(from, to) {
    this.metrics?.increment('plannerCalls');
    const startedAt = Date.now();
    try {
      const problem = this.buildProblem(from, to);
      const solver = await this.#loadSolver();
      const steps = await this.#solveWithTimeout(solver, DELIVEROO_DOMAIN, problem);
      if (!steps || steps.length === 0) {
        throw new Error('solver returned no plan');
      }
      const directions = this.#parseSteps(steps)
        .filter((step) => step.type === 'move')
        .map((step) => step.direction)
        .filter(Boolean);
      this.logger?.log('pddl_plan', {
        from, to,
        steps: directions.length,
        durationMs: Date.now() - startedAt,
      });
      return directions;
    } catch (error) {
      this.metrics?.increment('plannerFailures');
      this.logger?.log('pddl_failure', {
        from, to,
        error: String(error?.message ?? error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  /**
   * Generate a PDDL problem string from current beliefs: the reachable
   * region around the agent becomes the object set, allowed movements
   * become directed edge predicates.
   */
  buildProblem(from, to) {
    const graph = this.beliefs.graph;
    if (!graph) throw new Error('map not loaded yet');

    const startKey = keyOf(from.x, from.y);
    const goalKey = keyOf(to.x, to.y);
    const maxTiles = this.config.pddl?.maxTiles ?? 1600;

    const region = this.#reachableRegion(startKey, maxTiles);
    if (region.size > maxTiles) throw new Error(`problem too large (> ${maxTiles} tiles)`);
    if (!region.has(goalKey)) throw new Error(`target ${goalKey} unreachable from ${startKey}`);

    const objects = [...region].map(this.#tileObject).join(' ');
    const init = [`(at ${this.#tileObject(startKey)})`, ...this.#movementPredicates(region)];

    return `
(define (problem deliveroo-path)
  (:domain ${DOMAIN_NAME})
  (:objects ${objects})
  (:init ${init.join(' ')})
  (:goal (at ${this.#tileObject(goalKey)}))
)
`.trim();
  }

  /**
   * Generate a full single-parcel collect-and-deliver PDDL problem.
   * The goal is `(delivered parcel)`; pickup and putdown are solved by
   * PDDL together with the movement path. If `deliveryTile` is provided,
   * only that tile is marked as a valid delivery target; otherwise every
   * currently allowed delivery tile is accepted.
   *
   * @param {{x:number,y:number}} from
   * @param {{id:string,x:number,y:number}} parcel free parcel to collect
   * @param {{x:number,y:number}|null} [deliveryTile]
   */
  buildDeliveryProblem(from, parcel, deliveryTile = null) {
    const graph = this.beliefs.graph;
    if (!graph) throw new Error('map not loaded yet');
    if (!parcel?.id) throw new Error('parcel id required');

    const startKey = keyOf(from.x, from.y);
    const parcelKey = keyOf(parcel.x, parcel.y);
    const maxTiles = this.config.pddl?.maxTiles ?? 1600;
    const region = this.#reachableRegion(startKey, maxTiles);
    if (region.size > maxTiles) throw new Error(`problem too large (> ${maxTiles} tiles)`);
    if (!region.has(parcelKey)) throw new Error(`parcel ${parcel.id} unreachable from ${startKey}`);

    const deliveryKeys = deliveryTile
      ? [keyOf(deliveryTile.x, deliveryTile.y)]
      : graph.deliveryTiles.map((tile) => keyOf(tile.x, tile.y));
    const reachableDeliveries = deliveryKeys.filter((key) => region.has(key));
    if (reachableDeliveries.length === 0) throw new Error('no reachable delivery tile');

    const parcelObject = this.#parcelObject(parcel.id);
    const objects = [...region].map(this.#tileObject).concat(parcelObject).join(' ');
    const init = [
      `(at ${this.#tileObject(startKey)})`,
      `(parcel ${parcelObject})`,
      `(parcel-at ${parcelObject} ${this.#tileObject(parcelKey)})`,
      ...reachableDeliveries.map((key) => `(delivery ${this.#tileObject(key)})`),
      ...this.#movementPredicates(region),
    ];

    return `
(define (problem deliveroo-delivery)
  (:domain ${DOMAIN_NAME})
  (:objects ${objects})
  (:init ${init.join(' ')})
  (:goal (delivered ${parcelObject}))
)
`.trim();
  }

  /**
   * Optional full-task solver used for PDDL-vs-BFS experiments. Runtime
   * plans still prefer deterministic BDI steps unless explicitly wired.
   * @returns {Promise<object[]>} symbolic steps
   */
  async planDelivery(from, parcel, deliveryTile = null) {
    this.metrics?.increment('plannerCalls');
    const startedAt = Date.now();
    try {
      const problem = this.buildDeliveryProblem(from, parcel, deliveryTile);
      const solver = await this.#loadSolver();
      const steps = await this.#solveWithTimeout(solver, DELIVEROO_DOMAIN, problem);
      if (!steps || steps.length === 0) throw new Error('solver returned no plan');
      const parsed = this.#parseSteps(steps);
      this.logger?.log('pddl_delivery_plan', {
        from,
        parcelId: parcel.id,
        steps: parsed.length,
        durationMs: Date.now() - startedAt,
      });
      return parsed;
    } catch (error) {
      this.metrics?.increment('plannerFailures');
      this.logger?.log('pddl_failure', {
        from,
        parcelId: parcel?.id,
        error: String(error?.message ?? error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  #reachableRegion(startKey, maxTiles) {
    const graph = this.beliefs.graph;
    const region = new Set([startKey]);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length && region.size <= maxTiles) {
      const key = queue[head++];
      const tile = graph.tiles.get(key);
      if (!tile) continue;
      for (const edge of graph.neighbors(tile.x, tile.y, false)) {
        if (!region.has(edge.key)) {
          region.add(edge.key);
          queue.push(edge.key);
        }
      }
    }
    return region;
  }

  #movementPredicates(region) {
    const graph = this.beliefs.graph;
    const init = [];
    for (const key of region) {
      const { x, y } = graph.tiles.get(key);
      for (const edge of graph.neighbors(x, y, false)) {
        if (!region.has(edge.key)) continue;
        init.push(`(${edge.direction} ${this.#tileObject(key)} ${this.#tileObject(edge.key)})`);
      }
    }
    return init;
  }

  #tileObject(key) {
    return `t_${key.replace(',', '_')}`;
  }

  #parcelObject(id) {
    return `p_${String(id).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }

  #parseSteps(steps) {
    return steps.map((step) => {
      const action = String(step.action).toLowerCase();
      const args = this.#stepArgs(step);
      if (ACTION_TO_DIRECTION[action]) {
        return { type: 'move', direction: ACTION_TO_DIRECTION[action], raw: step };
      }
      if (action === 'pickup') return { type: 'pickup', parcel: args[0], tile: args[1], raw: step };
      if (action === 'putdown') return { type: 'putdown', parcel: args[0], tile: args[1], raw: step };
      return { type: 'unknown', action, raw: step };
    });
  }

  #stepArgs(step) {
    if (Array.isArray(step.args)) return step.args;
    if (Array.isArray(step.parameters)) return step.parameters;
    if (typeof step.args === 'string') return step.args.trim().split(/\s+/).filter(Boolean);
    if (typeof step.parameters === 'string') return step.parameters.trim().split(/\s+/).filter(Boolean);
    if (typeof step.name === 'string') return step.name.trim().split(/\s+/).slice(1);
    return [];
  }

  async #solveWithTimeout(solver, domain, problem) {
    const timeoutMs = this.config.pddl?.timeoutMs ?? 2500;
    if (!timeoutMs || timeoutMs <= 0) return solver(domain, problem);

    let timeoutId = null;
    try {
      return await Promise.race([
        solver(domain, problem),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`solver timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /** Lazy-load the solver so missing deps only matter when PDDL is used. */
  async #loadSolver() {
    if (this.#solver) return this.#solver;
    try {
      const { onlineSolver } = await import('@unitn-asa/pddl-client');
      this.#solver = onlineSolver;
      return this.#solver;
    } catch {
      throw new Error('@unitn-asa/pddl-client not installed — run npm install or set PDDL_ENABLED=false');
    }
  }
}
