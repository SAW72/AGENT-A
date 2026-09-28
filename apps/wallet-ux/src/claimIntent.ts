/**
 * EIP-712 ClaimIntent types for the connected wallet.
 * claim-relayer/claimIntent.json is the schema the relayer loads.
 * These constants must stay byte-identical with that file. The wallet-ux
 * test reads the JSON and fails if the two copies drift.
 */

export const CLAIM_INTENT_DOMAIN_NAME = "AgentBV Claim Relayer" as const
export const CLAIM_INTENT_DOMAIN_VERSION = "1" as const
export const CLAIM_INTENT_PRIMARY_TYPE = "ClaimIntent" as const
export const CLAIM_DEADLINE_SKEW_SECONDS = 240

export const CLAIM_INTENT_TYPE_STRING =
  "ClaimIntent(uint8 action,bytes32 escrowId,bytes32 calldataHash,address sender,uint256 nonce,uint256 deadline)"

export const CLAIM_INTENT_ACTIONS = ["createEscrow", "release", "refund", "dispute"] as const

export const CLAIM_INTENT_TYPES = {
  ClaimIntent: [
    { name: "action", type: "uint8" },
    { name: "escrowId", type: "bytes32" },
    { name: "calldataHash", type: "bytes32" },
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const

export function claimActionIndex(action: string): number {
  const index = CLAIM_INTENT_ACTIONS.indexOf(action as (typeof CLAIM_INTENT_ACTIONS)[number])
  if (index < 0) throw new Error(`Unknown claim action ${action}`)
  return index
}
