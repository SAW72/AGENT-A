import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { FORM_ERRORS } from "./submit"

/**
 * Subject for openDispute.
 * A current escrow returns panelSubject(escrowId, createdAt) and that bytes32 is used as-is.
 * The booked escrow in the address book is source 444c427. It has no such view: eth_call
 * reverts with empty data while getCode is non-empty, and that contract requires the subject
 * to be the claim identifier. That fallback is only for ADDRESSES.botAttestationEscrow.
 * viem wraps every eth_call failure in CallExecutionError. A real empty revert is that
 * wrapper around ExecutionRevertedError, whose cause is RpcRequestError code 3 with data
 * "0x" or no data. HTTP failures, timeouts, websocket failures, and any other RPC code
 * (including -32005 and -32000) block with the network message. No code blocks with the
 * no-code message. An empty revert on any other address is rejected and blocks.
 * A wrong subject would burn the random case identifier.
 * At the next redeploy, the wallet book, the relayer book, the deploy-guard pin, and the
 * superseded entry for the booked escrow change together.
 */
export type DisputeSubjectClient = {
  getCode: (args: { address: Address }) => Promise<Hex | undefined | null>
  call: (args: { to: Address; data: Hex }) => Promise<{ data?: Hex | null | undefined }>
  readContract: (args: {
    address: Address
    abi: Abi
    functionName: string
    args?: readonly unknown[]
  }) => Promise<unknown>
}

export type DisputeSubjectReady = {
  ok: true
  escrowId: Hex
  subject: Hex
  createdAt: bigint
  source: "view" | "escrow-id"
}

export type DisputeSubjectBlocked = {
  ok: false
  message: string
}

export type DisputeSubjectResult = DisputeSubjectReady | DisputeSubjectBlocked

type CallFailure = "empty-revert" | "reverted" | "transport"

function bytecodePresent(code: unknown): boolean {
  return typeof code === "string" && /^0x[0-9a-fA-F]+$/i.test(code) && code.length > 2
}

function hexField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  if (typeof value === "string") {
    const text = value.trim()
    if (/^0x$/i.test(text)) return null
    if (/^0x[0-9a-fA-F]+$/i.test(text)) return text.toLowerCase()
    return undefined
  }
  if (typeof value === "object" && value !== null && "data" in value) {
    return hexField((value as { data: unknown }).data)
  }
  return undefined
}

const TRANSPORT_NAMES = new Set(["HttpRequestError", "TimeoutError", "WebSocketRequestError"])
const EMPTY_REVERT_NAMES = new Set([
  "ExecutionRevertedError",
  "RawContractError",
  "ContractFunctionRevertedError",
])

/** True when a revert class carries revert bytes other than empty or absent data. */
function revertBytesPresent(record: Record<string, unknown>): boolean {
  for (const key of ["data", "raw"] as const) {
    if (!(key in record)) continue
    const found = hexField(record[key])
    if (typeof found === "string") return true
  }
  return false
}

/**
 * Walk `.cause` the same way viem's BaseError.walk does.
 * CallExecutionError alone is not a revert: viem wraps every eth_call failure in it.
 * RpcRequestError code 3 is the revert-data carrier under ExecutionRevertedError.
 * Any other RPC code, plus HTTP, timeout, and websocket errors, is a network failure.
 * An unrecognized shape does not count as a revert, so the default is to block.
 */
function callFailure(error: unknown): CallFailure {
  const seen = new Set<unknown>()
  let sawTransport = false
  let sawEmptyRevert = false
  let sawRevertBytes = false
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as Record<string, unknown>
    const name = typeof record.name === "string" ? record.name : ""
    if (TRANSPORT_NAMES.has(name)) sawTransport = true
    if (name === "RpcRequestError") {
      if (record.code === 3) {
        if (revertBytesPresent(record)) sawRevertBytes = true
      } else {
        sawTransport = true
      }
    } else if (EMPTY_REVERT_NAMES.has(name)) {
      if (revertBytesPresent(record)) sawRevertBytes = true
      else sawEmptyRevert = true
    } else if (name === "ContractFunctionZeroDataError") {
      sawRevertBytes = true
    }
    const cause = record.cause
    current = cause && typeof cause === "object" ? cause : undefined
  }
  if (sawTransport) return "transport"
  if (sawRevertBytes) return "reverted"
  if (sawEmptyRevert) return "empty-revert"
  return "transport"
}

function isBookedEscrow(escrow: Address): boolean {
  const booked = ADDRESSES.botAttestationEscrow
  if (!booked) return false
  return escrow.toLowerCase() === booked.toLowerCase()
}

function tupleField(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) return value[index]
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (name in record) return record[name]
    if (String(index) in record) return record[String(index)]
  }
  return undefined
}

function asCreatedAt(row: unknown): bigint | null {
  const value = tupleField(row, 5, "createdAt")
  if (typeof value === "bigint" && value >= 0n) return value
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value)
  return null
}

function bytes32Result(data: unknown): Hex | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/i.test(data)) return null
  return data.toLowerCase() as Hex
}

function blocked(message: string): DisputeSubjectBlocked {
  return { ok: false, message }
}

export async function readDisputeSubject(
  client: DisputeSubjectClient,
  escrow: Address,
  escrowId: Hex,
): Promise<DisputeSubjectResult> {
  let code: unknown
  try {
    code = await client.getCode({ address: escrow })
  } catch {
    return blocked(FORM_ERRORS.subjectNetwork)
  }
  if (!bytecodePresent(code)) return blocked(FORM_ERRORS.subjectNoCode)

  let createdAt: bigint | null
  try {
    const row = await client.readContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "escrows",
      args: [escrowId],
    })
    createdAt = asCreatedAt(row)
  } catch (error) {
    return blocked(callFailure(error) === "transport" ? FORM_ERRORS.subjectNetwork : FORM_ERRORS.subjectRejected)
  }
  if (createdAt === null) return blocked(FORM_ERRORS.subjectRejected)
  if (createdAt === 0n) return blocked(FORM_ERRORS.subjectMissing)

  const data = encodeFunctionData({
    abi: escrowAbi,
    functionName: "panelSubject",
    args: [escrowId, createdAt],
  })
  try {
    const result = await client.call({ to: escrow, data })
    const returned = result?.data
    if (typeof returned !== "string" || !/^0x[0-9a-fA-F]{64}$/i.test(returned)) {
      return blocked(FORM_ERRORS.subjectRejected)
    }
    try {
      const value = decodeFunctionResult({ abi: escrowAbi, functionName: "panelSubject", data: returned as Hex })
      const fromAbi = bytes32Result(value)
      if (!fromAbi) return blocked(FORM_ERRORS.subjectRejected)
      return { ok: true, escrowId, subject: fromAbi, createdAt, source: "view" }
    } catch {
      return blocked(FORM_ERRORS.subjectRejected)
    }
  } catch (error) {
    const failure = callFailure(error)
    if (failure === "empty-revert") {
      if (isBookedEscrow(escrow)) {
        return { ok: true, escrowId, subject: escrowId, createdAt, source: "escrow-id" }
      }
      return blocked(FORM_ERRORS.subjectNotBooked)
    }
    if (failure === "transport") return blocked(FORM_ERRORS.subjectNetwork)
    return blocked(FORM_ERRORS.subjectRejected)
  }
}
