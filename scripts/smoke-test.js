/**
 * Dependency-free smoke test of the core logic (no SDK, no network, no
 * installed packages needed). Run with: node scripts/smoke-test.js
 *
 * It exercises: graph building (walls + arrow tiles), BFS pathfinding,
 * delivery-distance precomputation, belief revision (decay projection,
 * negative evidence), option generation, all four strategies, mission
 * fallback parsing, mission constraints on the graph, PDDL problem
 * generation, plan library ordering, and the protocol envelope.
 */
import { PathPlanner } from '../src/planning/PathPlanner.js';
import { BeliefBase } from '../src/core/BeliefBase.js';
import { OptionGenerator } from '../src/core/OptionGenerator.js';
import { createStrategy } from '../src/strategies/index.js';
import { MissionInterpreter } from '../src/llm/MissionInterpreter.js';
import { PddlPlanner } from '../src/planning/PddlPlanner.js';
import { DELIVEROO_DOMAIN } from '../src/planning/pddlDomain.js';
import { buildDefaultPlanLibrary, chooseHoldTile } from '../src/core/PlanLibrary.js';
import { makeMessage, isProtocolMessage } from '../src/communication/MessageTypes.js';
import { MetricsCollector } from '../src/metrics/MetricsCollector.js';
import { aggregateResults } from '../src/metrics/aggregate.js';
import { RunLogger } from '../src/metrics/RunLogger.js';
import { normalizeIdList } from '../src/utils/serialization.js';
import { loadConfig } from '../src/config.js';
import os from 'node:os';
import fs from 'node:fs';
import nodePath from 'node:path';

let failures = 0;
const assert = (cond, msg) => {
  if (cond) console.log('ok  :', msg);
  else { console.error('FAIL:', msg); failures += 1; }
};

// --- Map: 4x3, wall at (1,1), arrow '→' at (2,0) ---------------------------
// y=2:  3 3 3 2      ('2' delivery at (3,2))
// y=1:  3 0 3 3      ('0' wall at (1,1))
// y=0:  1 3 > 3      ('1' spawner at (0,0), arrow right at (2,0))
const types = {
  '0,0': '1', '1,0': '3', '2,0': '→', '3,0': '3',
  '0,1': '3', '1,1': '0', '2,1': '3', '3,1': '3',
  '0,2': '3', '1,2': '3', '2,2': '3', '3,2': '2',
};
const tiles = Object.entries(types).map(([k, type]) => {
  const [x, y] = k.split(',').map(Number);
  return { x, y, type };
});

const beliefs = new BeliefBase();
beliefs.loadMap(4, 3, tiles);
beliefs.updateMe({ id: 'me1', name: 'tester', x: 0, y: 0, score: 0 });
beliefs.updateConfig({
  CLOCK: 50,
  GAME: { parcels: { decaying_event: '1s' }, player: { movement_duration: 100 } },
});

const graph = beliefs.graph;
assert(graph.tiles.size === 12, 'graph has 12 tiles');
assert(!graph.isWalkable(1, 1), 'wall not walkable');
const from30 = graph.neighbors(3, 0).map((e) => e.key);
assert(!from30.includes('2,0'), 'cannot enter arrow tile against arrow');
const from10 = graph.neighbors(1, 0).map((e) => e.key);
assert(from10.includes('2,0'), 'can enter arrow tile along arrow');

// --- PathPlanner ------------------------------------------------------------
const planner = new PathPlanner(beliefs);
const path = planner.shortestPath({ x: 0, y: 0 }, { x: 3, y: 2 });
assert(path && path.directions.length === 5, 'BFS shortest path has length 5');
const nd = planner.nearestDelivery({ x: 0, y: 0 });
assert(nd && nd.tile.x === 3 && nd.tile.y === 2, 'nearest delivery found');
assert(graph.deliveryDistance(0, 0) === 5, 'precomputed delivery distance (reversed BFS) = 5');

// --- Belief revision ----------------------------------------------------------
beliefs.updateSensing({
  positions: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
  parcels: [{ id: 'p1', x: 1, y: 0, reward: 30, carriedBy: null }],
  agents: [{ id: 'a2', name: 'opp', x: 3, y: 1, score: 10 }],
});
assert(beliefs.parcels.has('p1'), 'parcel sensed');
assert(beliefs.projectedReward(beliefs.parcels.get('p1')) === 30, 'projected reward fresh = 30');
// Decay projection follows server semantics: −1 per WHOLE decay tick
// (1.5 intervals elapsed -> one tick deducted, not a floored 1.5).
const agedParcel = { rewardAtLastSeen: 30, lastSeen: Date.now() - 1500 };
assert(beliefs.projectedReward(agedParcel) === 29, 'projection deducts whole decay ticks only');
const futureParcel = { rewardAtLastSeen: 30, lastSeen: Date.now() + 5000 };
assert(beliefs.projectedReward(futureParcel) === 30, 'projection tolerates clock skew (no negative elapsed)');
assert(Math.abs(beliefs.decayPerTile() - 0.1) < 1e-9, 'decayPerTile = 100ms/1000ms');
beliefs.updateSensing({ positions: [{ x: 1, y: 0 }], parcels: [], agents: [] });
assert(!beliefs.parcels.has('p1'), 'negative evidence deletes parcel belief');

