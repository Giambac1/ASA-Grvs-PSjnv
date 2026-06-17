import { keyOf, parseKey } from '../utils/serialization.js';

/**
 * Directed graph of the static map, built once from the `map` event.
 *
 * Directions follow the server convention: 'up' increases y.
 * Directional arrow tiles make the map a digraph: a tile of type '↑'
 * cannot be ENTERED while moving 'down' (i.e. against the arrow); all
 * other entries and every exit are allowed (verified in game_knowledge/01).
 *
 * The graph also tracks two kinds of dynamic blocking:
 *  - static blocks: mission constraints ("never go through (x,y)"),
 *    applied permanently via blockTiles();
 *  - soft blocks: tiles where moves recently failed (probably another
 *    agent), which expire after a TTL so paths route around them briefly.
 */

export const DIRECTIONS = {
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  right: { dx: 1, dy: 0 },
  left: { dx: -1, dy: 0 },
};

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const ARROW_TO_DIRECTION = { '↑': 'up', '↓': 'down', '→': 'right', '←': 'left' };

export class GridGraph {
  /** @type {Map<string, {x:number, y:number, type:string, walkable:boolean, delivery:boolean, spawner:boolean}>} */
  tiles = new Map();

  /** key -> [{key, x, y, direction}] outgoing edges */
  #adjacency = new Map();

  /** Mission-imposed permanently blocked tiles. */
  #blocked = new Set();

  /** key -> expiry timestamp (ms). */
  #softBlocked = new Map();

  /** Delivery tiles excluded by mission constraints ("never deliver in ..."). */
  #forbiddenDeliveries = new Set();

  /** key -> exact path distance to the nearest allowed delivery tile. */
  #deliveryDistance = new Map();

  width = 0;
  height = 0;

  /**
   * @param {number} width
   * @param {number} height
   * @param {{x:number, y:number, type:string}[]} tileList flat list from the `map` event
   */
  constructor(width, height, tileList) {
    this.width = width;
    this.height = height;
    for (const t of tileList) {
      const type = String(t.type);
      this.tiles.set(keyOf(t.x, t.y), {
        x: t.x,
        y: t.y,
        type,
        walkable: type !== '0',
        delivery: type === '2',
        spawner: type === '1',
      });
    }
    this.#buildAdjacency();
    this.#computeDeliveryDistances();
  }

