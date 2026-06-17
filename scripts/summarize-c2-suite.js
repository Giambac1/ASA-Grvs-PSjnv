import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const { values } = parseArgs({
  options: {
    campaign: { type: 'string' },
    dir: { type: 'string', default: 'experiments/c2-suite' },
    'logs-dir': { type: 'string', default: 'experiments/logs' },
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

const suiteDir = path.resolve(repoRoot, values.dir, values.campaign);
const manifestPath = path.join(suiteDir, 'run-summary.json');
const logsDir = path.resolve(repoRoot, values['logs-dir']);

if (!existsSync(manifestPath)) {
  console.error(`Cannot find suite manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

console.log(`\n=== Agent B Challenge 2 suite: ${manifest.campaign} ===`);
console.log(`agent: ${manifest.agentName} | strategy: ${manifest.strategy} | host: ${manifest.host}`);
console.log(`started: ${manifest.startedAt}${manifest.finishedAt ? ` | finished: ${manifest.finishedAt}` : ''}\n`);

console.log('| Scenario | Status | Interpreted Mission | Source | Mission Agent Evidence | Agent Evidence |');
console.log('|---|---|---|---|---|---|');

const details = [];
for (const entry of manifest.scenarios ?? []) {
  const agentLog = entry.files?.agentLog ?? findNewestLog(entry.label);
  const events = agentLog ? readJsonl(agentLog) : [];
  const interpreted = events.filter((event) => event.event === 'mission_interpreted');
  const applied = events.filter((event) => event.event === 'mission_applied');
  const answered = events.filter((event) => event.event === 'mission_answered');
  const reached = events.filter((event) => event.event === 'mission_target_reached');
  const llmCalls = events.filter((event) => event.event === 'llm_call');
  const deliveries = events.filter((event) => event.event === 'delivery');
  const scores = events.filter((event) => event.event === 'score');

  const lastMission = interpreted.at(-1);
  const source = lastMission?.source ?? '-';
  const missionText = describeMission(lastMission);
  const status = entry.ok ? 'PASS' : 'CHECK';
  const missionEvidence = describeMissionAgent(entry);
  const agentEvidence = describeAgentEvidence({ applied, answered, reached, deliveries, scores });

  console.log(
    `| ${entry.scenario} | ${status} (${entry.status}) | ${escapeCell(missionText)} | ${source} | ` +
      `${escapeCell(missionEvidence)} | ${escapeCell(agentEvidence)} |`,
  );

  details.push({
    entry,
    agentLog,
    interpreted,
    applied,
    answered,
    reached,
    llmCalls,
    deliveries,
    scores,
  });
}

console.log('\n=== Copyable evidence ===');
for (const detail of details) {
  const { entry, agentLog, interpreted, applied, answered, reached, llmCalls, deliveries, scores } = detail;
  const status = entry.ok ? 'PASS' : 'CHECK';
  console.log(`\n[${entry.scenario}] ${status} - ${entry.description}`);
  console.log(`label: ${entry.label}`);
  console.log(`expect: ${entry.expect}; outcome: ${entry.status}`);
  if (entry.error) console.log(`error: ${entry.error}`);

  if (interpreted.length > 0) {
    for (const mission of interpreted) {
      console.log(`interpreted: ${describeMission(mission)}; source=${mission.source ?? '-'}`);
    }
  } else {
    console.log('interpreted: -');
  }

  console.log(`applied: ${applied.length > 0 ? applied.map((event) => event.kind).join(', ') : '-'}`);
  console.log(`answered: ${answered.length > 0 ? answered.map((event) => event.answer).join(', ') : '-'}`);
  console.log(`reached: ${reached.length > 0 ? reached.map((event) => formatTarget(event.target)).join(', ') : '-'}`);
  console.log(`deliveries: ${deliveries.length > 0 ? deliveries.map((event) => event.count).join(', ') : '-'}`);
  console.log(`final score observed: ${scores.at(-1)?.score ?? '-'}`);
  console.log(`llm calls: ${llmCalls.length}${llmCalls.length > 0 ? `; durations=${llmCalls.map((event) => `${event.durationMs}ms`).join(', ')}` : ''}`);

  const rewardLines = actualRewardLines(entry);
  const penaltyLines = actualPenaltyLines(entry);
  console.log(`mission rewards: ${rewardLines.length > 0 ? rewardLines.join(' / ') : '-'}`);
  console.log(`mission penalties: ${penaltyLines.length > 0 ? penaltyLines.join(' / ') : '-'}`);
  console.log(`agent log: ${agentLog ?? '-'}`);
  console.log(`mission log: ${entry.files?.mission ?? '-'}`);
}

function printUsage() {
  console.log(`
Usage:
  node scripts/summarize-c2-suite.js --campaign c2-smoke-v1

Options:
  --campaign <name>       Required. Suite campaign name.
  --dir <path>            Suite artifact root. Default: experiments/c2-suite.
  --logs-dir <path>       Agent JSONL logs root. Default: experiments/logs.
`);
}

function readJsonl(file) {
  if (!file || !existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip partial/unreadable lines */
    }
  }
  return events;
}

function findNewestLog(label) {
  if (!existsSync(logsDir)) return null;
  const prefix = `${label}-llm-`;
  const matches = readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(logsDir, entry.name))
    .sort((a, b) => b.localeCompare(a));
  return matches[0] ?? null;
}

function describeMission(event) {
  if (!event) return '-';
  const parts = [event.kind ?? 'unknown'];
  if (event.forbidden) parts.push('forbidden=true');
  if (event.bonus != null) parts.push(`bonus=${event.bonus}`);
  if (event.count != null && event.count !== 0) parts.push(`count=${event.count}`);
  if (event.threshold != null && event.threshold !== 0) parts.push(`threshold=${event.threshold}`);
  if (event.answer != null) parts.push(`answer=${event.answer}`);
  if (Array.isArray(event.targets) && event.targets.length > 0) {
    parts.push(`targets=${event.targets.map(formatTarget).join(' ')}`);
  }
  return parts.join(' ');
}

function describeMissionAgent(entry) {
  const rewards = actualRewardLines(entry);
  const penalties = actualPenaltyLines(entry);
  if (rewards.length > 0) return rewards.at(-1);
  if (penalties.length > 0) return penalties.at(-1);
  return entry.expect === 'no-penalty' ? 'no penalty observed' : 'no reward observed';
}

function actualRewardLines(entry) {
  return (entry.rewardLines ?? []).filter((line) => /^\s*Rewarded\s+/i.test(line));
}

function actualPenaltyLines(entry) {
  return (entry.penaltyLines ?? []).filter((line) => /^\s*Penalized\s+/i.test(line));
}

function describeAgentEvidence({ applied, answered, reached, deliveries, scores }) {
  const parts = [];
  if (applied.length > 0) parts.push(`applied=${applied.map((event) => event.kind).join('/')}`);
  if (answered.length > 0) parts.push(`answered=${answered.map((event) => event.answer).join('/')}`);
  if (reached.length > 0) parts.push(`reached=${reached.map((event) => formatTarget(event.target)).join('/')}`);
  if (deliveries.length > 0) parts.push(`deliveries=${deliveries.map((event) => event.count).join('/')}`);
  if (scores.length > 0) parts.push(`score=${scores.at(-1).score}`);
  return parts.join('; ') || '-';
}

function formatTarget(target) {
  if (!target || target.x == null || target.y == null) return '-';
  return `(${target.x},${target.y})`;
}

function escapeCell(value) {
  return String(value ?? '-').replace(/\|/g, '/');
}
