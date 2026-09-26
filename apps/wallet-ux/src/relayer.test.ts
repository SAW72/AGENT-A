import { parseEther } from "viem"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { previewCreateEscrow, previewOpenDispute, previewRelease } from "./preview"
import {
  claimBodyFromPreview,
  postLiveClaim,
  relayerConfigFromEnv,
  relayerErrorText,
  relayerSubmitAllowed,
  type LiveClaimBody,
} from "./relayer"

const escrow = "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d" as const
const panel = "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb" as const
const id = `0x${"ab".repeat(32)}` as const
const other = `0x${"cd".repeat(32)}` as const
const payee = "0x0000000000000000000000000000000000000002" as const
const txHash = `0x${"ef".repeat(32)}` as const
const relayerUrl = "https://bot-verifier-claim-relayer.onrender.com"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("relayer config", () => {
  it("stays unset when the URL is missing so submits stay wallet-direct", () => {
    expect(relayerConfigFromEnv({})).toEqual({ url: null, secret: null })
    expect(relayerConfigFromEnv({ VITE_CLAIM_RELAYER_URL: "  ", VITE_CLAIM_API_SECRET: "  " })).toEqual({
      url: null,
      secret: null,
    })
  })

  it("keeps the public URL and an optional secret", () => {
    expect(
      relayerConfigFromEnv({
        VITE_CLAIM_RELAYER_URL: `${relayerUrl}/`,
        VITE_CLAIM_API_SECRET: " sepolia-test-secret ",
      }),
    ).toEqual({ url: relayerUrl, secret: "sepolia-test-secret" })
  })
})

describe("relayer chain guard", () => {
  it("allows a disconnected wallet and a Base Sepolia wallet", () => {
    expect(relayerSubmitAllowed({ walletConnected: false, walletChainId: null })).toEqual({ ok: true })
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
  const release = claimBodyFromPreview(previewRelease(escrow, id))

  it("posts live:true with x-claim-secret and chain 84532", async () => {
    const captured: { url: string; init: RequestInit } = { url: "", init: {} }
    const result = await postLiveClaim({
      url: relayerUrl,
      secret: "sepolia-test-secret",
      body: release,
      fetchImpl: async (url, init) => {
        captured.url = String(url)
        captured.init = init ?? {}
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(result).toEqual({ txHash, mode: "live" })
    expect(captured.url).toBe(`${relayerUrl}/v1/claims`)
    const headers = new Headers(captured.init.headers)
    expect(headers.get("x-claim-secret")).toBe("sepolia-test-secret")
    expect(headers.get("content-type")).toBe("application/json")
    const body = JSON.parse(String(captured.init.body)) as LiveClaimBody
    expect(body.live).toBe(true)
    expect(body.chainId).toBe(84532)
    expect(body.action).toBe("release")
    expect(body.claimId).toBe(id)
  })

  it("omits the claim header when no secret is configured", async () => {
    let header: string | null = "unset"
    await postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async (_url, init) => {
        header = new Headers(init?.headers).get("x-claim-secret")
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    expect(header).toBeNull()
  })

  it("surfaces 401, 503, and CORS without calling a mainnet chain", async () => {
    const unauthorized = postLiveClaim({
      url: relayerUrl,
      secret: "wrong",
      body: release,
      fetchImpl: async () => jsonResponse(401, { ok: false, error: "unauthorized" }),
    })
    await expect(unauthorized).rejects.toMatchObject({ status: 401, code: "unauthorized" })
    await expect(unauthorized).rejects.toThrow(/401 unauthorized/)

    const closed = postLiveClaim({
      url: relayerUrl,
      body: release,
      fetchImpl: async () => jsonResponse(503, { ok: false, error: "claim_api_secret_required" }),
    })
    await expect(closed).rejects.toMatchObject({ status: 503, code: "claim_api_secret_required" })
    await expect(closed).rejects.toThrow(/CLAIM_API_SECRET is unset/)

    const cors = postLiveClaim({
      url: relayerUrl,
      secret: "sepolia-test-secret",
      body: release,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    await expect(cors).rejects.toMatchObject({ code: "cors_or_network", status: null })
    await expect(cors).rejects.toThrow(/CORS/)
    await expect(cors).rejects.toThrow(/agent-a-wallet-ux\.pages\.dev/)
    await expect(cors).rejects.toThrow(/x-claim-secret/)

    let fetches = 0
    const mainnet = postLiveClaim({
      url: relayerUrl,
      secret: "sepolia-test-secret",
      body: { ...release, chainId: 1 } as unknown as LiveClaimBody,
      fetchImpl: async () => {
        fetches += 1
        return jsonResponse(200, { ok: true, mode: "live", txHash })
      },
    })
    await expect(mainnet).rejects.toMatchObject({ code: "mainnet_refused" })
    const baseMainnet = postLiveClaim({
      url: relayerUrl,
      body: { ...release, chainId: 8453 } as unknown as LiveClaimBody,
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
        body: release,
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

describe("wallet submit stays direct unless the UI opts in", () => {
  it("keeps submit.ts free of the relayer and wires errors in FlowPreview", () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const submit = readFileSync(join(dir, "submit.ts"), "utf8")
    const flow = readFileSync(join(dir, "FlowPreview.tsx"), "utf8")
    expect(submit).not.toContain("VITE_CLAIM_RELAYER_URL")
    expect(submit).not.toContain("postLiveClaim")
    expect(flow).toContain("sendTransactionAsync")
    expect(flow).toContain("postLiveClaim")
    expect(flow).toContain("relayerErrorText")
    expect(flow).toContain('data-testid="relayer-submit"')
    expect(flow).toContain("relayer.url")
  })
})