// --- Options + strategies ------------------------------------------------------
beliefs.updateSensing({
  positions: [],
  parcels: [{ id: 'p2', x: 2, y: 2, reward: 40, carriedBy: null }],
  agents: [],
});
const gen = new OptionGenerator();
let options = gen.generate(beliefs);
assert(options.some((o) => o.type === 'go_pick_up'), 'go_pick_up option generated');
assert(
  options.some((o) => o.type === 'explore') && options.some((o) => o.type === 'wait'),
  'fallback options present',
);
for (const id of ['greedy-nearest', 'reward-distance', 'reward-distance-total', 'delivery-threshold', 'mission-aware']) {
  const s = createStrategy(id);
  const best = s.selectOption(gen.generate(beliefs), beliefs, planner.scoringHelpers());
  assert(best && best.type === 'go_pick_up', `${id} selects pickup`);
}
beliefs.markCarried('p2');
options = gen.generate(beliefs);
assert(options.some((o) => o.type === 'deliver_carried'), 'deliver option when carrying');
const greedy = createStrategy('greedy-nearest');
const best2 = greedy.selectOption(gen.generate(beliefs), beliefs, planner.scoringHelpers());
assert(best2.type === 'deliver_carried', 'greedy delivers when nothing left to pick');

// --- reward-distance-total puts pickup on the total-load scale -------------------
// With a parcel carried (p2) AND a free parcel reachable, reward-distance-total's
// pickup utility must equal reward-distance's pickup utility plus the carried value
// (the algebraic identity that makes it hoard instead of small-batching).
beliefs.updateSensing({ positions: [], parcels: [{ id: 'p3', x: 1, y: 0, reward: 30, carriedBy: null }], agents: [] });
const helpers = planner.scoringHelpers();
const pickP3 = gen.generate(beliefs).find((o) => o.type === 'go_pick_up' && o.parcelId === 'p3');
const carriedValue = beliefs.carried().reduce((s, p) => s + Math.max(beliefs.projectedReward(p), 0), 0);
const uRD = createStrategy('reward-distance').utility(pickP3, beliefs, helpers);
const uRDT = createStrategy('reward-distance-total').utility(pickP3, beliefs, helpers);
assert(pickP3 && carriedValue > 0, 'reward-distance-total test: carried value present with a free parcel');
assert(Math.abs(uRDT - (uRD + carriedValue)) < 1e-9, 'reward-distance-total pickup = reward-distance pickup + carried value');
beliefs.mission.deliverExactly = 3;
const exactDelivery = gen.generate(beliefs).find((o) => o.type === 'deliver_carried');
assert(
  createStrategy('mission-aware').utility(exactDelivery, beliefs, helpers) === -Infinity,
  'mission-aware suppresses premature delivery during deliver_exactly_n',
);
beliefs.mission.deliverExactly = null;
beliefs.mission.deliverMaxValue = 10;
assert(
  createStrategy('mission-aware').utility(exactDelivery, beliefs, helpers) === -Infinity,
  'mission-aware suppresses over-threshold delivery during deliver_less_value_than',
);
beliefs.mission.deliverMaxValue = null;

// --- Mission fallback parsing ----------------------------------------------------
const F = MissionInterpreter.fallbackParse;
assert(F('Go to (19,19) or (20,19) for 1000 points!').kind === 'go_to', 'go_to parsed');
assert(F('Go to (19,19) for 1000 points').targets[0].x === 19, 'coordinates extracted');
assert(F('Go to (19,19) for 1000 points').bonus === 1000, 'bonus extracted');
assert(F('Drop a package in (1,1) for 1000 pts').kind === 'deliver_at', 'deliver_at parsed');
const qa = F('Calculate 5*(5+3)/2');
assert(qa.kind === 'question_answer' && qa.answer === '20', 'arithmetic question answered');
const qaCourse = F('Calculate (5*(5+3)/2)+2 to get a bonus una tantum. Bonus is 10000pts.');
assert(qaCourse.kind === 'question_answer' && qaCourse.answer === '22', 'arithmetic question parses course template');
assert(
  F('Do not go through tiles (13,15) (14,15) or you will be penalized -500 points').forbidden === true,
  'negative mission detected',
);
const jsonGoTo = F('Go to one of these coordinates for a bonus. Bonus is 1000pts. Coordinates are [{"x":19,"y":19},{"x":20,"y":19},{"x":21,"y":19}]');
assert(jsonGoTo.kind === 'go_to' && jsonGoTo.targets.length === 3, 'go_to parses JSON coordinates');
const jsonDeliverAt = F('Deliver a package in 1,1 to get a 1000pts bonus una tantum. Bonus is 1000pts. Coordinates are [{"x":1,"y":1}].');
assert(jsonDeliverAt.kind === 'deliver_at' && jsonDeliverAt.targets[0].x === 1, 'deliver_at parses JSON coordinates');
assert(F('Deliver exactly one package at a time for a bonus').kind === 'deliver_exactly_n', 'deliver_exactly_n parsed');
assert(
  F('Deliver a total reward of less than 10 to get a bonus').kind === 'deliver_less_value_than',
  'value threshold mission parsed',
);
assert(
  F('Every time you deliver parcels for a total amount of reward lower or equal to 10, you get a bonus. Threshold is 10pts.').threshold === 10,
  'value threshold mission parses lower-or-equal template',
);
assert(MissionInterpreter.parseLightState('RED LIGHT').movementAllowed === false, 'red light gates movement');
assert(
  MissionInterpreter.parseLightState('RED LIGHT! Stop moving until the next green light!').movementAllowed === false,
  'red light shout gates movement even when it mentions green',
);
assert(MissionInterpreter.parseLightState('GREEN LIGHT').movementAllowed === true, 'green light opens gate');

