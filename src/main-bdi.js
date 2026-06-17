import { pathToFileURL } from 'node:url';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { loadConfig } from './config.js';
import { BeliefBase } from './core/BeliefBase.js';
import { ActionExecutor } from './core/ActionExecutor.js';
import { IntentionRevision } from './core/IntentionRevision.js';
import { buildDefaultPlanLibrary } from './core/PlanLibrary.js';
import { AgentLoop } from './core/AgentLoop.js';
import { PathPlanner } from './planning/PathPlanner.js';
import { PddlPlanner } from './planning/PddlPlanner.js';
import { createStrategy } from './strategies/index.js';
import { TeamProtocol } from './communication/TeamProtocol.js';
import { MetricsCollector } from './metrics/MetricsCollector.js';
import { RunLogger } from './metrics/RunLogger.js';

/**
 * Agent A — the BDI agent.
 *
 * Wires the shared runtime: connection, beliefs, deterministic planning,
 * strategy, intention revision, team protocol, metrics. The same builder
 * is reused by Agent B (main-llm.js), which adds the LLM layer on top —
 * both agents need the full BDI machinery to act in the world.
 */

/**
 * Build and start the full BDI runtime.
 * @param {object} config  from loadConfig()
 * @param {string} role    'bdi' | 'llm' (log naming)
 * @returns runtime handles {socket, beliefs, executor, pathPlanner,
 *          pddlPlanner, strategy, revision, protocol, loop, metrics,
 *          logger, stop}
 */
export async function buildAgentRuntime(config, role = 'bdi') {
  const logger = new RunLogger({ dir: config.log.dir, label: config.log.label, role });
  const metrics = new MetricsCollector({
    logger,
    strategy: config.strategy,
    scenario: config.log.label,
  });

  const socket = DjsConnect(config.host, config.token, config.name);

  // First-connection convenience: persist this token to keep the same
  // in-game identity across restarts.
  socket.on('token', (token) => {
    logger.log('token_received', { token });
    console.log(`[${role}] Server issued a token — save it in .env as TOKEN to keep this identity:\n${token}`);
  });

  const beliefs = new BeliefBase();
  // Explicit handover roles (26c2_8): Agent A (BDI) collects, Agent B (LLM,
  // which interprets the mission) delivers. Deterministic, so the two
  // agents never both pick or both deliver.
  beliefs.handoverRole = role === 'llm' ? 'deliverer' : 'picker';
  const executor = new ActionExecutor(socket, { metrics });
  // Red-light gate: the executor freezes movement when a mission says so.
  executor.movementGate = () => beliefs.mission.movementAllowed !== false;

  const pathPlanner = new PathPlanner(beliefs);
  const pddlPlanner = new PddlPlanner({ beliefs, config, metrics, logger });
  const planLibrary = buildDefaultPlanLibrary();

  const planContext = { beliefs, executor, pathPlanner, pddlPlanner, planLibrary, metrics, logger, config };

  const strategy = createStrategy(config.strategy, config.strategyOptions);
  logger.log('strategy_selected', { strategy: strategy.name });

  const revision = new IntentionRevision({
    context: planContext,
    metrics,
    logger,
    hysteresisMargin: config.agent.hysteresisMargin,
  });

  const protocol = new TeamProtocol({
    socket,
    beliefs,
    metrics,
    logger,
    teammateName: config.teammateName,
    getCurrentIntention: () => revision.current,
    heartbeatMs: config.agent.heartbeatMs,
  });

  // Plans need the protocol to signal the teammate (e.g. handover drop).
  planContext.protocol = protocol;

  // Announce pickup targets to the teammate (first claim wins).
  revision.onIntentionChange = (intention) => {
    if (intention.option.type === 'go_pick_up') {
      protocol.claimParcel(intention.option.parcelId);
    }
  };

  const loop = new AgentLoop({
    socket, beliefs, strategy, revision, pathPlanner, metrics, logger, config,
  });

  await loop.start();
  protocol.start();
  console.log(`[${role}] ${beliefs.me.name} ready — strategy: ${strategy.name}, map ${beliefs.graph.width}x${beliefs.graph.height}`);

  const stop = () => {
    loop.stop();
    protocol.stop();
    const resultFile = logger.writeResult(metrics.summary(), config.log.resultsDir);
    logger.close();
    socket.disconnect();
    return resultFile;
  };

  return {
    socket, beliefs, executor, pathPlanner, pddlPlanner,
    strategy, revision, protocol, loop, metrics, logger, stop,
  };
}

/** Start Agent A with environment configuration (+ optional overrides). */
export async function startBdiAgent(overrides = {}) {
  const config = loadConfig(overrides);
  return buildAgentRuntime(config, 'bdi');
}

// Run directly: `node src/main-bdi.js`
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startBdiAgent().catch((error) => {
    console.error('Agent A failed to start:', error);
    process.exit(1);
  });
}
