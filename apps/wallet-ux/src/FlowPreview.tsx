import { useEffect, useRef, useState, type FormEvent } from "react"
import { formatEther, isAddress, parseEther, type Address, type Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction, useWalletClient } from "wagmi"
import { BASE_SEPOLIA_CHAIN_ID } from "./addresses"
import { parseBytes32 } from "./bytes32"
import { ErrorNotice } from "./ErrorNotice"
import { presentError, type ErrorPresentation } from "./format"
import { resolveWalletChainId } from "./guard"
import {
  ERROR_GLOSSARY,
  MAX_DURATION_SECONDS,
  previewCreateEscrow,
  previewDispute,
  panelSubject,
  previewOpenDispute,
  previewRefund,
  previewRelease,
  type CallPreview,
} from "./preview"
import {
  readRelayerHealth,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_CONNECT_NOTE,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_WAITING_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerSubmitAllowed,
  relayerTxUrl,
  runRelayerSubmission,
  type RelayerHealth,
  type RelayerPhase,
} from "./relayer"
import { submitAfterPreflight } from "./preflight"
import {
  assertSubmitTarget,
  durationValidationMessage,
  evaluateEscrowSubmit,
  FORM_ERRORS,
  previewCardCopy,
  submitControl,
  submitSenderNote,
} from "./submit"
import { useConnectorChainId } from "./useWalletChain"

function notice(main: string): ErrorPresentation {
  return { main, detail: null }
}