// Go-to-and-wait (26c2_10): target + neighbourhood radius + hold.
const gotoWait = F('Move both agents to the neighborhood of position (19,5) within a maximum distance of 3, and have them wait for each other. You will receive 500pts.');
assert(gotoWait.kind === 'go_to' && !gotoWait.forbidden, 'go-to-and-wait parsed as a positive go_to');
assert(gotoWait.targets[0] && gotoWait.targets[0].x === 19 && gotoWait.targets[0].y === 5, 'go-to-and-wait target extracted');
assert(gotoWait.tolerance === 3, 'go-to-and-wait neighbourhood radius extracted');
assert(gotoWait.holdAtTarget === true, 'go-to-and-wait sets holdAtTarget');

// chooseHoldTile: nearest reachable tile within the neighbourhood radius,
// avoiding the teammate's tile so the two agents do not contend for one spot.
const hw = new BeliefBase();
hw.loadMap(4, 3, tiles);
hw.updateMe({ id: 'me1', name: 'agentA', x: 0, y: 0, score: 0 });
const hwPlanner = new PathPlanner(hw);
const hold = chooseHoldTile(hw, hwPlanner, { x: 2, y: 2 }, 1);
assert(hold && Math.abs(hold.x - 2) + Math.abs(hold.y - 2) <= 1, 'chooseHoldTile returns a tile within the radius');
assert(hold && hw.graph.isWalkable(hold.x, hold.y), 'chooseHoldTile returns a walkable tile');
hw.teammate.x = hold.x;
hw.teammate.y = hold.y;
const hold2 = chooseHoldTile(hw, hwPlanner, { x: 2, y: 2 }, 1);
assert(hold2 && !(hold2.x === hold.x && hold2.y === hold.y), 'chooseHoldTile avoids the teammate tile when alternatives exist');

// The go-to-and-wait target centre may be a wall (26c2_10: (19,5) is type
// '0'); the strategy must still rank the mission by the reachable
// neighbourhood, not return -Infinity on the exact (unwalkable) centre.
const gw = new BeliefBase();
gw.loadMap(4, 3, tiles); // (1,1) is a wall
gw.updateMe({ id: 'me1', name: 'agentA', x: 0, y: 0, score: 0 });
gw.updateConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: '1s' }, player: { movement_duration: 100 } } });
gw.setMission({ kind: 'go_to', holdAtTarget: true, tolerance: 1, bonus: 500, targets: [{ x: 1, y: 1 }] });
const gwOpt = new OptionGenerator().generate(gw).find((o) => o.type === 'go_to_mission_target');
assert(!!gwOpt, 'go-to-and-wait generates a go_to_mission_target option');
const gwUtil = createStrategy('mission-aware').utility(gwOpt, gw, new PathPlanner(gw).scoringHelpers());
assert(Number.isFinite(gwUtil) && gwUtil > 0, 'go-to-and-wait ranks by the neighbourhood even when the target centre is a wall');

// go-to-and-wait must NOT falsely complete if the teammate never arrives:
// it aborts and keeps the mission active so it retries.
const gwTo = new BeliefBase();
gwTo.loadMap(4, 3, tiles);
gwTo.updateMe({ id: 'me1', name: 'agentA', x: 2, y: 2, score: 0 }); // already within radius 1 of (2,2)
gwTo.setMission({ kind: 'go_to', holdAtTarget: true, tolerance: 1, bonus: 500, targets: [{ x: 2, y: 2 }] });
gwTo.teammate.x = 0; gwTo.teammate.y = 0; // distance 4 from (2,2): never near
const gwToOpt = new OptionGenerator().generate(gwTo).find((o) => o.type === 'go_to_mission_target');
let gwToReason = null;
try {
  const gwLib = buildDefaultPlanLibrary();
  await new (gwLib.plansFor({ type: 'go_to_mission_target' }, {})[0])({
    beliefs: gwTo,
    executor: { move: async () => false },
    pathPlanner: new PathPlanner(gwTo),
    planLibrary: gwLib,
    config: { agent: { teammateWaitMs: 50, holdTogetherMs: 1 } },
  }).execute(gwToOpt);
} catch (err) {
  gwToReason = err?.reason;
}
assert(gwToReason === 'teammate-not-arrived', 'go-to-and-wait aborts (no false completion) when the teammate never arrives');
assert(gwTo.mission.active != null, 'go-to-and-wait keeps the mission active after a wait timeout (will retry)');

// Safety-critical constraints are pre-applied synchronously (before the
// LLM round-trip) so a slow interpretation cannot incur a penalty.
assert(
  MissionInterpreter.isSafetyCritical(F('Do not go through tiles (13,15) (14,15) or you will be penalized')) === true,
  'forbidden go_to is safety-critical (pre-applied before LLM)',
);
assert(
  MissionInterpreter.isSafetyCritical(F('Do never deliver in (15,32) (16,31) or you will be penalized')) === true,
  'forbidden deliver_at is safety-critical',
);
assert(
  MissionInterpreter.isSafetyCritical(MissionInterpreter.parseLightState('RED LIGHT! Stop until the next green light!')) === true,
  'red light is safety-critical',
);
assert(
  MissionInterpreter.isSafetyCritical(F('Go to (19,19) for 1000 points')) === false,
  'positive go_to is NOT safety-critical (stays LLM-first)',
);

// --- Mission constraints on the graph ----------------------------------------------
beliefs.setMission({ kind: 'go_to', forbidden: true, targets: [{ x: 2, y: 1 }] });
assert(!graph.isWalkable(2, 1), 'mission-blocked tile not walkable');
const pathAfterBlock = planner.shortestPath({ x: 0, y: 0 }, { x: 3, y: 2 });
assert(pathAfterBlock && pathAfterBlock.directions.length === 5, 'path still exists avoiding blocked tile');

