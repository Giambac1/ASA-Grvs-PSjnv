import { Intention } from './Intention.js';
import { sleep } from '../utils/sleep.js';
import { normalizeIdList } from '../utils/serialization.js';

/**
 * Plan library: maps intentions (options) to executable plans.
 *
 * Each plan class declares its applicability statically and implements
 * `execute(option)`. Plans are deterministic: they translate an option
 * into awaited, serialized game actions. Failures throw, the Intention
 * falls back to the next applicable plan, and ultimately the intention
 * revision loop re-deliberates — this is how failures are "reported to
 * the intention layer".
 */
export class PlanLibrary {
  #planClasses = [];

  register(PlanClass) {
    this.#planClasses.push(PlanClass);
  }

  /** Applicable plan classes for an option, in registration order. */
  plansFor(option, context) {
    return this.#planClasses.filter((P) => P.isApplicableTo(option, context));
  }
}

/** Shared base: stop propagation and sub-intention support. */
class PlanBase {
  #stopped = false;
  #subIntentions = [];

  constructor(context, parent) {
    this.context = context;
    this.parent = parent;
  }

  get stopped() {
    return this.#stopped;
  }

  stop() {
    this.#stopped = true;
    for (const sub of this.#subIntentions) sub.stop();
  }

  log(...args) {
    this.parent?.log?.(...args);
  }

  /** Throw if this plan (or its intention) was stopped. */
  assertRunning() {
    if (this.#stopped || this.parent?.stopped) throw { reason: 'stopped' };
  }

  /** Achieve a nested option (e.g. go_pick_up -> go_to) as a sub-intention. */
  async subIntention(option) {
    const sub = new Intention(option, this.context, this);
    this.#subIntentions.push(sub);
    return sub.achieve();
  }
}

// ---------------------------------------------------------------------------
// Movement plans (the deterministic core)
// ---------------------------------------------------------------------------

/**
 * Follow a BFS path step by step. Handles failed moves: a dynamic
 * blocker (another agent) gets a few retries and a path recompute;
 * persistent failure soft-blocks the tile and fails the plan, reporting
 * the failure up to the intention layer.
 */
export class FollowPathGoTo extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'go_to';
  }

  async execute(option) {
    const { beliefs, executor, pathPlanner, metrics, config } = this.context;
    const retries = config?.agent?.moveRetries ?? 2;
    const retryDelay = config?.agent?.moveRetryDelayMs ?? 200;
    const softBlockMs = config?.agent?.softBlockMs ?? 3000;

    const atTarget = () =>
      Math.round(beliefs.me.x) === option.x && Math.round(beliefs.me.y) === option.y;

    let consecutiveFailures = 0;

    while (!atTarget()) {
      this.assertRunning();

      const path = pathPlanner.shortestPath(
        { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) },
        { x: option.x, y: option.y },
      );
      if (!path) throw { reason: 'unreachable' };
      if (path.directions.length === 0) break;

      for (let i = 0; i < path.directions.length; i++) {
        this.assertRunning();
        const nextTile = path.tiles[i];
        if (nextTile && beliefs.graph && !beliefs.graph.isWalkable(nextTile.x, nextTile.y)) {
          metrics?.increment('failedMoves');
          throw { reason: 'path-invalidated' };
        }
        const result = await executor.move(path.directions[i]);

        if (result === false) {
          consecutiveFailures += 1;
          metrics?.increment('failedMoves');
          if (consecutiveFailures > retries) {
            // Probably a stationary agent: route around it for a while.
            const blockedTile = path.tiles[i];
            if (blockedTile) beliefs.graph?.softBlock(blockedTile.x, blockedTile.y, softBlockMs);
            throw { reason: 'path-blocked' };
          }
          await sleep(retryDelay);
          break; // recompute the path (the blocker may have moved)
        }

        consecutiveFailures = 0;
        // The move ack is the authoritative position update.
        beliefs.me.x = result.x;
        beliefs.me.y = result.y;
      }
    }
    return true;
  }
}

/**
 * Serve `go_to` with a PDDL plan from the online solver (meaningful PDDL
 * integration: same intention, planner-built means). Registered before
 * the BFS plan when PDDL is enabled; any failure (solver down, problem
 * too large, move blocked) falls back to FollowPathGoTo automatically.
 */
