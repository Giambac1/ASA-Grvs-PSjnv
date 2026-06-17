import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const C1_MAPS = [
  '26c1_1',
  '26c1_2',
  '26c1_3',
  '26c1_4',
  '26c1_5',
  '26c1_6',
  '26c1_7',
  '26c1_8',
];

const DEFAULT_STRATEGIES = [
  'greedy-nearest',
  'reward-distance',
  'delivery-threshold',
  'mission-aware',
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const { values } = parseArgs({
  options: {
    campaign: { type: 'string' },
    maps: { type: 'string', default: C1_MAPS.join(',') },
    strategies: { type: 'string', default: DEFAULT_STRATEGIES.join(',') },
    duration: { type: 'string', default: '30' },
    runs: { type: 'string', default: '1' },
    agent: { type: 'string', default: 'bdi' },
    port: { type: 'string', default: '8080' },
    host: { type: 'string' },
    'server-dir': { type: 'string', default: '../Deliveroo.js/backend' },
    csv: { type: 'string' },
    'skip-aggregate': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (!values.campaign) {
  console.error('Missing required --campaign name.');
  printUsage();
  process.exit(1);
}

const maps = splitList(values.maps);
const strategies = splitList(values.strategies);
const duration = parsePositiveNumber(values.duration, '--duration');
const runs = parsePositiveInteger(values.runs, '--runs');
const port = parsePositiveInteger(values.port, '--port');
const host = values.host ?? `http://localhost:${port}`;
const serverDir = path.resolve(repoRoot, values['server-dir']);
const csvPath = values.csv ?? `experiments/results/${values.campaign}.csv`;

let currentServer = null;

process.on('SIGINT', async () => {
  console.log('\nInterrupted. Stopping the Deliveroo.js server...');
  await stopServer(currentServer);
  process.exit(130);
});

if (!existsSync(path.join(serverDir, 'index.js'))) {
  console.error(`Cannot find Deliveroo.js backend at: ${serverDir}`);
  console.error('Use --server-dir if your Deliveroo.js checkout is elsewhere.');
  process.exit(1);
}

printPlan();

if (values['dry-run']) {
  process.exit(0);
}

const preExisting = await fetchConfig(host);
if (preExisting) {
  console.error(`A server is already responding at ${host}.`);
  console.error('Stop the manual server first with Ctrl+C, then rerun this campaign.');
  process.exit(1);
}

// Per-map resilience: a failure on one map must not abort the rest of an
// unattended campaign. Each map stops its own server (so the port is free
// for the next one), records the outcome, and the loop continues.
const succeeded = [];
const failed = [];

for (const map of maps) {
  const label = `${map}-${values.campaign}`;

  try {
    console.log(`\n=== ${map}: starting Deliveroo.js server ===`);
    currentServer = startServer({ map, port, serverDir });
    await waitForServer({ host, map, timeoutMs: 30000 });

    console.log(`=== ${map}: running ${label} ===`);
    await runCommand(process.execPath, [
      'scripts/run-baseline.js',
      '--label', label,
      '--duration', String(duration),
      '--runs', String(runs),
      '--strategies', strategies.join(','),
      '--agent', values.agent,
      '--host', host,
    ], { cwd: repoRoot });

    succeeded.push(label);
  } catch (error) {
    const reason = error?.message ?? String(error);
    console.error(`!!! ${map}: FAILED - ${reason}`);
    failed.push({ label, reason });
  } finally {
    // Always stop the server before moving on, even after a failure.
    console.log(`=== ${map}: stopping Deliveroo.js server ===`);
    await stopServer(currentServer);
    currentServer = null;
    await waitForServerDown(host, 10000).catch((error) => {
      console.error(`Warning: ${error?.message ?? error}`);
    });
  }
}

if (!values['skip-aggregate'] && succeeded.length > 0) {
  console.log(`\n=== Aggregating campaign "${values.campaign}" ===`);
  await runCommand(process.execPath, [
    'scripts/aggregate-results.js',
    '--scenario', values.campaign,
    '--csv', csvPath,
  ], { cwd: repoRoot }).catch((error) => {
    console.error(`Aggregation failed: ${error?.message ?? error}`);
  });
}

printSummary(succeeded, failed);
process.exitCode = failed.length > 0 ? 1 : 0;

function printUsage() {
  console.log(`
Usage:
  node scripts/run-campaign.js --campaign smoke-v1 --duration 30 --runs 1
  node scripts/run-campaign.js --campaign baseline-v1 --duration 120 --runs 5
  node scripts/run-campaign.js --campaign test-45 --maps 26c1_4,26c1_5 --duration 60 --runs 2

Options:
  --campaign <name>       Required. Used in labels: <map>-<campaign>.
  --maps <list>           Comma-separated map list. Default: all Challenge 1 maps.
  --strategies <list>     Comma-separated strategies. Default: all registered baseline strategies.
  --duration <seconds>    Seconds per run. Default: 30.
  --runs <n>              Runs per strategy. Default: 1.
  --agent <bdi|llm>       Agent type passed to run-baseline.js. Default: bdi.
  --server-dir <path>     Deliveroo.js backend path. Default: ../Deliveroo.js/backend.
  --csv <path>            Final CSV path. Default: experiments/results/<campaign>.csv.
  --skip-aggregate        Do not aggregate at the end.
  --dry-run               Print the plan without starting anything.
`);
}

function printPlan() {
  const totalRuns = maps.length * strategies.length * runs;
  const estimatedSeconds = totalRuns * (duration + 2);
  console.log('Campaign plan');
  console.log(`campaign:   ${values.campaign}`);
  console.log(`maps:       ${maps.join(', ')}`);
  console.log(`strategies: ${strategies.join(', ')}`);
  console.log(`agent:      ${values.agent}`);
  console.log(`duration:   ${duration}s`);
  console.log(`runs:       ${runs} per strategy/map`);
  console.log(`labels:     <map>-${values.campaign}`);
  console.log(`server:     ${serverDir}`);
  console.log(`host:       ${host}`);
  console.log(`total runs: ${totalRuns}`);
  console.log(`estimate:   ~${Math.ceil(estimatedSeconds / 60)} min plus server startup`);
  if (!values['skip-aggregate']) console.log(`csv:        ${csvPath}`);
}

function printSummary(succeeded, failed) {
  console.log('\n=== Campaign summary ===');
  console.log(`succeeded (${succeeded.length}): ${succeeded.join(', ') || '-'}`);
  if (failed.length > 0) {
    console.log(`failed (${failed.length}):`);
    for (const { label, reason } of failed) console.log(`  - ${label}: ${reason}`);
  } else {
    console.log('failed (0): -');
  }
}

function splitList(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(1);
  }
  return number;
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return number;
}

function startServer({ map, port, serverDir }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      GAME_NAME: map,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, `[server ${map}]`);
  prefixStream(child.stderr, `[server ${map} err]`);
  return child;
}

function prefixStream(stream, prefix) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`${prefix} ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffered.trim()) console.log(`${prefix} ${buffered}`);
  });
}

async function waitForServer({ host, map, timeoutMs }) {
  const start = Date.now();
  let lastTitle = null;
  while (Date.now() - start < timeoutMs) {
    const config = await fetchConfig(host);
    if (config) {
      lastTitle = config.GAME?.title ?? null;
      if (lastTitle === map) return;
    }
    await sleep(500);
  }
  const detail = lastTitle ? ` Last responding game was "${lastTitle}".` : '';
  throw new Error(`Server did not become ready for ${map} within ${timeoutMs} ms.${detail}`);
}

async function waitForServerDown(host, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const config = await fetchConfig(host);
    if (!config) return;
    await sleep(250);
  }
  throw new Error(`Server at ${host} did not stop within ${timeoutMs} ms`);
}

async function fetchConfig(host) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(`${host}/api/configs`, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: 'inherit',
  });
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${code ?? signal}`);
  }
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGINT');
  const stopped = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(5000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(2000)]);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
