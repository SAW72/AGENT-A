import { formatEther } from "viem"
import { ZERO_ADDRESS } from "./addresses"
import { presentError } from "./revert"

export { decodeRevert, presentError, presentRevertHex, type DecodedRevert, type ErrorPresentation } from "./revert"

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

/** Seven days. Refund stays blocked for this long after the claim ends while a dispute is unresolved. */
export const RULING_GRACE_SECONDS = 7n * 24n * 60n * 60n

export const PAYEE_OPEN_BEFORE_EXPIRY_TEXT =
  "Open a dispute before this claim ends. After that time the payer can refund unless a dispute is already open. While a dispute is unresolved, a refund stays blocked until 7 days after the claim ends."

export const PAYEE_OPEN_AFTER_EXPIRY_TEXT =
  "This claim has ended, so a dispute can no longer be opened. The payer can refund unless a dispute is already open. While a dispute is unresolved, a refund stays blocked until 7 days after the claim ends."

export type PayeeExpiryNotice = {
  beforeExpiry: boolean
  endsLabel: string
  graceEndsLabel: string
  text: string
}

const OPEN_ESCROW_STATE = 0

export function formatUnixUtc(seconds: bigint): string {
  const ms = seconds * 1000n
  if (ms < 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) return "an unknown time"
  const iso = new Date(Number(ms)).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
}

export function payeeOpenExpiryNotice(input: {
  viewer?: string | null
  payee: string
  payer: string
  state: number
  expiresAt: bigint
  used: boolean
  createdAt: bigint
  nowSeconds: bigint
}): PayeeExpiryNotice | null {
  if (!input.viewer) return null
  if (input.state !== OPEN_ESCROW_STATE) return null
  if (!input.used && isZeroAddress(input.payer) && input.createdAt === 0n) return null
  if (!sameAddress(input.viewer, input.payee)) return null
  const beforeExpiry = input.nowSeconds <= input.expiresAt
  return {
    beforeExpiry,
    endsLabel: formatUnixUtc(input.expiresAt),
    graceEndsLabel: formatUnixUtc(input.expiresAt + RULING_GRACE_SECONDS),
    text: beforeExpiry ? PAYEE_OPEN_BEFORE_EXPIRY_TEXT : PAYEE_OPEN_AFTER_EXPIRY_TEXT,
  }
}

export function errorText(error: unknown): string {
  const presented = presentError(error)
  if (!presented.detail) return presented.main
  return `${presented.main}\n${presented.detail}`
}
