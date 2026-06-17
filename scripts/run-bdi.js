import { parseArgs } from 'node:util';
import { startBdiAgent } from '../src/main-bdi.js';

/**
 * Run Agent A (BDI).
 *
 *   node scripts/run-bdi.js [--strategy <id>] [--label <name>] [--host <url>] [--name <agentName>] [--teammate <name>]
 *
 * CLI flags override .env values. `--teammate` sets the expected teammate
 * name for protocol discovery (overrides TEAMMATE_NAME) — needed when A and
 * B share one .env, since they require different teammate names.
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

startBdiAgent(overrides).catch((error) => {
  console.error(error);
  process.exit(1);
});