// --- PDDL problem generation ----------------------------------------------------------
const pddl = new PddlPlanner({
  beliefs,
  config: { pddl: { enabled: true, maxTiles: 100, minPathLength: 0 } },
  metrics: new MetricsCollector(),
});
const problem = pddl.buildProblem({ x: 0, y: 0 }, { x: 3, y: 2 });
assert(problem.includes('(:goal (at t_3_2))'), 'PDDL goal emitted');
assert(problem.includes('(at t_0_0)'), 'PDDL initial position emitted');
assert(!problem.includes('t_2_1'), 'blocked tile excluded from PDDL problem');
assert(DELIVEROO_DOMAIN.includes('(:action pickup'), 'PDDL domain includes pickup action');
assert(DELIVEROO_DOMAIN.includes('(:action putdown'), 'PDDL domain includes putdown action');
const deliveryProblem = pddl.buildDeliveryProblem(
  { x: 0, y: 0 },
  { id: 'parcel-1', x: 1, y: 0 },
  { x: 3, y: 2 },
);
assert(deliveryProblem.includes('(parcel p_parcel_1)'), 'PDDL delivery problem emits parcel object');
assert(deliveryProblem.includes('(parcel-at p_parcel_1 t_1_0)'), 'PDDL delivery problem emits parcel position');
assert(deliveryProblem.includes('(delivery t_3_2)'), 'PDDL delivery problem emits delivery tile');
assert(deliveryProblem.includes('(:goal (delivered p_parcel_1))'), 'PDDL delivery problem goal is delivered parcel');

// --- Plan library ordering + protocol envelope ------------------------------------------
beliefs.clearCarried();
const lib = buildDefaultPlanLibrary();
const goToPlans = lib.plansFor(
  { type: 'go_to', x: 3, y: 2 },
  {
    pddlPlanner: pddl,
    beliefs,
    pathPlanner: planner,
    config: { pddl: { minPathLength: 0, avoidWhileCarrying: true } },
  },
);
assert(
  goToPlans.length === 2 && goToPlans[0].name === 'PddlGoTo',
  'PDDL plan precedes BFS plan when enabled',
);
const goToPlansNoPddl = lib.plansFor({ type: 'go_to' }, { pddlPlanner: { isEnabled: () => false } });
assert(
  goToPlansNoPddl.length === 1 && goToPlansNoPddl[0].name === 'FollowPathGoTo',
  'BFS only when PDDL disabled',
);

// A path can become invalid while an intention is already executing
// (e.g. a forbidden-tile mission arrives after the path was computed).
const stalePathBeliefs = new BeliefBase();
stalePathBeliefs.loadMap(2, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '3' }]);
stalePathBeliefs.updateMe({ id: 'me1', name: 'tester', x: 0, y: 0, score: 0 });
stalePathBeliefs.setMission({ kind: 'go_to', forbidden: true, targets: [{ x: 1, y: 0 }] });
let staleMoveCalled = false;
let staleReason = null;
try {
  await new goToPlansNoPddl[0]({
    beliefs: stalePathBeliefs,
    executor: { move: async () => { staleMoveCalled = true; return { x: 1, y: 0 }; } },
    pathPlanner: { shortestPath: () => ({ directions: ['right'], tiles: [{ x: 1, y: 0 }] }) },
    metrics: new MetricsCollector(),
  }).execute({ type: 'go_to', key: 'go_to:1,0', x: 1, y: 0 });
} catch (err) {
  staleReason = err?.reason;
}
assert(staleReason === 'path-invalidated', 'FollowPathGoTo rejects paths invalidated by new mission constraints');
assert(!staleMoveCalled, 'FollowPathGoTo does not step onto a newly forbidden tile');

