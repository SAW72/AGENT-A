import { decodeFunctionData, parseEther } from "viem"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { disputePanelAbi, escrowAbi } from "./abi"
import {
  ERROR_GLOSSARY,
  MAX_DURATION_SECONDS,
  previewCreateEscrow,
  previewDispute,
  previewOpenDispute,
  previewRefund,
  previewRelease,
} from "./preview"

const escrow = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d" as const
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
const id = `0x${"ab".repeat(32)}` as const
const other = `0x${"cd".repeat(32)}` as const
const payee = "0x0000000000000000000000000000000000000002" as const

describe("calldata preview", () => {
  it("encodes createEscrow without sending value anywhere but the preview", () => {
    const preview = previewCreateEscrow({
      escrow,
      escrowId: id,
      payee,
      payerBotId: id,
      payeeBotId: other,
      durationSeconds: BigInt(MAX_DURATION_SECONDS),
      valueWei: parseEther("0.01"),
    })
    const decoded = decodeFunctionData({ abi: escrowAbi, data: preview.calldata })
    expect(preview.to).toBe(escrow)
    expect(preview.functionName).toBe("createEscrow")
    expect(preview.valueWei).toBe(parseEther("0.01"))
    expect(decoded.functionName).toBe("createEscrow")
    expect(decoded.args?.[0]).toBe(id)
  })

  it("encodes release, refund, dispute, and openDispute as zero-value calldata", () => {
    const release = previewRelease(escrow, id)
    const refund = previewRefund(escrow, id)
    const dispute = previewDispute(escrow, id, other)
    const opened = previewOpenDispute(panel, other, id, "preview only")
    expect(decodeFunctionData({ abi: escrowAbi, data: release.calldata }).functionName).toBe("release")
    expect(decodeFunctionData({ abi: escrowAbi, data: refund.calldata }).functionName).toBe("refund")
    expect(decodeFunctionData({ abi: escrowAbi, data: dispute.calldata }).functionName).toBe("dispute")
    expect(decodeFunctionData({ abi: disputePanelAbi, data: opened.calldata }).functionName).toBe("openDispute")
    expect(release.valueWei).toBe(0n)
    expect(opened.to).toBe(panel)
  })

  it("lists the escrow and panel revert strings", () => {
    const names = ERROR_GLOSSARY.map((entry) => entry.name)
    expect(names).toContain("FundingBeforeGovernance")
    expect(names).toContain("panel not seated")
    expect(names).toContain("AttestationFailed")
    expect(names).toContain("DisputeAlreadyResolved")
    expect(names).toContain("DisputeVotesCast")
    expect(names).toContain("DisputePredatesEscrow")
    expect(names).toContain("DisputeChallengerNotParty")
    expect(names).toContain("DisputeAfterExpiry")
  })
})

describe("Base Sepolia submit", () => {
  it("submits escrow calldata from the connected wallet on chain 84532", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(source).not.toContain("Held until Spencer go")
    expect(source).not.toContain("held-submit")
    expect(source).toContain("sendTransactionAsync")
    expect(source).toContain("chainId: BASE_SEPOLIA_CHAIN_ID")
    expect(source).toContain("evaluateEscrowSubmit")
    expect(source).toContain("assertSubmitTarget")
    expect(source).not.toContain("writeContract(")
    expect(source).not.toContain("wallet_sendTransaction")
  })
})
