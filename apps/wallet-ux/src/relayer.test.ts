import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CallExecutionError,
  ExecutionRevertedError,
  RpcRequestError,
  keccak256,
  parseEther,
  recoverTypedDataAddress,
  toBytes,
  type Hex,
} from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { describe, expect, it, vi } from "vitest"
import {
  CLAIM_INTENT_ACTIONS,
  CLAIM_INTENT_DOMAIN_NAME,
  CLAIM_INTENT_DOMAIN_VERSION,
  CLAIM_INTENT_PRIMARY_TYPE,
  CLAIM_INTENT_TYPE_STRING,
  CLAIM_INTENT_TYPES,
} from "./claimIntent"
import { previewCreateEscrow, previewDispute, previewOpenDispute, previewRelease } from "./preview"
import {
  claimBodyFromPreview,
  postLiveClaim,
  presentRelayerError,
  readRelayerHealth,
  readRelayerPaused,
  RELAYER_CHECK_WALLET_LABEL,
  RELAYER_CHECKING_NOTE,
  RELAYER_CONNECT_NOTE,
  RELAYER_COULD_NOT_SUBMIT,
  RELAYER_DOWN_NOTE,
  RELAYER_PAUSED_NOTE,
  RELAYER_RECEIPT_REVERTED_TEXT,
  RELAYER_RECEIPT_UNKNOWN_TEXT,
  RELAYER_TIMEOUT_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerErrorText,
  relayerSubmitAllowed,
  relayerTxUrl,
  relayerWalletUrl,
  runRelayerSubmission,
  type ClaimSignArgs,
  type SignedLiveClaim,
} from "./relayer"

const escrow = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d" as const
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
const id = `0x${"ab".repeat(32)}` as const
const other = `0x${"cd".repeat(32)}` as const
const payee = "0x0000000000000000000000000000000000000002" as const
const txHash = `0x${"ef".repeat(32)}` as const
const relayerUrl = "https://bot-verifier-claim-relayer.onrender.com"
const TEST_MNEMONIC = "test test test test test test test test test test test junk"
const payerAccount = mnemonicToAccount(TEST_MNEMONIC)
const CLAIM_INTENT_TYPEHASH = "0x34ba3a41e51e53513e455b5e4bc91be46317c71f0430096556c954dc76195242"

function signerInput(sign?: (args: ClaimSignArgs) => Promise<Hex>) {
  return {
    sender: payerAccount.address,
    verifyingContract: escrow,
    signTypedData: sign ?? ((args: ClaimSignArgs) => payerAccount.signTypedData(args)),
  }
}

function liveBody(preview: ReturnType<typeof previewRelease>, chainId = 84532): SignedLiveClaim {
  const claim = claimBodyFromPreview(preview)
  return {
    live: true,
    calldata: preview.calldata,
    signature: `0x${"11".repeat(65)}`,
    intent: {
      action: claim.action,
      escrowId: claim.claimId,
      calldataHash: keccak256(preview.calldata),
      sender: payerAccount.address,
      nonce: "7",
      deadline: "1893456000",
      chainId,
      verifyingContract: escrow,
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("relayer config", () => {
  it("stays unset when the URL is missing so submits stay wallet-direct", () => {
    expect(relayerConfigFromEnv({})).toEqual({ url: null })
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: "  " })).toEqual({ url: null })
  })

  it("keeps the public URL and does not read a claim secret", () => {
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: `${relayerUrl}/` })).toEqual({ url: relayerUrl })
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: relayerUrl })).not.toHaveProperty("secret")
  })
})

describe("relayer chain guard", () => {
  it("requires a connected Base Sepolia wallet so the claim can be signed", () => {
    const disconnected = relayerSubmitAllowed({ walletConnected: false, walletChainId: null })
    expect(disconnected).toEqual({ ok: false, reason: RELAYER_CONNECT_NOTE })
    expect(relayerSubmitAllowed({ walletConnected: true, walletChainId: 84532 })).toEqual({ ok: true })
  })

  it("refuses a connected mainnet wallet", () => {
    const ethereum = relayerSubmitAllowed({ walletConnected: true, walletChainId: 1 })
    const base = relayerSubmitAllowed({ walletConnected: true, walletChainId: 8453 })
    expect(ethereum.ok).toBe(false)
    expect(base.ok).toBe(false)
    if (!ethereum.ok) expect(ethereum.reason).toMatch(/chain id 1/)
    if (!base.ok) expect(base.reason).toMatch(/8453/)
  })
})