export class PddlGoTo extends PlanBase {
  static isApplicableTo(option, context) {
    if (option.type !== 'go_to' || !context?.pddlPlanner?.isEnabled()) return false;
    if (option.pddlAllowed === false) return false;

    const carrying = context.beliefs?.carried?.().length ?? 0;
    if (carrying > 0 && context.config?.pddl?.avoidWhileCarrying !== false) return false;

    const path = context.pathPlanner?.shortestPath?.(
      {
        x: Math.round(context.beliefs.me.x),
        y: Math.round(context.beliefs.me.y),
      },
      { x: option.x, y: option.y },
    );
    if (!path) return false;

    const minPathLength = context.config?.pddl?.minPathLength ?? 10;
    return path.directions.length >= minPathLength;
  }

  async execute(option) {
    const { beliefs, executor, pddlPlanner, metrics } = this.context;
    const directions = await pddlPlanner.planPath(
      { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) },
      { x: option.x, y: option.y },
    );
    for (const direction of directions) {
      this.assertRunning();
      const result = await executor.move(direction);
      if (result === false) {
        metrics?.increment('failedMoves');
        // No local repair here: fail so the BFS plan (which handles
        // dynamic obstacles) takes over.
        throw { reason: 'pddl-step-blocked' };
      }
      beliefs.me.x = result.x;
      beliefs.me.y = result.y;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Task plans
// ---------------------------------------------------------------------------

export class GoPickUp extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'go_pick_up';
  }

  async execute(option) {
    const { beliefs, executor, metrics, logger } = this.context;

    await this.subIntention({ type: 'go_to', key: `go_to:${option.x},${option.y}`, x: option.x, y: option.y });
    this.assertRunning();

    const picked = await executor.pickup();
    if (picked.length === 0) {
      // Race lost: the parcel expired or someone got there first.
      metrics?.increment('pickupsLost');
      beliefs.parcels.delete(option.parcelId);
      throw { reason: 'pickup-empty' };
    }
    // Ack shape varies across server versions; when no ids are usable,
    // fall back to "everything on my tile is now carried" (the actual
    // pickup semantics).
    const pickedIds = normalizeIdList(picked);
    if (pickedIds.length > 0) {
      for (const id of pickedIds) beliefs.markCarried(id);
    } else {
      beliefs.markTilePickedUp();
    }
    metrics?.increment('parcelsPickedUp', picked.length);
    logger?.log('pickup', { count: picked.length, ids: pickedIds });
    return true;
  }
}

/**
 * Mission-aware putdown selection (shared by the BDI and PDDL delivery
 * plans so both enforce the same safety). Default: empty list = drop all.
 *  - deliver_exactly_n: drop exactly N (highest value first);
 *  - deliver_less_value_than: greedy lowest-value subset under the cap
 *    (null = no compliant subset yet, so do not put down).
 * TODO(strategy): tune subset choice (e.g. keep high-value parcels
 * carried for a later compliant delivery).
 */
export function selectParcelsForPutdown(beliefs) {
  const carried = beliefs.carried();
  const { deliverExactly, deliverMaxValue } = beliefs.mission;

  if (deliverExactly != null && carried.length > deliverExactly) {
    return carried
      .slice()
      .sort((a, b) => beliefs.projectedReward(b) - beliefs.projectedReward(a))
      .slice(0, deliverExactly)
      .map((p) => p.id);
  }

  if (deliverMaxValue != null) {
    const sorted = carried
      .slice()
      .sort((a, b) => beliefs.projectedReward(a) - beliefs.projectedReward(b));
    const selected = [];
    let total = 0;
    for (const parcel of sorted) {
      const value = Math.max(beliefs.projectedReward(parcel), 0);
      if (value > deliverMaxValue || total + value > deliverMaxValue) break;
      selected.push(parcel.id);
      total += value;
    }
    if (selected.length > 0) return selected;
    return null;
  }

  return []; // empty list = put down everything
}

/**
 * Optional full-task PDDL plan: solve "go to parcel, pick it up, go to a
 * delivery tile, put it down" as one symbolic task. This is deliberately
 * gated by `PDDL_DELIVERY_ENABLED`: it is useful for PDDL experiments,
 * while the normal BDI decomposition remains the default low-latency path.
 *
 * Mission-safe by construction: it does not activate while a delivery /
 * positional mission constraint is in force (those are served by the
 * dedicated BDI mission plans), and its putdown step reuses the same
 * `selectParcelsForPutdown` guard as `DeliverCarried`, so it can never
 * drop a non-compliant batch.
 */
