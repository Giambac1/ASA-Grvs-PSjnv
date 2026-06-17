import { GridGraph } from '../planning/GridGraph.js';
import { keyOf, clockEventToMs } from '../utils/serialization.js';

/**
 * Central belief store, revised from server events.
 *
 * Belief revision principles (lab2 / game_knowledge 05):
 *  - timestamp every dynamic belief (`lastSeen`);
 *  - project decay onto remembered parcel rewards — a remembered reward
 *    is an upper bound, the projection is the usable estimate;
 *  - negative evidence only arrives when a tile re-enters view: a
 *    remembered parcel is deleted when its tile is visible but the
 *    parcel is not sensed there anymore;
 *  - my own position/score are authoritative only via `you` / move acks.
 */
export class BeliefBase {
  /** My agent state (from the `you` event and action acks). */
  me = { id: null, name: null, teamId: null, x: null, y: null, score: 0, penalty: 0 };

  /** @type {GridGraph|null} static map graph, built once from `map`. */
  graph = null;

  /** parcelId -> {id, x, y, reward, carriedBy, lastSeen, rewardAtLastSeen} */
  parcels = new Map();

  /** agentId -> {id, name, teamId, x, y, score, lastSeen} (others only) */
  agents = new Map();

  /** tile key -> timestamp of last time the tile was inside sensing range */
  tileLastSeen = new Map();

  /** Raw server config payload ({CLOCK, PENALTY, GAME: {...}}). */
  config = null;

  /**
   * Fixed handover role for the one_pickup_another_deliver mission, set by
   * the runtime: 'picker' (Agent A / BDI collects) or 'deliverer'
   * (Agent B / LLM delivers). Explicit and deterministic, so the two
   * agents never both pick or both deliver.
   * @type {'picker'|'deliverer'|null}
   */
  handoverRole = null;

  /**
   * Mission state, written by the LLM interpreter (Agent B) or received
   * from the teammate via mission-update messages (Agent A).
   */
  mission = {
    active: null,          // structured mission with a positional goal (go_to / deliver_at)
    movementAllowed: true, // red-light/green-light gate
    deliverExactly: null,  // putdown exactly N parcels per delivery
    deliverMaxValue: null, // putdown total reward <= threshold
    handover: null,        // one-pickup-another-deliver coordination state
    lastQuestion: null,    // last question_answer mission (handled by Agent B)
  };

  /** Teammate state maintained by the TeamProtocol. */
  teammate = { id: null, name: null, x: null, y: null, carrying: 0, intention: null, lastSeen: 0 };

  /** parcelId -> agentId that claimed it (team deconfliction). */
  claims = new Map();

  // -------------------------------------------------------------------------
  // Revision entry points (one per server event)
  // -------------------------------------------------------------------------

  loadMap(width, height, tiles) {
    this.graph = new GridGraph(width, height, tiles);
  }

  updateTile(tile) {
    this.graph?.updateTile(tile);
  }

  updateConfig(config) {
    this.config = config;
  }

  updateMe(payload) {
    Object.assign(this.me, payload);
  }