describe("postLiveClaim", () => {
  const releasePreview = previewRelease(escrow, id)
  const release = liveBody(releasePreview)

  it("posts a signed intent on chain 84532 and does not send a claim secret", async () => {
    const captured: { url: string; init: RequestInit } = { url: "", init: {} }
    const result = await postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async (url, init) => {
        captured.url = String(url)
        captured.init = init ?? {}
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(result).toEqual({ txHash, mode: "live", escrowAddress: null })
    expect(captured.url).toBe(`${relayerUrl}/v1/claims`)
    const headers = new Headers(captured.init.headers)
    expect(headers.get("x-claim-secret")).toBeNull()
    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("content-type")).toBe("application/json")
    const body = JSON.parse(String(captured.init.body)) as SignedLiveClaim
    expect(body.live).toBe(true)
    expect(body.calldata).toBe(releasePreview.calldata)
    expect(body.intent.chainId).toBe(84532)
    expect(body.intent.action).toBe("release")
    expect(body.intent.escrowId).toBe(id)
    expect(body.intent.sender).toBe(payerAccount.address)
  })

  it("surfaces 401, 503, and CORS without calling a mainnet chain", async () => {
    const unauthorized = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => jsonResponse(401, { ok: false, error: "unauthorized" }),
    })
    await expect(unauthorized).rejects.toMatchObject({ status: 401, code: "unauthorized" })
    await expect(unauthorized).rejects.toThrow(/401 unauthorized/)

    const closed = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => jsonResponse(503, { ok: false, error: "relayer_key_missing" }),
    })
    await expect(closed).rejects.toMatchObject({ status: 503, code: "relayer_key_missing" })
    await expect(closed).rejects.toThrow(/503 relayer_key_missing/)

    const cors = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    await expect(cors).rejects.toMatchObject({ code: "cors_or_network", status: null })
    await expect(cors).rejects.toThrow(/CORS/)
    await expect(cors).rejects.toThrow(/agent-a-wallet-ux\.pages\.dev/)
    await expect(cors).rejects.not.toThrow(/x-claim-secret/)

    let fetches = 0
    const mainnet = postLiveClaim({
      url: relayerUrl,
      body: liveBody(releasePreview, 1),
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    await expect(mainnet).rejects.toMatchObject({ code: "mainnet_refused" })
    const baseMainnet = postLiveClaim({
      url: relayerUrl,
      body: liveBody(releasePreview, 8453),
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    await expect(baseMainnet).rejects.toMatchObject({ code: "mainnet_refused" })
    expect(fetches).toBe(0)
    expect(relayerErrorText(await cors.catch((error: unknown) => error))).toMatch(/CORS/)
  })

  it("refuses a credentialed URL and openDispute", async () => {
    let fetches = 0
    await expect(
      postLiveClaim({
        url: "https://user:secret@bot-verifier-claim-relayer.onrender.com",
        body: liveBody(releasePreview),
        fetchImpl: async () => {
          fetches += 1
          return jsonResponse(200, { ok: true, mode: "live", txHash })
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_relayer_url" })
    expect(fetches).toBe(0)
    expect(() => claimBodyFromPreview(previewOpenDispute(panel, other, id, "wallet only"))).toThrow(/openDispute/)
  })

  it("builds a createEscrow live body from the wallet preview", () => {
    const body = claimBodyFromPreview(
      previewCreateEscrow({
        escrow,
        escrowId: id,
        payee,
        payerBotId: id,
        payeeBotId: other,
        durationSeconds: 3600n,
        valueWei: parseEther("0.01"),
      }),
    )
    expect(body.action).toBe("createEscrow")
    expect(body.live).toBe(true)
    expect(body.chainId).toBe(84532)
    expect(body.amountWei).toBe(parseEther("0.01").toString())
    expect(body.payee).toBe(payee)
    expect(body.durationSeconds).toBe("3600")
  })
})

describe("relayer broadcast failures", () => {
  it("shows plain English for 502 broadcast_failed and keeps the raw status in the details", async () => {
    const body = liveBody(previewRelease(escrow, id))
    const failed = postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted for an unknown reason." }),
    })
    await expect(failed).rejects.toThrow(/502 broadcast_failed/)
    const error = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted for an unknown reason." }),
    }).catch((cause: unknown) => cause)
    const presented = presentRelayerError(error)
    expect(presented.main).toBe(RELAYER_COULD_NOT_SUBMIT)
    expect(presented.main).not.toMatch(/502|broadcast_failed|Execution reverted|unknown reason/)
    expect(presented.detail).toBe("Details: 502 broadcast_failed")
  })

  it("decodes revert_data on a 502 and still works when that field is absent", async () => {
    const body = liveBody(previewRelease(escrow, id))
    const withData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, { error: "broadcast_failed", reason: "Execution reverted", revert_data: "0xf10068b5" }),
    }).catch((cause: unknown) => cause)
    const decoded = presentRelayerError(withData)
    expect(decoded.main).toBe("This dispute is already resolved, so it can't be linked to this claim.")
    expect(decoded.detail).toContain("DisputeAlreadyResolved")
    expect(decoded.detail).toContain("0xf10068b5")
    expect(decoded.detail).toContain("502 broadcast_failed")
    expect(decoded.main).not.toContain("0xf10068b5")

    const fromRevertData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, {
          error: "broadcast_failed",
          revert_data: null,
          revertData: "0x8aab0a8f",
          data: "0x9bc3a099",
        }),
    }).catch((cause: unknown) => cause)
    const revertDataHit = presentRelayerError(fromRevertData)
    expect(revertDataHit.main).toBe("This dispute already has votes, so it can't be linked to this claim.")
    expect(revertDataHit.detail).toContain("0x8aab0a8f")
    expect(revertDataHit.main).not.toMatch(/0x[0-9a-fA-F]+/)
    expect(revertDataHit.main).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/)

    const fromData = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () =>
        jsonResponse(502, {
          error: "broadcast_failed",
          revert_data: "",
          revertData: "0x",
          data: "0x9bc3a099",
        }),
    }).catch((cause: unknown) => cause)
    const dataHit = presentRelayerError(fromData)
    expect(dataHit.main).toBe("This dispute was opened before this claim, so it can't be linked.")
    expect(dataHit.detail).toContain("0x9bc3a099")
    expect(dataHit.main).not.toContain("0x9bc3a099")

    const absent = await postLiveClaim({
      url: relayerUrl,
      body,
      fetchImpl: async () => jsonResponse(502, { error: "broadcast_failed" }),
    }).catch((cause: unknown) => cause)
    const plain = presentRelayerError(absent)
    expect(plain.main).toBe(RELAYER_COULD_NOT_SUBMIT)
    expect(plain.detail).toBe("Details: 502 broadcast_failed")
  })
})

