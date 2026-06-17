import { StrategyBase } from './StrategyBase.js';

/**
 * Baseline strategy: always chase the nearest reachable parcel; deliver
 * only when carrying and nothing (reachable) is left to pick up.
 *
 * Deliberately ignores parcel value and decay — it is the control
 * baseline that smarter strategies are compared against in experiments.
 */
export class GreedyNearestStrategy extends StrategyBase {
  static id = 'greedy-nearest';

  utility(option, beliefs, helpers) {
    switch (option.type) {
      case 'go_pick_up': {
        const distance = helpers.distanceTo(option.x, option.y);
        if (!Number.isFinite(distance)) return -Infinity;
        // Pure distance ranking; PICKUP_BASE keeps pickups above
        // delivery/explore as long as any parcel is reachable.
        return GreedyNearestStrategy.PICKUP_BASE - distance;
      }
      case 'deliver_carried': {
        const distance = helpers.deliveryDistanceFrom(beliefs.me.x, beliefs.me.y);
        if (!Number.isFinite(distance)) return -Infinity;
        return GreedyNearestStrategy.DELIVER_BASE - distance;
      }
      default:
        return super.utility(option, beliefs, helpers);
    }
  }

  /** Utility offsets defining the fixed priority: pickup > deliver > explore. */
  static PICKUP_BASE = 1000;
  static DELIVER_BASE = 500;
}
