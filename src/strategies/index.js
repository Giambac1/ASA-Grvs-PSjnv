import { GreedyNearestStrategy } from './GreedyNearestStrategy.js';
import { RewardDistanceStrategy } from './RewardDistanceStrategy.js';
import { RewardDistanceTotalStrategy } from './RewardDistanceTotalStrategy.js';
import { DeliveryThresholdStrategy } from './DeliveryThresholdStrategy.js';
import { MissionAwareStrategy } from './MissionAwareStrategy.js';

/**
 * Strategy registry. To add a strategy: create the class file, import it
 * here, add it to the list. It becomes selectable via STRATEGY=<id> or
 * `--strategy <id>` without touching any other code.
 */
const STRATEGY_CLASSES = [
  GreedyNearestStrategy,
  RewardDistanceStrategy,
  RewardDistanceTotalStrategy,
  DeliveryThresholdStrategy,
  MissionAwareStrategy,
];

export const strategies = new Map(STRATEGY_CLASSES.map((S) => [S.id, S]));

/**
 * @param {string} id      registered strategy id
 * @param {object} [options] strategy-specific tuning options
 */
export function createStrategy(id, options = {}) {
  const StrategyClass = strategies.get(id);
  if (!StrategyClass) {
    const known = [...strategies.keys()].join(', ');
    throw new Error(`Unknown strategy "${id}". Available: ${known}`);
  }
  return new StrategyClass(options);
}
