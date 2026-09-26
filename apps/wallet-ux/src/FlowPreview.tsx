import { useEffect, useRef, useState, type FormEvent } from "react"
import { formatEther, isAddress, parseEther, type Address, type Hex } from "viem"
import { useAccount, usePublicClient, useSendTransaction } from "wagmi"
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
  previewOpenDispute,
  previewRefund,
  previewRelease,
  type CallPreview,
} from "./preview"
import {
  readRelayerPaused,
  RELAYER_CONFIRMED_TEXT,
  RELAYER_SUBMITTED_TEXT,
  RELAYER_SUBMITTING_TEXT,
  RELAYER_TX_LINK_LABEL,
  RELAYER_WAITING_TEXT,
  relayerButtonModel,
  relayerConfigFromEnv,
  relayerSubmitAllowed,
  relayerTxUrl,
  runRelayerSubmission,
  type RelayerPhase,
} from "./relayer"
import { submitAfterPreflight } from "./preflight"
import { assertSubmitTarget, evaluateEscrowSubmit, submitControl, submitSenderNote } from "./submit"
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
  const { sendTransactionAsync, isPending } = useSendTransaction()
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [submitError, setSubmitError] = useState<ErrorPresentation | null>(null)
  const [relayerPhase, setRelayerPhase] = useState<RelayerPhase>("idle")
  const [relayerPaused, setRelayerPaused] = useState(false)
  const [pendingHash, setPendingHash] = useState<Hex | null>(null)
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const relayerFlight = useRef(false)
  const relayer = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
    VITE_CLAIM_API_SECRET: import.meta.env.VITE_CLAIM_API_SECRET,
  })
  const relayerGate = relayerSubmitAllowed({ walletConnected: account.isConnected, walletChainId })
  const relayerBusy = relayerPhase !== "idle"
  const control = submitControl(decision, isPending || relayerBusy)
  const relayerButton = relayerButtonModel({
    url: relayer.url,
    secret: relayer.secret,
    paused: relayerPaused,
    phase: relayerPhase,
    gate: relayerGate,
    action: preview.functionName,
  })

  useEffect(() => {
    if (!relayer.url) return
    let cancelled = false
    void readRelayerPaused({ url: relayer.url }).then((paused) => {
      if (!cancelled && paused != null) setRelayerPaused(paused)
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
    if (!relayer.url || !relayer.secret || relayerPaused) return
    if (!publicClient) {
      setTxHash(null)
      setSubmitError(notice("The network client isn't ready, so nothing was sent."))
      return
    }
    relayerFlight.current = true
    setRelayerPhase("submitting")
    setTxHash(null)
    try {
      assertSubmitTarget(preview.to, [escrow, panel])
      const url = relayer.url
      const secret = relayer.secret
      const outcome = await runRelayerSubmission({
        url,
        secret,
        preview,
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
      if (outcome.code === "kill_switch") setRelayerPaused(true)
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
      <p>
        Calldata for <strong>{preview.functionName}</strong>. Submit sends it from the connected wallet on Base Sepolia
        only.
        {relayerConfigured
          ? " Escrow actions can also be posted live to the Base Sepolia claim relayer."
          : ""}
      </p>
      <p className="mono">to {preview.to}</p>
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
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} spellCheck={false} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  )
}

export function FlowPreview({ escrow, panel }: { escrow: Address; panel: Address }) {
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CallPreview | null>(null)
  const relayerConfigured = relayerConfigFromEnv({
    VITE_CLAIM_RELAYER_URL: import.meta.env.VITE_CLAIM_RELAYER_URL,
    VITE_CLAIM_API_SECRET: import.meta.env.VITE_CLAIM_API_SECRET,
  }).url != null

  function show(next: CallPreview) {
    setError(null)
    setPreview(next)
  }

  return (
    <div>
      <h3>Calldata preview</h3>
      <p className="muted">
        Forms build calldata, then the connected wallet can submit on Base Sepolia (chain id {BASE_SEPOLIA_CHAIN_ID}).
        Ethereum mainnet and Base mainnet are refused. There is no EIP-712 stamp.
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
        title="release(escrowId)"
        onSubmit={(escrowId) => show(previewRelease(escrow, escrowId))}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <IdForm
        idPrefix="refund"
        title="refund(escrowId)"
        onSubmit={(escrowId) => show(previewRefund(escrow, escrowId))}
        onError={(message) => {
          setPreview(null)
          setError(message)
        }}
      />
      <OpenDisputeForm
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
      onError("createEscrow needs three bytes32 values.")
      return
    }
    if (!isAddress(payee)) {
      onError("payee must be an address.")
      return
    }
    const durationSeconds = Number(duration)
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
      onError(`durationSeconds must be a whole number from 1 through ${MAX_DURATION_SECONDS} (30 days).`)
      return
    }
    let valueWei: bigint
    try {
      valueWei = parseEther(value.trim())
    } catch {
      onError("value must be an ETH amount, such as 0.01.")
      return
    }
    if (valueWei <= 0n) {
      onError("value must be greater than 0. The preview still is not sent.")
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
      <h3>createEscrow</h3>
      <Field id="create-id" label="escrowId" value={escrowId} onChange={setEscrowId} />
      <Field id="create-payee" label="payee" value={payee} onChange={setPayee} />
      <Field id="create-payer-bot" label="payerBotId" value={payerBotId} onChange={setPayerBotId} />
      <Field id="create-payee-bot" label="payeeBotId" value={payeeBotId} onChange={setPayeeBotId} />
      <Field
        id="create-duration"
        label="durationSeconds"
        value={duration}
        onChange={setDuration}
        hint={`Greater than 0 and at most ${MAX_DURATION_SECONDS} (30 days).`}
      />
      <Field
        id="create-value"
        label="value (ETH)"
        value={value}
        onChange={setValue}
        hint="This is msg.value if you submit on Base Sepolia. The connected wallet must be the payer's Vault operator."
      />
      <button type="submit">Build createEscrow calldata</button>
    </form>
  )
}

function IdForm({
  idPrefix,
  title,
  onSubmit,
  onError,
}: {
  idPrefix: string
  title: string
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
          onError(`${title} needs a bytes32 escrowId.`)
          return
        }
        onSubmit(id)
      }}
    >
      <h3>{title}</h3>
      <Field id={`${idPrefix}-id`} label="escrowId" value={escrowId} onChange={setEscrowId} />
      <button type="submit">Build {title} calldata</button>
    </form>
  )
}

