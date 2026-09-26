import type { Address, Hex } from "viem"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"

export type PreflightCall = {
  account?: Address
  to: Address
  data: Hex
  value?: bigint
}

/** Narrow client so tests can pass a mock. A wagmi public client satisfies this. */
export type PreflightClient = {
  call: (args: PreflightCall) => Promise<unknown>
}

/**
 * Base Sepolia eth_call with the same calldata the wallet would send.
 * A revert throws and the wallet prompt is not opened.
 */
export async function submitAfterPreflight<T>(input: {
  chainId: number
  client: PreflightClient
  account?: Address
  to: Address
  data: Hex
  value: bigint
  send: () => Promise<T>
}): Promise<T> {
  if (input.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Preflight is Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) only.`)
  }
  await input.client.call({
    account: input.account,
    to: input.to,
    data: input.data,
    value: input.value,
  })
  return input.send()
}
