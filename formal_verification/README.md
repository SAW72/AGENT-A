# Formal Verification Layer

Security-critical contracts need mathematical proof, not just tests.

## Why
The denylist and vault contracts control bans, access grants, and burns. Vault burn is irreversible. Denylist active membership can be cleared by the owner; listing history cannot. A bug in matching could let a dangerous bot slip through, or a bug in history could hide that it was ever listed.

## Approach
- Use a formal verification tool (Certora, Slither, or equivalent)
- Specify invariants the contracts must always hold
- Prove the invariants hold for all possible states
- Run verification in CI on every contract change

## Invariants to Prove
1. Clearing an active denylist row does not erase `timesListed` or `everListed` (history survives removal).
2. A burned bot ID can never be re-registered (burn is final; `registeredAt` stays set).
3. `PromptBlock` is a hard block. Vault `register` fails closed on every `MatchLevel` other than `None`, including prompt-hash matches. A previous draft of this list said prompt matches must not auto-reject. That wording is retired.
4. `Denylist.check` is a view and emits no `Checked` event. `Listed` and `Unlisted` are the denylist audit trail.
5. `Vault.grantAccess` allows a call only for an active bot, and only up to that bot's tier cap. It does not consult an attestation or an expiry.
6. Denylist and Vault expose no upgrade function. Owner calls (`add*`, `remove`, `register`, `setOperator`, `burn`) are the mutation surface. On the live pair that owner is `CORE_TIMELOCK` (`deployments/base-sepolia.json`).

## Files
- `invariants.md` — full list of invariants
- `verification_spec.md` — how to run the verification suite
- `ci_verification.yml` — GitHub Actions workflow for automated checks