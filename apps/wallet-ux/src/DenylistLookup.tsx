import { useEffect, useState, type FormEvent } from "react"
import { matchLevelLabel, parseBytes32 } from "./bytes32"
import { errorText } from "./format"
import { readCheck, readMembership, type Membership, type SepoliaClient } from "./read"
import { FORM_ERRORS } from "./submit"

export function DenylistLookup({
  client,
  enabled,
  blockedReason,
}: {
  client: SepoliaClient
  enabled: boolean
  blockedReason: string | null
}) {
  const [hash, setHash] = useState("")
  const [weight, setWeight] = useState("")
  const [signature, setSignature] = useState("")
  const [prompt, setPrompt] = useState("")
  const [membership, setMembership] = useState<Membership | null>(null)
  const [level, setLevel] = useState<number | null>(null)
  const [pending, setPending] = useState<"membership" | "check" | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setMembership(null)
    setLevel(null)
    setError(null)
    setPending(null)
  }, [enabled])

  async function onMembership(event: FormEvent) {
    event.preventDefault()
    setMembership(null)
    setError(null)
    const parsed = parseBytes32(hash)
    if (!parsed) {
      setError(FORM_ERRORS.denylistHash)
      return
    }
    if (!enabled) {
      setError(blockedReason ?? "Reads are paused.")
      return
    }
    setPending("membership")
    try {
      setMembership(await readMembership(client, parsed))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(null)
    }
  }

  async function onCheck(event: FormEvent) {
    event.preventDefault()
    setLevel(null)
    setError(null)
    const weightHash = parseBytes32(weight)
    const behaviorSig = parseBytes32(signature)
    const promptHash = parseBytes32(prompt)
    if (!weightHash || !behaviorSig || !promptHash) {
      setError(FORM_ERRORS.denylistCheck)
      return
    }
    if (!enabled) {
      setError(blockedReason ?? "Reads are paused.")
      return
    }
    setPending("check")
    try {
      setLevel(await readCheck(client, weightHash, behaviorSig, promptHash))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="card" aria-labelledby="lookup-heading">
      <h2 id="lookup-heading">Denylist lookup</h2>
      <p className="muted">View calls only. Nothing is signed or sent.</p>
      {blockedReason ? <p className="muted">{blockedReason}</p> : null}

      <form onSubmit={(event) => void onMembership(event)}>
        <div className="field">
          <label htmlFor="hash-id">Hash</label>
          <input
            id="hash-id"
            value={hash}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || pending !== null}
            placeholder="0x…64 hex chars"
            onChange={(event) => setHash(event.target.value)}
          />
        </div>
        <button type="submit" disabled={!enabled || pending !== null}>
          {pending === "membership" ? "Reading…" : "Read denylistedHashes"}
        </button>
        <p className="hint">Also reads denylistedSignatures and denylistedPrompts for the same id.</p>
      </form>

      {membership ? (
        <dl className="result" data-testid="membership-result">
          <div>
            <dt>denylistedHashes</dt>
            <dd>{membership.exact ? "listed" : "not listed"}</dd>
          </div>
          <div>
            <dt>denylistedSignatures</dt>
            <dd>{membership.signature ? "listed" : "not listed"}</dd>
          </div>
          <div>
            <dt>denylistedPrompts</dt>
            <dd>{membership.prompt ? "listed" : "not listed"}</dd>
          </div>
        </dl>
      ) : null}

      <form onSubmit={(event) => void onCheck(event)}>
        <h3>check(weight, signature, prompt)</h3>
        <div className="field">
          <label htmlFor="hash-weight">weightHash</label>
          <input
            id="hash-weight"
            value={weight}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || pending !== null}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="hash-sig">behaviorSig</label>
          <input
            id="hash-sig"
            value={signature}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || pending !== null}
            onChange={(event) => setSignature(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="hash-prompt">promptHash</label>
          <input
            id="hash-prompt"
            value={prompt}
            spellCheck={false}
            autoComplete="off"
            disabled={!enabled || pending !== null}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>
        <button type="submit" disabled={!enabled || pending !== null}>
          {pending === "check" ? "Reading…" : "Read check()"}
        </button>
      </form>

      {level != null ? (
        <p data-testid="check-result">
          check() returned <strong>{matchLevelLabel(level)}</strong> ({level}).
        </p>
      ) : null}
      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  )
}