export class PddlPickUpAndDeliver extends PlanBase {
  static isApplicableTo(option, context) {
    if (option.type !== 'go_pick_up' || !context?.pddlPlanner?.isDeliveryEnabled?.()) {
      return false;
    }
    // Defer to the dedicated BDI mission plans whenever a mission
    // constraint is active: the single-parcel PDDL task cannot honour
    // multi-parcel exact-N / threshold / positional / handover missions.
    const m = context?.beliefs?.mission;
    if (m && (m.deliverExactly != null || m.deliverMaxValue != null
              || m.active != null || m.handover?.active === true)) {
      return false;
    }
    return true;
  }

  async execute(option) {
    const { beliefs, executor, pddlPlanner, metrics, logger } = this.context;
    const parcel = beliefs.parcels.get(option.parcelId);
    if (!parcel || parcel.carriedBy) throw { reason: 'pddl-delivery-parcel-gone' };

    const steps = await pddlPlanner.planDelivery(
      { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) },
      { id: parcel.id, x: option.x, y: option.y },
    );

    let picked = false;
    for (const step of steps) {
      this.assertRunning();
      if (step.type === 'move') {
        const result = await executor.move(step.direction);
        if (result === false) {
          metrics?.increment('failedMoves');
          throw { reason: 'pddl-delivery-step-blocked' };
        }
        beliefs.me.x = result.x;
        beliefs.me.y = result.y;
      } else if (step.type === 'pickup') {
        const ack = await executor.pickup();
        if (ack.length === 0) {
          beliefs.parcels.delete(option.parcelId);
          throw { reason: 'pddl-delivery-pickup-empty' };
        }
        const ids = normalizeIdList(ack);
        if (ids.length > 0) {
          for (const id of ids) beliefs.markCarried(id);
        } else {
          beliefs.markTilePickedUp();
        }
        picked = true;
        metrics?.increment('parcelsPickedUp', ack.length);
        logger?.log('pickup', { count: ack.length, ids, via: 'pddl_delivery' });
      } else if (step.type === 'putdown') {
        if (!picked && beliefs.carried().length === 0) {
          throw { reason: 'pddl-delivery-putdown-before-pickup' };
        }
        // Defense-in-depth: reuse the BDI mission-safety selection so a
        // PDDL delivery can never drop a non-compliant batch. With no
        // mission this is [] (drop all) — same as before. On a constraint
        // it cannot satisfy, abort so the normal plans take over.
        const mission = beliefs.mission;
        // The applicability gate only covers plan start; a positional /
        // handover mission may arrive WHILE this plan runs, so re-check here.
        if (mission.active != null || mission.handover?.active === true) {
          throw { reason: 'pddl-delivery-mission-active' };
        }
        if (mission.deliverExactly != null && beliefs.carried().length < mission.deliverExactly) {
          throw { reason: 'pddl-delivery-exactly-not-ready' };
        }
        const requestedIds = selectParcelsForPutdown(beliefs);
        if (requestedIds === null) {
          throw { reason: 'pddl-delivery-threshold-not-ready' };
        }
        const dropped = await executor.putdown(requestedIds);
        if (dropped.length === 0) {
          beliefs.clearCarried();
          throw { reason: 'pddl-delivery-putdown-empty' };
        }
        const ids = normalizeIdList(dropped);
        if (ids.length > 0) beliefs.markDelivered(ids);
        else if (requestedIds.length > 0) beliefs.markDelivered(requestedIds);
        else beliefs.clearCarried();
        metrics?.increment('parcelsDelivered', dropped.length);
        logger?.log('delivery', { count: dropped.length, ids, via: 'pddl_delivery' });
      }
    }
    return true;
  }
}