  /** Rebuild outgoing edges for every walkable tile, honoring arrows. */
  #buildAdjacency() {
    this.#adjacency.clear();
    for (const [key, tile] of this.tiles) {
      if (!tile.walkable) continue;
      const edges = [];
      for (const [direction, { dx, dy }] of Object.entries(DIRECTIONS)) {
        const nKey = keyOf(tile.x + dx, tile.y + dy);
        const neighbor = this.tiles.get(nKey);
        if (!neighbor || !neighbor.walkable) continue;
        // Directional entry rule: cannot enter an arrow tile moving
        // against its arrow.
        const arrow = ARROW_TO_DIRECTION[neighbor.type];
        if (arrow && direction === OPPOSITE[arrow]) continue;
        edges.push({ key: nKey, x: neighbor.x, y: neighbor.y, direction });
      }
      this.#adjacency.set(key, edges);
    }
  }

  /** Replace one tile (server `tile` event) and refresh derived data. */
  updateTile({ x, y, type }) {
    const t = String(type);
    this.tiles.set(keyOf(x, y), {
      x, y,
      type: t,
      walkable: t !== '0',
      delivery: t === '2',
      spawner: t === '1',
    });
    this.#buildAdjacency();
    this.#computeDeliveryDistances();
  }

  /** Walkability of the *static* map (ignores soft blocks). */
  isWalkable(x, y) {
    const tile = this.tiles.get(keyOf(x, y));
    return !!tile && tile.walkable && !this.#blocked.has(keyOf(x, y));
  }

  /** True when a tile must be avoided right now (static or soft block). */
  isBlocked(key) {
    if (this.#blocked.has(key)) return true;
    const expiry = this.#softBlocked.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.#softBlocked.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Outgoing edges of a tile. With `respectSoftBlocks` (default) edges
   * into temporarily blocked tiles are filtered out — use it for live
   * pathfinding; scoring helpers use the static graph instead.
   */
  neighbors(x, y, respectSoftBlocks = true) {
    const edges = this.#adjacency.get(keyOf(x, y)) ?? [];
    return edges.filter((e) => {
      if (this.#blocked.has(e.key)) return false;
      if (respectSoftBlocks && this.isBlocked(e.key)) return false;
      return true;
    });
  }

  /** Permanently block tiles (mission constraint) and refresh distances. */
  blockTiles(coords) {
    for (const { x, y } of coords) this.#blocked.add(keyOf(x, y));
    this.#computeDeliveryDistances();
  }

  /** Temporarily avoid a tile (e.g. occupied by another agent). */
  softBlock(x, y, ttlMs) {
    this.#softBlocked.set(keyOf(x, y), Date.now() + ttlMs);
  }

  /** Exclude delivery tiles from being used as delivery targets. */
  setForbiddenDeliveries(coords) {
    for (const { x, y } of coords) this.#forbiddenDeliveries.add(keyOf(x, y));
    this.#computeDeliveryDistances();
  }

  /** Delivery tiles currently allowed as targets. */
  get deliveryTiles() {
    const result = [];
    for (const [key, tile] of this.tiles) {
      if (tile.delivery && !this.#forbiddenDeliveries.has(key) && !this.#blocked.has(key)) {
        result.push(tile);
      }
    }
    return result;
  }

  /** Parcel spawner tiles (static). */
  get spawnerTiles() {
    return [...this.tiles.values()].filter((t) => t.spawner);
  }

  /**
   * Deterministic handover rendezvous: a walkable, non-delivery,
   * non-blocked tile one step from a delivery tile (min delivery
   * distance), tie-broken toward the map center then by key — so both
   * agents, computing from the same static map, agree on the same tile
   * without any negotiation. The deliverer reaches a delivery tile in one
   * move from here, minimizing carried-decay after the handover.
   * @returns {{x:number, y:number}|null} the rendezvous, or null if none
   */
  rendezvousTile() {
    const cx = (this.width - 1) / 2;
    const cy = (this.height - 1) / 2;
    let best = null;
    let bestDd = Infinity;
    let bestCenter = Infinity;
    let bestKey = null;
    for (const tile of this.tiles.values()) {
      if (!tile.walkable || tile.delivery) continue;
      const key = keyOf(tile.x, tile.y);
      if (this.#blocked.has(key)) continue;
      const dd = this.deliveryDistance(tile.x, tile.y);
      if (!Number.isFinite(dd) || dd === 0) continue; // unreachable to / on a delivery
      const center = Math.abs(tile.x - cx) + Math.abs(tile.y - cy);
      if (
        dd < bestDd ||
        (dd === bestDd && center < bestCenter) ||
        (dd === bestDd && center === bestCenter && (bestKey === null || key < bestKey))
      ) {
        best = { x: tile.x, y: tile.y };
        bestDd = dd;
        bestCenter = center;
        bestKey = key;
      }
    }
    return best;
  }

  /**
   * Exact path distance from (x,y) to the nearest allowed delivery tile,
   * or Infinity when unreachable. O(1) lookup, precomputed by a
   * multi-source BFS on REVERSED edges (correct on the digraph).
   */
  deliveryDistance(x, y) {
    return this.#deliveryDistance.get(keyOf(x, y)) ?? Infinity;
  }

  /**
   * Multi-source BFS from every allowed delivery tile over reversed
   * edges. Reversal matters: with one-way arrows, the distance "to" a
   * delivery differs from the distance "from" it.
   */
  #computeDeliveryDistances() {
    // Build the reverse adjacency once per recompute (maps are small).
    const reverse = new Map();
    for (const [fromKey, edges] of this.#adjacency) {
      if (this.#blocked.has(fromKey)) continue;
      for (const e of edges) {
        if (this.#blocked.has(e.key)) continue;
        if (!reverse.has(e.key)) reverse.set(e.key, []);
        reverse.get(e.key).push(fromKey);
      }
    }

    this.#deliveryDistance.clear();
    const queue = [];
    for (const tile of this.deliveryTiles) {
      const key = keyOf(tile.x, tile.y);
      this.#deliveryDistance.set(key, 0);
      queue.push(key);
    }
    let head = 0;
    while (head < queue.length) {
      const key = queue[head++];
      const dist = this.#deliveryDistance.get(key);
      for (const fromKey of reverse.get(key) ?? []) {
        if (!this.#deliveryDistance.has(fromKey)) {
          this.#deliveryDistance.set(fromKey, dist + 1);
          queue.push(fromKey);
        }
      }
    }
  }

  /** Convenience: tile object at coordinates, if any. */
  tileAt(x, y) {
    return this.tiles.get(keyOf(x, y)) ?? null;
  }

  /** Expose key parsing for consumers iterating internal maps. */
  static parseKey = parseKey;
}
