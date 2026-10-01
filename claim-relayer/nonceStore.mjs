/**
 * In-memory relayer account-nonce reservation.
 *
 * One hot wallet, one process. reserve() is serialized so concurrent quotes
 * cannot take the same nonce. A repeated claimId refreshes the same hold
 * until it expires or is consumed.
 *
 * Restart drops the map and the counter returns to initialNonce. Two
 * processes are not coordinated. Run a single web instance (Render: do not
 * scale horizontally). A later build may seed the counter from a pending
 * nonce read. This stub does not call RPC and does not invent a balance.
 */

export function createNonceStore(opts = {}) {
  const now = opts.now || Date.now;
  let next = BigInt(opts.initialNonce ?? 0);

  /** @type {Map<string, { expiresAtMs: number, consumed: boolean, claimId: string }>} */
  const byNonce = new Map();
  /** @type {Map<string, string>} */
  const byClaim = new Map();
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function prune(atMs) {
    for (const [key, rec] of byNonce) {
      if (!rec.consumed && rec.expiresAtMs <= atMs) {
        byNonce.delete(key);
        if (byClaim.get(rec.claimId) === key) byClaim.delete(rec.claimId);
      }
    }
  }

  /**
   * @param {{ claimId: string, ttlMs?: number, atMs?: number }} reserveOpts
   * @returns {Promise<{ nonce: bigint, expiresAtMs: number, claimId: string }>}
   */
  function reserve(reserveOpts = {}) {
    const claimId = String(reserveOpts.claimId || "");
    const ttlMs = Number(reserveOpts.ttlMs ?? 30 * 60 * 1000);
    return withLock(async () => {
      if (!claimId) {
        throw Object.assign(new Error("claim_id_required"), {
          status: 400,
          error: "claim_id_required",
        });
      }
      const atMs = reserveOpts.atMs ?? now();
      prune(atMs);
      const existingKey = byClaim.get(claimId);
      if (existingKey) {
        const rec = byNonce.get(existingKey);
        if (rec && !rec.consumed && rec.expiresAtMs > atMs) {
          rec.expiresAtMs = atMs + ttlMs;
          return { nonce: BigInt(existingKey), expiresAtMs: rec.expiresAtMs, claimId };
        }
      }
      const nonce = next;
      next += 1n;
      const key = nonce.toString();
      const expiresAtMs = atMs + ttlMs;
      byNonce.set(key, { expiresAtMs, consumed: false, claimId });
      byClaim.set(claimId, key);
      return { nonce, expiresAtMs, claimId };
    });
  }

  function markConsumed(nonce) {
    const key = BigInt(nonce).toString();
    const rec = byNonce.get(key);
    if (!rec) return false;
    rec.consumed = true;
    rec.expiresAtMs = Number.POSITIVE_INFINITY;
    return true;
  }

  function release(nonce) {
    const key = BigInt(nonce).toString();
    const rec = byNonce.get(key);
    if (!rec || rec.consumed) return false;
    byNonce.delete(key);
    if (byClaim.get(rec.claimId) === key) byClaim.delete(rec.claimId);
    return true;
  }

  function peek(nonce) {
    prune(now());
    return byNonce.get(BigInt(nonce).toString()) || null;
  }

  return { reserve, markConsumed, release, peek };
}
