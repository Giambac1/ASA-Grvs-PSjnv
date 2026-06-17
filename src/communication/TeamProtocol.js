import { MessageTypes, makeMessage, isProtocolMessage } from './MessageTypes.js';

/**
 * Team coordination protocol between Agent A (BDI) and Agent B (LLM).
 *
 * Discovery: each agent shouts a `hello` once connected; the peer whose
 * name matches TEAMMATE_NAME (or the first peer, when unset) is recorded
 * as the teammate and greeted back via `say`. From then on messages flow
 * point-to-point with `say` (one-way) — `ask` is reserved for explicit
 * synchronization points because it blocks with a 1 s server timeout.
 *
 * Incoming protocol messages update the BeliefBase (teammate state,
 * claims, mission state); everything is logged for the report.
 */
export class TeamProtocol {
  #heartbeatTimer = null;

  /**
   * @param {object} deps
   * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} deps.socket
   * @param {import('../core/BeliefBase.js').BeliefBase} deps.beliefs
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [deps.metrics]
   * @param {import('../metrics/RunLogger.js').RunLogger} [deps.logger]
   * @param {string|null} [deps.teammateName] expected teammate name (handshake filter)
   * @param {() => object|null} [deps.getCurrentIntention] for heartbeats
   * @param {(mission: object) => void} [deps.onMissionUpdate]
   * @param {number} [deps.heartbeatMs]
   */
  constructor({
    socket,
    beliefs,
    metrics = null,
    logger = null,
    teammateName = null,
    getCurrentIntention = () => null,
    onMissionUpdate = null,
    heartbeatMs = 1000,
  }) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.metrics = metrics;
    this.logger = logger;
    this.teammateName = teammateName;
    this.getCurrentIntention = getCurrentIntention;
    this.onMissionUpdate = onMissionUpdate;
    this.heartbeatMs = heartbeatMs;
  }

  /** Register the message handler and announce ourselves. */
  start() {
    this.socket.onMsg((id, name, msg, reply) => this.#handleMessage(id, name, msg, reply));
    // Shout hello so the teammate (whenever it joins) can find us.
    this.#shout(MessageTypes.HELLO, { name: this.beliefs.me.name });
  }

  stop() {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
  }

  // -------------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------------

  /** Send a typed message to the teammate. No-op until discovery. */
  async send(type, payload = {}) {
    if (!this.beliefs.teammate.id) return false;
    this.metrics?.increment('messagesSent');
    this.logger?.log('msg_out', { type, to: this.beliefs.teammate.id });
    return this.socket.emitSay(
      this.beliefs.teammate.id,
      makeMessage(type, payload, this.beliefs.me.id),
    );
  }

  /**
   * Synchronous exchange with the teammate (server timeout: 1 s). Use
   * only at synchronization points, e.g. handover sequencing.
   * @returns {Promise<object|null>} the reply, or null on timeout
   */
  async askTeammate(type, payload = {}) {
    if (!this.beliefs.teammate.id) return null;
    this.metrics?.increment('messagesSent');
    this.logger?.log('msg_ask', { type, to: this.beliefs.teammate.id });
    const reply = await Promise.race([
      this.socket.emitAsk(this.beliefs.teammate.id, makeMessage(type, payload, this.beliefs.me.id)),
      new Promise((resolve) => setTimeout(() => resolve(null), 1100)),
    ]);
    return reply ?? null;
  }

  /** Claim a parcel as our target (first claim wins by convention). */
  claimParcel(parcelId) {
    this.beliefs.claims.set(parcelId, this.beliefs.me.id);
    return this.send(MessageTypes.CLAIM, { parcelId });
  }

  /** Forward a structured mission to the teammate (Agent B -> Agent A). */
  sendMissionUpdate(mission) {
    return this.send(MessageTypes.MISSION_UPDATE, { mission });
  }

  /**
   * Signal a handover step to the teammate. Coordinates are the robust
   * locator of the drop (parcelId is a best-effort hint — see
   * BeliefBase.applyHandoverUpdate).
   * @param {{state:string, parcelId?:string|null, x?:number, y?:number}} payload
   */
  sendHandover(payload = {}) {
    return this.send(MessageTypes.HANDOVER, payload);
  }

  async #shout(type, payload) {
    this.metrics?.increment('messagesSent');
    return this.socket.emitShout(makeMessage(type, payload, this.beliefs.me.id));
  }

  // -------------------------------------------------------------------------
  // Incoming
  // -------------------------------------------------------------------------

  #handleMessage(id, name, msg, reply) {
    if (!isProtocolMessage(msg)) return; // mission shouts etc. — not ours
    if (id === this.beliefs.me.id) return; // our own shout echoed back

    this.metrics?.increment('messagesReceived');
    this.logger?.log('msg_in', { type: msg.type, from: id });

    switch (msg.type) {
      case MessageTypes.HELLO: {
        // Accept the peer as teammate when the name matches (or no
        // expectation is configured).
        if (this.teammateName && msg.payload?.name !== this.teammateName) return;
        const isNew = this.beliefs.teammate.id !== id;
        this.beliefs.teammate.id = id;
        this.beliefs.teammate.name = msg.payload?.name ?? name;
        if (isNew) this.logger?.log('teammate_discovered', { id, name: this.beliefs.teammate.name });
        if (isNew && !msg.payload?.isReply) {
          this.send(MessageTypes.HELLO, { name: this.beliefs.me.name, isReply: true });
        }
        this.#startHeartbeat();
        return;
      }
      case MessageTypes.POSITION: {
        Object.assign(this.beliefs.teammate, {
          x: msg.payload?.x,
          y: msg.payload?.y,
          carrying: msg.payload?.carrying ?? 0,
          intention: msg.payload?.intention ?? null,
          lastSeen: Date.now(),
        });
        return;
      }
      case MessageTypes.INTENTION: {
        this.beliefs.teammate.intention = msg.payload ?? null;
        return;
      }
      case MessageTypes.CLAIM: {
        if (msg.payload?.parcelId) this.beliefs.claims.set(msg.payload.parcelId, id);
        return;
      }
      case MessageTypes.MISSION_UPDATE: {
        const mission = msg.payload?.mission;
        if (mission) {
          this.beliefs.setMission(mission);
          this.onMissionUpdate?.(mission);
        }
        this.#acknowledge(MessageTypes.MISSION_UPDATE, reply);
        return;
      }
      case MessageTypes.REQUEST_HELP: {
        // Stored for strategies to react to. TODO(strategy): rebalance
        // targets toward the teammate's area when help is requested.
        this.beliefs.teammate.requestHelp = { ...msg.payload, ts: Date.now() };
        this.#acknowledge(MessageTypes.REQUEST_HELP, reply);
        return;
      }
      case MessageTypes.HANDOVER: {
        // Revise the handover belief (belief logic lives in BeliefBase).
        // Coordinates locate the drop; parcelId is only a hint.
        this.beliefs.applyHandoverUpdate(msg.payload ?? {});
        this.logger?.log('handover_msg', {
          from: id,
          state: msg.payload?.state ?? null,
          parcelId: msg.payload?.parcelId ?? null,
          x: msg.payload?.x ?? null,
          y: msg.payload?.y ?? null,
        });
        this.#acknowledge(MessageTypes.HANDOVER, reply);
        return;
      }
      case MessageTypes.ACK:
        return; // logged above, nothing else to do
      default:
        this.logger?.log('msg_unknown', { type: msg.type, from: id });
    }
  }

  /** Reply through the ask-callback when present, else send an ack message. */
  #acknowledge(aboutType, reply) {
    const ack = makeMessage(MessageTypes.ACK, { about: aboutType }, this.beliefs.me.id);
    if (typeof reply === 'function') reply(ack);
    else this.send(MessageTypes.ACK, { about: aboutType });
  }

  /** Periodic position broadcast, started once the teammate is known. */
  #startHeartbeat() {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(() => {
      const intention = this.getCurrentIntention();
      this.send(MessageTypes.POSITION, {
        x: this.beliefs.me.x,
        y: this.beliefs.me.y,
        carrying: this.beliefs.carried().length,
        intention: intention ? { key: intention.key, type: intention.option?.type } : null,
      });
    }, this.heartbeatMs);
  }
}
