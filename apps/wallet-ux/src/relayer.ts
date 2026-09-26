import { decodeFunctionData, type Address, type Hex } from "viem"
import { escrowAbi } from "./abi"
import { BASE_SEPOLIA_CHAIN_ID, SUPERSEDED } from "./addresses"
import { presentError, presentRevertHex, type ErrorPresentation } from "./format"
import { BASE_MAINNET_CHAIN_ID, ETHEREUM_MAINNET_CHAIN_ID, type WalletChainId } from "./guard"
import { CLAIM_RELAYER_WALLET, submitRelayerAfterPreflight, type PreflightClient } from "./preflight"
import type { CallPreview } from "./preview"
import { REVERT_FALLBACK_TEXT } from "./revert"
import { evaluateEscrowSubmit } from "./submit"

const RELAYER_ACTIONS = ["createEscrow", "release", "refund", "dispute"] as const

export type RelayerAction = (typeof RELAYER_ACTIONS)[number]

export type RelayerConfig = {
  url: string | null
  secret: string | null
}

export type LiveClaimBody = {
  action: RelayerAction
  claimId: Hex
  chainId: typeof BASE_SEPOLIA_CHAIN_ID
  live: true
  payee?: Address
  payerBotId?: Hex
  payeeBotId?: Hex
  durationSeconds?: string
  amountWei?: string
  disputeId?: Hex
}

export type LiveClaimResult = {
  txHash: Hex
  mode: "live"
  escrowAddress: Address | null
}

export const RELAYER_FETCH_TIMEOUT_MS = 30_000
export const RELAYER_RECEIPT_TIMEOUT_MS = 60_000
export const RELAYER_HEALTH_TIMEOUT_MS = 5_000

export const RELAYER_SUBMITTING_TEXT = "Submitting through the claim relayer…"
export const RELAYER_WAITING_TEXT = "Waiting for confirmation…"
export const RELAYER_SUBMITTED_TEXT = "The claim relayer submitted this transaction."
export const RELAYER_CONFIRMED_TEXT = "The transaction is confirmed."
export const RELAYER_TX_LINK_LABEL = "View this transaction on Base Sepolia"
export const RELAYER_CHECK_WALLET_LABEL = "Check the relayer wallet on Base Sepolia"
export const RELAYER_PAUSED_NOTE = "The claim relayer is paused. Use your wallet to submit instead."
export const RELAYER_SECRET_NOTE =
  "This app is missing the claim secret, so the claim relayer stays off. Use your wallet to submit instead."
export const RELAYER_TIMEOUT_TEXT =
  "The claim relayer didn't answer in time. It may still have submitted this transaction. Check the relayer wallet on Base Sepolia before you try again."
export const RELAYER_RECEIPT_UNKNOWN_TEXT =
  "The claim relayer submitted this transaction, but this page could not confirm it. Check the transaction before you try again."
export const RELAYER_RECEIPT_REVERTED_TEXT =
  "The transaction was included, but the contract rejected it. No funds moved."

export type RelayerPhase = "idle" | "submitting" | "confirming"

export type RelayerButtonModel =
  | { visible: false }
  | { visible: true; disabled: boolean; label: string; note: string | null }

export type RelayerRunResult =
  | { ok: true; txHash: Hex }
  | { ok: false; txHash: Hex | null; code: string | null; presentation: ErrorPresentation }

export function relayerTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`
}

export function relayerWalletUrl(): string {
  return `https://sepolia.basescan.org/address/${CLAIM_RELAYER_WALLET}`
}

export class RelayerRequestError extends Error {
  readonly status: number | null
  readonly code: string
  readonly body: Record<string, unknown> | null

  constructor(message: string, status: number | null, code: string, body: Record<string, unknown> | null = null) {
    super(message)
    this.name = "RelayerRequestError"
    this.status = status
    this.code = code
    this.body = body
  }
}

