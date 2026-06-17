import { RewardDistanceStrategy } from './RewardDistanceStrategy.js';

/**
 * Challenge 2 strategy: reward/distance farming that defers to mission
 * state in the BeliefBase (written by the LLM interpreter or received
 * from the teammate).
 *
 * Mission handling:
 *  - go_to / deliver_at goals: utility = mission bonus minus travel cost
 *    (inherited from StrategyBase, re-weighted here) — bonuses dominate
 *    parcel income, so missions win whenever they are feasible;
 *  - forbidden tiles / forbidden deliveries: already enforced by the
 *    graph (BeliefBase.setMission blocks them), nothing to do here;
 *  - deliver_exactly_n: wait until enough parcels are carried, then deliver
 *    (selective putdown is done by the DeliverCarried plan);
 *  - deliver_less_value_than: deliver only when at least one carried
 *    parcel can satisfy the value cap;
 *  - red light: enforced by the ActionExecutor movement gate.
 *
 *  - one_pickup_another_deliver: the picker, once carrying, hands the
 *    parcel over at the rendezvous (handover_deposit) instead of self-
 *    delivering; the deliverer fetches the drop (handover_collect) and
 *    delivers it via the normal deliver_carried path — a different agent
 *    does the final delivery, so the team earns the bonus.
 */
export class MissionAwareStrategy extends RewardDistanceStrategy {
  static id = 'mission-aware';

  constructor(options = {}) {
    super(options);
    // Multiplier on mission bonus when ranking mission goals against
    // regular farming (>1 = even more mission-eager).
    this.missionWeight = options.missionWeight ?? 1;
  }

  utility(option, beliefs, helpers) {
    switch (option.type) {
      case 'go_to_mission_target': {
        const mission = option.mission;
        const target = mission.targets?.[0];
        // Go-to-and-wait (26c2_10): the target centre may be a wall, so
        // rank by the nearest reachable tile WITHIN the neighbourhood
        // radius, not the (possibly unwalkable) exact target.
        if (target && (mission.tolerance ?? 0) > 0 && mission.holdAtTarget) {
          let dist = Infinity;
          for (const tile of beliefs.graph?.tiles.values() ?? []) {
            if (!tile.walkable) continue;
            if (Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) > mission.tolerance) continue;
            const d = helpers.distanceTo(tile.x, tile.y);
            if (d < dist) dist = d;
          }
          if (!Number.isFinite(dist)) return -Infinity;
          return ((mission.bonus ?? 500) - dist * (helpers.decayPerTile || 0.1)) * this.missionWeight;
        }
        const base = super.utility(option, beliefs, helpers); // StrategyBase case
        if (!Number.isFinite(base)) return base;
        return base * this.missionWeight;
      }
      case 'handover_deposit': {
        // Picker carrying a parcel to the rendezvous: dominate farming so
        // it hands the parcel over instead of self-delivering. Worth the
        // team bonus minus the trip to the rendezvous.
        const r = option.rendezvous ?? beliefs.mission.handover?.rendezvous;
        if (!r) return -Infinity;
        const d = helpers.distanceTo(r.x, r.y);
        if (!Number.isFinite(d)) return -Infinity;
        return MissionAwareStrategy.HANDOVER_BOOST - d * (helpers.decayPerTile || 0.1);
      }
      case 'handover_collect': {
        // Deliverer fetching the drop: dominate farming so the handed-over
        // parcel is collected promptly (then delivered for the team bonus).
        const d = helpers.distanceTo(option.x, option.y);
        if (!Number.isFinite(d)) return -Infinity;
        return MissionAwareStrategy.HANDOVER_BOOST - d * (helpers.decayPerTile || 0.1);
      }
      case 'deliver_carried': {
        // In an active handover the picker must NOT self-deliver (no bonus
        // when one agent both picks and delivers): force the deposit path.
        const handover = beliefs.mission.handover;
        if (handover?.active && handover.role === 'picker') return -Infinity;

        const base = super.utility(option, beliefs, helpers);
        if (!Number.isFinite(base)) return base;
        const carried = beliefs.carried();
        const { deliverExactly, deliverMaxValue } = beliefs.mission;

        // An exact-N mission penalizes premature deliveries: wait until
        // the compliant batch size is available.
        if (deliverExactly != null && carried.length < deliverExactly) {
          return -Infinity;
        }
        if (deliverExactly != null) {
          return base + MissionAwareStrategy.COMPLIANT_DELIVERY_BOOST;
        }
        if (deliverMaxValue != null && carried.length > 0) {
          const cheapest = Math.min(
            ...carried.map((p) => Math.max(beliefs.projectedReward(p), 0)),
          );
          if (cheapest > deliverMaxValue) return -Infinity;
          return base + MissionAwareStrategy.COMPLIANT_DELIVERY_BOOST;
        }
        return base;
      }
      default:
        return super.utility(option, beliefs, helpers);
    }
  }

  static COMPLIANT_DELIVERY_BOOST = 200;

  // Utility floor for bringing a parcel to the handover rendezvous: high
  // enough to dominate ordinary farming (parcels are worth <= ~50) so the
  // picker commits to the handover once it is carrying.
  static HANDOVER_BOOST = 500;
}
