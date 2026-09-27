import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import deploymentBook from "./base-sepolia.json"

/** Booked Base Sepolia claim-relayer wallet. Simulations of relayer submits use this as `from`. */
export const CLAIM_RELAYER_WALLET = deploymentBook.claimRelayerWallet as Address

export const ESCROW_NOT_FOUND_CODE = "escrow_not_found"
export const ESCROW_NOT_FOUND_TEXT =
  "We couldn't find a claim with that identifier on this network. Check the number and try again."
export const ESCROW_READ_FAILED_TEXT =
  "The network didn't answer whether this claim exists. Nothing was sent."

export class EscrowNotFoundError extends Error {
  readonly code = ESCROW_NOT_FOUND_CODE

  constructor() {
    super(ESCROW_NOT_FOUND_TEXT)
    this.name = "EscrowNotFoundError"
  }
}

export type PreflightCall = {
  account?: Address
  to: Address
  data: Hex
  value?: bigint
  blockTag?: "latest"
}

/** Narrow client so tests can pass a mock. A wagmi public client satisfies this. */
export type PreflightClient = {
  call: (args: PreflightCall) => Promise<unknown>
}

const EXISTING_ESCROW_CALLS = new Set(["release", "refund", "dispute"])

function asHex32(value: unknown): Hex | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null
  return value as Hex
}

/**
 * Release, refund, and dispute need an existing claim. openDispute stores the
 * claim id as its subject. createEscrow is a new id, so it is not looked up.
 */
function escrowExistenceTarget(
  data: Hex,
  escrow: Address | null,
  to: Address,
): { escrow: Address; id: Hex } | null {
  try {
    const decoded = decodeFunctionData({ abi: escrowAbi, data })
    if (!EXISTING_ESCROW_CALLS.has(decoded.functionName)) return null
    const id = asHex32(decoded.args?.[0])
    if (!id) return null
    return { escrow: escrow ?? to, id }
  } catch {
    /* not an escrow call */
  }
  try {
    const decoded = decodeFunctionData({ abi: disputePanelAbi, data })
    if (decoded.functionName !== "openDispute") return null
    const id = asHex32(decoded.args?.[1])
    const target = escrow ?? ADDRESSES.botAttestationEscrow
    if (!id || !target) throw new Error(ESCROW_READ_FAILED_TEXT)
    return { escrow: target, id }
  } catch (cause) {
    if (cause instanceof Error && cause.message === ESCROW_READ_FAILED_TEXT) throw cause
    return null
  }
}

function resultWord(result: unknown): Hex | null {
  const data =
    typeof result === "string"
      ? result
      : result && typeof result === "object" && "data" in result
        ? (result as { data?: unknown }).data
        : null
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]+$/.test(data) || data === "0x") return null
  return data as Hex
}

/** eth_call usedEscrowIds(id) at latest. A false bit blocks submit before simulation. */
async function assertRecordedEscrow(client: PreflightClient, escrow: Address, escrowId: Hex): Promise<void> {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: "usedEscrowIds", args: [escrowId] })
  const result = await client.call({ to: escrow, data, blockTag: "latest" })
  const word = resultWord(result)
  if (!word) throw new Error(ESCROW_READ_FAILED_TEXT)
  if (BigInt(word) === 0n) throw new EscrowNotFoundError()
}

/**
 * Base Sepolia eth_call with the same calldata the wallet would send.
 * A missing claim, or a revert, throws and the wallet prompt is not opened.
 */
export async function submitAfterPreflight<T>(input: {
  chainId: number
  client: PreflightClient
  account?: Address
  to: Address
  data: Hex
  value: bigint
  escrow?: Address
  send: () => Promise<T>
}): Promise<T> {
  if (input.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error("This check only runs on the Base Sepolia network. Nothing was sent.")
  }
  const target = escrowExistenceTarget(input.data, input.escrow ?? null, input.to)
  if (target) await assertRecordedEscrow(input.client, target.escrow, target.id)
  await input.client.call({
    account: input.account,
    to: input.to,
    data: input.data,
    value: input.value,
  })
  return input.send()
}

/** Simulate the claim as the relayer wallet, then POST only if the call succeeds. */
export async function submitRelayerAfterPreflight<T>(input: {
  client: PreflightClient
  to: Address
  data: Hex
  value: bigint
  escrow?: Address
  post: () => Promise<T>
}): Promise<T> {
  return submitAfterPreflight({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    client: input.client,
    account: CLAIM_RELAYER_WALLET,
    to: input.to,
    data: input.data,
    value: input.value,
    escrow: input.escrow,
    send: input.post,
  })
}
