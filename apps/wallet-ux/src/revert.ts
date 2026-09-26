import {
  BaseError,
  ContractFunctionRevertedError,
  RawContractError,
  decodeErrorResult,
  type Hex,
} from "viem"
import { disputePanelAbi, escrowAbi } from "./abi"
import { ERROR_GLOSSARY } from "./preview"

/** Solidity `Error(string)` and `Panic(uint256)`, alongside the wallet ABIs. */
const STANDARD_REVERT_ERRORS = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
  {
    type: "error",
    name: "Panic",
    inputs: [{ name: "code", type: "uint256" }],
  },
] as const

const REVERT_ABI = [...escrowAbi, ...disputePanelAbi, ...STANDARD_REVERT_ERRORS]

export type DecodedRevert = {
  name: string
  args: readonly unknown[] | undefined
  meaning: string | null
  selector: Hex
}

export type ErrorPresentation = {
  main: string
  detail: string | null
}

export const WALLET_CANCEL_TEXT = "You cancelled in your wallet"
export const REVERT_FALLBACK_TEXT = "The contract rejected this transaction. No funds moved."

function isRevertData(value: string): value is Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return false
  const bytes = (value.length - 2) / 2
  return Number.isInteger(bytes) && bytes >= 4 && (bytes - 4) % 32 === 0
}

function hexFromDataField(data: unknown): Hex | null {
  if (typeof data === "string" && isRevertData(data)) return data
  if (data && typeof data === "object" && "data" in data) {
    return hexFromDataField((data as { data?: unknown }).data)
  }
  return null
}

function selectorOf(data: Hex): Hex {
  return `0x${data.slice(2, 10).toLowerCase()}` as Hex
}

/** Follow `cause`, using `BaseError.walk` when the node is a viem error. */
function chainOf(error: unknown): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const visit = (item: unknown) => {
    if (item == null || typeof item !== "object" || seen.has(item)) return
    seen.add(item)
    out.push(item)
    if (item instanceof BaseError) {
      const deepest = item.walk()
      if (deepest && deepest !== item) visit(deepest)
    }
    if ("cause" in item) visit((item as { cause?: unknown }).cause)
  }
  visit(error)
  return out
}

function matchesWalletCancel(item: unknown): boolean {
  if (!item || typeof item !== "object") return false
  const record = item as { name?: unknown; code?: unknown }
  return record.name === "UserRejectedRequestError" || record.code === 4001
}

export function isWalletCancel(error: unknown): boolean {
  if (error instanceof BaseError) {
    const found = error.walk((item) => matchesWalletCancel(item))
    if (found) return true
  }
  return chainOf(error).some((item) => matchesWalletCancel(item))
}

function glossaryMeaning(name: string, args: readonly unknown[] | undefined): string | null {
  const direct = ERROR_GLOSSARY.find((entry) => entry.name === name)
  if (direct) return direct.meaning
  const message = args?.[0]
  if (name === "Error" && typeof message === "string") {
    const byMessage = ERROR_GLOSSARY.find((entry) => entry.name === message)
    if (byMessage) return byMessage.meaning
  }
  return null
}

export function revertDataOf(error: unknown): Hex | null {
  if (error instanceof BaseError) {
    const reverted = error.walk((item) => item instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError && reverted.raw && isRevertData(reverted.raw)) {
      return reverted.raw
    }
    const raw = error.walk((item) => item instanceof RawContractError)
    if (raw instanceof RawContractError) {
      const hex = hexFromDataField(raw.data)
      if (hex) return hex
    }
  }
  for (const item of chainOf(error)) {
    if (item instanceof ContractFunctionRevertedError && item.raw && isRevertData(item.raw)) return item.raw
    if (item instanceof RawContractError) {
      const hex = hexFromDataField(item.data)
      if (hex) return hex
    }
    if (item && typeof item === "object" && "data" in item) {
      const hex = hexFromDataField((item as { data?: unknown }).data)
      if (hex) return hex
    }
  }
  return null
}

export function decodeRevert(error: unknown): DecodedRevert | null {
  const data = revertDataOf(error)
  if (!data) return null
  const selector = selectorOf(data)
  try {
    const decoded = decodeErrorResult({ abi: REVERT_ABI, data })
    const args = decoded.args === undefined ? undefined : [...decoded.args]
    return {
      name: decoded.errorName,
      args,
      meaning: glossaryMeaning(decoded.errorName, args),
      selector,
    }
  } catch {
    return null
  }
}

function firstLine(text: string): string {
  const line = text.split("\n")[0]?.trim() ?? ""
  if (line.length === 0) return ""
  if (line.includes(" at ") || text.includes("\n    at ") || text.includes("\n at ")) return ""
  return line
}

function safeShort(error: unknown): string {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const short = (error as { shortMessage?: unknown }).shortMessage
    if (typeof short === "string") {
      const line = firstLine(short)
      if (line.length > 0) return line
    }
  }
  if (error instanceof Error) {
    const line = firstLine(error.message)
    if (line.length > 0) return line
  }
  return "Request failed"
}

export function presentError(error: unknown): ErrorPresentation {
  if (isWalletCancel(error)) return { main: WALLET_CANCEL_TEXT, detail: null }

  const data = revertDataOf(error)
  if (!data) return { main: safeShort(error), detail: null }

  const selector = selectorOf(data)
  const decoded = decodeRevert(error)
  if (decoded?.meaning) {
    return { main: decoded.meaning, detail: `Details: ${decoded.name} (${selector})` }
  }
  if (decoded) {
    return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${decoded.name} (${selector})` }
  }
  return { main: REVERT_FALLBACK_TEXT, detail: `Details: ${selector}` }
}