describe("wallet submit stays direct unless the UI opts in", () => {
  it("keeps submit.ts free of the relayer and wires errors in FlowPreview", () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const submit = readFileSync(join(dir, "submit.ts"), "utf8")
    const flow = readFileSync(join(dir, "FlowPreview.tsx"), "utf8")
    expect(submit).not.toContain("VITE_CLAIM_RELAYER_URL")
    expect(submit).not.toContain("postLiveClaim")
    expect(flow).toContain("sendTransactionAsync")
    expect(flow).toContain("runRelayerSubmission")
    expect(flow).toContain('data-testid="relayer-submit"')
    expect(flow).toContain('data-testid="relayer-tx-link"')
    expect(flow).toContain("relayer.url")
    expect(flow).toContain("RELAYER_SUBMITTING_TEXT")
    expect(flow).toContain("RELAYER_WAITING_TEXT")
    expect(flow).toContain("relayerFlight")
    expect(flow).toContain("if (relayerFlight.current) return")
    expect(flow).toContain("signTypedData")
    expect(flow).toContain("readRelayerHealth")
    expect(flow).not.toContain("VITE_CLAIM_API_SECRET")
    expect(flow).not.toContain("x-claim-secret")
  })
})

const retiredEscrow = "0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c"
const relayerPackage = join(dirname(fileURLToPath(import.meta.url)), "../../../claim-relayer")

function rpcRevert(data: Hex) {
  const rpc = new RpcRequestError({
    body: { method: "eth_call", params: [] },
    error: { code: 3, message: "execution reverted", data },
    url: "http://127.0.0.1:8545",
  })
  const reverted = new ExecutionRevertedError({ cause: rpc, message: rpc.details })
  return new CallExecutionError(reverted, { to: escrow, data: "0x" })
}

