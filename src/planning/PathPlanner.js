import { keyOf } from '../utils/serialization.js';

/**
 * Deterministic low-level navigation on the GridGraph.
 *
 * BFS is sufficient (unit edge costs); the graph is directed, so all
 * searches automatically respect one-way arrow tiles. The planner reads
 * the graph from the BeliefBase each call: it stays valid after mission
 * constraints block tiles or after soft blocks appear.
 */
export class PathPlanner {
  /** @param {import('../core/BeliefBase.js').BeliefBase} beliefs */
  constructor(beliefs) {
    this.beliefs = beliefs;
  }

  get #graph() {
    return this.beliefs.graph;
  }

  /**
   * Shortest path from `from` to `to` (rounded coordinates).
   * @returns {{directions: string[], tiles: {x:number,y:number}[]} | null}
   *          null when unreachable.
   */
  shortestPath(from, to, { respectSoftBlocks = true } = {}) {
    const graph = this.#graph;
    if (!graph) return null;
    const startKey = keyOf(from.x, from.y);
    const goalKey = keyOf(to.x, to.y);
    if (startKey === goalKey) return { directions: [], tiles: [] };
    if (!graph.tiles.get(goalKey)?.walkable) return null;

    // BFS storing the incoming edge of each visited tile.
    const cameFrom = new Map([[startKey, null]]);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const { x, y } = graph.tiles.get(key);
      for (const edge of graph.neighbors(x, y, respectSoftBlocks)) {
        if (cameFrom.has(edge.key)) continue;
        cameFrom.set(edge.key, { from: key, direction: edge.direction, x: edge.x, y: edge.y });
        if (edge.key === goalKey) return this.#reconstruct(cameFrom, goalKey);
        queue.push(edge.key);
      }
    }
    return null;
  }

  #reconstruct(cameFrom, goalKey) {
    const directions = [];
    const tiles = [];
    let entry = cameFrom.get(goalKey);
    while (entry) {
      directions.unshift(entry.direction);
      tiles.unshift({ x: entry.x, y: entry.y });
      entry = cameFrom.get(entry.from);
    }
    return { directions, tiles };
  }

  /**
   * Single-source BFS: path distance from `from` to every reachable tile.
   * Used once per deliberation to score all options in O(V+E).
   * @returns {Map<string, number>} tile key -> distance
   */
  distancesFrom(from, { respectSoftBlocks = false } = {}) {
    const graph = this.#graph;
    const distances = new Map();
    if (!graph) return distances;
    const startKey = keyOf(from.x, from.y);
    if (!graph.tiles.has(startKey)) return distances;
    distances.set(startKey, 0);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const dist = distances.get(key);
      const { x, y } = graph.tiles.get(key);
      for (const edge of graph.neighbors(x, y, respectSoftBlocks)) {
        if (!distances.has(edge.key)) {
          distances.set(edge.key, dist + 1);
          queue.push(edge.key);
        }
      }
    }
    return distances;
  }

  /**
   * Nearest allowed delivery tile reachable from `from`, with its path.
   * @returns {{tile: {x:number,y:number}, path: {directions:string[]}} | null}
   */
  nearestDelivery(from) {
    const graph = this.#graph;
    if (!graph) return null;
    // BFS until the first delivery tile is dequeued — that is the nearest.
    const startKey = keyOf(from.x, from.y);
    const start = graph.tiles.get(startKey);
    if (!start) return null;
    if (start.delivery && graph.deliveryTiles.some((t) => keyOf(t.x, t.y) === startKey)) {
      return { tile: { x: start.x, y: start.y }, path: { directions: [], tiles: [] } };
    }
    const allowed = new Set(graph.deliveryTiles.map((t) => keyOf(t.x, t.y)));
    const cameFrom = new Map([[startKey, null]]);
    const queue = [startKey];
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const { x, y } = graph.tiles.get(key);
      for (const edge of graph.neighbors(x, y)) {
        if (cameFrom.has(edge.key)) continue;
        cameFrom.set(edge.key, { from: key, direction: edge.direction, x: edge.x, y: edge.y });
        if (allowed.has(edge.key)) {
          return { tile: { x: edge.x, y: edge.y }, path: this.#reconstruct(cameFrom, edge.key) };
        }
        queue.push(edge.key);
      }
    }
    return null;
  }

  /**
   * Per-deliberation scoring helpers handed to strategies:
   *  - distanceTo(x,y): exact path distance from my position (Infinity if
   *    unreachable), from a single cached BFS;
   *  - deliveryDistanceFrom(x,y): exact distance to the nearest allowed
   *    delivery tile (precomputed on the graph);
   *  - decayPerTile: reward lost per move per carried parcel
   *    (movement_duration / decaying interval; 0 when decay is off).
   */
  scoringHelpers() {
    const beliefs = this.beliefs;
    const distances = this.distancesFrom(beliefs.me);
    return {
      distanceTo: (x, y) => distances.get(keyOf(x, y)) ?? Infinity,
      deliveryDistanceFrom: (x, y) => beliefs.graph?.deliveryDistance(x, y) ?? Infinity,
      decayPerTile: beliefs.decayPerTile(),
    };
  }
}
