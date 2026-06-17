/**
 * In-memory metrics for one agent run. Counters are incremented by the
 * infrastructure (executor, plans, revision, protocol, planners); the
 * summary feeds experiment result files and report tables.
 */
export class MetricsCollector {
  counters = {
    parcelsPickedUp: 0,
    parcelsDelivered: 0,
    pickupsLost: 0,
    failedMoves: 0,
    failedActions: 0,
    intentionChanges: 0,
    failedIntentions: 0,
    plannerCalls: 0,
    plannerFailures: 0,
    llmInterpretations: 0,
    messagesSent: 0,
    messagesReceived: 0,
  };

  /** {t: ms since start, score} — the score timeline for plots. */
  scoreTimeline = [];

  /**
   * @param {object} opts
   * @param {import('./RunLogger.js').RunLogger} [opts.logger] echo events to the run log
   * @param {string} [opts.strategy] selected strategy id
   * @param {string} [opts.scenario] scenario/run label
   */
  constructor({ logger = null, strategy = 'unknown', scenario = 'default' } = {}) {
    this.logger = logger;
    this.strategy = strategy;
    this.scenario = scenario;
    this.startedAt = Date.now();
  }

  increment(name, by = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  recordScore(score) {
    this.scoreTimeline.push({ t: Date.now() - this.startedAt, score });
    this.logger?.log('score', { score });
  }

  /** Free-form event passthrough to the run log. */
  record(event, payload = {}) {
    this.logger?.log(event, payload);
  }

  summary() {
    const last = this.scoreTimeline.at(-1);
    return {
      strategy: this.strategy,
      scenario: this.scenario,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
      finalScore: last?.score ?? 0,
      counters: { ...this.counters },
      scoreTimeline: this.scoreTimeline,
    };
  }
}