function SepoliaSubmit({ preview, escrow, panel }: { preview: CallPreview; escrow: Address; panel: Address }) {
  const account = useAccount()
  const connectorChainId = useConnectorChainId(account.connector, account.isConnected)
  const walletChainId = account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null
  const decision = evaluateEscrowSubmit({ walletConnected: account.isConnected, walletChainId })
  const publicClient = usePublicClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { data: walletClient } = useWalletClient({ chainId: BASE_SEPOLIA_CHAIN_ID })
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const [relayerPhase, setRelayerPhase] = useState<RelayerPhase>("idle")
  const [relayerHealth, setRelayerHealth] = useState<RelayerHealth>("unknown")
  const [pendingHash, setPendingHash] = useState<Hex | null>(null)
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const relayerFlight = useRef(false)
  const relayer = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  })
  const relayerGate = relayerSubmitAllowed({ walletConnected: account.isConnected, walletChainId })
  const relayerBusy = relayerPhase !== "idle"
  const control = submitControl(decision, isPending || relayerBusy)
  const relayerButton = relayerButtonModel({
    url: relayer.url,
    health: relayerHealth,
    phase: relayerPhase,
    gate: relayerGate,
    action: preview.functionName,
  })

  useEffect(() => {
    if (!relayer.url) return
    let cancelled = false
    void readRelayerHealth({ url: relayer.url }).then((health) => {
      if (!cancelled) setRelayerHealth(health)
    })
    return () => {
      cancelled = true
    }
  }, [relayer.url])

  async function onClick() {
    setSubmitError(null)
    setConfirmedHash(null)
    setPendingHash(null)
    const current = evaluateEscrowSubmit({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!current.ok) {
      setTxHash(null)
      setSubmitError(notice(current.reason))
      return
    }
    try {
      assertSubmitTarget(preview.to, [escrow, panel])
      if (!publicClient) {
        setTxHash(null)
        setSubmitError(notice("Base Sepolia client is unavailable. The wallet was not opened."))
        return
      }
      const hash = await submitAfterPreflight({
        chainId: BASE_SEPOLIA_CHAIN_ID,
        client: publicClient,
        account: account.address,
        to: preview.to,
        data: preview.calldata,
        value: preview.valueWei,
        send: () =>
          sendTransactionAsync({
            to: preview.to,
            data: preview.calldata,
            value: preview.valueWei,
            chainId: BASE_SEPOLIA_CHAIN_ID,
          }),
      })
      setTxHash(hash)
    } catch (cause) {
      setTxHash(null)
      setSubmitError(presentError(cause))
    }
  }

  async function onRelayer() {
    if (relayerFlight.current) return
    setSubmitError(null)
    setConfirmedHash(null)
    setPendingHash(null)
    const gate = relayerSubmitAllowed({
      walletConnected: account.isConnected,
      walletChainId: account.isConnected ? resolveWalletChainId(account.chainId, connectorChainId) : null,
    })
    if (!gate.ok) {
      setTxHash(null)
      setSubmitError(notice(gate.reason))
      return
    }
    if (!relayer.url || relayerHealth !== "ok") return
    if (!publicClient) {
      setTxHash(null)
      setSubmitError(notice("The network client isn't ready, so nothing was sent."))
      return
    }
    if (!account.address || !walletClient) {
      setTxHash(null)
      setSubmitError(notice(RELAYER_CONNECT_NOTE))
      return
    }
    const signer = walletClient
    const sender = account.address
    relayerFlight.current = true
    setRelayerPhase("submitting")
    setTxHash(null)
    try {
      assertSubmitTarget(preview.to, [escrow, panel])
      const url = relayer.url
      const outcome = await runRelayerSubmission({
        url,
        preview,
        sender,
        verifyingContract: escrow,
        signTypedData: (args) => signer.signTypedData(args),
        client: publicClient,
        onPhase: (phase, hash) => {
          setRelayerPhase(phase)
          if (hash) setPendingHash(hash)
        },
      })
      if (outcome.ok) {
        setPendingHash(null)
        setConfirmedHash(outcome.txHash)
        return
      }
      setPendingHash(null)
      setSubmitError(outcome.presentation)
      if (outcome.code === "kill_switch") setRelayerHealth("paused")
    } catch (cause) {
      setPendingHash(null)
      setSubmitError(presentError(cause))
    } finally {
      relayerFlight.current = false
      setRelayerPhase("idle")
    }
  }

  return (
    <div>
      <p>{submitSenderNote(preview.functionName)}</p>
      <button type="button" data-testid={control.testId} disabled={control.disabled} onClick={() => void onClick()}>
        {control.label}
      </button>
      {relayerButton.visible ? (
        <div data-testid="relayer-panel">
          <p>Submit through the claim relayer, or from your wallet.</p>
          {relayerButton.note ? (
            <p className="relayer-pending" role="status" data-testid="relayer-note">
              {relayerButton.note}
            </p>
          ) : null}
          {relayerPhase === "submitting" ? (
            <p className="relayer-pending" role="status" data-testid="relayer-status">
              {RELAYER_SUBMITTING_TEXT}
            </p>
          ) : null}
          {relayerPhase === "confirming" && pendingHash ? (
            <div className="relayer-pending" role="status" data-testid="relayer-status">
              <p>{RELAYER_WAITING_TEXT}</p>
              <p>{RELAYER_SUBMITTED_TEXT}</p>
              <p>
                <a href={relayerTxUrl(pendingHash)} data-testid="relayer-tx-link">
                  {RELAYER_TX_LINK_LABEL}
                </a>
              </p>
            </div>
          ) : null}
          <button
            type="button"
            data-testid="relayer-submit"
            disabled={relayerButton.disabled || isPending}
            aria-busy={relayerBusy}
            onClick={() => void onRelayer()}
          >
            {relayerButton.label}
          </button>
        </div>
      ) : null}
      {confirmedHash ? (
        <div className="relayer-ok" role="status" data-testid="relayer-result">
          <p>{RELAYER_SUBMITTED_TEXT}</p>
          <p>{RELAYER_CONFIRMED_TEXT}</p>
          <p>
            <a href={relayerTxUrl(confirmedHash)} data-testid="relayer-tx-link">
              {RELAYER_TX_LINK_LABEL}
            </a>
          </p>
        </div>
      ) : null}
      {submitError ? (
        <ErrorNotice main={submitError.main} detail={submitError.detail} link={submitError.link} />
      ) : null}
      {txHash ? (
        <p className="mono" data-testid="submit-tx">
          Submitted {txHash}
        </p>
      ) : null}
    </div>
  )
}