export const RELAYER_COULD_NOT_SUBMIT =
  "The claim relayer couldn't submit this transaction. Nothing was sent from your wallet."

export const RELAYER_UNAVAILABLE_TEXT = "The claim relayer is unavailable. Nothing was sent."

const RELAYER_VALIDATION_TEXT = "The claim relayer could not accept this submission. Nothing was sent."
const RELAYER_NOT_LIVE_TEXT = "The claim relayer is not accepting live submissions right now. Nothing was sent."
const RELAYER_RETIRED_TEXT =
  "The claim relayer is pointed at a retired escrow, so this was not submitted. Use your wallet instead."
const RELAYER_RETIRED_SENT_TEXT =
  "The claim relayer used a retired escrow. Check the transaction before you try again."

const RELAYER_PLAIN: Record<string, string> = {
  unauthorized: "The claim relayer refused this request. Nothing was sent.",
  forbidden: "The claim relayer refused this request. Nothing was sent.",
  claim_api_secret_required: "The claim relayer is not ready to submit claims yet. Nothing was sent.",
  relayer_key_missing: "The claim relayer is not ready to submit claims yet. Nothing was sent.",
  kill_switch: "The claim relayer is paused. Nothing was sent.",
  cors_or_network: "The claim relayer could not be reached. Nothing was sent.",
  mainnet_refused: "The claim relayer only submits on the Base Sepolia network. Nothing was sent.",
  wrong_chain: "The claim relayer only submits on the Base Sepolia network. Nothing was sent.",
  action_not_claim: "This step has to be sent from your wallet, not the claim relayer.",
  invalid_relayer_url: "The claim relayer address is not valid. Nothing was sent.",
  invalid_bytes32: "A required identifier is missing or not the right length. Nothing was sent.",
  invalid_claim_id: "The claim identifier was not accepted. Nothing was sent.",
  invalid_address: "A required wallet address is missing. Nothing was sent.",
  invalid_duration: "The time window for this claim is missing. Nothing was sent.",
  invalid_amount: "This claim needs an amount greater than zero. Nothing was sent.",
  invalid_uint: "A required number was not accepted. Nothing was sent.",
  invalid_parties: "The payer and payee must be different wallets. Nothing was sent.",
  invalid_json: RELAYER_VALIDATION_TEXT,
  value_not_allowed: "This action cannot include a payment amount. Nothing was sent.",
  action_required: "This step is missing the action the claim relayer needs. Nothing was sent.",
  payload_too_large: "This submission is too large for the claim relayer. Nothing was sent.",
  validation: RELAYER_VALIDATION_TEXT,
  unprocessable: RELAYER_VALIDATION_TEXT,
  calldata_mismatch: "The prepared transaction doesn't match this action. Nothing was sent.",
  live_required: "The claim relayer only accepts a live submission. Nothing was sent.",
  missing_tx_hash: "The claim relayer did not confirm a transaction. Nothing was shown as sent.",
  not_found: "The claim relayer could not find that submission path. Nothing was sent.",
  live_submit_blocked: RELAYER_NOT_LIVE_TEXT,
  escrow_not_booked: "The claim relayer has no escrow configured, so it will not submit. Nothing was sent.",
  escrow_not_booked_sepolia: "The claim relayer is not pointed at the booked escrow, so it will not submit. Nothing was sent.",
  escrow_booked_spencer_run_auth_required: RELAYER_NOT_LIVE_TEXT,
  live_submit_off: RELAYER_NOT_LIVE_TEXT,
  quote_does_not_broadcast: RELAYER_NOT_LIVE_TEXT,
  rate_limited: "The claim relayer is limiting submissions. Wait a moment and try again. Nothing was sent.",
  too_many_requests: "The claim relayer is limiting submissions. Wait a moment and try again. Nothing was sent.",
  retired_or_superseded_address: RELAYER_RETIRED_TEXT,
  timeout_unknown: RELAYER_TIMEOUT_TEXT,
}

