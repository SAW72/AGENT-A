import { describe, expect, it } from "vitest"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import {
  assertSepoliaOnly,
  BASE_MAINNET_CHAIN_ID,
  ETHEREUM_MAINNET_CHAIN_ID,
  evaluateReadGuard,
  resolveWalletChainId,
} from "./guard"

describe("evaluateReadGuard", () => {
  it("allows a verified Sepolia RPC with no wallet", () => {
    expect(
      evaluateReadGuard({
        rpcChainId: BASE_SEPOLIA_CHAIN_ID,
        walletConnected: false,
        walletChainId: null,
      }),
    ).toEqual({ ok: true, code: "ok" })
  })

  it("ignores a stale wallet chain id while disconnected", () => {
    expect(
      evaluateReadGuard({
        rpcChainId: BASE_SEPOLIA_CHAIN_ID,
        walletConnected: false,
        walletChainId: ETHEREUM_MAINNET_CHAIN_ID,
      }).ok,
    ).toBe(true)
  })

  it("refuses Ethereum mainnet and Base mainnet RPCs", () => {
    expect(evaluateReadGuard({ rpcChainId: 1, walletConnected: false, walletChainId: null }).code).toBe("rpc-mainnet")
    expect(evaluateReadGuard({ rpcChainId: 8453, walletConnected: false, walletChainId: null }).code).toBe(
      "rpc-base-mainnet",
    )
  })

  it("refuses other RPC chain ids", () => {
    const guard = evaluateReadGuard({ rpcChainId: 11155111, walletConnected: false, walletChainId: null })
    expect(guard.ok).toBe(false)
    if (!guard.ok) expect(guard.reason).toContain("11155111")
  })

  it("refuses a connected wallet on any chain other than Base Sepolia", () => {
    for (const walletChainId of [1, 8453, 10, null, "conflict" as const]) {
      const guard = evaluateReadGuard({
        rpcChainId: BASE_SEPOLIA_CHAIN_ID,
        walletConnected: true,
        walletChainId,
      })
      expect(guard.ok).toBe(false)
    }
  })

  it("allows a wallet that is on Base Sepolia", () => {
    expect(
      evaluateReadGuard({
        rpcChainId: BASE_SEPOLIA_CHAIN_ID,
        walletConnected: true,
        walletChainId: BASE_SEPOLIA_CHAIN_ID,
      }).ok,
    ).toBe(true)
  })

  it("waits while the RPC chain id is unknown", () => {
    expect(evaluateReadGuard({ rpcChainId: null, walletConnected: false, walletChainId: null }).code).toBe(
      "rpc-pending",
    )
  })
})

describe("resolveWalletChainId", () => {
  it("treats disagreeing sources as a conflict", () => {
    expect(resolveWalletChainId(84532, 1)).toBe("conflict")
  })

  it("uses the connector chain when wagmi has not resolved one", () => {
    expect(resolveWalletChainId(undefined, 1)).toBe(1)
  })
})

describe("assertSepoliaOnly", () => {
  it("accepts Base Sepolia and rejects mainnet configs", () => {
    expect(() => assertSepoliaOnly([BASE_SEPOLIA_CHAIN_ID])).not.toThrow()
    expect(() => assertSepoliaOnly([ETHEREUM_MAINNET_CHAIN_ID])).toThrow(/Mainnet/)
    expect(() => assertSepoliaOnly([BASE_MAINNET_CHAIN_ID])).toThrow(/Mainnet/)
    expect(() => assertSepoliaOnly([BASE_SEPOLIA_CHAIN_ID, 11155111])).toThrow(/Base Sepolia/)
  })
})