/** Encode the dispute body the same way claim-relayer/escrowCalldata.mjs does, without that package's install. */
function relayerDisputeCalldata(body: { claimId: string; disputeId: string }): string {
  const calldataSource = readFileSync(join(relayerPackage, "escrowCalldata.mjs"), "utf8")
  const claimsSource = readFileSync(join(relayerPackage, "claims.mjs"), "utf8")
  expect(calldataSource).toContain('dispute: "dispute(bytes32,bytes32)"')
  expect(calldataSource).toMatch(/if \(action === "dispute"\) \{[\s\S]*assertNoValue\(body\)[\s\S]*bytes32Word\(body\.disputeId, "disputeId"\)/)
  expect(calldataSource).toContain("return bytes32Word(body.claimId, \"claimId\")")
  expect(claimsSource).toContain("return body.live === true || body.liveSubmit === true")
  expect(claimsSource).toContain("const encoded = prepared?.encoded || describeCalldata(body)")
  expect(claimsSource).toContain("const claimId = parseClaimId(prepared?.claimId || body.claimId)")
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.claimId) || !/^0x[0-9a-fA-F]{64}$/.test(body.disputeId)) {
    throw new Error("relayer dispute body failed bytes32 validation")
  }
  const selector = keccak256(toBytes("dispute(bytes32,bytes32)")).slice(0, 10)
  return `${selector}${body.claimId.slice(2).toLowerCase()}${body.disputeId.slice(2).toLowerCase()}`
}

function readyClient(receipt: { status: "success" | "reverted" } | Error) {
  return {
    call: vi.fn(async () => "0x"),
    waitForTransactionReceipt: vi.fn(async () => {
      if (receipt instanceof Error) throw receipt
      return receipt
    }),
  }
}