// A mission may arrive while a deliver_carried intention is already
// walking to a delivery tile. The plan must re-check exact-N just before
// putdown, otherwise it can complete a newly-forbidden partial delivery.
const exactBeliefs = new BeliefBase();
exactBeliefs.loadMap(2, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '2' }]);
exactBeliefs.updateMe({ id: 'me1', name: 'tester', x: 1, y: 0, score: 0 });
exactBeliefs.parcels.set('e1', { id: 'e1', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
exactBeliefs.parcels.set('e2', { id: 'e2', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
exactBeliefs.mission.deliverExactly = 3;
const exactPlanner = new PathPlanner(exactBeliefs);
let putdownCalled = false;
const exactPlan = lib.plansFor({ type: 'deliver_carried' }, {})[0];
let exactReason = null;
try {
  await new exactPlan({
    beliefs: exactBeliefs,
    executor: { putdown: async () => { putdownCalled = true; return [{ id: 'e1' }]; } },
    pathPlanner: exactPlanner,
    planLibrary: lib,
  }).execute();
} catch (err) {
  exactReason = err?.reason;
}
assert(exactReason === 'deliver-exactly-not-ready', 'DeliverCarried re-checks exact-N before putdown');
assert(!putdownCalled, 'DeliverCarried does not putdown an under-sized exact-N batch');

const thresholdBeliefs = new BeliefBase();
thresholdBeliefs.loadMap(2, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '2' }]);
thresholdBeliefs.updateMe({ id: 'me1', name: 'tester', x: 1, y: 0, score: 0 });
thresholdBeliefs.parcels.set('high', { id: 'high', x: 1, y: 0, reward: 25, rewardAtLastSeen: 25, lastSeen: Date.now(), carriedBy: 'me1' });
thresholdBeliefs.mission.deliverMaxValue = 10;
const thresholdPlanner = new PathPlanner(thresholdBeliefs);
let thresholdPutdownCalled = false;
const thresholdPlan = lib.plansFor({ type: 'deliver_carried' }, {})[0];
let thresholdReason = null;
try {
  await new thresholdPlan({
    beliefs: thresholdBeliefs,
    executor: { putdown: async () => { thresholdPutdownCalled = true; return [{ id: 'high' }]; } },
    pathPlanner: thresholdPlanner,
    planLibrary: lib,
  }).execute();
} catch (err) {
  thresholdReason = err?.reason;
}
assert(thresholdReason === 'deliver-threshold-not-ready', 'DeliverCarried waits when no parcel is below the value threshold');
assert(!thresholdPutdownCalled, 'DeliverCarried does not putdown an over-threshold batch');

thresholdBeliefs.parcels.set('low', { id: 'low', x: 1, y: 0, reward: 8, rewardAtLastSeen: 8, lastSeen: Date.now(), carriedBy: 'me1' });
let requestedThresholdIds = null;
await new thresholdPlan({
  beliefs: thresholdBeliefs,
  executor: { putdown: async (ids) => { requestedThresholdIds = ids; return ids.map((id) => ({ id })); } },
  pathPlanner: thresholdPlanner,
  planLibrary: lib,
  metrics: new MetricsCollector(),
}).execute();
assert(JSON.stringify(requestedThresholdIds) === '["low"]', 'DeliverCarried selects only parcels under the value threshold');

const goToPlansShortPath = lib.plansFor(
  { type: 'go_to', x: 3, y: 2 },
  {
    pddlPlanner: pddl,
    beliefs,
    pathPlanner: planner,
    config: { pddl: { minPathLength: 10, avoidWhileCarrying: true } },
  },
);
assert(
  goToPlansShortPath.length === 1 && goToPlansShortPath[0].name === 'FollowPathGoTo',
  'short paths skip PDDL and go straight to BFS',
);
beliefs.markCarried('p2');
const goToPlansCarrying = lib.plansFor(
  { type: 'go_to', x: 3, y: 2 },
  {
    pddlPlanner: pddl,
    beliefs,
    pathPlanner: planner,
    config: { pddl: { minPathLength: 0, avoidWhileCarrying: true } },
  },
);
assert(
  goToPlansCarrying.length === 1 && goToPlansCarrying[0].name === 'FollowPathGoTo',
  'carrying parcels skips PDDL to avoid solver latency during decay',
);
beliefs.clearCarried();
assert(
  lib.plansFor({ type: 'go_pick_up' }, { pddlPlanner: { isDeliveryEnabled: () => false } })[0].name === 'GoPickUp',
  'normal pickup plan first when PDDL delivery disabled',
);
assert(
  lib.plansFor({ type: 'go_pick_up' }, { pddlPlanner: { isDeliveryEnabled: () => true } })[0].name === 'PddlPickUpAndDeliver',
  'PDDL delivery plan precedes normal pickup when explicitly enabled',
);

// --- PDDL delivery is mission-safe (defers to the BDI mission plans) -------
// Gate: the single-parcel PDDL delivery plan must NOT activate while a
// delivery/positional mission constraint is in force; those are served by
// the dedicated BDI plans, which enforce exact-N / threshold compliance.
const pddlGateBeliefs = new BeliefBase();
const pddlDeliveryOn = { pddlPlanner: { isDeliveryEnabled: () => true }, beliefs: pddlGateBeliefs };
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'PddlPickUpAndDeliver',
  'PDDL delivery applies when no mission constraint is active',
);
pddlGateBeliefs.mission.deliverExactly = 3;
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'GoPickUp',
  'PDDL delivery defers to the BDI plan under deliver_exactly_n',
);
pddlGateBeliefs.mission.deliverExactly = null;
pddlGateBeliefs.mission.deliverMaxValue = 10;
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'GoPickUp',
  'PDDL delivery defers to the BDI plan under deliver_less_value_than',
);
pddlGateBeliefs.mission.deliverMaxValue = null;
pddlGateBeliefs.mission.active = { kind: 'go_to' };
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'GoPickUp',
  'PDDL delivery defers to the BDI plan under an active positional mission',
);
pddlGateBeliefs.mission.active = null;
pddlGateBeliefs.mission.handover = { active: true };
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'GoPickUp',
  'PDDL delivery defers to the BDI plan during an active handover',
);
pddlGateBeliefs.mission.handover = { active: false };
assert(
  lib.plansFor({ type: 'go_pick_up' }, pddlDeliveryOn)[0].name === 'PddlPickUpAndDeliver',
  'PDDL delivery still applies when a handover is present but not active',
);
pddlGateBeliefs.mission.handover = null;

// Putdown guard (defense-in-depth): even if forced to run, the PDDL
// delivery putdown reuses the same safety selection as DeliverCarried.
const PddlDeliverPlan = lib.plansFor(
  { type: 'go_pick_up' },
  { pddlPlanner: { isDeliveryEnabled: () => true }, beliefs: new BeliefBase() },
)[0];
const deliverOption = { type: 'go_pick_up', parcelId: 'target', x: 1, y: 0 };
const onePutdownPlan = { planDelivery: async () => [{ type: 'putdown' }] };
function makePddlDeliveryBeliefs() {
  const b = new BeliefBase();
  b.loadMap(2, 1, [{ x: 0, y: 0, type: '3' }, { x: 1, y: 0, type: '2' }]);
  b.updateMe({ id: 'me1', name: 'tester', x: 1, y: 0, score: 0 });
  // a free target parcel the plan is dispatched for (not carried)
  b.parcels.set('target', { id: 'target', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now() });
  return b;
}

