/**
 * Small helpers shared by belief storage, the grid graph, logging
 * and the message protocol.
 */

/** Canonical string key for a tile coordinate (rounded). */
export function keyOf(x, y) {
  return `${Math.round(x)},${Math.round(y)}`;
}

/** Inverse of keyOf. */
export function parseKey(key) {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * Convert a Deliveroo clock-event string ('frame'|'1s'|'2s'|'5s'|'10s'|
 * '1m'|'1h'|'infinite') to milliseconds. 'frame' depends on the server
 * CLOCK (default 50 ms). 'infinite' means the event never fires.
 */
export function clockEventToMs(event, clockMs = 50) {
  const table = {
    frame: clockMs,
    '1s': 1000,
    '2s': 2000,
    '5s': 5000,
    '10s': 10000,
    '1m': 60000,
    '1h': 3600000,
    infinite: Infinity,
  };
  return table[event] ?? Infinity;
}

/**
 * Normalize a pickup/putdown ack into an array of parcel id strings.
 * Server versions differ: elements may be {id} objects, plain id strings,
 * or full parcel objects — never trust one shape (observed live).
 */
export function normalizeIdList(ackArray) {
  if (!Array.isArray(ackArray)) return [];
  return ackArray
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') return entry.id ?? entry.parcelId ?? null;
      return null;
    })
    .filter((id) => id != null && id !== '');
}

/** JSON.stringify that never throws (used by the run logger). */
export function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

/** Extract the first {...} JSON object embedded in free text (LLM output). */
export function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
