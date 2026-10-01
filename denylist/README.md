# Denylist Registry

On-chain registry of dangerous bot fingerprints.

The live Base Sepolia Denylist is pre–PR #10 bytecode. The tip-bytecode redeploy (new Denylist, new Vault, timelock `acceptOwnership`, active-listing migration) is [`script/DEPLOY_DENYLIST.md`](../script/DEPLOY_DENYLIST.md). Agents simulate. Spencer broadcasts.

Active listings block registration and escrow verification. The owner (CORE_TIMELOCK on the live Denylist) can clear an active listing. Clearing does not erase history: `everListed` and `listing.timesListed` stay set, and `Listed` / `Unlisted` events record who, when, bucket, and listing count.

## Purpose
Stop a denounced bot from being re-registered while its fingerprint is actively listed, and keep a permanent record that it was listed.

## Match levels
`check` returns the strongest active hit:

1. `ExactBlock` — weight hash
2. `SignatureBlock` — behavioral signature
3. `PromptBlock` — prompt hash
4. `None` — no active listing

`PromptBlock` is a hard block. It occupies the same ordinal as the old `PromptReview` name (`1`). Vault registration and escrow `_verifyBot` reject every level other than `None`. There is no advisory match level.

`check` is a view. It does not emit. The audit trail is the list and unlist events, because those are the state changes.

## Components
- denylist_contract.md
- fuzzy_matching.md
- prompt_hash_layer.md
- revocation_oracle.md
- burn_and_blacklist_flow.md