// exact-N not satisfied -> abort (no drop), so the normal plans take over
const pddlExact = makePddlDeliveryBeliefs();
pddlExact.parcels.set('c1', { id: 'c1', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
pddlExact.parcels.set('c2', { id: 'c2', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
pddlExact.mission.deliverExactly = 3;
let pddlExactPutdown = false;
let pddlExactReason = null;
try {
  await new PddlDeliverPlan({
    beliefs: pddlExact,
    executor: { putdown: async () => { pddlExactPutdown = true; return [{ id: 'c1' }]; } },
    pddlPlanner: onePutdownPlan,
  }).execute(deliverOption);
} catch (err) { pddlExactReason = err?.reason; }
assert(pddlExactReason === 'pddl-delivery-exactly-not-ready', 'PDDL delivery aborts an under-sized exact-N batch');
assert(!pddlExactPutdown, 'PDDL delivery does not putdown an under-sized exact-N batch');

// value-threshold: no compliant subset -> abort
const pddlThreshAbort = makePddlDeliveryBeliefs();
pddlThreshAbort.parcels.set('high', { id: 'high', x: 1, y: 0, reward: 25, rewardAtLastSeen: 25, lastSeen: Date.now(), carriedBy: 'me1' });
pddlThreshAbort.mission.deliverMaxValue = 10;
let pddlThreshPutdown = false;
let pddlThreshReason = null;
try {
  await new PddlDeliverPlan({
    beliefs: pddlThreshAbort,
    executor: { putdown: async () => { pddlThreshPutdown = true; return [{ id: 'high' }]; } },
    pddlPlanner: onePutdownPlan,
  }).execute(deliverOption);
} catch (err) { pddlThreshReason = err?.reason; }
assert(pddlThreshReason === 'pddl-delivery-threshold-not-ready', 'PDDL delivery aborts an over-threshold batch');
assert(!pddlThreshPutdown, 'PDDL delivery does not putdown an over-threshold batch');

// value-threshold: compliant subset -> drop only the under-cap parcels
const pddlThreshOk = makePddlDeliveryBeliefs();
pddlThreshOk.parcels.set('high', { id: 'high', x: 1, y: 0, reward: 25, rewardAtLastSeen: 25, lastSeen: Date.now(), carriedBy: 'me1' });
pddlThreshOk.parcels.set('low', { id: 'low', x: 1, y: 0, reward: 8, rewardAtLastSeen: 8, lastSeen: Date.now(), carriedBy: 'me1' });
pddlThreshOk.mission.deliverMaxValue = 10;
let pddlRequestedIds = null;
await new PddlDeliverPlan({
  beliefs: pddlThreshOk,
  executor: { putdown: async (ids) => { pddlRequestedIds = ids; return ids.map((id) => ({ id })); } },
  pddlPlanner: onePutdownPlan,
  metrics: new MetricsCollector(),
}).execute(deliverOption);
assert(JSON.stringify(pddlRequestedIds) === '["low"]', 'PDDL delivery puts down only parcels under the value threshold');

// runtime guard: a positional / handover mission arriving WHILE the PDDL
// plan runs must stop the putdown (the gate only covers plan start).
const pddlMidActive = makePddlDeliveryBeliefs();
pddlMidActive.parcels.set('c1', { id: 'c1', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
pddlMidActive.mission.active = { kind: 'go_to' };
let pddlMidActivePutdown = false;
let pddlMidActiveReason = null;
try {
  await new PddlDeliverPlan({
    beliefs: pddlMidActive,
    executor: { putdown: async () => { pddlMidActivePutdown = true; return [{ id: 'c1' }]; } },
    pddlPlanner: onePutdownPlan,
  }).execute(deliverOption);
} catch (err) { pddlMidActiveReason = err?.reason; }
assert(pddlMidActiveReason === 'pddl-delivery-mission-active', 'PDDL delivery aborts when a positional mission arrives mid-plan');
assert(!pddlMidActivePutdown, 'PDDL delivery does not putdown while a positional mission is active');

const pddlMidHandover = makePddlDeliveryBeliefs();
pddlMidHandover.parcels.set('c1', { id: 'c1', x: 1, y: 0, reward: 10, rewardAtLastSeen: 10, lastSeen: Date.now(), carriedBy: 'me1' });
pddlMidHandover.mission.handover = { active: true };
let pddlMidHandoverPutdown = false;
let pddlMidHandoverReason = null;
try {
  await new PddlDeliverPlan({
    beliefs: pddlMidHandover,
    executor: { putdown: async () => { pddlMidHandoverPutdown = true; return [{ id: 'c1' }]; } },
    pddlPlanner: onePutdownPlan,
  }).execute(deliverOption);
} catch (err) { pddlMidHandoverReason = err?.reason; }
assert(pddlMidHandoverReason === 'pddl-delivery-mission-active', 'PDDL delivery aborts when a handover starts mid-plan');
assert(!pddlMidHandoverPutdown, 'PDDL delivery does not putdown during an active handover');

const envelope = makeMessage('claim', { parcelId: 'p9' }, 'me1');
assert(isProtocolMessage(envelope) && !isProtocolMessage('free text'), 'protocol envelope detection');

// Config overrides used by the run scripts to pair A and B from one .env
// (each agent needs a different teammate name for discovery).
assert(loadConfig({ teammateName: 'agentA' }).teammateName === 'agentA', 'loadConfig honors --teammate override');
assert(loadConfig({ name: 'agentB' }).name === 'agentB', 'loadConfig honors --name override');

// --- Handover data layer (26c2_8 level 3, Fetta 2) -----------------------------
// Rendezvous is deterministic and map-derived: a non-delivery walkable tile
// one step from a delivery (so both agents agree without negotiating).
const rv1 = graph.rendezvousTile();
const rv2 = graph.rendezvousTile();
assert(rv1 && rv1.x === rv2.x && rv1.y === rv2.y, 'rendezvousTile is deterministic');
assert(rv1 && !graph.tileAt(rv1.x, rv1.y).delivery && graph.isWalkable(rv1.x, rv1.y), 'rendezvous is a walkable non-delivery tile');
assert(rv1 && graph.deliveryDistance(rv1.x, rv1.y) === 1, 'rendezvous is one step from a delivery tile');

const hov = new BeliefBase();
hov.loadMap(4, 3, tiles);
hov.handoverRole = 'picker';
hov.setMission({ kind: 'one_pickup_another_deliver' });
assert(hov.mission.handover.active && hov.mission.handover.role === 'picker', 'handover mission sets the explicit role');
assert(hov.mission.handover.rendezvous != null, 'handover mission computes a rendezvous from the map');
// Coordinate-first locator: id + coords -> both stored.
hov.applyHandoverUpdate({ state: 'dropped', parcelId: 'p7', x: 2, y: 2 });
assert(
  hov.mission.handover.parcel.x === 2 && hov.mission.handover.parcel.y === 2 && hov.mission.handover.parcel.id === 'p7',
  'handover update stores drop coordinates and id',
);
assert(hov.mission.handover.peerState === 'dropped', 'handover update tracks peer state');
// Coordinate fallback: a later message with coords but NO id still locates the drop.
hov.applyHandoverUpdate({ state: 'dropped', x: 1, y: 0 });
assert(
  hov.mission.handover.parcel.x === 1 && hov.mission.handover.parcel.y === 0,
  'handover locates the drop by coordinates even without a parcelId',
);

// Picker side (Fetta 3 step A): carrying a parcel under an active handover
// generates a deposit option, the strategy commits to it, and the picker
// is barred from self-delivering (no bonus when one agent does both).
const pick = new BeliefBase();
pick.loadMap(4, 3, tiles);
pick.updateMe({ id: 'me1', name: 'agentA', x: 0, y: 0, score: 0 });
pick.updateConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: '1s' }, player: { movement_duration: 100 } } });
pick.handoverRole = 'picker';
pick.setMission({ kind: 'one_pickup_another_deliver' });
pick.parcels.set('hp', { id: 'hp', x: 0, y: 0, reward: 30, rewardAtLastSeen: 30, lastSeen: Date.now(), carriedBy: 'me1' });
const pickPlanner = new PathPlanner(pick);
const pickHelpers = pickPlanner.scoringHelpers();
const pickOpts = new OptionGenerator().generate(pick);
const depOpt = pickOpts.find((o) => o.type === 'handover_deposit');
assert(!!depOpt, 'picker carrying a parcel generates a handover_deposit option');
const ma = createStrategy('mission-aware');
assert(Number.isFinite(ma.utility(depOpt, pick, pickHelpers)), 'handover_deposit has a finite utility for the picker');
assert(
  ma.utility({ type: 'deliver_carried', key: 'deliver_carried' }, pick, pickHelpers) === -Infinity,
  'picker is barred from self-delivering during a handover',
);
const depPlan = lib.plansFor({ type: 'handover_deposit' }, {})[0];
assert(depPlan && depPlan.name === 'HandoverDeposit', 'HandoverDeposit plan serves handover_deposit');

// The picker must not re-grab a parcel it dropped at the rendezvous (that
// drop is reserved for the deliverer) — otherwise it loops on its own drop.
const rvTile = pick.mission.handover.rendezvous;
pick.parcels.set('atRv', { id: 'atRv', x: rvTile.x, y: rvTile.y, reward: 30, rewardAtLastSeen: 30, lastSeen: Date.now(), carriedBy: null });
const optsWithRvDrop = new OptionGenerator().generate(pick);
assert(
  !optsWithRvDrop.some((o) => o.type === 'go_pick_up' && o.parcelId === 'atRv'),
  'picker ignores parcels sitting on the rendezvous tile',
);

// Safety: the picker must NOT signal the drop if it cannot vacate the
// rendezvous (two agents cannot share a tile — the deliverer would head
// for a tile the picker still blocks).
const blk = new BeliefBase();
blk.loadMap(4, 3, tiles);
blk.handoverRole = 'picker';
blk.setMission({ kind: 'one_pickup_another_deliver' });
const rrv = blk.mission.handover.rendezvous;
blk.updateMe({ id: 'me1', name: 'agentA', x: rrv.x, y: rrv.y, score: 0 });
blk.parcels.set('hd', { id: 'hd', x: rrv.x, y: rrv.y, reward: 30, rewardAtLastSeen: 30, lastSeen: Date.now(), carriedBy: 'me1' });
let handoverSignalled = false;
let depReason = null;
try {
  await new (lib.plansFor({ type: 'handover_deposit' }, {})[0])({
    beliefs: blk,
    executor: { putdown: async () => [{ id: 'hd' }], move: async () => false },
    protocol: { sendHandover: async () => { handoverSignalled = true; } },
    pathPlanner: new PathPlanner(blk),
    planLibrary: lib,
    metrics: new MetricsCollector(),
  }).execute({ type: 'handover_deposit', key: 'handover_deposit', rendezvous: rrv });
} catch (err) {
  depReason = err?.reason;
}
assert(depReason === 'handover-exit-blocked', 'HandoverDeposit aborts when it cannot free the rendezvous');
assert(!handoverSignalled, 'HandoverDeposit does not signal the drop while the rendezvous stays blocked');

// Deliverer side (Fetta 3 step B): a waiting drop (located by coordinates)
// generates a collect option, the strategy commits to it, and the plan
// collects then clears the slot so the normal delivery path takes over.
const del = new BeliefBase();
del.loadMap(4, 3, tiles);
del.handoverRole = 'deliverer';
del.setMission({ kind: 'one_pickup_another_deliver' });
del.applyHandoverUpdate({ state: 'dropped', parcelId: 'hx', x: 2, y: 2 });
del.updateMe({ id: 'me2', name: 'agentB', x: 2, y: 2, score: 0 });
del.updateConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: '1s' }, player: { movement_duration: 100 } } });
del.parcels.set('hx', { id: 'hx', x: 2, y: 2, reward: 30, rewardAtLastSeen: 30, lastSeen: Date.now(), carriedBy: null });
const delPlanner = new PathPlanner(del);
const colOpt = new OptionGenerator().generate(del).find((o) => o.type === 'handover_collect');
assert(!!colOpt && colOpt.x === 2 && colOpt.y === 2, 'deliverer generates handover_collect at the drop coordinates');
assert(Number.isFinite(ma.utility(colOpt, del, delPlanner.scoringHelpers())), 'handover_collect has a finite utility for the deliverer');
const colPlanCls = lib.plansFor({ type: 'handover_collect' }, {})[0];
assert(colPlanCls && colPlanCls.name === 'HandoverCollect', 'HandoverCollect plan serves handover_collect');
await new colPlanCls({
  beliefs: del,
  executor: { pickup: async () => [{ id: 'hx' }] },
  pathPlanner: delPlanner,
  planLibrary: lib,
  metrics: new MetricsCollector(),
}).execute(colOpt);
assert(del.mission.handover.parcel === null, 'HandoverCollect clears the drop slot after collecting');
assert(del.mission.handover.myState === 'collected', 'HandoverCollect marks the deliverer state collected');
assert(del.carried().some((p) => p.id === 'hx'), 'the collected parcel is now carried by the deliverer (to be delivered)');

