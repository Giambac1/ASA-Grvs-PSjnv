import { RewardDistanceStrategy } from './RewardDistanceStrategy.js';

/**
 * Variant of reward-distance that fixes a scale mismatch found in the
 * Challenge 1 baseline diagnosis (experiments/RESULTS-baseline-v1.md):
 *
 *   reward-distance scores a pickup by the *new* parcel's value only, while
 *   its deliver utility already includes the *carried* value. So once it
 *   carries 1-2 parcels, delivering tends to out-score any single pickup,
 *   and the agent delivers in tiny ~2-parcel batches instead of hoarding.
 *
 * This variant scores a pickup by the *total delivered value of the whole
 * load* if that pickup is taken and then delivered, putting pickup and
 * deliver on the same (total-load) scale:
 *
 *   pickup  = carriedValue + newValue
 *             - (carried+1) * (d(me,parcel) + d(parcel,delivery)) * decay
 *   deliver = carriedValue - d(me,delivery) * decay * carried
 *
 * Equivalently, pickup = (reward-distance pickup) + carriedValue. The agent
 * therefore keeps collecting while the marginal parcel adds net delivered
 * value, instead of dropping the load early. No deliverBias is needed (the
 * two utilities are already comparable). reward-distance itself is left
 * unchanged; this is a separate, selectable strategy for the experiment.
 */
export class RewardDistanceTotalStrategy extends RewardDistanceStrategy {
  static id = 'reward-distance-total';

  utility(option, beliefs, helpers) {
    const carried = beliefs.carried();
    const decay = helpers.decayPerTile;
    const carriedValue = carried.reduce(
      (sum, p) => sum + Math.max(beliefs.projectedReward(p), 0),
      0,
    );

    switch (option.type) {
      case 'go_pick_up': {
        const parcel = beliefs.parcels.get(option.parcelId);
        if (!parcel) return -Infinity;
        const toParcel = helpers.distanceTo(option.x, option.y);
        const toDelivery = helpers.deliveryDistanceFrom(option.x, option.y);
        if (!Number.isFinite(toParcel) || !Number.isFinite(toDelivery)) return -Infinity;
        const newValue = Math.max(beliefs.projectedReward(parcel), 0);
        // Whole load (carried + this one) decays over the detour-then-deliver path.
        const travel = (toParcel + toDelivery) * decay * (carried.length + 1);
        return carriedValue + newValue - travel;
      }
      case 'deliver_carried': {
        const toDelivery = helpers.deliveryDistanceFrom(beliefs.me.x, beliefs.me.y);
        if (!Number.isFinite(toDelivery)) return -Infinity;
        return carriedValue - toDelivery * decay * carried.length;
      }
      default:
        return super.utility(option, beliefs, helpers);
    }
  }
}