describe("dispute submit via the claim relayer", () => {
  const dispute = previewDispute(escrow, id, other)

  it("posts the exact live dispute body the relayer handler validates", async () => {
    const phases: string[] = []
    let posted = ""
    let method = ""
    let secretHeader: string | null = null
    let target = ""
    const client = readyClient({ status: "success" })
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client,
      onPhase: (phase) => phases.push(phase),
      fetchImpl: async (url, init) => {
        target = String(url)
        method = String(init?.method)
        posted = String(init?.body)
        secretHeader = new Headers(init?.headers).get("x-claim-secret")
        expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
        return jsonResponse(200, {
          ok: true,
          mode: "live",
          txHash,
          escrowAddress: escrow,
          chainId: 84532,
        })
      },
    })
    expect(phases).toEqual(["submitting", "confirming"])
    expect(method).toBe("POST")
    expect(target).toBe(`${relayerUrl}/v1/claims`)
    expect(secretHeader).toBeNull()
    const body = JSON.parse(posted) as SignedLiveClaim
    expect(body.live).toBe(true)
    expect(body.calldata.toLowerCase()).toBe(dispute.calldata.toLowerCase())
    expect(body.intent.action).toBe("dispute")
    expect(body.intent.escrowId).toBe(id)
    expect(body.intent.chainId).toBe(84532)
    expect(body.intent.verifyingContract).toBe(escrow)
    expect(body.intent.sender).toBe(payerAccount.address)
    expect(body.intent.calldataHash).toBe(keccak256(dispute.calldata))
    expect(body).not.toHaveProperty("amountWei")
    expect(body.intent).not.toHaveProperty("disputeId")
    const accepted = relayerDisputeCalldata({ claimId: id, disputeId: other })
    expect(accepted.toLowerCase()).toBe(dispute.calldata.toLowerCase())
    expect(client.call).toHaveBeenCalledWith({
      account: "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
      to: escrow,
      data: dispute.calldata,
      value: 0n,
    })
    expect(result).toEqual({ ok: true, txHash })
    expect(relayerTxUrl(txHash)).toBe(`https://sepolia.basescan.org/tx/${txHash}`)
  })

  it("rejects a non-relayer action before any eth_call or fetch", async () => {
    let fetches = 0
    const client = {
      call: vi.fn(async () => "0x"),
      waitForTransactionReceipt: vi.fn(),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: previewOpenDispute(panel, other, id, "wallet only"),
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(client.call).not.toHaveBeenCalled()
    expect(fetches).toBe(0)
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("action_not_claim")
      expect(result.presentation.main).toBe("This step has to be sent from your wallet, not the claim relayer.")
    }
  })

  it("does not post when the relayer-wallet simulation reverts", async () => {
    let fetches = 0
    const client = {
      call: vi.fn(async () => {
        throw rpcRevert("0xf10068b5")
      }),
      waitForTransactionReceipt: vi.fn(),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(fetches).toBe(0)
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.presentation.main).toBe("This dispute is already resolved, so it can't be linked to this claim.")
    }
  })

  it("keeps a timed-out post unknown and points at the relayer wallet", async () => {
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client: readyClient({ status: "success" }),
      fetchTimeoutMs: 20,
      fetchImpl: () => new Promise(() => undefined),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("timeout_unknown")
    expect(result.presentation.main).toBe(RELAYER_TIMEOUT_TEXT)
    expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
    expect(result.presentation.main).not.toMatch(/[()]/)
    expect(result.presentation.detail).toBe("Details: timeout_unknown")
    expect(result.presentation.link).toEqual({ href: relayerWalletUrl(), label: RELAYER_CHECK_WALLET_LABEL })
  })

  it("links the transaction when the receipt never arrives", async () => {
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client: readyClient(Object.assign(new Error("Timed out while waiting for transaction."), { name: "WaitForTransactionReceiptTimeoutError" })),
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("receipt_unknown")
    expect(result.txHash).toBe(txHash)
    expect(result.presentation.main).toBe(RELAYER_RECEIPT_UNKNOWN_TEXT)
    expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
    expect(result.presentation.link?.href).toBe(relayerTxUrl(txHash))
  })

  it("explains a reverted receipt in plain English and keeps the transaction link", async () => {
    let calls = 0
    const client = {
      call: vi.fn(async () => {
        calls += 1
        if (calls === 1) return "0x"
        throw rpcRevert("0xf10068b5")
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" as const })),
    }
    const decoded = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client,
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.presentation.main).toBe("This dispute is already resolved, so it can't be linked to this claim.")
    expect(decoded.presentation.link?.href).toBe(relayerTxUrl(txHash))
    expect(decoded.presentation.main).not.toMatch(/[()]/)

    const plain = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client: readyClient({ status: "reverted" }),
      fetchImpl: async () => jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow }),
    })
    expect(plain.ok).toBe(false)
    if (plain.ok) return
    expect(plain.presentation.main).toBe(RELAYER_RECEIPT_REVERTED_TEXT)
    expect(plain.presentation.main).toContain("The transaction was sent")
    expect(plain.presentation.main).toContain("no escrow funds moved")
    expect(plain.presentation.main).not.toContain("No funds moved")
    expect(plain.presentation.main).not.toMatch(/Nothing was sent/)
    expect(plain.presentation.link?.href).toBe(relayerTxUrl(txHash))
  })
})