// --- Ack normalization + belief reconciliation (live-observed server quirk) -----
assert(
  JSON.stringify(normalizeIdList([{ id: 'a' }, 'b', { parcelId: 'c' }, {}, null])) === '["a","b","c"]',
  'ack id normalization handles objects, strings and junk',
);
assert(normalizeIdList(undefined).length === 0, 'ack normalization tolerates non-arrays');
// Phantom-carry reconciliation: clearCarried removes only my parcels.
beliefs.parcels.set('mine', { id: 'mine', x: 0, y: 0, reward: 5, rewardAtLastSeen: 5, lastSeen: Date.now(), carriedBy: 'me1' });
beliefs.parcels.set('theirs', { id: 'theirs', x: 1, y: 2, reward: 5, rewardAtLastSeen: 5, lastSeen: Date.now(), carriedBy: 'a2' });
beliefs.clearCarried();
assert(!beliefs.parcels.has('mine') && beliefs.parcels.has('theirs'), 'clearCarried removes only own-carried beliefs');
// Tile-pickup fallback: free parcel on my tile becomes carried.
beliefs.parcels.set('onTile', { id: 'onTile', x: 0, y: 0, reward: 9, rewardAtLastSeen: 9, lastSeen: Date.now(), carriedBy: null });
beliefs.markTilePickedUp();
assert(beliefs.parcels.get('onTile').carriedBy === 'me1', 'markTilePickedUp marks free parcels on my tile');

