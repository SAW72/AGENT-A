# Formal Verification Invariants

Properties the current Denylist and Vault source must satisfy. The live Base Sepolia pair in `deployments/base-sepolia.json` is that source. These notes do not change its bytecode.

Use with Certora, Slither, or manual review. Foundry coverage lives in `test/Denylist.t.sol`, `test/Vault.t.sol`, and `test/OpsLive.t.sol`.

Tip rules:

- Listing history survives `remove`. `timesListed` never decreases. `everListed` stays true.
- `PromptBlock` is a hard block. It occupies ordinal `1` (the old `PromptReview` slot) and is not an advisory level.
- Vault `register` (both overloads) fails closed on every `MatchLevel` other than `None`.
- `Denylist.check` is a view. It does not emit. There is no `Checked` event. The audit trail is `Listed` / `Unlisted`.

## Denylist.sol
1. `remove(id, bucket)` clears `active` for that bucket only. `timesListed` never decreases, and `everListed` stays true after removal. `firstListedAt` stays. A later add increments `timesListed` and emits `Listed` again.
2. `bytes32(0)` cannot be added or removed (`ZeroId`).
3. `check` returns the strongest active MatchLevel (`ExactBlock` > `SignatureBlock` > `PromptBlock` > `None`). Ordinals stay 3, 2, 1, 0. `PromptBlock` is a hard block, the same gate as the other non-`None` levels.
4. An id with `active == false` does not produce a match, even if it was listed before. An id with `active == true` cannot produce `MatchLevel.None` for that bucket.
5. Only `owner` can add or remove. A second add while `active` reverts `AlreadyListed` and does not bump `timesListed`. `remove` on an inactive id reverts `NotListed`.
6. `check` does not emit a `Checked` event or any other log. Reads are not the audit trail. Vault and escrow call `check` as a view, including under static execution.

## Vault.sol
1. Both `register` overloads revert `bot is denylisted` unless `denylist.check(...) == None`. `PromptBlock`, `SignatureBlock`, and `ExactBlock` all fail closed. There is no advisory match level.
2. `burn` sets `active = false` and there is no `unburn` or revive function.
3. `grantAccess` reverts `bot not active` when the bot is missing or burned. When the bot is active it returns whether `requestedPerms <= tierMaxPermissions[tier]`. It does not read an attestation, and it does not check expiry. It is a view, so it does not emit `AccessGranted`.
4. A burned botId cannot be registered again. `registeredAt != 0` reverts `already registered`, including after burn.
5. Only `owner` can register, `setOperator`, or burn.
6. The six-arg `register` binds `operator` in the same transaction. The five-arg `register` leaves `operator` at `address(0)`. A zero operator on the six-arg overload reverts `zero operator` and does not store the bot.

## Liability.sol
1. `settle` can be called only once per claimId (`paid` flag).
2. Waterfall order: Owner, then Auditor, then Insurance.
3. Insurance payout requires sufficient `InsuranceFund.balance`.
4. No double-claim on the same `incidentHash`.
5. `Party.Auditor` settle reverts until a slash/escrow hook exists (`Liability: auditor slash/escrow unset`) and does not set `paid`.

## InsuranceFund.sol
1. `payout` succeeds only when `msg.sender == liability` (`onlyLiability`).
2. `liability` is immutable and non-zero.
3. Owner / random EOAs / other contracts cannot `payout`.

## DisputePanel.sol
1. A dispute resolves only after >= 3 votes.
2. `upheld` is true iff `votesFor >= votesAgainst`.
3. No vote after resolution.
4. `vote` reverts unless the caller is an allowlisted arbitrator (`isArbitrator`).
