import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { buildAgentRuntime } from './main-bdi.js';
import { LlmClient } from './llm/LlmClient.js';
import { MissionInterpreter } from './llm/MissionInterpreter.js';
import { buildToolset } from './llm/tools.js';
import { isProtocolMessage } from './communication/MessageTypes.js';

/**
 * Agent B — the LLM agent.
 *
 * Architecture: the SAME deterministic BDI runtime as Agent A (it must
 * still move, collect and deliver), plus a high-level LLM layer that:
 *  - interprets mission-agent messages into structured missions
 *    (LLM when configured, deterministic fallback otherwise), while
 *    pre-applying safety-critical constraints (prohibitions, red light)
 *    immediately so a slow LLM round-trip cannot incur a penalty;
 *  - answers pure-reasoning missions (question_answer) via chat;
 *  - applies missions to its own beliefs (strategy constraints/goals);
 *  - forwards missions to Agent A through the team protocol.
 *
 * The LLM never issues movement commands: it changes WHAT the BDI loop
 * wants, never HOW the agent walks.
 */
export async function startLlmAgent(overrides = {}) {
  const config = loadConfig({
    // Agent B defaults to the mission-aware strategy.
    strategy: overrides.strategy ?? process.env.STRATEGY ?? 'mission-aware',
    ...overrides,
  });

  const runtime = await buildAgentRuntime(config, 'llm');
  const { socket, beliefs, protocol, metrics, logger } = runtime;

  const llmClient = new LlmClient({ ...config.llm, metrics, logger });
  if (!llmClient.isConfigured()) {
    console.log('[llm] No LLM provider configured — using deterministic mission parsing.');
  }

  const interpreter = new MissionInterpreter({ llmClient, metrics, logger });

  // High-level tool registry (lab8 pattern), available for tool-loop
  // experiments; the default flow below only uses the interpreter.
  const toolset = buildToolset({ beliefs, protocol, socket });

  // Mission/request handling: every non-protocol message is treated as a
  // potential mission or atomic request.
  socket.onMsg(async (id, name, msg, reply) => {
    if (isProtocolMessage(msg)) return; // teammate traffic: TeamProtocol's job
    if (id === beliefs.me.id) return;

    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);

    // Latency-critical safety: the LLM round-trip can take seconds (8.7 s
    // observed live), and a pending prohibition must not be ignored while
    // interpreting — otherwise the agent keeps farming and can cross a
    // forbidden tile / move on red. Deterministically pre-apply the few
    // safety-critical constraints NOW; the authoritative LLM mission below
    // reconciles (setMission is idempotent for these).
    const provisional = MissionInterpreter.parseLightState(text)
      ?? MissionInterpreter.fallbackParse(text);
    if (MissionInterpreter.isSafetyCritical(provisional)) {
      beliefs.setMission(provisional);
      logger.log('mission_preapplied', { kind: provisional.kind, forbidden: !!provisional.forbidden });
    }

    const mission = await interpreter.interpret(text, id);

    if (mission.kind === 'unknown') return;

    if (mission.kind === 'question_answer') {
      // Atomic request (Challenge 2 level 1): reply in chat, no movement.
      if (mission.answer != null) {
        await socket.emitSay(id, String(mission.answer));
        if (typeof reply === 'function') reply(String(mission.answer));
        logger.log('mission_answered', { question: mission.expression, answer: mission.answer });
      }
      return;
    }

    // Strategy adaptation (level 2) and coordination (level 3): apply to
    // own beliefs and share with Agent A.
    beliefs.setMission(mission);
    await protocol.sendMissionUpdate(mission);
    logger.log('mission_applied', { kind: mission.kind, forwarded: !!beliefs.teammate.id });
  });

  console.log('[llm] Mission interpreter active.');
  return { ...runtime, llmClient, interpreter, toolset };
}

// Run directly: `node src/main-llm.js`
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startLlmAgent().catch((error) => {
    console.error('Agent B failed to start:', error);
    process.exit(1);
  });
}
