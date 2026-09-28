import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from "viem"
import { escrowAbi } from "./abi"
import { FORM_ERRORS } from "./submit"

/**
 * Subject for openDispute.
 * A current escrow returns panelSubject(escrowId, createdAt) and that bytes32 is used as-is.
 * The booked 444c427 escrow has no such view: eth_call reverts with empty data while getCode
 * is non-empty, and that contract requires the subject to be the claim identifier.
 * Any other failure blocks the open. A wrong subject would burn the random case identifier.
 * At the next redeploy, the wallet book, the relayer book, the deploy-guard pin, and the
 * superseded entry for 0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d change together.
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

function callFailure(error: unknown): CallFailure {
  const seen = new Set<unknown>()
  const stack: unknown[] = [error]
  let sawRevert = false
  let sawHex = false
  let hex: string | null = null
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const record = current as Record<string, unknown>
    const name = typeof record.name === "string" ? record.name : ""
    const message = [record.shortMessage, record.message, record.details]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
    if (name === "ContractFunctionZeroDataError" || /returned no data/i.test(message)) return "reverted"
    if (
      name === "RawContractError" ||
      name === "ExecutionRevertedError" ||
      name === "CallExecutionError" ||
      /execution reverted/i.test(message)
    ) {
      sawRevert = true
    }
    const found = hexField(record.data) ?? hexField(record.raw)
    if (found !== undefined) {
      sawHex = true
      hex = found
    }
    if (record.cause && typeof record.cause === "object") stack.push(record.cause)
  }
  if (!sawRevert) return "transport"
  if (!sawHex || hex === null) return "empty-revert"
  return "reverted"
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
  if (code == null) return blocked(FORM_ERRORS.subjectNetwork)
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
    const decoded = bytes32Result(result?.data)
    if (!decoded) {
      try {
        const value = decodeFunctionResult({ abi: escrowAbi, functionName: "panelSubject", data: result?.data ?? "0x" })
        const fromAbi = bytes32Result(value)
        if (!fromAbi) return blocked(FORM_ERRORS.subjectRejected)
        return { ok: true, escrowId, subject: fromAbi, createdAt, source: "view" }
      } catch {
        return blocked(FORM_ERRORS.subjectRejected)
      }
    }
    return { ok: true, escrowId, subject: decoded, createdAt, source: "view" }
  } catch (error) {
    const failure = callFailure(error)
    if (failure === "empty-revert") {
      return { ok: true, escrowId, subject: escrowId, createdAt, source: "escrow-id" }
    }
    if (failure === "transport") return blocked(FORM_ERRORS.subjectNetwork)
    return blocked(FORM_ERRORS.subjectRejected)
  }
}