export const RELAYER_PLAIN_TEXT = [RELAYER_COULD_NOT_SUBMIT, RELAYER_UNAVAILABLE_TEXT, ...Object.values(RELAYER_PLAIN)]

export const RELAYER_USER_TEXT = [
  ...RELAYER_PLAIN_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_WAITING_TEXT,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_CHECK_WALLET_LABEL,
  RELAYER_PAUSED_NOTE,
  RELAYER_SECRET_NOTE,
  RELAYER_RECEIPT_UNKNOWN_TEXT,
  RELAYER_RECEIPT_REVERTED_TEXT,
  RELAYER_RETIRED_SENT_TEXT,
]

export function relayerConfigFromEnv(env: {
  VITE_CLAIM_RELAYER_URL?: string
  VITE_CLAIM_API_SECRET?: string
}): RelayerConfig {
  const url = String(env.VITE_CLAIM_RELAYER_URL ?? "").trim().replace(/\/$/, "")
  const secret = String(env.VITE_CLAIM_API_SECRET ?? "").trim()
  return {
    url: url.length > 0 ? url : null,
    secret: secret.length > 0 ? secret : null,
  }
}

/** Connected wallets must already be on Base Sepolia. A disconnected wallet can still use the relayer. */
export function relayerSubmitAllowed(input: {
  walletConnected: boolean
  walletChainId: WalletChainId
}): { ok: true } | { ok: false; reason: string } {
  if (!input.walletConnected) return { ok: true }
  const decision = evaluateEscrowSubmit(input)
  if (!decision.ok) return { ok: false, reason: decision.reason }
  return { ok: true }
}

export function assertRelayerChain(chainId: number): void {
  if (chainId === ETHEREUM_MAINNET_CHAIN_ID || chainId === BASE_MAINNET_CHAIN_ID) {
    throw new RelayerRequestError(
      `Chain id ${chainId} is mainnet. The claim relayer accepts Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) only.`,
      null,
      "mainnet_refused",
    )
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new RelayerRequestError(
      `Chain id ${chainId} is refused. The claim relayer accepts Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) only.`,
      null,
      "wrong_chain",
    )
  }
}

function isRelayerAction(name: string): name is RelayerAction {
  return (RELAYER_ACTIONS as readonly string[]).includes(name)
}

export function previewSupportsRelayer(functionName: string): boolean {
  return isRelayerAction(functionName)
}

export function relayerButtonModel(input: {
  url: string | null
  secret: string | null
  paused: boolean
  phase: RelayerPhase
  gate: { ok: true } | { ok: false; reason: string }
  action: string
}): RelayerButtonModel {
  if (!input.url || !previewSupportsRelayer(input.action)) return { visible: false }
  if (!input.gate.ok) return { visible: true, disabled: true, label: input.gate.reason, note: null }
  if (input.phase === "submitting") {
    return { visible: true, disabled: true, label: RELAYER_SUBMITTING_TEXT, note: null }
  }
  if (input.phase === "confirming") {
    return { visible: true, disabled: true, label: RELAYER_WAITING_TEXT, note: null }
  }
  if (input.paused) {
    return { visible: true, disabled: true, label: "Submit via claim relayer", note: RELAYER_PAUSED_NOTE }
  }
  if (!input.secret) {
    return { visible: true, disabled: true, label: "Submit via claim relayer", note: RELAYER_SECRET_NOTE }
  }
  return { visible: true, disabled: false, label: "Submit via claim relayer", note: null }
}

function asHex32(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new RelayerRequestError(`Claim relayer needs a bytes32 ${field}.`, null, "invalid_bytes32")
  }
  return value as Hex
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new RelayerRequestError(`Claim relayer needs an address ${field}.`, null, "invalid_address")
  }
  return value as Address
}

