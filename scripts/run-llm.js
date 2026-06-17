import { parseArgs } from 'node:util';
import { startLlmAgent } from '../src/main-llm.js';

/**
 * Run Agent B (LLM).
 *
 *   node scripts/run-llm.js [--strategy <id>] [--label <name>] [--host <url>] [--name <agentName>] [--teammate <name>]
 *
 * CLI flags override .env values. Without an LLM provider configured the
 * agent still runs, using deterministic mission parsing. `--teammate` sets
 * the expected teammate name for protocol discovery (overrides
 * TEAMMATE_NAME) — needed when A and B share one .env.
 */
const { values } = parseArgs({
  options: {
    strategy: { type: 'string' },
    label: { type: 'string' },
    host: { type: 'string' },
    name: { type: 'string' },
    token: { type: 'string' },
    teammate: { type: 'string' },
  },
});

const overrides = {};
if (values.strategy) overrides.strategy = values.strategy;
if (values.host) overrides.host = values.host;
if (values.name) overrides.name = values.name;
if (values.token) overrides.token = values.token;
if (values.teammate) overrides.teammateName = values.teammate;
if (values.label) overrides.log = { label: values.label };

startLlmAgent(overrides).catch((error) => {
  console.error(error);
  process.exit(1);
});