describe("relayer response copy", () => {
  const dispute = previewDispute(escrow, id, other)
  const cases: { status: number; body: Record<string, unknown>; main: string; detail: string }[] = [
    {
      status: 400,
      body: { ok: false, error: "invalid_json" },
      main: "The claim relayer could not accept this submission. Nothing was sent.",
      detail: "Details: 400 invalid_json",
    },
    {
      status: 401,
      body: { ok: false, error: "unauthorized" },
      main: "The claim relayer refused this request. Nothing was sent.",
      detail: "Details: 401 unauthorized",
    },
    {
      status: 403,
      body: { ok: false, error: "forbidden" },
      main: "The claim relayer refused this request. Nothing was sent.",
      detail: "Details: 403 forbidden",
    },
    {
      status: 404,
      body: { ok: false, error: "not_found" },
      main: "The claim relayer could not find that submission path. Nothing was sent.",
      detail: "Details: 404 not_found",
    },
    {
      status: 409,
      body: { ok: false, error: "live_submit_blocked", reason: "live_submit_off", txHash: null },
      main: "The claim relayer isn't accepting live submissions right now. Nothing was sent.",
      detail: "Details: 409 live_submit_blocked",
    },
    {
      status: 422,
      body: { ok: false, error: "unprocessable" },
      main: "The claim relayer could not accept this submission. Nothing was sent.",
      detail: "Details: 422 unprocessable",
    },
    {
      status: 429,
      body: { ok: false, error: "rate_limited" },
      main: "The claim relayer is limiting submissions. Wait a moment and try again. Nothing was sent.",
      detail: "Details: 429 rate_limited",
    },
    {
      status: 400,
      body: {
        ok: false,
        error: "retired_or_superseded_address",
        address: retiredEscrow,
        current: escrow,
      },
      main: "The claim relayer is pointed at a retired escrow, so this was not submitted. Use your wallet instead.",
      detail: "Details: 400 retired_or_superseded_address",
    },
    {
      status: 409,
      body: {
        ok: false,
        error: "live_submit_blocked",
        reason: "escrow_not_booked_sepolia",
        escrowAddress: retiredEscrow,
        txHash: null,
      },
      main: "The claim relayer is pointed at a retired escrow, so this was not submitted. Use your wallet instead.",
      detail: "Details: 409 live_submit_blocked",
    },
    {
      status: 503,
      body: { ok: false, error: "kill_switch" },
      main: "The claim relayer is paused. Nothing was sent.",
      detail: "Details: 503 kill_switch",
    },
  ]

  it("maps client errors to plain English and keeps the raw status in the details", async () => {
    for (const item of cases) {
      const result = await runRelayerSubmission({
        url: relayerUrl,
        ...signerInput(),
        preview: dispute,
        client: readyClient({ status: "success" }),
        fetchImpl: async () => jsonResponse(item.status, item.body),
      })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.presentation.main).toBe(item.main)
      expect(result.presentation.detail).toBe(item.detail)
      expect(result.presentation.main).not.toMatch(/[()]/)
      expect(result.presentation.main).not.toContain(String(item.status))
      const code = String(item.body.error)
      expect(result.presentation.main).not.toContain(code)
    }
  })

  it("treats a live hash aimed at the retired escrow as already submitted", async () => {
    const client = readyClient({ status: "success" })
    const result = await runRelayerSubmission({
      url: relayerUrl,
      ...signerInput(),
      preview: dispute,
      client,
      fetchImpl: async () =>
        jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: retiredEscrow }),
    })
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("retired_or_superseded_address")
    expect(result.presentation.main).toBe("The claim relayer used a retired escrow. Check the transaction before you try again.")
    expect(result.presentation.main.toLowerCase()).not.toContain("nothing was sent")
    expect(result.presentation.link?.href).toBe(relayerTxUrl(txHash))
    expect(result.presentation.detail).toBe("Details: 200 retired_or_superseded_address")
  })
})

describe("relayer button", () => {
  it("hides the relayer when the URL is unset and when the action is not a claim", () => {
    expect(
      relayerButtonModel({
        url: null,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "dispute",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "openDispute",
      }).visible,
    ).toBe(false)
    expect(
      relayerButtonModel({
        url: relayerUrl,
        health: "ok",
        phase: "idle",
        gate: { ok: true },
        action: "createEscrow",
      }).visible,
    ).toBe(false)
  })

  it("enables the button only when health is ok, and explains checking, down, and paused", () => {
    const checking = relayerButtonModel({
      url: relayerUrl,
      health: "unknown",
      phase: "idle",
      gate: { ok: true },
      action: "dispute",
    })
    expect(checking).toMatchObject({ visible: true, disabled: true, note: RELAYER_CHECKING_NOTE })
    const down = relayerButtonModel({
      url: relayerUrl,
      health: "down",
      phase: "idle",
      gate: { ok: true },
      action: "dispute",
    })
    expect(down).toMatchObject({ visible: true, disabled: true, note: RELAYER_DOWN_NOTE })
    const paused = relayerButtonModel({
      url: relayerUrl,
      health: "paused",
      phase: "idle",
      gate: { ok: true },
      action: "release",
    })
    expect(paused).toMatchObject({ visible: true, disabled: true, note: RELAYER_PAUSED_NOTE })
    const ready = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "idle",
      gate: { ok: true },
      action: "dispute",
    })
    expect(ready).toMatchObject({ visible: true, disabled: false, label: "Submit via claim relayer", note: null })
  })

  it("disables the button while submitting and while waiting for confirmation", () => {
    const submitting = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "submitting",
      gate: { ok: true },
      action: "dispute",
    })
    const waiting = relayerButtonModel({
      url: relayerUrl,
      health: "ok",
      phase: "confirming",
      gate: { ok: true },
      action: "refund",
    })
    expect(submitting).toMatchObject({ disabled: true, label: "Submitting through the claim relayer…" })
    expect(waiting).toMatchObject({ disabled: true, label: "Waiting for confirmation…" })
  })
})

