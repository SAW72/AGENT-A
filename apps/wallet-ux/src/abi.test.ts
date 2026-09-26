import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import escrowAbi from "./abi/BotAttestationEscrow.json"
import denylistAbi from "./abi/Denylist.json"
import disputePanelAbi from "./abi/DisputePanel.json"
import insuranceFundAbi from "./abi/InsuranceFund.json"
import liabilityAbi from "./abi/Liability.json"
import vaultHookAbi from "./abi/IVault.json"
import vaultAbi from "./abi/Vault.json"

type AbiItem = { type?: string; name?: string; stateMutability?: string }

function names(abi: AbiItem[], type = "function"): Set<string> {
  return new Set(abi.filter((item) => item.type === type).map((item) => item.name ?? ""))
}

describe("forge ABIs", () => {
  it("includes the Gate A read surface", () => {
    for (const name of ["owner", "pendingOwner", "denylistedHashes", "denylistedSignatures", "denylistedPrompts", "check"]) {
      expect(names(denylistAbi).has(name)).toBe(true)
    }
    for (const name of ["owner", "pendingOwner", "denylist"]) {
      expect(names(vaultAbi).has(name)).toBe(true)
      expect(names(vaultHookAbi).has(name)).toBe(true)
    }
    for (const name of ["owner", "arbitratorCount", "PANEL_SIZE"]) {
      expect(names(disputePanelAbi).has(name)).toBe(true)
    }
    for (const name of ["owner", "pendingOwner", "governance", "disputePanel", "lockedValue", "escrows", "createEscrow", "release", "refund", "dispute"]) {
      expect(names(escrowAbi).has(name)).toBe(true)
    }
    for (const name of [
      "DisputeAlreadyResolved",
      "DisputeVotesCast",
      "DisputePredatesEscrow",
      "DisputeChallengerNotParty",
      "DisputeAfterExpiry",
    ]) {
      expect(names(escrowAbi, "error").has(name)).toBe(true)
    }
    for (const name of ["owner", "insurance"]) expect(names(liabilityAbi).has(name)).toBe(true)
    for (const name of ["owner", "liability", "balance"]) expect(names(insuranceFundAbi).has(name)).toBe(true)
  })
})

const FORBIDDEN = [
  "useWriteContract",
  "useSignTypedData",
  "writeContract(",
  "signTypedData(",
  "wallet_sendTransaction",
]

const SEND_ONLY = ["useSendTransaction", "sendTransactionAsync"]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith(".test.ts")) continue
    if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path)
  }
  return out
}

describe("wallet writes", () => {
  it("limits sends to the Base Sepolia escrow submit and keeps typed-data signing out", () => {
    const src = dirname(fileURLToPath(import.meta.url))
    const hits: string[] = []
    const sendHits: string[] = []
    for (const path of sourceFiles(src)) {
      const text = readFileSync(path, "utf8")
      for (const token of FORBIDDEN) {
        if (text.includes(token)) hits.push(`${path} contains ${token}`)
      }
      for (const token of SEND_ONLY) {
        if (text.includes(token)) sendHits.push(`${path} contains ${token}`)
      }
    }
    expect(hits).toEqual([])
    expect(sendHits.every((hit) => hit.includes("FlowPreview.tsx"))).toBe(true)
    expect(sendHits.length).toBeGreaterThan(0)
  })
})
