/**
 * Manhattan distance between two points.
 * Coordinates are rounded because agents in motion report fractional
 * positions (the server moves them 0.6 of a tile immediately).
 *
 * Note: this is a lower bound of the real path distance. For decisions
 * that depend on actual reachability use PathPlanner (BFS on the digraph).
 */
export function manhattan(a, b) {
  const dx = Math.abs(Math.round(a.x) - Math.round(b.x));
  const dy = Math.abs(Math.round(a.y) - Math.round(b.y));
  return dx + dy;
}
