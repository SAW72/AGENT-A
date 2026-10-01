/** How often the payee expiry prompt re-reads the clock. */
export const PAYEE_NOW_INTERVAL_MS = 30_000

export function nowSecondsFrom(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000))
}

/** Seconds since the epoch, from the same clock the payee prompt uses. */
export function currentNowSeconds(now: () => number = Date.now): bigint {
  return nowSecondsFrom(now())
}

/** Calls `onTick` on an interval. The returned function clears that timer. */
export function startNowTicker(
  onTick: (nowSeconds: bigint) => void,
  intervalMs = PAYEE_NOW_INTERVAL_MS,
  now: () => number = Date.now,
): () => void {
  const timer = setInterval(() => {
    onTick(nowSecondsFrom(now()))
  }, intervalMs)
  return () => clearInterval(timer)
}
