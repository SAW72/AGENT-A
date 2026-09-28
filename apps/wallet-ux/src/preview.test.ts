import { decodeFunctionData, parseEther, toFunctionSelector } from "viem"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { disputePanelAbi, escrowAbi } from "./abi"
import {
  ERROR_GLOSSARY,
  MAX_DURATION_SECONDS,
  POST_EXPIRY_REFUND_ORDER,
  RULING_PENDING_TEXT,
  previewCreateEscrow,
  previewDispute,
  panelSubject,
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
    expect(names).toContain("ReleaseNotAuthorized")
    expect(names).toContain("NotParty")
    expect(names).toContain("DisputeAfterExpiry")
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "ReleaseNotAuthorized")?.meaning).toBe(
      "Only the payer can release an open escrow.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "NotParty")?.meaning).toBe(
      "This wallet is not a party to this escrow.",
    )
    expect(ERROR_GLOSSARY.find((entry) => entry.name === "RulingPending")?.meaning).toBe(RULING_PENDING_TEXT)
    expect(toFunctionSelector("RulingPending()")).toBe("0x3a0621bd")
    expect(toFunctionSelector("RULING_GRACE()")).toBe("0x3cfbadae")
    expect(POST_EXPIRY_REFUND_ORDER.map((step) => step.error)).toEqual([
      null,
      "DisputePending",
      "RulingPending",
      null,
    ])
    expect(POST_EXPIRY_REFUND_ORDER.map((step) => step.outcome)).toEqual([
      "The payer is refunded.",
      "The payee should release.",
      RULING_PENDING_TEXT,
      "The payer is refunded.",
    ])
    const flow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(flow).toContain('data-testid="post-expiry-refund-order"')
    expect(flow).toContain("POST_EXPIRY_REFUND_ORDER")
  })

  it("fills the dispute subject from the claim id and the time the claim was created", () => {
    const createdAt = 1_700_000_000n
    const subject = panelSubject(escrow, id, createdAt)
    expect(subject).toBe("0xbb13800c96edf91bb23cf6e0b3563c7f804d0f2215f3c390d62689d2a4ca1d7a")
    expect(subject).not.toBe(id)
    expect(panelSubject(escrow, id, createdAt)).toBe(subject)
    expect(panelSubject(escrow, other, createdAt)).not.toBe(subject)
    expect(panelSubject(panel, id, createdAt)).not.toBe(subject)
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    expect(source).toContain("panelSubject(escrow, claim, created)")
    expect(source).toContain('id="open-subject"')
    expect(source).toContain("readOnly")
    expect(source).not.toContain("Use the claim identifier. The panel stores this as the subject.")
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
