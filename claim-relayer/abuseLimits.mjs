/**
 * Abuse limits that sit on top of signature auth.
 * In-memory, one process. A restart clears the windows.
 * These limits are not authentication.
 */

import { httpError } from "./config.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function keyAddress(value) {
  return String(value || "").toLowerCase();
}

/**
 * @param {object} limits
 * @param {number} limits.senderLimit
 * @param {number} limits.ipLimit
 * @param {number} limits.windowMs
 * @param {number} limits.escrowCap
 * @param {number} limits.escrowWindowMs
 * @param {bigint} limits.dailyGasBudgetWei
 * @param {() => number} [opts.now]
 */
export function createAbuseGuard(limits, opts = {}) {
  const now = opts.now || Date.now;
  /** @type {{ atMs: number, sender: string, ip: string, escrowId: string, gasWei: bigint }[]} */
  const events = [];
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
    const keepAfter = atMs - Math.max(limits.windowMs, limits.escrowWindowMs, DAY_MS);
    while (events.length > 0 && events[0].atMs <= keepAfter) events.shift();
  }

  function assertWithin(input, atMs) {
    const sender = keyAddress(input.sender);
    const ip = String(input.ip || "unknown");
    const escrowId = keyAddress(input.escrowId);
    const gasWei = BigInt(input.gasWei ?? 0);
    const budget = BigInt(limits.dailyGasBudgetWei);
    let senderCount = 0;
    let ipCount = 0;
    let escrowCount = 0;
    let gas = 0n;
    for (const event of events) {
      if (atMs - event.atMs < limits.windowMs) {
        if (event.sender === sender) senderCount += 1;
        if (event.ip === ip) ipCount += 1;
      }
      if (atMs - event.atMs < limits.escrowWindowMs && event.escrowId === escrowId) escrowCount += 1;
      if (atMs - event.atMs < DAY_MS) gas += event.gasWei;
    }
    if (senderCount >= limits.senderLimit || ipCount >= limits.ipLimit) {
      throw httpError(429, "rate_limited");
    }
    if (escrowCount >= limits.escrowCap) throw httpError(429, "escrow_cap");
    if (gas + gasWei > budget) throw httpError(429, "gas_budget_exhausted");
  }

  return {
    /**
     * Reject when this claim would pass a limit. Does not record it.
     * @param {{ sender: string, ip: string, escrowId: string, gasWei?: bigint, atMs?: number }} input
     */
    check(input) {
      return withLock(async () => {
        const atMs = input.atMs ?? now();
        prune(atMs);
        assertWithin(input, atMs);
      });
    },

    /**
     * Record a claim that is about to be simulated or broadcast.
     * @param {{ sender: string, ip: string, escrowId: string, gasWei: bigint, atMs?: number }} input
     */
    consume(input) {
      return withLock(async () => {
        const atMs = input.atMs ?? now();
        prune(atMs);
        assertWithin(input, atMs);
        events.push({
          atMs,
          sender: keyAddress(input.sender),
          ip: String(input.ip || "unknown"),
          escrowId: keyAddress(input.escrowId),
          gasWei: BigInt(input.gasWei ?? 0),
        });
      });
    },
  };
}
