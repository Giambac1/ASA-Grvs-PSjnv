import 'dotenv/config';
import { parseArgs } from 'node:util';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/**
 * LOCAL TEST HARNESS — not an official mission agent.
 *
 * The course repository provides no concrete mission agent for 26c2_10:
 * `DeliverooAgent.js/missionAgents/start.js` references a placeholder
 * `---.js`. To validate the DOCUMENTED semantics of the go-to-and-wait
 * mission without modifying the (read-only) course repo, this god-observer
 * fixture reproduces the rule: reward once when BOTH named agents are
 * within Manhattan distance `radius` of `target` and stay together for a
 * short interval. At the real challenge the professor's mission agent is
 * used instead.
 *
 * Run (after the two agents are connected):
 *   node scripts/fixtures/goto-wait-mission.js
 * Needs ADMIN_TOKEN (god) in .env. Defaults match 26c2_10.
 */
const { values } = parseArgs({
  options: {
    x: { type: 'string' },
    y: { type: 'string' },
    radius: { type: 'string' },
    bonus: { type: 'string' },
    a: { type: 'string' },
    b: { type: 'string' },
  },
});

const HOST = process.env.HOST || 'http://localhost:8080';
const TOKEN = process.env.ADMIN_TOKEN;
const target = { x: Number(values.x ?? 19), y: Number(values.y ?? 5) };
const radius = Number(values.radius ?? 3);
const bonus = Number(values.bonus ?? 500);
const nameA = values.a ?? 'agentA';
const nameB = values.b ?? 'agentB';
const holdMs = 1000; // both must stay near together at least this long

if (!TOKEN) {
  console.error('Missing ADMIN_TOKEN in .env (this fixture must connect as god).');
  process.exit(1);
}

const prompt =
  `Move both agents to the neighborhood of position (${target.x},${target.y}) ` +
  `within a maximum distance of ${radius}, and have them wait for each other. ` +
  `You will receive ${bonus}pts.`;

const socket = DjsConnect(HOST, TOKEN);
const positions = new Map(); // name -> {x, y, id}
let bothSince = null;
let rewarded = false;

const near = (p) => !!p && Math.abs(p.x - target.x) + Math.abs(p.y - target.y) <= radius;

socket.onSensing((sensing) => {
  for (const a of sensing.agents ?? []) {
    if (a.x == null || a.y == null) continue;
    positions.set(a.name, { x: Math.round(a.x), y: Math.round(a.y), id: a.id });
  }
  const a = positions.get(nameA);
  const b = positions.get(nameB);
  if (near(a) && near(b)) {
    bothSince ??= Date.now();
    if (!rewarded && Date.now() - bothSince >= holdMs) {
      rewarded = true;
      for (const agent of [a, b]) socket.emit('reward', { agentId: agent.id, points: bonus });
      const msg =
        `Rewarded ${nameA} and ${nameB} with ${bonus}pts because: both within ` +
        `distance ${radius} of (${target.x},${target.y}) together`;
      console.log(msg);
    }
  } else {
    bothSince = null; // they drifted apart; the timer restarts
  }
});

await new Promise((resolve) => socket.onceYou(resolve));
console.log(prompt);
socket.emitShout(prompt);
