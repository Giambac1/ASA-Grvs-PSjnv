/** Await a pause of `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Yield control back to the event loop (used by busy loops). */
export function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}
