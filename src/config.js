import 'dotenv/config';

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Central runtime configuration.
 *
 * Everything tunable lives here so that no behavior is hidden in magic
 * constants spread across the codebase. Values come from (in priority
 * order): explicit overrides (CLI/scripts) > environment (.env) > defaults.
 *
 * Note: the *game* configuration (movement_duration, decay, observation
 * distance, ...) is NOT here — it is read at runtime from the server
 * `config` event and stored in the BeliefBase, because it changes per
 * scenario and must never be hardcoded.
 */
export function loadConfig(overrides = {}) {
  const env = process.env;

  const config = {
    // --- connection -------------------------------------------------------
    host: env.HOST || 'http://localhost:8080',
    token: env.TOKEN || undefined,
    name: env.NAME || 'asa-agent',
    teammateName: env.TEAMMATE_NAME || null,

    // --- strategy ---------------------------------------------------------
    // See src/strategies/index.js for the list of registered ids.
    strategy: env.STRATEGY || 'reward-distance',
    strategyOptions: {},

    // --- BDI loop tuning ----------------------------------------------------
    agent: {
      // Fallback deliberation period (ms). Sensing only fires on *change*,
      // so a timer guarantees the agent keeps re-evaluating options.
      deliberationIntervalMs: 250,
      // Additive utility margin a new option must exceed over the current
      // intention before we switch (hysteresis against target thrashing).
      // Unit: same as strategy utilities (≈ reward points).
      hysteresisMargin: 5,
      // Consecutive failed moves tolerated before a path is declared
      // blocked and the intention fails (dynamic obstacles get retries).
      moveRetries: 2,
      // Pause between move retries (lets a passing agent clear the tile).
      moveRetryDelayMs: 200,
      // How long a tile stays soft-blocked after repeated move failures,
      // so the next BFS routes around the (probably occupied) tile.
      softBlockMs: 3000,
      // Duration of one 'wait' intention.
      waitMs: 300,
      // Teammate position heartbeat period.
      heartbeatMs: 1000,
      // Go-to-and-wait (26c2_10): how long to wait for the teammate to
      // reach the neighbourhood before giving up, and how long both then
      // hold together so the mission observer sees them in place.
      teammateWaitMs: 15000,
      holdTogetherMs: 2000,
    },

    // --- PDDL ---------------------------------------------------------------
    pddl: {
      enabled: (env.PDDL_ENABLED || 'false').toLowerCase() === 'true',
      deliveryEnabled: (env.PDDL_DELIVERY_ENABLED || 'false').toLowerCase() === 'true',
      // Safety bound: do not generate PDDL problems for reachable regions
      // larger than this many tiles (the online solver gets slow).
      maxTiles: positiveInt(env.PDDL_MAX_TILES, 1600),
      // Fail fast and let the next plan (BFS) take over when the online
      // solver is slower than the game can tolerate.
      timeoutMs: positiveInt(env.PDDL_TIMEOUT_MS, 2500),
      // Do not spend a multi-second solver call on short paths. BFS is
      // essentially instant there, and live tests showed fixed PDDL
      // overhead around 3 s even for one-step plans.
      minPathLength: positiveInt(env.PDDL_MIN_PATH_LENGTH, 10),
      // Delivery urgency beats symbolic elegance: while carrying parcels,
      // reward decay makes the online-planner delay especially expensive.
      avoidWhileCarrying: (env.PDDL_AVOID_WHILE_CARRYING || 'true').toLowerCase() !== 'false',
      // PAAS_HOST / PAAS_PATH are read directly by @unitn-asa/pddl-client.
    },

    // --- LLM (Agent B) ------------------------------------------------------
    llm: {
      baseUrl: env.LITELLM_BASE_URL || null,
      apiKey: env.LITELLM_API_KEY || null,
      model: env.LLM_MODEL || null,
    },

    // --- logging ------------------------------------------------------------
    log: {
      dir: env.LOG_DIR || 'experiments/logs',
      resultsDir: env.RESULTS_DIR || 'experiments/results',
      label: env.RUN_LABEL || 'dev',
    },
  };

  // Shallow-merge overrides (one nesting level is enough for our shape).
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      config[key] = { ...config[key], ...value };
    } else if (value !== undefined) {
      config[key] = value;
    }
  }

  return config;
}
