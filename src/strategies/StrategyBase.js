/**
 * Strategy interface.
 *
 * A strategy decides WHAT to pursue: it ranks the options produced by the
 * OptionGenerator and returns the best one. It never executes actions —
 * infrastructure (intention revision, plans, executor) does that.
 *
 * To add a new strategy:
 *   1. create src/strategies/MyStrategy.js extending StrategyBase;
 *   2. override `utility(option, beliefs, helpers)` (or `selectOption`
 *      for non-utility logic);
 *   3. register it in src/strategies/index.js with an id;
 *   4. select it with STRATEGY=<id> or --strategy <id>.
 *
 * `helpers` (built per deliberation by PathPlanner.scoringHelpers):
 *   - distanceTo(x, y)          exact path distance from me (Infinity = unreachable)
 *   - deliveryDistanceFrom(x,y) exact distance to nearest allowed delivery
 *   - decayPerTile              reward lost per move per carried parcel
 */
export class StrategyBase {
  /** Identifier used in config / experiment logs. */
  static id = 'base';

  constructor(options = {}) {
    this.options = options;
  }

  get name() {
    return this.constructor.id;
  }

  /**
   * Default selection: argmax of `utility`. Options with -Infinity
   * utility are unselectable. Utilities are written back onto the
   * options because intention revision compares them (hysteresis).
   */
  selectOption(options, beliefs, helpers) {
    let best = null;
    let bestUtility = -Infinity;
    for (const option of options) {
      option.utility = this.utility(option, beliefs, helpers);
      if (option.utility > bestUtility) {
        best = option;
        bestUtility = option.utility;
      }
    }
    return best;
  }

  /**
   * Baseline utilities shared by all strategies; subclasses override the
   * cases they care about. Scale convention: roughly "expected reward
   * points", so utilities stay comparable across option types.
   */
  utility(option, beliefs, helpers) {
    switch (option.type) {
      case 'go_to_mission_target': {
        // Mission bonuses (±200..±1000) dominate parcel income, so by
        // default every strategy honors an active positional mission.
        const mission = option.mission;
        const target = mission.targets?.[0];
        const distance = target ? helpers.distanceTo(target.x, target.y) : Infinity;
        if (!Number.isFinite(distance)) return -Infinity;
        // deliver_at needs something to drop: pick a parcel up first.
        if (mission.kind === 'deliver_at' && beliefs.carried().length === 0) return -Infinity;
        return (mission.bonus ?? 500) - distance * (helpers.decayPerTile || 0.1);
      }
      case 'explore':
        return 1; // weakly preferred over doing nothing
      case 'wait':
        return 0; // last resort
      default:
        return -Infinity; // pickup/delivery must be valued by subclasses
    }
  }
}
