import { CallExecutionError, RawContractError, decodeFunctionData, type Address, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { escrowAbi } from "./abi"
import { readDisputeSubject, type DisputeSubjectClient } from "./disputeSubject"
import { panelSubject } from "./preview"
import { FORM_ERRORS } from "./submit"

const escrow = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d" as Address
const escrowId = `0x${"ab".repeat(32)}` as Hex
const createdAt = 1_700_000_000n
const viewSubject = `0x${"11".repeat(32)}` as Hex

function row(created: bigint) {
  return [escrow, escrow, escrowId, escrowId, 1n, created, created + 86_400n, 0, `0x${"00".repeat(32)}`]
}

function client(overrides: Partial<DisputeSubjectClient> & { code?: Hex } = {}): DisputeSubjectClient & {
  calls: Hex[]
  reads: number
} {
  const calls: Hex[] = []
  let reads = 0
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
      return overrides.code ?? "0x60016000"
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

  it("falls back to the claim identifier only when the view reverts with empty data and code is present", async () => {
    const empties: unknown[] = [
      new CallExecutionError(new RawContractError({ data: "0x", message: "execution reverted" }), {
        to: escrow,
        data: "0x",
      }),
      { name: "ExecutionRevertedError", message: "execution reverted", data: null },
      { name: "CallExecutionError", message: "execution reverted", cause: { name: "RawContractError", data: "" } },
    ]
    for (const error of empties) {
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
    }
  })

  it("blocks a network or timeout error and does not fall back", async () => {
    const codeFailed = client({
      async getCode() {
        throw new Error("timeout")
      },
    })
    const fromCode = await readDisputeSubject(codeFailed, escrow, escrowId)
    expect(fromCode).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
    expect(codeFailed.calls).toHaveLength(0)
    expect(codeFailed.reads).toBe(0)

    const callFailed = client({
      async call() {
        throw new Error("fetch failed")
      },
    })
    const fromCall = await readDisputeSubject(callFailed, escrow, escrowId)
    expect(fromCall).toEqual({ ok: false, message: FORM_ERRORS.subjectNetwork })
    expect(fromCall.ok || fromCall.message).not.toBe(escrowId)
  })

  it("blocks an address with no code and does not call the view", async () => {
    const chain = client({ code: "0x" })
    const result = await readDisputeSubject(chain, escrow, escrowId)
    expect(result).toEqual({ ok: false, message: FORM_ERRORS.subjectNoCode })
    expect(chain.calls).toHaveLength(0)
    expect(chain.reads).toBe(0)
  })

  it("blocks a non-empty revert and an empty successful return", async () => {
    const reverted = client({
      async call() {
        throw new CallExecutionError(new RawContractError({ data: "0x08c379a0", message: "execution reverted" }), {
          to: escrow,
        })
      },
    })
    expect(await readDisputeSubject(reverted, escrow, escrowId)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectRejected,
    })

    const emptySuccess = client({
      async call() {
        return { data: "0x" }
      },
    })
    expect(await readDisputeSubject(emptySuccess, escrow, escrowId)).toEqual({
      ok: false,
      message: FORM_ERRORS.subjectRejected,
    })

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
