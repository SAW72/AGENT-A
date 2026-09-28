import {
  CallExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  WebSocketRequestError,
  decodeFunctionData,
  type Address,
  type Hex,
} from "viem"
import { getCallError } from "viem/utils"
import { describe, expect, it } from "vitest"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { readDisputeSubject, type DisputeSubjectClient } from "./disputeSubject"
import { panelSubject } from "./preview"
import { FORM_ERRORS } from "./submit"

const bookedEscrow = ADDRESSES.botAttestationEscrow
if (!bookedEscrow) throw new Error("The address book has no booked escrow.")
const escrow: Address = bookedEscrow
const otherEscrow = "0x2222222222222222222222222222222222222222" as Address
const escrowId = `0x${"ab".repeat(32)}` as Hex
const createdAt = 1_700_000_000n
const viewSubject = `0x${"11".repeat(32)}` as Hex
const rpcUrl = "https://sepolia.base.org"
const rpcBody = { method: "eth_call" }

function row(created: bigint) {
  return [escrow, escrow, escrowId, escrowId, 1n, created, created + 86_400n, 0, `0x${"00".repeat(32)}`]
}

function client(overrides: Partial<DisputeSubjectClient> & { code?: Hex | "" | null } = {}): DisputeSubjectClient & {
  calls: Hex[]
  reads: number
} {
  const calls: Hex[] = []
  let reads = 0
  const codeProvided = Object.hasOwn(overrides, "code")
  const built: DisputeSubjectClient & { calls: Hex[]; reads: number } = {
    calls,
    get reads() {
      return reads
    },
    set reads(value: number) {
      reads = value
    },
    async getCode() {
      if (overrides.getCode) return overrides.getCode({ address: escrow })
      if (codeProvided) return overrides.code as Hex | undefined | null
      return "0x60016000"
    },
    async readContract() {
      reads += 1
      if (overrides.readContract) {
        return overrides.readContract({ address: escrow, abi: escrowAbi, functionName: "escrows", args: [escrowId] })
      }
      return row(createdAt)
    },
    async call(args) {
      calls.push(args.data)
      if (overrides.call) return overrides.call(args)
      return { data: viewSubject }
    },
  }
  return built
}

function httpError(status?: number, details?: string) {
  return new CallExecutionError(
    new HttpRequestError({ url: rpcUrl, status, details, body: rpcBody }),
    { to: escrow },
  )
}