export function claimBodyFromPreview(preview: CallPreview): LiveClaimBody {
  assertRelayerChain(BASE_SEPOLIA_CHAIN_ID)
  if (preview.functionName === "openDispute") {
    throw new RelayerRequestError(
      "The claim relayer submits escrow actions only. openDispute stays on the connected wallet.",
      null,
      "action_not_claim",
    )
  }
  if (!isRelayerAction(preview.functionName)) {
    throw new RelayerRequestError(
      "The claim relayer submits createEscrow, release, refund, and dispute only.",
      null,
      "action_not_claim",
    )
  }
  const decoded = decodeFunctionData({ abi: escrowAbi, data: preview.calldata })
  if (decoded.functionName !== preview.functionName) {
    throw new RelayerRequestError("Calldata does not match the preview action.", null, "calldata_mismatch")
  }
  const args = decoded.args ?? []
  if (preview.functionName === "createEscrow") {
    const duration = args[4]
    if (typeof duration !== "bigint") {
      throw new RelayerRequestError("Claim relayer needs durationSeconds.", null, "invalid_duration")
    }
    if (preview.valueWei <= 0n) {
      throw new RelayerRequestError("createEscrow needs a positive value for the relayer.", null, "invalid_amount")
    }
    return {
      action: "createEscrow",
      claimId: asHex32(args[0], "escrowId"),
      payee: asAddress(args[1], "payee"),
      payerBotId: asHex32(args[2], "payerBotId"),
      payeeBotId: asHex32(args[3], "payeeBotId"),
      durationSeconds: duration.toString(),
      amountWei: preview.valueWei.toString(),
      chainId: BASE_SEPOLIA_CHAIN_ID,
      live: true,
    }
  }
  if (preview.functionName === "dispute") {
    return {
      action: "dispute",
      claimId: asHex32(args[0], "escrowId"),
      disputeId: asHex32(args[1], "disputeId"),
      chainId: BASE_SEPOLIA_CHAIN_ID,
      live: true,
    }
  }
  return {
    action: preview.functionName,
    claimId: asHex32(args[0], "escrowId"),
    chainId: BASE_SEPOLIA_CHAIN_ID,
    live: true,
  }
}

