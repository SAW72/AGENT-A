import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BaseError,
  CallExecutionError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RpcRequestError,
  UserRejectedRequestError,
  encodeErrorResult,
  type Hex,
} from "viem"
import { describe, expect, it, vi } from "vitest"
import { escrowAbi } from "./abi"
import { ADDRESSES } from "./addresses"
import { errorText, presentError } from "./format"
import { ERROR_GLOSSARY } from "./preview"
import { submitAfterPreflight } from "./preflight"

const escrow = ADDRESSES.botAttestationEscrow
if (!escrow) throw new Error("booked escrow missing")

const ESC_M1 = [
  {
    name: "DisputeAlreadyResolved",
    selector: "0xf10068b5",
    meaning: "This dispute is already resolved, so it can't be linked to this escrow.",
  },
  {
    name: "DisputeVotesCast",
    selector: "0x8aab0a8f",
    meaning: "This dispute already has votes, so it can't be linked to this escrow.",
  },
  {
    name: "DisputePredatesEscrow",
    selector: "0x9bc3a099",
    meaning: "This dispute was created before this escrow, so it can't be linked.",
  },
  {
    name: "DisputeChallengerNotParty",
    selector: "0xb4b5168e",
    meaning: "The challenger on this dispute is neither the payer nor the payee.",
  },
  {
    name: "DisputeAfterExpiry",
    selector: "0xaf6c5d51",
    meaning: "The escrow window has closed, so this dispute can't be linked.",
  },
] as const

const errorStringAbi = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
] as const

function executionError(data: Hex) {
  const reverted = new ContractFunctionRevertedError({
    abi: escrowAbi,
    data,
    functionName: "dispute",
  })
  return new ContractFunctionExecutionError(reverted, {
    abi: escrowAbi,
    args: [],
    contractAddress: escrow ?? undefined,
    functionName: "dispute",
  })
}

function rpcRevert(data: Hex) {
  const rpc = new RpcRequestError({
    body: { method: "eth_call", params: [] },
    error: { code: 3, message: "execution reverted", data },
    url: "https://sepolia.base.org",
  })
  const reverted = new ExecutionRevertedError({ cause: rpc, message: rpc.details })
  return new CallExecutionError(reverted, {
    to: escrow ?? undefined,
    data: "0x",
  })
}

describe("ESC-M-1 revert text", () => {
  it.each(ESC_M1)("renders $name from a viem execution error and an RPC revert", (entry) => {
    const glossary = ERROR_GLOSSARY.find((item) => item.name === entry.name)
    expect(glossary?.meaning).toBe(entry.meaning)
    const data = entry.selector as Hex

    for (const error of [executionError(data), rpcRevert(data)]) {
      const presented = presentError(error)
      expect(presented.main).toBe(entry.meaning)
      expect(presented.detail).toBe(`Details: ${entry.name} (${entry.selector})`)
      expect(presented.main).not.toContain(entry.selector)
      expect(presented.main).not.toContain(entry.name)
      expect(errorText(error).startsWith(entry.meaning)).toBe(true)
      expect(errorText(error)).not.toContain("\n    at ")
      expect(error.shortMessage).not.toBe(presented.main)
    }
  })

  it("uses a plain fallback for an unknown selector and keeps the selector in the details", () => {
    const error = rpcRevert("0x12345678")
    const presented = presentError(error)
    expect(presented.main).toBe("The contract rejected this transaction. No funds moved.")
    expect(presented.detail).toBe("Details: 0x12345678")
    expect(presented.main).not.toContain("0x12345678")
    expect(error.shortMessage).toBe("Execution reverted for an unknown reason.")
  })

  it("renders Error(string) from the glossary, with the name only in the details", () => {
    const data = encodeErrorResult({ abi: errorStringAbi, args: ["not a party"] })
    const presented = presentError(rpcRevert(data))
    expect(presented.main).toBe("dispute() caller is neither payer nor payee.")
    expect(presented.detail).toBe("Details: Error (0x08c379a0)")
    expect(presented.main).not.toContain("0x08c379a0")
  })

  it("says the wallet was cancelled for UserRejectedRequestError and EIP-1193 code 4001", () => {
    const rejected = new UserRejectedRequestError(new Error("User denied"))
    rejected.stack = "UserRejectedRequestError: User rejected the request.\n    at secret/wallet.js:1:1"
    const wrapped = new BaseError("Wallet request failed.", { cause: rejected })
    const coded = new BaseError("Provider failed.", {
      cause: Object.assign(new Error("denied"), { code: 4001 }),
    })

    for (const error of [rejected, wrapped, coded]) {
      const presented = presentError(error)
      expect(presented.main).toBe("You cancelled in your wallet")
      expect(presented.detail).toBeNull()
      expect(errorText(error)).toBe("You cancelled in your wallet")
      expect(errorText(error)).not.toContain("secret/wallet.js")
      expect(errorText(error)).not.toContain(" at ")
    }
  })
})

describe("preflight", () => {
  const calldata = "0x1234" as Hex

  it("does not open the wallet when the Base Sepolia simulation reverts", async () => {
    const send = vi.fn()
    const client = {
      call: vi.fn(async () => {
        throw rpcRevert("0xf10068b5")
      }),
    }
    await expect(
      submitAfterPreflight({
        chainId: 84532,
        client,
        account: "0x000000000000000000000000000000000000dEaD",
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toBeTruthy()
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(client.call).toHaveBeenCalledWith({
      account: "0x000000000000000000000000000000000000dEaD",
      to: escrow,
      data: calldata,
      value: 0n,
    })
    expect(send).not.toHaveBeenCalled()
    try {
      await submitAfterPreflight({
        chainId: 84532,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      })
    } catch (cause) {
      expect(presentError(cause).main).toBe(
        "This dispute is already resolved, so it can't be linked to this escrow.",
      )
    }
  })

  it("opens the wallet only after a successful Base Sepolia simulation", async () => {
    const send = vi.fn(async () => "0xabc" as Hex)
    const client = { call: vi.fn(async () => ({ data: "0x" })) }
    await expect(
      submitAfterPreflight({
        chainId: 84532,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).resolves.toBe("0xabc")
    expect(client.call).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("refuses every other chain before the simulation or the wallet", async () => {
    const send = vi.fn()
    const client = { call: vi.fn() }
    await expect(
      submitAfterPreflight({
        chainId: 1,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toThrow(/84532/)
    await expect(
      submitAfterPreflight({
        chainId: 8453,
        client,
        to: escrow,
        data: calldata,
        value: 0n,
        send,
      }),
    ).rejects.toThrow(/84532/)
    expect(client.call).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("runs the preflight in the submit handler before the wallet prompt", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "FlowPreview.tsx"), "utf8")
    const notice = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ErrorNotice.tsx"), "utf8")
    const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8")
    const preflight = source.indexOf("submitAfterPreflight")
    const send = source.indexOf("send: () =>")
    expect(preflight).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(preflight)
    expect(source).toContain("presentError")
    expect(source).toContain("ErrorNotice")
    expect(source).toContain("chainId: BASE_SEPOLIA_CHAIN_ID")
    expect(notice).toContain('role="alert"')
    expect(styles).toContain("overflow-wrap: anywhere")
    expect(styles).toContain(".error-notice")
  })
})