describe("relayer health", () => {
  it("reads the kill switch from /health and stays quiet when the check fails", async () => {
    let target = ""
    const paused = await readRelayerPaused({
      url: `${relayerUrl}/`,
      fetchImpl: async (url) => {
        target = String(url)
        return jsonResponse(200, { ok: true, killSwitch: true })
      },
    })
    expect(paused).toBe(true)
    expect(target).toBe(`${relayerUrl}/health`)
    const open = await readRelayerPaused({
      url: relayerUrl,
      fetchImpl: async () => jsonResponse(200, { ok: true, killSwitch: false }),
    })
    expect(open).toBe(false)
    const down = await readRelayerPaused({
      url: relayerUrl,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    expect(down).toBeNull()
    const health = await readRelayerHealth({
      url: relayerUrl,
      fetchImpl: async () => jsonResponse(200, { ok: true, killSwitch: false }),
    })
    expect(health).toBe("ok")
  })
})

describe("signed claim intent", () => {
  it("matches the relayer schema byte for byte and pins the ClaimIntent typehash", () => {
    const schema = JSON.parse(readFileSync(join(relayerPackage, "claimIntent.json"), "utf8")) as {
      domainName: string
      domainVersion: string
      primaryType: string
      typeString: string
      actions: string[]
      types: { ClaimIntent: { name: string; type: string }[] }
    }
    expect(schema.domainName).toBe(CLAIM_INTENT_DOMAIN_NAME)
    expect(schema.domainVersion).toBe(CLAIM_INTENT_DOMAIN_VERSION)
    expect(schema.primaryType).toBe(CLAIM_INTENT_PRIMARY_TYPE)
    expect(schema.typeString).toBe(CLAIM_INTENT_TYPE_STRING)
    expect(schema.actions).toEqual([...CLAIM_INTENT_ACTIONS])
    expect(schema.types.ClaimIntent).toEqual(
      CLAIM_INTENT_TYPES.ClaimIntent.map((field) => ({ name: field.name, type: field.type })),
    )
    expect(keccak256(toBytes(CLAIM_INTENT_TYPE_STRING))).toBe(CLAIM_INTENT_TYPEHASH)
    expect(keccak256(toBytes(schema.typeString))).toBe(CLAIM_INTENT_TYPEHASH)
  })

  it("signs with the connected wallet and posts that signature to a mock relayer", async () => {
    const dispute = previewDispute(escrow, id, other)
    const order: string[] = []
    let posted = ""
    let headerNames: string[] = []
    const client = {
      call: vi.fn(async () => {
        order.push("simulate")
        return "0x"
      }),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    }
    const result = await runRelayerSubmission({
      url: relayerUrl,
      preview: dispute,
      ...signerInput(async (args) => {
        order.push("sign")
        return payerAccount.signTypedData(args)
      }),
      client,
      nowSeconds: 1_780_000_000,
      nonce: 42n,
      fetchImpl: async (_url, init) => {
        order.push("post")
        posted = String(init?.body)
        headerNames = [...new Headers(init?.headers).keys()]
        return jsonResponse(200, { ok: true, mode: "live", txHash, escrowAddress: escrow })
      },
    })
    expect(order).toEqual(["simulate", "sign", "post"])
    expect(headerNames).not.toContain("x-claim-secret")
    const body = JSON.parse(posted) as SignedLiveClaim
    expect(body.calldata.toLowerCase()).toBe(dispute.calldata.toLowerCase())
    expect(body.intent.nonce).toBe("42")
    expect(body.intent.deadline).toBe(String(1_780_000_000 + 240))
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: CLAIM_INTENT_DOMAIN_NAME,
        version: CLAIM_INTENT_DOMAIN_VERSION,
        chainId: 84532,
        verifyingContract: escrow,
      },
      types: CLAIM_INTENT_TYPES,
      primaryType: CLAIM_INTENT_PRIMARY_TYPE,
      message: {
        action: 3,
        escrowId: id,
        calldataHash: keccak256(dispute.calldata),
        sender: payerAccount.address,
        nonce: 42n,
        deadline: BigInt(1_780_000_000 + 240),
      },
      signature: body.signature,
    })
    expect(recovered).toBe(payerAccount.address)
    expect(result).toEqual({ ok: true, txHash })
  })
})