function PreviewBlock({
  preview,
  escrow,
  panel,
  relayerConfigured,
}: {
  preview: CallPreview | null
  escrow: Address
  panel: Address
  relayerConfigured: boolean
}) {
  if (!preview) return null
  return (
    <div className="preview" data-testid="calldata-preview">
      <p>{previewCardCopy(preview.functionName, relayerConfigured)}</p>
      <p className="mono">{preview.to}</p>
      <p>value {formatEther(preview.valueWei)} ETH</p>
      <pre className="calldata">{preview.calldata}</pre>
      <SepoliaSubmit key={preview.calldata} preview={preview} escrow={escrow} panel={panel} />
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  readOnly = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  readOnly?: boolean
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        spellCheck={false}
        autoComplete="off"
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

function parseCreatedAt(value: string): bigint | null {
  const text = value.trim()
  if (!/^[0-9]+$/.test(text)) return null
  const parsed = BigInt(text)
  if (parsed >= 2n ** 256n) return null
  return parsed
}

export function FlowPreview({ escrow, panel }: { escrow: Address; panel: Address }) {
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)
  const relayerConfigured = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
  }).url != null

  function show(next: CallPreview) {
    setError(null)
    setPreview(next)
  }

  return (
    <div>
      <h3>Prepared transaction</h3>
      <p className="muted">
        These forms prepare a transaction, then the connected wallet can submit it on Base Sepolia, chain{" "}
        {BASE_SEPOLIA_CHAIN_ID}. Ethereum mainnet and Base mainnet are refused.
      </p>
      <CreateForm
        escrow={escrow}
        onPreview={show}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <IdForm
        idPrefix="release"
        title="Release a claim"
        buttonLabel="Prepare this payout"
        missingId={FORM_ERRORS.releaseId}
        onSubmit={(escrowId) => show(previewRelease(escrow, escrowId))}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <IdForm
        idPrefix="refund"
        title="Refund a claim"
        buttonLabel="Prepare this refund"
        missingId={FORM_ERRORS.refundId}
        onSubmit={(escrowId) => show(previewRefund(escrow, escrowId))}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <OpenDisputeForm
        escrow={escrow}
        panel={panel}
        onPreview={show}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <DisputeForm
        escrow={escrow}
        onPreview={show}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      <PreviewBlock preview={preview} escrow={escrow} panel={panel} relayerConfigured={relayerConfigured} />
      <h3>Revert glossary</h3>
      <dl className="glossary">
        {ERROR_GLOSSARY.map((entry) => (
          <div key={entry.name}>
            <dt>{entry.name}</dt>
            <dd>{entry.meaning}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function CreateForm({
  escrow,
  onPreview,
  onError,
}: {
  escrow: Address
  onPreview: (preview: CallPreview) => void
  onError: (message: string) => void
}) {
  const [escrowId, setEscrowId] = useState("")
  const [payee, setPayee] = useState("")
  const [payerBotId, setPayerBotId] = useState("")
  const [payeeBotId, setPayeeBotId] = useState("")
  const [duration, setDuration] = useState("86400")
  const [value, setValue] = useState("0.01")

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const id = parseBytes32(escrowId)
    const payerBot = parseBytes32(payerBotId)
    const payeeBot = parseBytes32(payeeBotId)
    if (!id || !payerBot || !payeeBot) {
      onError(FORM_ERRORS.createIds)
      return
    }
    if (!isAddress(payee)) {
      onError(FORM_ERRORS.payee)
      return
    }
    const durationSeconds = Number(duration)
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
      onError(durationValidationMessage(MAX_DURATION_SECONDS))
      return
    }
    let valueWei: bigint
    try {
      valueWei = parseEther(value.trim())
    } catch {
      onError(FORM_ERRORS.valueFormat)
      return
    }
    if (valueWei <= 0n) {
      onError(FORM_ERRORS.valueZero)
      return
    }
    onPreview(
      previewCreateEscrow({
        escrow,
        escrowId: id,
        payee,
        payerBotId: payerBot,
        payeeBotId: payeeBot,
        durationSeconds: BigInt(durationSeconds),
        valueWei,
      }),
    )
  }

  return (
    <form onSubmit={onSubmit}>
      <h3>Create a claim</h3>
      <Field id="create-id" label="Claim identifier" value={escrowId} onChange={setEscrowId} />
      <Field id="create-payee" label="Payee wallet" value={payee} onChange={setPayee} />
      <Field id="create-payer-bot" label="Payer bot identifier" value={payerBotId} onChange={setPayerBotId} />
      <Field id="create-payee-bot" label="Payee bot identifier" value={payeeBotId} onChange={setPayeeBotId} />
      <Field
        id="create-duration"
        label="Time window in seconds"
        value={duration}
        onChange={setDuration}
        hint={`Greater than 0 and at most ${MAX_DURATION_SECONDS}, which is 30 days.`}
      />
      <Field
        id="create-value"
        label="Amount in ETH"
        value={value}
        onChange={setValue}
        hint="This amount is sent with the transaction on Base Sepolia. The connected wallet must be allowed to fund claims for the payer."
      />
      <button type="submit">Prepare this claim</button>
    </form>
  )
}

function IdForm({
  idPrefix,
  title,
  buttonLabel,
  missingId,
  onSubmit,
  onError,
}: {
  idPrefix: string
  title: string
  buttonLabel: string
  missingId: string
  onSubmit: (escrowId: `0x${string}`) => void
  onError: (message: string) => void
}) {
  const [escrowId, setEscrowId] = useState("")
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(escrowId)
        if (!id) {
          onError(missingId)
          return
        }
        onSubmit(id)
      }}
    >
      <h3>{title}</h3>
      <Field id={`${idPrefix}-id`} label="Claim identifier" value={escrowId} onChange={setEscrowId} />
      <button type="submit">{buttonLabel}</button>
    </form>
  )
}

