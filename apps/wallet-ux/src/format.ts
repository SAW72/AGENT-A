import { formatEther } from "viem"
import { ZERO_ADDRESS } from "./addresses"
import { presentError } from "./revert"

export { decodeRevert, presentError, type DecodedRevert, type ErrorPresentation } from "./revert"

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatEth(wei: bigint): string {
  return `${formatEther(wei)} ETH`
}

export function isZeroAddress(address: string): boolean {
  return sameAddress(address, ZERO_ADDRESS)
}

export function errorText(error: unknown): string {
  const presented = presentError(error)
  if (!presented.detail) return presented.main
  return `${presented.main}\n${presented.detail}`
}