export class DeliverCarried extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'deliver_carried';
  }

  async execute() {
    const { beliefs, executor, pathPlanner, metrics, logger } = this.context;

    const target = pathPlanner.nearestDelivery({
      x: Math.round(beliefs.me.x),
      y: Math.round(beliefs.me.y),
    });
    if (!target) throw { reason: 'no-delivery-reachable' };

    await this.subIntention({
      type: 'go_to',
      key: `go_to:${target.tile.x},${target.tile.y}`,
      x: target.tile.x,
      y: target.tile.y,
      pddlAllowed: false,
    });
    this.assertRunning();

    const carried = beliefs.carried();
    const { deliverExactly } = beliefs.mission;
    if (deliverExactly != null && carried.length < deliverExactly) {
      throw { reason: 'deliver-exactly-not-ready' };
    }

    const requestedIds = selectParcelsForPutdown(beliefs);
    if (requestedIds === null) {
      throw { reason: 'deliver-threshold-not-ready' };
    }
    const dropped = await executor.putdown(requestedIds);
    if (dropped.length === 0) {
      // The server says we held nothing: the carry belief was wrong
      // (phantom parcels). Reconcile so we do not retry forever.
      beliefs.clearCarried();
      throw { reason: 'putdown-empty' };
    }

    // Prefer ack ids; fall back to what we asked to drop (or everything,
    // when the request was "drop all") — ack shapes vary across servers.
    const droppedIds = normalizeIdList(dropped);
    if (droppedIds.length > 0) beliefs.markDelivered(droppedIds);
    else if (requestedIds.length > 0) beliefs.markDelivered(requestedIds);
    else beliefs.clearCarried();
    metrics?.increment('parcelsDelivered', dropped.length);
    logger?.log('delivery', { count: dropped.length, ids: droppedIds });
    return true;
  }
}

export class GoToMissionTarget extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'go_to_mission_target';
  }

  async execute(option) {
    const { beliefs, executor, pathPlanner, logger } = this.context;
    const mission = option.mission;
    if (!beliefs.mission.active) throw { reason: 'mission-gone' };

    // Go-to-and-wait (26c2_10): reach a tile WITHIN `tolerance` of the
    // target (two agents cannot share a tile), then wait for the teammate
    // to reach the neighbourhood too (via position heartbeats) and hold
    // together briefly so the mission observer sees both in place.
    if (mission.kind === 'go_to' && mission.holdAtTarget && (mission.tolerance ?? 0) > 0) {
      const target = mission.targets?.[0];
      if (!target) throw { reason: 'mission-target-unreachable' };
      const hold = chooseHoldTile(beliefs, pathPlanner, target, mission.tolerance);
      if (!hold) throw { reason: 'mission-target-unreachable' };
      const atHold = () => Math.round(beliefs.me.x) === hold.x && Math.round(beliefs.me.y) === hold.y;
      if (!atHold()) {
        await this.subIntention({ type: 'go_to', key: `go_to:${hold.x},${hold.y}`, x: hold.x, y: hold.y });
        this.assertRunning();
      }
      const arrived = await this.#waitForTeammateNear(target, mission.tolerance);
      if (!arrived) {
        // Do NOT falsely complete: the mission needs BOTH agents in the
        // neighbourhood. Fail and keep the mission active so we retry
        // (the agent holds its position and waits again).
        logger?.log('mission_wait_timeout', { kind: mission.kind, target: hold, tolerance: mission.tolerance });
        throw { reason: 'teammate-not-arrived' };
      }
      // Both in the neighbourhood: hold together so the observer sees them.
      await sleep(this.context.config?.agent?.holdTogetherMs ?? 2000);
      logger?.log('mission_target_reached', { kind: mission.kind, target: hold, tolerance: mission.tolerance, waited: true });
      beliefs.completeMission();
      return true;
    }

    // Choose the nearest of the mission's target coordinates.
    const me = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
    let best = null;
    let bestLength = Infinity;
    for (const target of mission.targets) {
      const path = pathPlanner.shortestPath(me, target);
      if (path && path.directions.length < bestLength) {
        best = target;
        bestLength = path.directions.length;
      }
    }
    if (!best) throw { reason: 'mission-target-unreachable' };

    await this.subIntention({ type: 'go_to', key: `go_to:${best.x},${best.y}`, x: best.x, y: best.y });
    this.assertRunning();

    if (mission.kind === 'deliver_at') {
      // Give the mission observer a stable frame with agent + parcel on the
      // target tile before the parcel disappears through putdown.
      await sleep(500);
      this.assertRunning();
      const dropped = await executor.putdown();
      if (dropped.length === 0) {
        beliefs.clearCarried(); // carry belief contradicted — reconcile
        throw { reason: 'deliver-at-empty' };
      }
      const droppedIds = normalizeIdList(dropped);
      beliefs.markDropped(
        droppedIds.length > 0 ? droppedIds : beliefs.carried().map((p) => p.id),
      );
    }

    if (mission.kind === 'go_to' && mission.holdAtTarget) {
      // Legacy hold (holdAtTarget without a tolerance): brief fixed hold.
      await sleep(this.context.config?.agent?.holdTogetherMs ?? 2000);
    }

    logger?.log('mission_target_reached', { kind: mission.kind, target: best });
    beliefs.completeMission();
    return true;
  }

  /**
   * Wait until the teammate is within `radius` (Manhattan) of the target,
   * using the position heartbeats already maintained in beliefs.teammate.
   * Bounded by teammateWaitMs.
   * @returns {Promise<boolean>} true if the teammate reached the
   *   neighbourhood before the deadline, false on timeout.
   */
  async #waitForTeammateNear(target, radius) {
    const { beliefs, config } = this.context;
    const deadline = Date.now() + (config?.agent?.teammateWaitMs ?? 15000);
    const mateNear = () => {
      const m = beliefs.teammate;
      if (m?.x == null || m?.y == null) return false;
      return Math.abs(Math.round(m.x) - target.x) + Math.abs(Math.round(m.y) - target.y) <= radius;
    };
    while (!mateNear() && Date.now() < deadline) {
      this.assertRunning();
      await sleep(200);
    }
    return mateNear();
  }
}

