import { encodeFunctionData, type Address, type Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"

export const MAX_DURATION_SECONDS = 30 * 24 * 60 * 60

export type CallPreview = {
  to: Address
  functionName: string
  calldata: Hex
  valueWei: bigint
}

export type ErrorGlossaryEntry = {
  name: string
  meaning: string
}

/** Contract revert strings. These builders do not submit. */
export const ERROR_GLOSSARY: readonly ErrorGlossaryEntry[] = [
  { name: "FundingBeforeGovernance", meaning: "createEscrow reverts until owner() is governance (CORE_TIMELOCK has accepted)." },
  { name: "EscrowNotOpen", meaning: "release, refund, or dispute saw a state other than the one that path allows." },
  { name: "EscrowExpired", meaning: "Open release after expiresAt. An upheld dispute can still release." },
  { name: "AttestationFailed", meaning: "zero amount, bad duration, or a bot that is inactive, below Financial, access-denied, or denylisted." },
  { name: "InvalidParties", meaning: "Zero payee, payer equals payee, bot ids match or are zero, or Vault operator does not match." },
  { name: "Replay", meaning: "escrowId was already used." },
  { name: "InvalidDispute", meaning: "dispute id is zero, or the panel outcome is missing or its subjectHash is not the escrow id." },
  { name: "DisputeAlreadyResolved", meaning: "This dispute is already resolved, so it can't be linked to this escrow." },
  { name: "DisputeVotesCast", meaning: "This dispute already has votes, so it can't be linked to this escrow." },
  { name: "DisputePredatesEscrow", meaning: "This dispute was created before this escrow, so it can't be linked." },
  { name: "DisputeChallengerNotParty", meaning: "The challenger on this dispute is neither the payer nor the payee." },
  { name: "DisputeAfterExpiry", meaning: "The escrow window has closed, so this dispute can't be linked." },
  { name: "DisputePending", meaning: "refund is closed because the panel upheld the deal." },
  { name: "ZeroAddress", meaning: "A required address was zero." },
  { name: "InvalidGovernance", meaning: "Constructor governance was the deployer." },
  { name: "NotGovernance", meaning: "Caller is not governance, or owner() is not governance." },
  { name: "DependencyChangeWhileFunded", meaning: "setDenylist, setVault, or setDisputePanel while lockedValue is not zero." },
  { name: "DenylistUnchanged", meaning: "setDenylist was given the current denylist." },
  { name: "VaultUnchanged", meaning: "setVault was given the current vault." },
  { name: "DisputePanelUnchanged", meaning: "setDisputePanel was given the current dispute panel." },
  { name: "not a party", meaning: "dispute() caller is neither payer nor payee." },
  { name: "not expired", meaning: "refund() on an Open escrow before expiresAt." },
  { name: "transfer failed", meaning: "Paying the payee returned false." },
  { name: "refund failed", meaning: "Paying the payer returned false." },
  { name: "panel not seated", meaning: "openDispute while arbitratorCount is below PANEL_SIZE." },
  { name: "exists", meaning: "openDispute id is already on the panel." },
  { name: "not authorized", meaning: "vote() from an address that is not an arbitrator." },
  { name: "no dispute", meaning: "vote() for an unknown dispute id." },
  { name: "resolved", meaning: "vote() after the dispute is already resolved." },
  { name: "already voted", meaning: "That arbitrator already voted." },
  { name: "not owner", meaning: "DisputePanel owner call from someone else." },
  { name: "zero arbitrator", meaning: "setArbitrator was given the zero address." },
]

export function previewCreateEscrow(input: {
  escrow: Address
  escrowId: Hex
  payee: Address
  payerBotId: Hex
  payeeBotId: Hex
  durationSeconds: bigint
  valueWei: bigint
}): CallPreview {
  return {
    to: input.escrow,
    functionName: "createEscrow",
    valueWei: input.valueWei,
    calldata: encodeFunctionData({
      abi: escrowAbi,
      functionName: "createEscrow",
      args: [input.escrowId, input.payee, input.payerBotId, input.payeeBotId, input.durationSeconds],
    }),
  }
}

export function previewRelease(escrow: Address, escrowId: Hex): CallPreview {
  return {
    to: escrow,
    functionName: "release",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "release", args: [escrowId] }),
  }
}

export function previewRefund(escrow: Address, escrowId: Hex): CallPreview {
  return {
    to: escrow,
    functionName: "refund",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [escrowId] }),
  }
}

export function previewDispute(escrow: Address, escrowId: Hex, disputeId: Hex): CallPreview {
  return {
    to: escrow,
    functionName: "dispute",
    valueWei: 0n,
    calldata: encodeFunctionData({ abi: escrowAbi, functionName: "dispute", args: [escrowId, disputeId] }),
  }
}

export function previewOpenDispute(panel: Address, disputeId: Hex, subjectHash: Hex, reason: string): CallPreview {
  return {
    to: panel,
    functionName: "openDispute",
    valueWei: 0n,
    calldata: encodeFunctionData({
      abi: disputePanelAbi,
      functionName: "openDispute",
      args: [disputeId, subjectHash, reason],
    }),
  }
}