function OpenDisputeForm({
  escrow,
  panel,
  onPreview,
  onError,
}: {
  escrow: Address
  panel: Address
  onPreview: (preview: CallPreview) => void
  onError: (message: string) => void
}) {
  const [disputeId, setDisputeId] = useState("")
  const [claimId, setClaimId] = useState("")
  const [createdAt, setCreatedAt] = useState("")
  const [reason, setReason] = useState("")
  const parsedClaim = parseBytes32(claimId)
  const parsedCreatedAt = parseCreatedAt(createdAt)
  const subjectHash =
    parsedClaim && parsedCreatedAt !== null ? panelSubject(escrow, parsedClaim, parsedCreatedAt) : ""

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(disputeId)
        const claim = parseBytes32(claimId)
        const created = parseCreatedAt(createdAt)
        if (!id || !claim || created === null) {
          onError(FORM_ERRORS.openIds)
          return
        }
        if (reason.trim().length === 0) {
          onError(FORM_ERRORS.openReason)
          return
        }
        onPreview(previewOpenDispute(panel, id, panelSubject(escrow, claim, created), reason.trim()))
      }}
    >
      <h3>Open a dispute</h3>
      <Field id="open-dispute-id" label="Dispute identifier" value={disputeId} onChange={setDisputeId} />
      <Field id="open-claim-id" label="Claim identifier" value={claimId} onChange={setClaimId} />
      <Field
        id="open-created-at"
        label="Time the claim was created"
        value={createdAt}
        onChange={setCreatedAt}
        hint="Seconds since 1970, the same time stored when the claim was created."
      />
      <Field
        id="open-subject"
        label="Subject"
        value={subjectHash}
        onChange={() => undefined}
        readOnly
        hint="Filled from the claim identifier and the time the claim was created. The panel stores this subject."
      />
      <Field id="open-reason" label="Reason" value={reason} onChange={setReason} />
      <button type="submit">Prepare this dispute</button>
      <p className="mono">{panel}</p>
    </form>
  )
}

function DisputeForm({
  escrow,
  onPreview,
  onError,
}: {
  escrow: Address
  onPreview: (preview: CallPreview) => void
  onError: (message: string) => void
}) {
  const [escrowId, setEscrowId] = useState("")
  const [disputeId, setDisputeId] = useState("")
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(escrowId)
        const dispute = parseBytes32(disputeId)
        if (!id) {
          onError(FORM_ERRORS.disputeClaim)
          return
        }
        if (!dispute) {
          onError(FORM_ERRORS.disputeId)
          return
        }
        onPreview(previewDispute(escrow, id, dispute))
      }}
    >
      <h3>Link a dispute</h3>
      <Field id="escrow-dispute-id" label="Claim identifier" value={escrowId} onChange={setEscrowId} />
      <Field id="escrow-dispute-panel-id" label="Dispute identifier" value={disputeId} onChange={setDisputeId} />
      <button type="submit">Prepare this dispute link</button>
    </form>
  )
}
