/**
 * Pure aggregation of experiment result records for baseline comparison.
 *
 * Kept free of I/O so it can be unit-tested offline (npm test) and reused
 * by scripts/aggregate-results.js and the analysis notebooks. Input is the
 * array of parsed result JSONs written to experiments/results/ by a run
 * (see RunLogger.writeResult / MetricsCollector.summary).
 */

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation (n-1); 0 for fewer than two samples. */
function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Group result records by (scenario, strategy) and compute summary stats.
 * @param {Array<object>} records  parsed result JSONs
 * @returns {Array<{scenario,strategy,n,scoreMean,scoreStd,scoreMin,scoreMax,deliveredMean,intentionChangesMean}>}
 *          one row per (scenario, strategy), sorted by scenario then by
 *          descending mean score (best strategy first within each map).
 */
export function aggregateResults(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r || typeof r.finalScore !== 'number') continue;
    const scenario = r.scenario ?? 'unknown';
    const strategy = r.strategy ?? 'unknown';
    // Unambiguous composite key: no concatenation collisions for free-form
    // --label / strategy ids, and no invisible separator characters.
    const key = JSON.stringify([scenario, strategy]);
    if (!groups.has(key)) groups.set(key, { scenario, strategy, runs: [] });
    groups.get(key).runs.push(r);
  }

  const rows = [];
  for (const { scenario, strategy, runs } of groups.values()) {
    const scores = runs.map((r) => r.finalScore);
    const delivered = runs.map((r) => r.counters?.parcelsDelivered ?? 0);
    const intentionChanges = runs.map((r) => r.counters?.intentionChanges ?? 0);
    rows.push({
      scenario,
      strategy,
      n: runs.length,
      scoreMean: mean(scores),
      scoreStd: std(scores),
      scoreMin: Math.min(...scores),
      scoreMax: Math.max(...scores),
      deliveredMean: mean(delivered),
      intentionChangesMean: mean(intentionChanges),
    });
  }

  rows.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || b.scoreMean - a.scoreMean,
  );
  return rows;
}