// --- Baseline result aggregation (scripts/aggregate-results.js core) -----------
const aggRows = aggregateResults([
  { scenario: '26c1_1', strategy: 'reward-distance', finalScore: 800, counters: { parcelsDelivered: 30, intentionChanges: 98 } },
  { scenario: '26c1_1', strategy: 'reward-distance', finalScore: 600, counters: { parcelsDelivered: 24, intentionChanges: 80 } },
  { scenario: '26c1_1', strategy: 'greedy-nearest', finalScore: 500, counters: { parcelsDelivered: 20 } },
  { scenario: 'bad', strategy: 'x', finalScore: 'NaN' }, // ignored: non-numeric score
]);
const rd = aggRows.find((r) => r.strategy === 'reward-distance');
assert(aggRows.length === 2, 'aggregateResults groups by (scenario, strategy) and drops invalid records');
assert(rd && rd.n === 2 && rd.scoreMean === 700 && rd.scoreMin === 600 && rd.scoreMax === 800, 'aggregateResults computes mean/min/max per group');
assert(aggRows[0].strategy === 'reward-distance', 'aggregateResults sorts best mean score first within a scenario');

// --- RunLogger is close-safe (shutdown-race guard) -----------------------------
const tmpLogDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'asa-logger-'));
const rl = new RunLogger({ dir: tmpLogDir, label: 'smoke', role: 'test' });
rl.log('alive', { ok: true });
assert(rl.stream.listenerCount('error') > 0, 'RunLogger attaches a stream error listener (no crash on write-after-end)');
rl.close();
assert(rl.closed === true, 'RunLogger.close sets the closed flag');
let loggerThrew = false;
try { rl.log('after-close', {}); rl.close(); } catch { loggerThrew = true; }
assert(!loggerThrew, 'RunLogger log() and close() are safe to call after close (idempotent, no throw)');
try { fs.rmSync(tmpLogDir, { recursive: true, force: true }); } catch { /* file may still be flushing on Windows */ }

if (failures > 0) {
  console.error(`\n${failures} smoke test(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll smoke tests passed.');
