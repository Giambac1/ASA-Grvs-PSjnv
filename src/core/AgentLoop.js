import { OptionGenerator } from './OptionGenerator.js';

/**
 * The BDI control loop glue:
 *
 *   observe (socket events) -> revise beliefs (BeliefBase)
 *   -> generate options (OptionGenerator) -> rank/select (Strategy)
 *   -> revise intentions (IntentionRevision) -> plan & act (PlanLibrary
 *      via Intention -> ActionExecutor)
 *
 * Deliberation triggers: every `you`/`sensing` event, after each finished
 * intention, plus a fallback timer — sensing only fires on *change*, so
 * silence must not freeze the agent (game_knowledge 05, edge case 6).
 */
export class AgentLoop {
  #timer = null;
  #stopped = false;

  /**
   * @param {object} deps
   * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} deps.socket
   * @param {import('./BeliefBase.js').BeliefBase} deps.beliefs
   * @param {import('../strategies/StrategyBase.js').StrategyBase} deps.strategy
   * @param {import('./IntentionRevision.js').IntentionRevision} deps.revision
   * @param {import('../planning/PathPlanner.js').PathPlanner} deps.pathPlanner
   * @param {import('../metrics/MetricsCollector.js').MetricsCollector} [deps.metrics]
   * @param {import('../metrics/RunLogger.js').RunLogger} [deps.logger]
   * @param {object} deps.config
   */
  constructor({ socket, beliefs, strategy, revision, pathPlanner, metrics = null, logger = null, config }) {
    this.socket = socket;
    this.beliefs = beliefs;
    this.strategy = strategy;
    this.revision = revision;
    this.pathPlanner = pathPlanner;
    this.metrics = metrics;
    this.logger = logger;
    this.config = config;
    this.optionGenerator = new OptionGenerator();
  }

  /** Wire events, wait for the initial map/identity, start deliberating. */
  async start() {
    const { socket, beliefs } = this;

    socket.onConfig((cfg) => beliefs.updateConfig(cfg));
    socket.onTile((tile) => beliefs.updateTile(tile));

    const mapLoaded = new Promise((resolve) => {
      socket.onMap((width, height, tiles) => {
        beliefs.loadMap(width, height, tiles);
        this.logger?.log('map_loaded', { width, height });
        resolve();
      });
    });

    const identityKnown = new Promise((resolve) => {
      socket.onYou((me) => {
        const previousScore = beliefs.me.score;
        beliefs.updateMe(me);
        if (me.score !== previousScore) this.metrics?.recordScore(me.score);
        this.deliberate();
        resolve();
      });
    });

    socket.onSensing((sensing) => {
      beliefs.updateSensing(sensing);
      this.deliberate();
    });

    await Promise.all([mapLoaded, identityKnown]);
    this.logger?.log('agent_ready', { id: beliefs.me.id, name: beliefs.me.name });

    // Run the intention consumer (never awaited: it loops forever).
    this.revision.loop();

    // Fallback deliberation heartbeat.
    const interval = this.config?.agent?.deliberationIntervalMs ?? 250;
    this.#timer = setInterval(() => this.deliberate(), interval);
  }

  /**
   * One deliberation step: validity check on the current intention,
   * option generation, strategy selection, proposal to the revision.
   * Kept synchronous and cheap (a single BFS) so it can run per event.
   */
  deliberate() {
    if (this.#stopped || !this.beliefs.ready()) return;

    const current = this.revision.current;
    if (current && !OptionGenerator.isStillValid(current.option, this.beliefs)) {
      this.revision.abortCurrent('no-longer-valid');
    }

    const options = this.optionGenerator.generate(this.beliefs);
    const helpers = this.pathPlanner.scoringHelpers();
    const best = this.strategy.selectOption(options, this.beliefs, helpers);
    if (best) this.revision.push(best);
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.revision.stop();
  }
}
