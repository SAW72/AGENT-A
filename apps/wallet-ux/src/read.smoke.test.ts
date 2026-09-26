import { describe, expect, it } from "vitest"
import { ADDRESSES, CORE_TIMELOCK, ZERO_ADDRESS } from "./addresses"
import { sameAddress } from "./format"
import { gateAOwnershipNotes, liabilityLinkNotes } from "./gate"
import { createSepoliaClient, DEFAULT_RPC_URL, panelNotSeated, readGateStatus, readMembership } from "./read"

const live = process.env.SEPOLIA_SMOKE === "1"

describe.skipIf(!live)("Base Sepolia smoke", () => {
  it("reads Gate A from the public RPC", async () => {
    const client = createSepoliaClient(process.env.VITE_BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL)
    const status = await readGateStatus(client)
    expect(status.chainId).toBe(84532)
    expect(gateAOwnershipNotes(status)).toEqual([])
    expect(liabilityLinkNotes(status)).toEqual([])
    expect(sameAddress(status.denylist.owner, CORE_TIMELOCK)).toBe(true)
    expect(sameAddress(status.denylist.pendingOwner, ZERO_ADDRESS)).toBe(true)
    expect(sameAddress(status.vault.denylist, ADDRESSES.denylist)).toBe(true)
    expect(status.disputePanel.panelSize).toBe(3n)
    expect(status.disputePanel.arbitratorCount).toBe(3n)
    expect(panelNotSeated(status.disputePanel.arbitratorCount, status.disputePanel.panelSize)).toBe(false)
    expect(status.escrow).not.toBeNull()
    // The wiring snapshot records acceptOwnership as pending (owner is the deployer).
    // After acceptOwnership, owner is CORE_TIMELOCK. This check allows either read.
    const owner = status.escrow?.owner ?? ""
    const pending = status.escrow?.pendingOwner ?? ""
    const accepted =
      sameAddress(owner, CORE_TIMELOCK) && sameAddress(pending, ZERO_ADDRESS)
    const awaitingAccept =
      sameAddress(owner, "0x5D467FA00eC0E92044f779e495a17db66c5964aa") &&
      sameAddress(pending, CORE_TIMELOCK)
    expect(accepted || awaitingAccept).toBe(true)
    expect(sameAddress(status.escrow?.governance ?? "", CORE_TIMELOCK)).toBe(true)
    expect(sameAddress(status.escrow?.disputePanel ?? "", ADDRESSES.disputePanel)).toBe(true)
    expect(status.escrow?.fundingOpen).toBe(accepted)

    const empty = `0x${"00".repeat(32)}` as const
    const membership = await readMembership(client, empty)
    expect(membership).toEqual({ exact: false, signature: false, prompt: false })
  }, 30_000)
})