  /**
   * Revise dynamic beliefs from a `sensing` event
   * ({positions, agents, parcels, crates}).
   */
  updateSensing(sensing) {
    const now = Date.now();

    const visibleTiles = new Set();
    for (const pos of sensing.positions ?? []) {
      const key = keyOf(pos.x, pos.y);
      visibleTiles.add(key);
      this.tileLastSeen.set(key, now);
    }

    const sensedParcelIds = new Set();
    for (const p of sensing.parcels ?? []) {
      sensedParcelIds.add(p.id);
      this.parcels.set(p.id, {
        ...p,
        lastSeen: now,
        rewardAtLastSeen: p.reward,
      });
    }

    // Negative evidence: a remembered parcel whose tile is currently
    // visible but that was not sensed is gone (delivered/stolen/expired).
    for (const [id, parcel] of this.parcels) {
      if (sensedParcelIds.has(id)) continue;
      if (parcel.carriedBy === this.me.id) continue; // I still hold it
      if (visibleTiles.has(keyOf(parcel.x, parcel.y))) this.parcels.delete(id);
    }

    // Projected expiry: drop beliefs whose projected reward reached zero.
    for (const [id, parcel] of this.parcels) {
      if (this.projectedReward(parcel) <= 0) this.parcels.delete(id);
    }

    // Stale claims about disappeared parcels are released.
    for (const parcelId of this.claims.keys()) {
      if (!this.parcels.has(parcelId)) this.claims.delete(parcelId);
    }

    for (const a of sensing.agents ?? []) {
      if (a.id === this.me.id) continue;
      this.agents.set(a.id, { ...a, lastSeen: now });
      if (a.id === this.teammate.id) {
        this.teammate.x = a.x;
        this.teammate.y = a.y;
        this.teammate.lastSeen = now;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Derived beliefs
  // -------------------------------------------------------------------------

  /** True once the agent can deliberate (map + own position known). */
  ready() {
    return !!this.graph && this.me.x !== null && this.me.x >= 0;
  }

  /** Parcels currently carried by me. */
  carried() {
    return [...this.parcels.values()].filter((p) => p.carriedBy === this.me.id);
  }

  /** Decaying interval in ms (Infinity when decay is disabled). */
  decayIntervalMs() {
    const game = this.config?.GAME;
    if (!game?.parcels?.decaying_event) return Infinity;
    return clockEventToMs(game.parcels.decaying_event, this.config?.CLOCK ?? 50);
  }

  /** Reward lost per move per carried parcel (0 when decay is off). */
  decayPerTile() {
    const decayMs = this.decayIntervalMs();
    const moveMs = this.config?.GAME?.player?.movement_duration ?? 50;
    return decayMs === Infinity ? 0 : moveMs / decayMs;
  }

  /**
   * Estimate of a parcel's current reward, projecting the decay elapsed
   * since the parcel was last seen.
   */
  projectedReward(parcel) {
    const decayMs = this.decayIntervalMs();
    if (decayMs === Infinity) return parcel.rewardAtLastSeen ?? parcel.reward ?? 0;
    const elapsed = Math.max(0, Date.now() - (parcel.lastSeen ?? Date.now()));
    const elapsedDecayTicks = Math.floor(elapsed / decayMs);
    return (parcel.rewardAtLastSeen ?? parcel.reward ?? 0) - elapsedDecayTicks;
  }

  // -------------------------------------------------------------------------
  // Action feedback (called by plans after acks — sensing may lag or omit
  // own-carried parcels, so acks are the authoritative carry signal)
  // -------------------------------------------------------------------------

  markCarried(parcelId) {
    const parcel = this.parcels.get(parcelId);
    if (parcel) {
      parcel.carriedBy = this.me.id;
    } else {
      this.parcels.set(parcelId, {
        id: parcelId,
        x: this.me.x, y: this.me.y,
        reward: null, rewardAtLastSeen: null,
        carriedBy: this.me.id,
        lastSeen: Date.now(),
      });
    }
  }

  markDelivered(parcelIds) {
    for (const id of parcelIds) this.parcels.delete(id);
  }

  /**
   * Fallback when a pickup ack carries no usable ids (server versions
   * differ in ack shape): pickup grabs ALL free parcels on the tile, so
   * mark every believed free parcel on my rounded tile as carried.
   */
  markTilePickedUp() {
    const myX = Math.round(this.me.x);
    const myY = Math.round(this.me.y);
    for (const parcel of this.parcels.values()) {
      if (parcel.carriedBy) continue;
      if (Math.round(parcel.x) === myX && Math.round(parcel.y) === myY) {
        parcel.carriedBy = this.me.id;
      }
    }
  }

  /**
   * Belief reconciliation: forget everything believed carried by me.
   * Used when the server contradicts the carry belief (e.g. a putdown
   * ack reports nothing dropped) — my knowledge was wrong, not the
   * world. Truly-carried parcels reappear via sensing.
   */
  clearCarried() {
    for (const [id, parcel] of this.parcels) {
      if (parcel.carriedBy === this.me.id) this.parcels.delete(id);
    }
  }

  /** Parcels put down on a non-delivery tile stay in the world, free. */
  markDropped(parcelIds) {
    for (const id of parcelIds) {
      const parcel = this.parcels.get(id);
      if (parcel) {
        parcel.carriedBy = null;
        parcel.x = this.me.x;
        parcel.y = this.me.y;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mission state (structured missions produced by the MissionInterpreter)
  // -------------------------------------------------------------------------

  /**
   * Apply a structured mission to beliefs. Constraints (forbidden tiles,
   * movement gate, delivery policies) act on the graph / flags; goal-type
   * missions become `mission.active` and generate a dedicated option.
   */
  setMission(mission) {
    switch (mission.kind) {
      case 'light_state':
        this.mission.movementAllowed = mission.movementAllowed !== false;
        return;
      case 'go_to':
        if (mission.forbidden) {
          this.graph?.blockTiles(mission.targets ?? []);
        } else {
          this.mission.active = mission;
        }
        return;
      case 'deliver_at':
        if (mission.forbidden) {
          this.graph?.setForbiddenDeliveries(mission.targets ?? []);
        } else {
          this.mission.active = mission;
        }
        return;
      case 'deliver_exactly_n':
        this.mission.deliverExactly = mission.count ?? 1;
        return;
      case 'deliver_less_value_than':
        this.mission.deliverMaxValue = mission.threshold ?? null;
        return;
      case 'one_pickup_another_deliver':
        // Data layer (Fetta 2): role + shared rendezvous + state slots.
        // The executable choreography (deposit/collect plans, message
        // sequencing) is added on top in a later step.
        this.mission.handover = {
          active: true,
          role: this.handoverRole,            // 'picker' | 'deliverer' | null
          rendezvous: this.graph?.rendezvousTile() ?? null,
          parcel: null,                       // {id, x, y} of the handed-over parcel
          myState: 'idle',                    // this agent's progress (driven later)
          peerState: null,                    // teammate's last reported progress
        };
        return;
      case 'red_light_green_light':
        // Rules announcement only; actual gating arrives as light_state.
        this.mission.active = null;
        return;
      case 'question_answer':
        this.mission.lastQuestion = mission; // answered by Agent B, not BDI
        return;
      default:
        // Unknown mission: keep it visible for debugging, change nothing.
        this.mission.lastUnknown = mission;
    }
  }

  /** Called by plans when the active positional mission is completed. */
  completeMission() {
    this.mission.lastCompleted = this.mission.active;
    this.mission.active = null;
  }

  /**
   * Revise the handover state from a teammate HANDOVER message.
   *
   * Robustness: the drop is located by **coordinates first**. The
   * parcelId is only a hint — pickup/putdown acks omit ids on this server
   * (see normalizeIdList), so a teammate may not know the id, and ids do
   * not survive a drop+repickup cleanly. Coordinates always identify the
   * tile to collect from, so they never get overwritten by a missing id.
   *
   * @param {{state?:string, parcelId?:string, x?:number, y?:number}} payload
   * @returns {object} the updated handover belief
   */
  applyHandoverUpdate(payload = {}) {
    const h =
      this.mission.handover ??
      (this.mission.handover = {
        active: true,
        role: this.handoverRole,
        rendezvous: this.graph?.rendezvousTile() ?? null,
        parcel: null,
        myState: 'idle',
        peerState: null,
      });

    if (payload.state) h.peerState = payload.state;

    if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      // Coordinates present: authoritative locator (id is a best-effort hint).
      h.parcel = { id: payload.parcelId ?? h.parcel?.id ?? null, x: payload.x, y: payload.y };
    } else if (payload.parcelId != null) {
      // Only an id arrived: keep any coordinates we already had.
      h.parcel = { id: payload.parcelId, x: h.parcel?.x ?? null, y: h.parcel?.y ?? null };
    }

    return h;
  }
}
