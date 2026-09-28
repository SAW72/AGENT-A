import { describe, expect, it } from "vitest"
import { PAYEE_OPEN_AFTER_EXPIRY_TEXT, PAYEE_OPEN_BEFORE_EXPIRY_TEXT, payeeDisputeBeforeCta, payeeExpiryUrgentText } from "./format"
import { CASE_ID_HINT, LINK_CASE_HEADING, NEW_CASE_ID_BUTTON, OPEN_AND_LINK_BUTTON, OPEN_AND_LINK_TEXT, OPEN_CASE_HEADING } from "./preview"

const identifiers = [
  "createEscrow",
  "openDispute",
  "setDenylist",
  "setVault",
  "setDisputePanel",
  "setArbitrator",
  "escrowId",
  "subjectHash",
  "PANEL_SIZE",
  "arbitratorCount",
  "expiresAt",
  "lockedValue",
  "CORE_TIMELOCK",
  "bytes32",
  "durationSeconds",
  "payerBotId",
  "payeeBotId",
]

function rejectsCode(text: string): boolean {
  return (
    text.includes("()") ||
    /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(text) ||
    /\b[A-Z][A-Z0-9_]{3,}\b/.test(text) ||
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(text) ||
    /0x[0-9a-fA-F]+/.test(text) ||
    identifiers.some((name) => text.includes(name))
  )
}

describe("payee expiry copy", () => {
  const mains = [
    PAYEE_OPEN_BEFORE_EXPIRY_TEXT,
    PAYEE_OPEN_AFTER_EXPIRY_TEXT,
    "Dispute before this claim ends",
    "This claim has ended",
    "This claim ends 2026-10-01 12:00:00 UTC.",
    "This claim ended 2026-10-01 12:00:00 UTC.",
    "While a dispute is unresolved, a refund stays blocked until 2026-10-08 12:00:00 UTC.",
    payeeDisputeBeforeCta("2026-10-01 12:00:00 UTC"),
    payeeExpiryUrgentText("2026-10-01 12:00:00 UTC"),
    OPEN_AND_LINK_TEXT,
    OPEN_AND_LINK_BUTTON,
    NEW_CASE_ID_BUTTON,
    OPEN_CASE_HEADING,
    LINK_CASE_HEADING,
    CASE_ID_HINT,
  ]

  it("keeps the payee prompt free of calls and identifiers", () => {
    for (const text of mains) {
      expect(rejectsCode(text)).toBe(false)
    }
  })
})
