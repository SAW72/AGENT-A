/**
 * In-memory window limiter for the read API. A cold start on Render wipes it.
 * That is acceptable for Base Sepolia reads. It is not an auth control.
 */
export function createRateLimiter({ windowMs = 60_000, max = 60, clock = Date.now } = {}) {
  const hits = new Map();
  return function allow(key) {
    const now = clock();
    const id = String(key || "unknown");
    const prev = hits.get(id) || [];
    const fresh = prev.filter((ts) => now - ts < windowMs);
    if (fresh.length >= max) {
      hits.set(id, fresh);
      return false;
    }
    fresh.push(now);
    hits.set(id, fresh);
    if (hits.size > 10_000) {
      const oldest = hits.keys().next().value;
      hits.delete(oldest);
    }
    return true;
  };
}
