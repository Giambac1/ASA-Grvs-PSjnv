import { RewardDistanceStrategy } from './RewardDistanceStrategy.js';

/**
 * Batching strategy: keep collecting until a threshold is reached, then
 * deliver everything. Useful on maps where deliveries are the bottleneck
 * (e.g. 26c1_5: 91 spawners, 4 delivery tiles — batch per lap).
 *
 * Thresholds (constructor options):
 *   minCarried   deliver once carrying at least this many parcels (default 3)
 *   minValue     ... or once carried projected value reaches this (default Infinity)
 *
 * TODO(strategy): derive thresholds from the scenario config (parcels.max,
 * decay speed) instead of fixed defaults.
 */
export class DeliveryThresholdStrategy extends RewardDistanceStrategy {
  static id = 'delivery-threshold';

  constructor(options = {}) {
    super(options);
    this.minCarried = options.minCarried ?? 3;
    this.minValue = options.minValue ?? Infinity;
  }

  utility(option, beliefs, helpers) {
    if (option.type !== 'deliver_carried') {
      return super.utility(option, beliefs, helpers);
    }

    const carried = beliefs.carried();
    const value = carried.reduce(
      (sum, p) => sum + Math.max(beliefs.projectedReward(p), 0),
      0,
    );
    const base = super.utility(option, beliefs, helpers);
    if (!Number.isFinite(base)) return base;

    if (carried.length >= this.minCarried || value >= this.minValue) {
      // Threshold reached: make delivering dominate any single pickup.
      return base + DeliveryThresholdStrategy.DELIVER_BOOST;
    }
    // Below threshold: discourage early delivery (but never forbid it —
    // when no pickup is reachable, delivering still beats exploring).
    return base - DeliveryThresholdStrategy.EARLY_DELIVERY_PENALTY;
  }

  static DELIVER_BOOST = 1000;
  static EARLY_DELIVERY_PENALTY = 20;
}
