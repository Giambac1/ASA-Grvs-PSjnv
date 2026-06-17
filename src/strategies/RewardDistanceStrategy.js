import { StrategyBase } from './StrategyBase.js';

/**
 * Value-aware strategy: estimates the *delivered* value of each choice.
 *
 * Score model (game_knowledge 05): delivered reward = current reward
 * minus the decay accumulated while traveling; each move costs
 * `decayPerTile` reward per carried parcel. So:
 *
 *   pickup utility  = projectedReward(p)
 *                     - (d(me,p) + d(p,delivery)) * decayPerTile * (carried+1)
 *   deliver utility = sum(projected carried rewards)
 *                     - d(me,delivery) * decayPerTile * carried
 *                     - deliverBias   (small bias encourages batching)
 *
 * TODO(strategy): account for opponent proximity (drop a parcel when a
 * visible opponent is closer to it) and for spawn-throttling effects.
 */
export class RewardDistanceStrategy extends StrategyBase {
  static id = 'reward-distance';

  constructor(options = {}) {
    super(options);
    // Bias subtracted from the deliver utility: how much potential value
    // the agent is willing to keep carrying in hope of a nearby pickup.
    this.deliverBias = options.deliverBias ?? 10;
  }

  utility(option, beliefs, helpers) {
    const carried = beliefs.carried();
    const decay = helpers.decayPerTile;

    switch (option.type) {
      case 'go_pick_up': {
        const parcel = beliefs.parcels.get(option.parcelId);
        if (!parcel) return -Infinity;
        const toParcel = helpers.distanceTo(option.x, option.y);
        const toDelivery = helpers.deliveryDistanceFrom(option.x, option.y);
        if (!Number.isFinite(toParcel) || !Number.isFinite(toDelivery)) return -Infinity;
        const travel = (toParcel + toDelivery) * decay * (carried.length + 1);
        return beliefs.projectedReward(parcel) - travel;
      }
      case 'deliver_carried': {
        const toDelivery = helpers.deliveryDistanceFrom(beliefs.me.x, beliefs.me.y);
        if (!Number.isFinite(toDelivery)) return -Infinity;
        const value = carried.reduce(
          (sum, p) => sum + Math.max(beliefs.projectedReward(p), 0),
          0,
        );
        return value - toDelivery * decay * carried.length - this.deliverBias;
      }
      default:
        return super.utility(option, beliefs, helpers);
    }
  }
}
