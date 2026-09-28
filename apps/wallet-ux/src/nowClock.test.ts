import { afterEach, describe, expect, it, vi } from "vitest"
import { PAYEE_NOW_INTERVAL_MS, startNowTicker } from "./nowClock"

describe("payee now ticker", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("moves the clock forward on the interval and stops after cleanup", () => {
    vi.useFakeTimers()
    let clock = 1_700_000_000_000
    const ticks: bigint[] = []
    const stop = startNowTicker((value) => ticks.push(value), PAYEE_NOW_INTERVAL_MS, () => clock)
    expect(PAYEE_NOW_INTERVAL_MS).toBe(30_000)
    expect(ticks).toEqual([])
    clock += 30_000
    vi.advanceTimersByTime(30_000)
    expect(ticks).toEqual([1_700_000_030n])
    clock += 60_000
    vi.advanceTimersByTime(30_000)
    expect(ticks).toEqual([1_700_000_030n, 1_700_000_090n])
    stop()
    clock += 120_000
    vi.advanceTimersByTime(120_000)
    expect(ticks).toHaveLength(2)
  })
})