/**
 * Pick a hold tile for a go-to-and-wait mission: the nearest reachable
 * walkable tile within `radius` (Manhattan) of the target, preferring not
 * the teammate's current tile so the two agents do not contend for the
 * same spot. Returns null when nothing in range is reachable.
 * @param {import('./BeliefBase.js').BeliefBase} beliefs
 * @param {import('../planning/PathPlanner.js').PathPlanner} pathPlanner
 * @param {{x:number, y:number}} target
 * @param {number} radius
 * @returns {{x:number, y:number}|null}
 */
export function chooseHoldTile(beliefs, pathPlanner, target, radius) {
  const graph = beliefs.graph;
  if (!graph) return null;
  const from = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
  const mate = beliefs.teammate;
  const mateTile = mate?.x != null && mate?.y != null
    ? { x: Math.round(mate.x), y: Math.round(mate.y) }
    : null;
  let best = null;
  let bestScore = Infinity;
  for (const tile of graph.tiles.values()) {
    if (!tile.walkable) continue;
    if (Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) > radius) continue;
    const path = pathPlanner.shortestPath(from, { x: tile.x, y: tile.y });
    if (!path) continue;
    const onMate = mateTile && mateTile.x === tile.x && mateTile.y === tile.y;
    const score = path.directions.length + (onMate ? 1000 : 0);
    if (score < bestScore) {
      best = { x: tile.x, y: tile.y };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Picker side of the one_pickup_another_deliver handover (26c2_8): carry
 * the held parcel to the shared rendezvous, drop it on that (non-delivery)
 * tile so it stays on the ground, step off to free the tile for the
 * deliverer, then signal the drop (coordinates are the robust locator).
 * The deliverer-side collect/deliver is a separate plan.
 */
export class HandoverDeposit extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'handover_deposit';
  }

  async execute(option) {
    const { beliefs, executor, protocol, metrics, logger } = this.context;
    const handover = beliefs.mission.handover;
    if (!handover?.active || handover.role !== 'picker') throw { reason: 'not-picker' };
    const r = option.rendezvous ?? handover.rendezvous;
    if (!r) throw { reason: 'no-rendezvous' };
    if (beliefs.carried().length === 0) throw { reason: 'nothing-to-hand-over' };

    // 1. carry the parcel to the rendezvous tile
    await this.subIntention({ type: 'go_to', key: `go_to:${r.x},${r.y}`, x: r.x, y: r.y });
    this.assertRunning();

    // 2. drop on the rendezvous (non-delivery -> the parcel stays free)
    const carriedIds = beliefs.carried().map((p) => p.id);
    const dropped = await executor.putdown();
    if (dropped.length === 0) {
      beliefs.clearCarried(); // carry belief contradicted — reconcile
      throw { reason: 'deposit-empty' };
    }
    const droppedIds = normalizeIdList(dropped);
    beliefs.markDropped(droppedIds.length > 0 ? droppedIds : carriedIds);
    const parcelId = droppedIds[0] ?? carriedIds[0] ?? null;

    // 3. free the rendezvous tile so the deliverer can step onto it. Two
    // agents cannot share a tile, so if we cannot vacate we must NOT
    // signal — otherwise the deliverer would head for a tile we block.
    // Try every neighbour (a single exit may be transiently occupied).
    let freed = false;
    for (const exit of beliefs.graph?.neighbors(r.x, r.y) ?? []) {
      const moved = await executor.move(exit.direction);
      if (moved !== false) {
        beliefs.me.x = moved.x;
        beliefs.me.y = moved.y;
        freed = true;
        break;
      }
    }
    if (!freed) {
      metrics?.increment('handoverExitBlocked');
      logger?.log('handover_exit_blocked', { x: r.x, y: r.y, parcelId });
      throw { reason: 'handover-exit-blocked' };
    }

    // 4. record + signal the drop (coordinates locate it; id is a hint)
    handover.parcel = { id: parcelId, x: r.x, y: r.y };
    handover.myState = 'dropped';
    await protocol?.sendHandover({ state: 'dropped', parcelId, x: r.x, y: r.y });

    metrics?.increment('handoverDeposits');
    logger?.log('handover_deposit', { x: r.x, y: r.y, parcelId, count: dropped.length });
    return true;
  }
}

