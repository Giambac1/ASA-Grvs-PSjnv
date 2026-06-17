import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_SCENARIOS = [
  '26c2_3',
  '26c2_1',
  '26c2_2',
  '26c2_5',
  '26c2_7',
  '26c2_4',
  '26c2_6',
  '26c2_9',
];

const SCENARIOS = {
  '26c2_1': {
    description: 'GoTo positive',
    timeout: 120,
    expect: 'reward',
    missionScript: 'GoTo.js',
    missionArgs: [
      '--prompt', 'Go to one of these coordinates for a bonus.',
      '--unatantum', 'true',
      '--bonus', '1000',
      '--coordinates', JSON.stringify([
        { x: 19, y: 19 },
        { x: 20, y: 19 },
        { x: 21, y: 19 },
      ]),
    ],
  },
  '26c2_2': {
    description: 'DeliverAt positive',
    timeout: 180,
    expect: 'reward',
    missionScript: 'DeliverAt.js',
    missionArgs: [
      '--prompt', 'Deliver a package in 1,1 to get a 1000pts bonus una tantum.',
      '--unatantum', 'true',
      '--bonus', '1000',
      '--coordinates', JSON.stringify([{ x: 1, y: 1 }]),
    ],
  },
  '26c2_3': {
    description: 'QuestionAnswer',
    timeout: 45,
    expect: 'reward',
    missionScript: 'QuestionAnswer.js',
    missionArgs: [
      '--prompt', 'Calculate (5*(5+3)/2)+2 to get a bonus una tantum.',
      '--bonus', '10000',
      '--answers', '22',
    ],
  },
  '26c2_4': {
    description: 'Avoid forbidden GoTo tiles',
    timeout: 120,
    expect: 'no-penalty',
    missionScript: 'GoTo.js',
    missionArgs: [
      '--prompt', 'Do not go through tiles (13,15) (14,15) (15,15) (16,15) or you will be penalized.',
      '--unatantum', 'false',
      '--bonus', '-1000',
      '--coordinates', JSON.stringify([
        { x: 13, y: 15 },
        { x: 14, y: 15 },
        { x: 15, y: 15 },
        { x: 16, y: 15 },
      ]),
    ],
  },
  '26c2_5': {
    description: 'Deliver exactly N parcels',
    timeout: 180,
    expect: 'reward',
    missionScript: 'deliverExactlyNParcels.js',
    missionArgs: [
      '--prompt', 'Deliver exactly three packages at a time.',
      '--bonus', '100',
      '--parcels', '3',
    ],
  },
  '26c2_6': {
    description: 'Avoid forbidden delivery tiles',
    timeout: 120,
    expect: 'no-penalty',
    missionScript: 'DeliverAt.js',
    missionArgs: [
      '--prompt', 'Do never deliver in (15,32) (16,32) (15,31) (16,31).',
      '--unatantum', 'false',
      '--bonus', '-500',
      '--coordinates', JSON.stringify([
        { x: 15, y: 32 },
        { x: 16, y: 32 },
        { x: 15, y: 31 },
        { x: 16, y: 31 },
      ]),
    ],
  },
  '26c2_7': {
    description: 'Deliver total value below threshold',
    timeout: 180,
    expect: 'reward',
    missionScript: 'DeliverLessValueThan.js',
    missionArgs: [
      '--prompt', 'Every time you deliver parcels for a total amount of reward lower or equal to 10, you get a bonus.',
      '--bonus', '1000',
      '--threshold', '10',
    ],
  },
  '26c2_9': {
    description: 'Red light / green light',
    timeout: 80,
    expect: 'no-penalty',
    missionScript: 'RedLightGreenLight.js',
    missionArgs: [
      '--prompt', 'All agents prepare to stop at red light and wait for the green light message before moving again. For every movement during red light you will receive a penalty.',
      '--bonus', '-10',
    ],
  },
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const { values } = parseArgs({
  options: {
    campaign: { type: 'string' },
    scenarios: { type: 'string', default: DEFAULT_SCENARIOS.join(',') },
    strategy: { type: 'string', default: 'mission-aware' },
    name: { type: 'string', default: 'agentB' },
    timeout: { type: 'string' },
    port: { type: 'string', default: '8080' },
    host: { type: 'string' },
    'server-dir': { type: 'string', default: '../Deliveroo.js/backend' },
    'mission-dir': { type: 'string', default: '../DeliverooAgent.js/missionAgents' },
    'out-dir': { type: 'string', default: 'experiments/c2-suite' },
    verbose: { type: 'boolean', default: false },
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

const scenarios = splitList(values.scenarios);
const unsupported = scenarios.filter((name) => !SCENARIOS[name]);
if (unsupported.length > 0) {
  console.error(`Unsupported scenario(s): ${unsupported.join(', ')}`);
  console.error(`Supported scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const port = parsePositiveInteger(values.port, '--port');
const host = values.host ?? `http://localhost:${port}`;
const timeoutOverride = values.timeout ? parsePositiveNumber(values.timeout, '--timeout') : null;
const serverDir = path.resolve(repoRoot, values['server-dir']);
const missionDir = path.resolve(repoRoot, values['mission-dir']);
const challengeDir = path.join(missionDir, 'challenge2');
const outRoot = path.resolve(repoRoot, values['out-dir'], values.campaign);
const manifestPath = path.join(outRoot, 'run-summary.json');
const logDir = path.join(repoRoot, 'experiments', 'logs');

function startLoggedProcess({ command, args, cwd, env, prefix, logFile, echoMode }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new LoggedProcess({ child, prefix, logFile, echoMode });
}

class LoggedProcess {
  constructor({ child, prefix, logFile, echoMode }) {
    this.child = child;
    this.prefix = prefix;
    this.logFile = logFile;
    this.echoMode = echoMode;
    this.lines = [];
    this.waiters = [];
    this.stream = createWriteStream(logFile, { flags: 'w' });
    this.stream.on('error', () => {});

    this.attach(child.stdout, 'stdout');
    this.attach(child.stderr, 'stderr');

    child.on('error', (error) => {
      this.recordLine(error?.message ?? String(error), 'error');
    });

    child.on('exit', (code, signal) => {
      this.stream.write(`[exit] code=${code ?? ''} signal=${signal ?? ''}\n`);
      this.stream.end();
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error(`${this.prefix} exited before matching ${waiter.pattern}`));
      }
    });
  }

  attach(stream, fd) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) this.recordLine(line, fd);
    });
    stream.on('end', () => {
      if (buffered) this.recordLine(buffered, fd);
    });
  }

  recordLine(line, fd) {
    this.lines.push(line);
    this.stream.write(`[${fd}] ${line}\n`);

    if (this.shouldEcho(line)) console.log(`[${this.prefix}] ${line}`);

    for (const waiter of [...this.waiters]) {
      if (waiter.pattern.test(line)) {
        clearTimeout(waiter.timeout);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(line);
      }
    }
  }

  shouldEcho(line) {
    if (!line.trim()) return false;
    if (this.echoMode === 'all') return true;
    return /Mission interpreter active|ready|Authenticated as|Rewarded|Penalized|RED LIGHT|GREEN LIGHT|Bonus is|Server listening/i.test(line);
  }

  waitForLine(pattern, timeoutMs) {
    for (const line of this.lines) {
      if (pattern.test(line)) return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        pattern,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          reject(new Error(`${this.prefix} did not print ${pattern} within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

let current = { server: null, agent: null, mission: null };

process.on('SIGINT', async () => {
  console.log('\nInterrupted. Stopping active processes...');
  await stopAll(current);
  process.exit(130);
});

validatePaths({ requireMissionEnv: !values['dry-run'] });
printPlan();

if (values['dry-run']) {
  process.exit(0);
}

mkdirSync(outRoot, { recursive: true });

const preExisting = await fetchConfig(host);
if (preExisting) {
  console.error(`A server is already responding at ${host}.`);
  console.error('Stop the manual server first with Ctrl+C, then rerun this suite.');
  process.exit(1);
}

const manifest = {
  campaign: values.campaign,
  startedAt: new Date().toISOString(),
  host,
  agentName: values.name,
  strategy: values.strategy,
  scenarios: [],
};

for (const scenario of scenarios) {
  const spec = SCENARIOS[scenario];
  const label = `${scenario}-${values.campaign}`;
  const timeoutSeconds = timeoutOverride ?? spec.timeout;
  const scenarioDir = path.join(outRoot, scenario);
  mkdirSync(scenarioDir, { recursive: true });

  const entry = {
    scenario,
    label,
    description: spec.description,
    expect: spec.expect,
    timeoutSeconds,
    startedAt: new Date().toISOString(),
    status: 'unknown',
    ok: false,
    files: {
      server: path.join(scenarioDir, 'server.log'),
      agent: path.join(scenarioDir, 'agent-process.log'),
      mission: path.join(scenarioDir, 'mission-agent.log'),
    },
    rewardLines: [],
    penaltyLines: [],
    notes: [],
  };

  const startedMs = Date.now();

  try {
    console.log(`\n=== ${scenario}: starting Deliveroo.js server ===`);
    current.server = startLoggedProcess({
      command: process.execPath,
      args: ['index.js', '-g', gameFileFor(scenario)],
      cwd: serverDir,
      env: { ...process.env, PORT: String(port) },
      prefix: `server ${scenario}`,
      logFile: entry.files.server,
      echoMode: values.verbose ? 'all' : 'important',
    });
    await waitForServer({ host, scenario, timeoutMs: 30000 });

    console.log(`=== ${scenario}: starting Agent B (${label}) ===`);
    current.agent = startLoggedProcess({
      command: process.execPath,
      args: [
        'scripts/run-llm.js',
        '--name', values.name,
        '--strategy', values.strategy,
        '--label', label,
        '--host', host,
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: host,
        NAME: values.name,
        TOKEN: '',
        STRATEGY: values.strategy,
        RUN_LABEL: label,
      },
      prefix: `agent ${scenario}`,
      logFile: entry.files.agent,
      echoMode: values.verbose ? 'all' : 'important',
    });
    await current.agent.waitForLine(/Mission interpreter active\./, 45000);

    console.log(`=== ${scenario}: starting mission agent (${spec.missionScript}) ===`);
    current.mission = startLoggedProcess({
      command: process.execPath,
      args: [spec.missionScript, ...spec.missionArgs],
      cwd: missionDir,
      env: { ...process.env, HOST: host },
      prefix: `mission ${scenario}`,
      logFile: entry.files.mission,
      echoMode: values.verbose ? 'all' : 'important',
    });

    await runObservationWindow({ spec, mission: current.mission, agentName: values.name, timeoutSeconds });
    classifyMissionOutcome(entry, current.mission.lines);
  } catch (error) {
    entry.status = 'error';
    entry.ok = false;
    entry.error = error?.message ?? String(error);
    console.error(`!!! ${scenario}: FAILED - ${entry.error}`);
  } finally {
    console.log(`=== ${scenario}: stopping processes ===`);
    await stopAll(current);
    current = { server: null, agent: null, mission: null };
    await waitForServerDown(host, 10000).catch((error) => {
      entry.notes.push(error?.message ?? String(error));
      console.error(`Warning: ${error?.message ?? error}`);
    });

    entry.finishedAt = new Date().toISOString();
    entry.files.agentLog = findNewestFile(logDir, `${label}-llm-`, '.jsonl', startedMs);
    manifest.scenarios.push(entry);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
}

manifest.finishedAt = new Date().toISOString();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

printSummary(manifest);
process.exitCode = manifest.scenarios.some((entry) => !entry.ok) ? 1 : 0;

function printUsage() {
  console.log(`
Usage:
  node scripts/run-c2-suite.js --campaign c2-smoke-v1 --dry-run
  node scripts/run-c2-suite.js --campaign c2-smoke-v1 --scenarios 26c2_3,26c2_1,26c2_2
  node scripts/run-c2-suite.js --campaign c2-policy-v1 --scenarios 26c2_5,26c2_7 --timeout 240

Options:
  --campaign <name>       Required. Used in labels: <scenario>-<campaign>.
  --scenarios <list>      Comma-separated list. Default: ${DEFAULT_SCENARIOS.join(',')}.
  --strategy <id>         Agent B strategy. Default: mission-aware.
  --name <agentName>      Agent B name. Default: agentB.
  --timeout <seconds>     Override every scenario timeout.
  --server-dir <path>     Deliveroo.js backend path. Default: ../Deliveroo.js/backend.
  --mission-dir <path>    DeliverooAgent.js missionAgents path. Default: ../DeliverooAgent.js/missionAgents.
  --out-dir <path>        Suite artifact root. Default: experiments/c2-suite.
  --verbose               Echo all child-process output.
  --dry-run               Print the plan without starting anything.
`);
}

function validatePaths({ requireMissionEnv }) {
  const missing = [];
  if (!existsSync(path.join(serverDir, 'index.js'))) missing.push(`Deliveroo.js backend: ${serverDir}`);
  if (!existsSync(missionDir)) missing.push(`missionAgents dir: ${missionDir}`);
  if (!existsSync(challengeDir)) missing.push(`Challenge 2 config dir: ${challengeDir}`);
  for (const scenario of scenarios) {
    const spec = SCENARIOS[scenario];
    if (!existsSync(path.join(missionDir, spec.missionScript))) {
      missing.push(`${scenario} mission script: ${path.join(missionDir, spec.missionScript)}`);
    }
    if (!existsSync(gameFileFor(scenario))) {
      missing.push(`${scenario} game file: ${gameFileFor(scenario)}`);
    }
  }
  if (missing.length > 0) {
    console.error('Missing required paths:');
    for (const item of missing) console.error(`  - ${item}`);
    process.exit(1);
  }

  const missionEnv = path.resolve(missionDir, '..', '.env');
  if (!envFileHasValue(missionEnv, 'ADMIN_TOKEN')) {
    if (!requireMissionEnv) {
      console.error(`Warning: ADMIN_TOKEN is missing/empty in ${missionEnv}. Live runs will fail until it is set.`);
      return;
    }
    console.error(`Mission agents need ADMIN_TOKEN in ${missionEnv}`);
    console.error('Create that file with HOST=http://localhost:8080 and ADMIN_TOKEN=<god-token>.');
    process.exit(1);
  }
}

function printPlan() {
  console.log('Challenge 2 suite plan');
  console.log(`campaign:   ${values.campaign}`);
  console.log(`scenarios:  ${scenarios.join(', ')}`);
  console.log(`agent:      ${values.name}`);
  console.log(`strategy:   ${values.strategy}`);
  console.log(`host:       ${host}`);
  console.log(`server:     ${serverDir}`);
  console.log(`missions:   ${missionDir}`);
  console.log(`out:        ${outRoot}`);
  console.log('timeouts:');
  for (const scenario of scenarios) {
    const spec = SCENARIOS[scenario];
    console.log(`  - ${scenario}: ${timeoutOverride ?? spec.timeout}s (${spec.description}, expect=${spec.expect})`);
  }
  const totalSeconds = scenarios.reduce((sum, scenario) => sum + (timeoutOverride ?? SCENARIOS[scenario].timeout), 0);
  console.log(`estimate:   ~${Math.ceil(totalSeconds / 60)} min plus startup/shutdown`);
}

function printSummary(manifest) {
  console.log('\n=== Challenge 2 suite summary ===');
  for (const entry of manifest.scenarios) {
    const mark = entry.ok ? 'PASS' : 'CHECK';
    const reason = entry.error ? ` - ${entry.error}` : '';
    console.log(`${mark} ${entry.scenario} ${entry.description}: ${entry.status}${reason}`);
    for (const line of entry.rewardLines) console.log(`  reward: ${line}`);
    for (const line of entry.penaltyLines) console.log(`  penalty: ${line}`);
  }
  console.log(`\nManifest written to: ${manifestPath}`);
  console.log(`Summarize with: node scripts/summarize-c2-suite.js --campaign ${values.campaign}`);
}

function gameFileFor(scenario) {
  return path.join(challengeDir, `${scenario}.json`);
}

async function runObservationWindow({ spec, mission, agentName, timeoutSeconds }) {
  if (spec.expect === 'reward') {
    const rewardPattern = new RegExp(`Rewarded\\s+(${escapeRegExp(agentName)}|[^\\s]+)\\s+with`, 'i');
    await mission.waitForLine(rewardPattern, timeoutSeconds * 1000).catch(() => {});
    await sleep(2000);
    return;
  }

  await sleep(timeoutSeconds * 1000);
}

function classifyMissionOutcome(entry, missionLines) {
  entry.rewardLines = missionLines.filter(isActualRewardLine);
  entry.penaltyLines = missionLines.filter(isActualPenaltyLine);

  if (entry.expect === 'reward') {
    entry.ok = entry.rewardLines.length > 0;
    entry.status = entry.ok ? 'rewarded' : 'missing-reward';
    return;
  }

  entry.ok = entry.penaltyLines.length === 0;
  entry.status = entry.ok ? 'no-penalty-observed' : 'penalty-observed';
}

function isActualRewardLine(line) {
  return /^\s*Rewarded\s+/i.test(line);
}

function isActualPenaltyLine(line) {
  return /^\s*Penalized\s+/i.test(line);
}

async function waitForServer({ host, scenario, timeoutMs }) {
  const start = Date.now();
  let lastTitle = null;
  while (Date.now() - start < timeoutMs) {
    const config = await fetchConfig(host);
    if (config) {
      lastTitle = config.GAME?.title ?? null;
      if (lastTitle === scenario) return;
    }
    await sleep(500);
  }
  const detail = lastTitle ? ` Last responding game was "${lastTitle}".` : '';
  throw new Error(`Server did not become ready for ${scenario} within ${timeoutMs} ms.${detail}`);
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

async function stopAll(handles) {
  await stopProcess(handles.mission);
  await stopProcess(handles.agent);
  await stopProcess(handles.server);
}

async function stopProcess(handle) {
  const child = handle?.child;
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

function findNewestFile(dir, prefix, suffix, newerThanMs) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      try {
        return { file, mtimeMs: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.mtimeMs >= newerThanMs - 5000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.file ?? null;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function envFileHasValue(file, key) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(`${key}=`) && trimmed.slice(key.length + 1).trim().length > 0;
  });
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