function rpcError(code: number, message: string, data?: Hex) {
  return getCallError(
    new RpcRequestError({
      url: rpcUrl,
      body: rpcBody,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
    { to: escrow },
  )
}

const emptyReverts: unknown[] = [
  new CallExecutionError(new RawContractError({ data: "0x" }), { to: escrow }),
  new CallExecutionError(new RawContractError({}), { to: escrow }),
  new CallExecutionError(new ExecutionRevertedError(), { to: escrow }),
  new CallExecutionError(
    new ContractFunctionRevertedError({ abi: escrowAbi, functionName: "panelSubject", data: "0x" }),
    { to: escrow },
  ),
  rpcError(3, "execution reverted", "0x"),
  rpcError(3, "execution reverted"),
]

describe("dispute subject", () => {
  it("uses the on-chain subject as returned, even when it differs from the local hash", async () => {
    const chain = client()
    const result = await readDisputeSubject(chain, escrow, escrowId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("view")
    expect(result.subject).toBe(viewSubject)
    expect(result.createdAt).toBe(createdAt)
    expect(result.subject).not.toBe(escrowId)
    expect(result.subject).not.toBe(panelSubject(escrow, escrowId, createdAt))
    expect(chain.calls).toHaveLength(1)
    const decoded = decodeFunctionData({ abi: escrowAbi, data: chain.calls[0] ?? "0x" })
    expect(decoded.functionName).toBe("panelSubject")
    expect(decoded.args).toEqual([escrowId, createdAt])
  })

  it("falls back to the claim identifier only for an empty revert on the booked escrow", async () => {
    const genuine = rpcError(3, "execution reverted", "0x")
    const names: string[] = []
    let cursor: unknown = genuine
    const seen = new Set<unknown>()
    while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
      seen.add(cursor)
      const record = cursor as { name?: string; cause?: unknown; code?: number; data?: unknown }
      if (record.name) names.push(record.name)
      if (record.name === "RpcRequestError") {
        expect(record.code).toBe(3)
        expect(record.data).toBe("0x")
      }
      cursor = record.cause
    }
    expect(names).toEqual(["CallExecutionError", "ExecutionRevertedError", "RpcRequestError"])

    for (const error of emptyReverts) {
      const chain = client({
        async call() {
          throw error
        },
      })
      const result = await readDisputeSubject(chain, escrow, escrowId)
      expect(result).toEqual({
        ok: true,
        escrowId,
        subject: escrowId,
        createdAt,
        source: "escrow-id",
      })
      const mixed = client({
        async call() {
          throw error
        },
      })
      const cased = await readDisputeSubject(mixed, escrow.toUpperCase() as Address, escrowId)
      expect(cased).toEqual({
        ok: true,
        escrowId,
        subject: escrowId,
        createdAt,
        source: "escrow-id",
      })
    }
  })

  it("rejects an empty revert on a coded address that is not the legacy escrow", async () => {
    expect(FORM_ERRORS.subjectNotBooked).toBe(
      "This contract did not return a dispute subject. It is not a supported escrow.",
    )
    for (const error of emptyReverts) {
      const chain = client({
        async call() {
          throw error
        },
      })
      const result = await readDisputeSubject(chain, otherEscrow, escrowId)
      expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNotBooked })
      expect(result.ok || result.message).not.toBe(escrowId)
    }
  })

  it("blocks HTTP, timeout, websocket, and non-revert RPC failures", async () => {
    const failures = [
      httpError(429),
      httpError(500),
      httpError(undefined, "fetch failed"),
      getCallError(new TimeoutError({ url: rpcUrl, body: rpcBody }), { to: escrow }),
      getCallError(new WebSocketRequestError({ url: rpcUrl, body: rpcBody }), { to: escrow }),
      rpcError(-32005, "limit exceeded"),
      rpcError(-32000, "header not found"),
      new CallExecutionError(new HttpRequestError({ url: rpcUrl, status: 429, body: rpcBody }), { to: escrow }),
    ]
    for (const error of failures) {
      const chain = client({
        async call() {
          throw error
        },
      })
      const result = await readDisputeSubject(chain, escrow, escrowId)
      expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
      expect(result.ok || result.message).not.toBe(escrowId)
    }

    const codeFailed = client({
      async getCode() {
        throw new TimeoutError({ url: rpcUrl, body: rpcBody })
      },
    })
    const fromCode = await readDisputeSubject(codeFailed, escrow, escrowId)
    expect(fromCode).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
    expect(codeFailed.calls).toHaveLength(0)
    expect(codeFailed.reads).toBe(0)
  })

  it("treats undefined, empty, and 0x code as no contract", async () => {
    expect(FORM_ERRORS.subjectNoCode).toBe("No escrow contract at this address on this network.")
    expect(FORM_ERRORS.subjectNetwork).toBe("The network did not answer, so this dispute was not prepared.")
    for (const code of [undefined, "", "0x"] as const) {
      const chain = client({ code })
      const result = await readDisputeSubject(chain, escrow, escrowId)
      expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNoCode })
      expect(chain.calls).toHaveLength(0)
      expect(chain.reads).toBe(0)
    }
  })

  it("blocks a non-empty revert, a short return, and a return that is not 32 bytes", async () => {
    const reverted = client({
      async call() {
        throw rpcError(3, "execution reverted", "0x08c379a0")
      },
    })
    expect(await readDisputeSubject(reverted, escrow, escrowId)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectRejected,
    })

    const raw = client({
      async call() {
        throw new CallExecutionError(new RawContractError({ data: "0x08c379a0" }), { to: escrow })
      },
    })
    expect(await readDisputeSubject(raw, escrow, escrowId)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectRejected,
    })

    for (const data of ["0x", "0x1234", `0x${"ab".repeat(31)}`, `0x${"ab".repeat(40)}`, undefined] as const) {
      const chain = client({
        async call() {
          return { data }
        },
      })
      expect(await readDisputeSubject(chain, escrow, escrowId)).toEqual({
        ok: false,
        message: FORM_ERRORS.subjectRejected,
      })
    }

    const missing = client({
      async readContract() {
        return row(0n)
      },
    })
    const absent = await readDisputeSubject(missing, escrow, escrowId)
    expect(absent).toEqual({ ok: false, message: FORM_ERRORS.subjectMissing })
    expect(missing.calls).toHaveLength(0)
  })
})