function claimsEndpoint(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL is not a valid URL.", null, "invalid_relayer_url")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL must be http or https.", null, "invalid_relayer_url")
  }
  if (parsed.username || parsed.password) {
    throw new RelayerRequestError("VITE_CLAIM_RELAYER_URL must not include credentials.", null, "invalid_relayer_url")
  }
  const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`
  return base.endsWith("/v1/claims") ? base : `${base}/v1/claims`
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text()
  if (!text) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function errorFromResponse(status: number, body: Record<string, unknown> | null): RelayerRequestError {
  const error = typeof body?.error === "string" ? body.error : "request_failed"
  const reason = typeof body?.reason === "string" ? body.reason : ""
  if (status === 401 || error === "unauthorized") {
    return new RelayerRequestError(
      "Claim relayer refused the live claim (401 unauthorized). Check VITE_CLAIM_API_SECRET against CLAIM_API_SECRET on the relayer.",
      401,
      "unauthorized",
      body,
    )
  }
  if (status === 503 && error === "claim_api_secret_required") {
    return new RelayerRequestError(
      "Claim relayer live submit is allowed but CLAIM_API_SECRET is unset (503 claim_api_secret_required). The claim was not broadcast.",
      503,
      "claim_api_secret_required",
      body,
    )
  }
  if (status === 503 && error === "kill_switch") {
    return new RelayerRequestError(
      "Claim relayer kill switch is on (503). The live claim was not broadcast.",
      503,
      "kill_switch",
      body,
    )
  }
  if (status === 503) {
    return new RelayerRequestError(
      `Claim relayer is unavailable (503 ${error}). The live claim was not broadcast.`,
      503,
      error,
      body,
    )
  }
  const detail = reason ? `${error} (${reason})` : error
  return new RelayerRequestError(
    `Claim relayer rejected the live claim (${status} ${detail}).`,
    status,
    codeForStatus(status, error),
    body,
  )
}

function codeForStatus(status: number, error: string): string {
  if (error !== "request_failed") return error
  if (status === 400 || status === 422) return "validation"
  if (status === 401) return "unauthorized"
  if (status === 403) return "forbidden"
  if (status === 404) return "not_found"
  if (status === 409) return "live_submit_blocked"
  if (status === 413) return "payload_too_large"
  if (status === 429) return "rate_limited"
  return error
}

function bodyRevertHex(body: Record<string, unknown> | null): unknown {
  if (!body) return null
  if ("revert_data" in body) return body.revert_data
  if ("revertData" in body) return body.revertData
  if ("data" in body) return body.data
  return null
}

function withStatus(detail: string | null, status: number | null, code: string): string {
  const statusText = [status, code].filter((part) => part !== null && part !== "").join(" ")
  if (!detail) return `Details: ${statusText}`
  return `${detail} · ${statusText}`
}

function isRetiredEscrow(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === SUPERSEDED.botAttestationEscrow.toLowerCase()
}

function txHashFromBody(body: Record<string, unknown> | null): Hex | null {
  const txHash = body?.txHash
  if (typeof txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(txHash)) return txHash as Hex
  return null
}

function isRetiredResponse(error: RelayerRequestError): boolean {
  if (error.code === "retired_or_superseded_address") return true
  if (!error.body) return false
  return isRetiredEscrow(error.body.escrowAddress) || isRetiredEscrow(error.body.address)
}

function plainLine(code: string): string | null {
  return RELAYER_PLAIN[code] ?? null
}

function statusFallback(status: number | null): string | null {
  if (status === 400 || status === 422) return RELAYER_VALIDATION_TEXT
  if (status === 401 || status === 403) return plainLine("unauthorized")
  if (status === 404) return plainLine("not_found")
  if (status === 409) return RELAYER_NOT_LIVE_TEXT
  if (status === 413) return plainLine("payload_too_large")
  if (status === 429) return plainLine("rate_limited")
  if (status === 503) return RELAYER_UNAVAILABLE_TEXT
  return null
}

function plainFor(error: RelayerRequestError): string {
  if (error.code === "live_submit_blocked") {
    const reason = typeof error.body?.reason === "string" ? error.body.reason : ""
    const byReason = reason ? plainLine(reason) : null
    if (byReason) return byReason
  }
  return plainLine(error.code) ?? statusFallback(error.status) ?? RELAYER_COULD_NOT_SUBMIT
}

function withLink(presentation: ErrorPresentation, href: string, label: string): ErrorPresentation {
  return { ...presentation, link: { href, label } }
}

/** User-facing relayer failure. Raw status and codes stay in the details line. */
export function presentRelayerError(error: unknown): ErrorPresentation {
  if (!(error instanceof RelayerRequestError)) return presentError(error)
  const detail = withStatus(null, error.status, error.code)
  if (error.code === "broadcast_failed") {
    const decoded = presentRevertHex(bodyRevertHex(error.body))
    if (decoded) return { main: decoded.main, detail: withStatus(decoded.detail, error.status, error.code) }
    return { main: RELAYER_COULD_NOT_SUBMIT, detail }
  }
  if (isRetiredResponse(error)) {
    const hash = txHashFromBody(error.body)
    if (hash) {
      return withLink(
        { main: RELAYER_RETIRED_SENT_TEXT, detail },
        relayerTxUrl(hash),
        RELAYER_TX_LINK_LABEL,
      )
    }
    return { main: RELAYER_RETIRED_TEXT, detail }
  }
  if (error.code === "timeout_unknown") {
    return withLink({ main: RELAYER_TIMEOUT_TEXT, detail }, relayerWalletUrl(), RELAYER_CHECK_WALLET_LABEL)
  }
  return { main: plainFor(error), detail }
}

export function relayerErrorText(error: unknown): string {
  if (error instanceof RelayerRequestError) return error.message
  if (error instanceof Error && error.message.length > 0) return error.message
  return "Claim relayer request failed."
}

/**
 * POST /v1/claims with live:true. Sends x-claim-secret only when a secret is set.
 * Chain id must be Base Sepolia (84532). Mainnet is refused before fetch.
 */
function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false
  const name = String((error as { name: unknown }).name)
  return name === "AbortError" || name === "TimeoutError"
}

function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort()
      reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))
    }, timeoutMs)
    fetchImpl(url, { ...init, signal: controller.signal }).then(
      (response) => {
        clearTimeout(timer)
        resolve(response)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        if (isAbort(cause) || controller.signal.aborted) {
          reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }))
          return
        }
        reject(cause)
      },
    )
  })
}

function addressOrNull(value: unknown): Address | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null
  return value as Address
}

export async function postLiveClaim(input: {
  url: string
  secret?: string | null
  body: LiveClaimBody
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<LiveClaimResult> {
  assertRelayerChain(input.body.chainId)
  if (input.body.live !== true) {
    throw new RelayerRequestError("Relayer submits must set live: true.", null, "live_required")
  }
  const endpoint = claimsEndpoint(input.url)
  const headers: Record<string, string> = { "content-type": "application/json" }
  const secret = String(input.secret ?? "").trim()
  if (secret) headers["x-claim-secret"] = secret
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(input.body),
      },
      input.timeoutMs ?? RELAYER_FETCH_TIMEOUT_MS,
    )
  } catch (cause) {
    if (cause instanceof RelayerRequestError) throw cause
    if (isAbort(cause)) {
      throw new RelayerRequestError(
        "The claim relayer did not answer before the page stopped waiting. The submission may still have been accepted.",
        null,
        "timeout_unknown",
      )
    }
    throw new RelayerRequestError(
      "Could not reach the claim relayer. If this is the Pages site, CORS on Render must allow this origin (https://agent-a-wallet-ux.pages.dev) and the x-claim-secret header.",
      null,
      "cors_or_network",
    )
  }
  const json = await readJson(response)
  if (!response.ok) throw errorFromResponse(response.status, json)
  const txHash = json?.txHash
  if (json?.ok !== true || json.mode !== "live" || typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new RelayerRequestError("Claim relayer did not return a live transaction hash.", response.status, "missing_tx_hash")
  }
  const escrowAddress = addressOrNull(json.escrowAddress)
  if (escrowAddress && isRetiredEscrow(escrowAddress)) {
    throw new RelayerRequestError(
      "Claim relayer targeted a retired escrow.",
      response.status,
      "retired_or_superseded_address",
      json,
    )
  }
  return { txHash: txHash as Hex, mode: "live", escrowAddress }
}

export async function readRelayerPaused(input: {
  url: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<boolean | null> {
  let endpoint: string
  try {
    const parsed = new URL(input.url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    if (parsed.username || parsed.password) return null
    endpoint = `${parsed.origin}/health`
  } catch {
    return null
  }
  try {
    const response = await fetchWithTimeout(
      input.fetchImpl ?? fetch,
      endpoint,
      { method: "GET" },
      input.timeoutMs ?? RELAYER_HEALTH_TIMEOUT_MS,
    )
    if (!response.ok) return null
    const json = await readJson(response)
    if (!json || typeof json.killSwitch !== "boolean") return null
    return json.killSwitch
  } catch {
    return null
  }
}

export type RelayerReceiptClient = {
  waitForTransactionReceipt: (args: { hash: Hex; timeout?: number }) => Promise<{ status: "success" | "reverted" }>
}

function isReceiptTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = "name" in error ? String((error as { name: unknown }).name) : ""
  return name === "WaitForTransactionReceiptTimeoutError" || name === "TimeoutError" || name === "AbortError"
}

function presentReceiptRevert(cause: unknown | null): ErrorPresentation {
  if (!cause) return { main: RELAYER_RECEIPT_REVERTED_TEXT, detail: null }
  const presented = presentError(cause)
  if (presented.main === REVERT_FALLBACK_TEXT || presented.main === "Something went wrong. Nothing was sent.") {
    return { main: RELAYER_RECEIPT_REVERTED_TEXT, detail: presented.detail }
  }
  return presented
}

export async function confirmRelayerReceipt(input: {
  client: RelayerReceiptClient & Partial<PreflightClient>
  hash: Hex
  timeoutMs?: number
  replay?: { to: Address; data: Hex; value: bigint }
}): Promise<{ status: "success" } | { status: "reverted"; cause: unknown | null } | { status: "unknown" }> {
  let receipt: { status: "success" | "reverted" }
  try {
    receipt = await input.client.waitForTransactionReceipt({
      hash: input.hash,
      timeout: input.timeoutMs ?? RELAYER_RECEIPT_TIMEOUT_MS,
    })
  } catch (cause) {
    if (isReceiptTimeout(cause) || cause instanceof Error) return { status: "unknown" }
    return { status: "unknown" }
  }
  if (receipt.status === "success") return { status: "success" }
  if (receipt.status !== "reverted") return { status: "unknown" }
  if (!input.replay || !input.client.call) return { status: "reverted", cause: null }
  try {
    await input.client.call({
      account: CLAIM_RELAYER_WALLET,
      to: input.replay.to,
      data: input.replay.data,
      value: input.replay.value,
    })
    return { status: "reverted", cause: null }
  } catch (cause) {
    return { status: "reverted", cause }
  }
}

/**
 * Simulate as the relayer wallet, POST /v1/claims, then wait for the receipt.
 * A timed-out POST does not claim that nothing was broadcast.
 */
export async function runRelayerSubmission(input: {
  url: string
  secret?: string | null
  preview: CallPreview
  client: PreflightClient & RelayerReceiptClient
  fetchImpl?: typeof fetch
  fetchTimeoutMs?: number
  receiptTimeoutMs?: number
  onPhase?: (phase: RelayerPhase, txHash?: Hex) => void
}): Promise<RelayerRunResult> {
  input.onPhase?.("submitting")
  let posted: LiveClaimResult
  try {
    posted = await submitRelayerAfterPreflight({
      client: input.client,
      to: input.preview.to,
      data: input.preview.calldata,
      value: input.preview.valueWei,
      post: () =>
        postLiveClaim({
          url: input.url,
          secret: input.secret,
          body: claimBodyFromPreview(input.preview),
          fetchImpl: input.fetchImpl,
          timeoutMs: input.fetchTimeoutMs,
        }),
    })
  } catch (cause) {
    return {
      ok: false,
      txHash: txHashFromBody(cause instanceof RelayerRequestError ? cause.body : null),
      code: cause instanceof RelayerRequestError ? cause.code : null,
      presentation: presentRelayerError(cause),
    }
  }

  input.onPhase?.("confirming", posted.txHash)
  const receipt = await confirmRelayerReceipt({
    client: input.client,
    hash: posted.txHash,
    timeoutMs: input.receiptTimeoutMs,
    replay: { to: input.preview.to, data: input.preview.calldata, value: input.preview.valueWei },
  })
  if (receipt.status === "success") return { ok: true, txHash: posted.txHash }
  if (receipt.status === "reverted") {
    return {
      ok: false,
      txHash: posted.txHash,
      code: "receipt_reverted",
      presentation: withLink(presentReceiptRevert(receipt.cause), relayerTxUrl(posted.txHash), RELAYER_TX_LINK_LABEL),
    }
  }
  return {
    ok: false,
    txHash: posted.txHash,
    code: "receipt_unknown",
    presentation: withLink(
      { main: RELAYER_RECEIPT_UNKNOWN_TEXT, detail: null },
      relayerTxUrl(posted.txHash),
      RELAYER_TX_LINK_LABEL,
    ),
  }
}
