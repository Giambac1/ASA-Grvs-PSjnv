/**
 * Tool registry for the LLM agent (lab8 pattern: the LLM selects tools,
 * a JavaScript runtime validates and executes them).
 *
 * These are HIGH-LEVEL tools only: inspect state, set strategy
 * constraints, communicate. There is deliberately no "move one step"
 * tool — low-level movement stays deterministic inside the BDI loop.
 *
 * Each tool: { name, description, parameters (JSON-schema-ish), execute }.
 * Use `executeTool` as the single entry point so every call is validated
 * and logged uniformly.
 */
import { MessageTypes } from '../communication/MessageTypes.js';

/**
 * @param {object} deps
 * @param {import('../core/BeliefBase.js').BeliefBase} deps.beliefs
 * @param {import('../communication/TeamProtocol.js').TeamProtocol} deps.protocol
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} deps.socket
 * @param {import('../metrics/RunLogger.js').RunLogger} [deps.logger]
 */
export function buildToolset({ beliefs, protocol, socket }) {
  return [
    {
      name: 'get_state',
      description: 'Read-only snapshot of own state, carried parcels, mission and teammate.',
      parameters: {},
      execute: () => ({
        me: { x: beliefs.me.x, y: beliefs.me.y, score: beliefs.me.score },
        carried: beliefs.carried().map((p) => ({ id: p.id, reward: beliefs.projectedReward(p) })),
        visibleParcels: beliefs.parcels.size,
        mission: beliefs.mission,
        teammate: beliefs.teammate,
      }),
    },
    {
      name: 'set_movement_allowed',
      description: 'Open/close the movement gate (red light / green light).',
      parameters: { allowed: 'boolean' },
      execute: ({ allowed }) => {
        if (typeof allowed !== 'boolean') throw new Error('allowed must be boolean');
        beliefs.mission.movementAllowed = allowed;
        return { movementAllowed: allowed };
      },
    },
    {
      name: 'block_tiles',
      description: 'Permanently forbid tiles for pathfinding (mission constraint).',
      parameters: { tiles: '[{x:int, y:int}]' },
      execute: ({ tiles }) => {
        if (!Array.isArray(tiles) || tiles.some((t) => !Number.isFinite(t?.x) || !Number.isFinite(t?.y))) {
          throw new Error('tiles must be an array of {x, y}');
        }
        beliefs.graph?.blockTiles(tiles);
        return { blocked: tiles.length };
      },
    },
    {
      name: 'set_mission',
      description: 'Apply a structured mission to beliefs (same schema as the interpreter output).',
      parameters: { mission: 'object' },
      execute: ({ mission }) => {
        if (!mission || typeof mission !== 'object' || !mission.kind) {
          throw new Error('mission must be an object with a kind');
        }
        beliefs.setMission(mission);
        return { applied: mission.kind };
      },
    },
    {
      name: 'send_to_teammate',
      description: `Send a protocol message to the teammate. Types: ${Object.values(MessageTypes).join(', ')}.`,
      parameters: { type: 'string', payload: 'object' },
      execute: ({ type, payload }) => {
        if (!Object.values(MessageTypes).includes(type)) throw new Error(`unknown type ${type}`);
        protocol.send(type, payload ?? {});
        return { sent: type };
      },
    },
    {
      name: 'reply_to_agent',
      description: 'Send a chat message to any agent id (e.g. answer a mission agent).',
      parameters: { agentId: 'string', text: 'string' },
      execute: ({ agentId, text }) => {
        if (typeof agentId !== 'string' || typeof text !== 'string') {
          throw new Error('agentId and text must be strings');
        }
        socket.emitSay(agentId, text);
        return { sent: true };
      },
    },
  ];
}

/**
 * Validated tool dispatch: the only path from LLM output to effects.
 * @returns {{ok: boolean, result?: any, error?: string}}
 */
export function executeTool(toolset, name, args = {}, logger = null) {
  const tool = toolset.find((t) => t.name === name);
  if (!tool) {
    logger?.log('tool_unknown', { name });
    return { ok: false, error: `unknown tool: ${name}` };
  }
  try {
    const result = tool.execute(args);
    logger?.log('tool_call', { name, args });
    return { ok: true, result };
  } catch (error) {
    logger?.log('tool_error', { name, args, error: String(error?.message ?? error) });
    return { ok: false, error: String(error?.message ?? error) };
  }
}