function OpenDisputeForm({
  panel,
  onPreview,
  onError,
}: {
  panel: Address
  onPreview: (preview: CallPreview) => void
  onError: (message: string) => void
}) {
  const [disputeId, setDisputeId] = useState("")
  const [subjectHash, setSubjectHash] = useState("")
  const [reason, setReason] = useState("")

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const id = parseBytes32(disputeId)
        const subject = parseBytes32(subjectHash)
        if (!id || !subject) {
          onError("openDispute needs disputeId and subjectHash bytes32 values. subjectHash is the escrow id.")
          return
        }
        if (reason.trim().length === 0) {
          onError("openDispute needs a reason string.")
          return
        }
        onPreview(previewOpenDispute(panel, id, subject, reason.trim()))
      }}
    >
      <h3>DisputePanel.openDispute</h3>
      <Field id="open-dispute-id" label="disputeId" value={disputeId} onChange={setDisputeId} />
      <Field
        id="open-subject"
        label="subjectHash"
        value={subjectHash}
        onChange={setSubjectHash}
        hint="Use the escrow id. The panel stores this as the subject."
      />
      <Field id="open-reason" label="reason" value={reason} onChange={setReason} />
      <button type="submit">Build openDispute calldata</button>
      <p className="hint">Target {panel}</p>
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
        if (!id || !dispute) {
          onError("dispute() needs escrowId and disputeId bytes32 values.")
          return
        }
        onPreview(previewDispute(escrow, id, dispute))
      }}
    >
      <h3>Escrow.dispute</h3>
      <Field id="escrow-dispute-id" label="escrowId" value={escrowId} onChange={setEscrowId} />
      <Field id="escrow-dispute-panel-id" label="disputeId" value={disputeId} onChange={setDisputeId} />
      <button type="submit">Build dispute calldata</button>
    </form>
  )
}