/**
 * Deliverer side of the one_pickup_another_deliver handover (26c2_8): go
 * to the drop (located by coordinates — robust to missing/stale ids),
 * pick it up, and clear the handover slot. The parcel is then carried by
 * us, so the normal DeliverCarried plan delivers it on a delivery tile —
 * a different agent than the picker, which is what earns the team bonus.
 */
export class HandoverCollect extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'handover_collect';
  }

  async execute(option) {
    const { beliefs, executor, metrics, logger } = this.context;
    const handover = beliefs.mission.handover;
    if (!handover?.active || handover.role !== 'deliverer') throw { reason: 'not-deliverer' };
    const drop = handover.parcel ?? option;
    if (!Number.isFinite(drop?.x) || !Number.isFinite(drop?.y)) throw { reason: 'no-drop' };

    // 1. go to the drop tile (coordinates are the authoritative locator)
    await this.subIntention({ type: 'go_to', key: `go_to:${drop.x},${drop.y}`, x: drop.x, y: drop.y });
    this.assertRunning();

    // 2. collect the handed-over parcel(s)
    const picked = await executor.pickup();
    if (picked.length === 0) {
      handover.parcel = null; // the drop is gone (decayed / already taken)
      metrics?.increment('handoverCollectsEmpty');
      throw { reason: 'handover-collect-empty' };
    }
    const pickedIds = normalizeIdList(picked);
    if (pickedIds.length > 0) for (const id of pickedIds) beliefs.markCarried(id);
    else beliefs.markTilePickedUp();

    // 3. clear the slot so we deliver it next (and do not re-collect here)
    handover.parcel = null;
    handover.myState = 'collected';
    metrics?.increment('handoverCollects');
    logger?.log('handover_collect', { x: drop.x, y: drop.y, count: picked.length });
    return true;
  }
}

export class Explore extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'explore';
  }

  /**
   * Visit the spawner tile seen least recently (never-seen tiles first).
   * Spawners are where parcels appear, so they maximize the information
   * gained per tile traveled.
   */
  async execute() {
    const { beliefs } = this.context;
    const candidates = (beliefs.graph?.spawnerTiles ?? [])
      .map((tile) => ({
        tile,
        lastSeen: beliefs.tileLastSeen.get(`${tile.x},${tile.y}`) ?? 0,
      }))
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, 3); // try the 3 stalest, in case some are unreachable

    for (const { tile } of candidates) {
      this.assertRunning();
      try {
        await this.subIntention({ type: 'go_to', key: `go_to:${tile.x},${tile.y}`, x: tile.x, y: tile.y });
        return true;
      } catch {
        // unreachable or blocked — try the next candidate
      }
    }
    throw { reason: 'no-explore-target' };
  }
}

export class Wait extends PlanBase {
  static isApplicableTo(option) {
    return option.type === 'wait';
  }

  async execute() {
    await sleep(this.context.config?.agent?.waitMs ?? 300);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Default library assembly
// ---------------------------------------------------------------------------

/**
 * Build the default plan library. Order matters: for `go_to`, the PDDL
 * plan (when enabled) is tried before the BFS plan, which acts as the
 * deterministic fallback.
 */
export function buildDefaultPlanLibrary() {
  const library = new PlanLibrary();
  library.register(PddlPickUpAndDeliver);
  library.register(GoPickUp);
  library.register(DeliverCarried);
  library.register(GoToMissionTarget);
  library.register(HandoverDeposit);
  library.register(HandoverCollect);
  library.register(Explore);
  library.register(Wait);
  library.register(PddlGoTo); // applicability self-checks pddl enablement
  library.register(FollowPathGoTo);
  return library;
}
