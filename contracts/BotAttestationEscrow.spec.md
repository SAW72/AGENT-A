# BotAttestationEscrow release and dispute link

Spec for who may call `release`, and which `DisputePanel` cases `dispute` will link. The panel contract is unchanged. `release` does not transfer ETH. It credits `pendingWithdrawals`.

## State machine

`EscrowState` is `Open`, `Disputed`, `Released`, or `Refunded`. `createEscrow` starts at `Open`. `Released` and `Refunded` are terminal.

| State | `release` | `refund` | `dispute` |
| --- | --- | --- | --- |
| `Open`, inside the window, attestation still passes | Payer or payee. Credits the create-time payee. | Reverts `not expired`. | Payer or payee, if the panel case passes the link checks below. Moves to `Disputed`. |
| `Open`, past `expiresAt` | A party reverts `EscrowExpired`. A stranger reverts `ReleaseNotAuthorized`. | Anyone. Credits the payer. | A party reverts `DisputeAfterExpiry`. |
| `Disputed`, panel case not a completed uphold | A party reverts `DisputePending`. A stranger reverts `ReleaseNotAuthorized`. | Anyone, but only after a panel unwind, or after `expiresAt` if the panel has not upheld. A pending case inside the window reverts `DisputePending`. An uphold reverts `DisputePending` even after expiry. | Reverts `EscrowNotOpen`. |
| `Disputed`, panel case resolved and upheld | Payer or payee. Credits the create-time payee. Skips expiry, re-attestation, and operator rebinding. A stranger reverts `ReleaseNotAuthorized`. | Reverts `DisputePending`. | Reverts `EscrowNotOpen`. |
| `Released` or `Refunded` | `EscrowNotOpen`. | `EscrowNotOpen`. | `EscrowNotOpen`. |

A missing id reverts `EscrowNotFound` before any caller check.

**Who may release.** While `Open`, only the payer or the payee stored at `createEscrow`. While `Disputed`, those same two addresses, and only when the linked ruling is resolved and upheld. Governance is not a release caller. There is no relayer role on the contract. `refund` stays permissionless because it only credits the payer, and only on the expiry or unwind paths above.

The payee can still `release` an `Open` escrow that passes attestation. That is the collection path. Taking it away would let the payer wait for expiry and refund themselves. A stranger cannot do it, so a third party cannot settle the escrow in the gap before `dispute` links.

## Linking a panel case

`dispute(escrowId, disputeId)` does not call the panel. The party opens the case with `DisputePanel.openDispute`, then links it here. The link checks, in order:

1. The case exists (`createdAt != 0`) and `subjectHash` equals `panelSubject(escrowId, createdAt)`.
2. The case is not `resolved`.
3. Neither side has `UNMOVABLE_PANEL_VOTES` (2) or more. `DisputePanel.PANEL_SIZE` is 3, so two votes on one side cannot be outvoted, and `resolved` is still false until the third vote.
4. `dispute.createdAt >= escrow.createdAt` (same block is allowed).
5. The panel `challenger` is the payer or the payee.
6. `block.timestamp <= expiresAt`.

### Race between `openDispute` and `dispute`

Those are two transactions. An arbitrator can vote in between. Requiring zero votes made that vote revert the link (`DisputeVotesCast`). The escrow stayed `Open`, and anyone could `release` it.

**Choice.** Link whenever the subject matches, at any vote count that has not already decided the panel. Do not bind the link inside `openDispute`.

Binding at `openDispute` time was the other option. The panel does not call the escrow. The escrow would have to call `openDispute` itself. That is a new external call into a permissionless function. The dispute id is in the calldata, so a front-run can squat it (`exists`) before the escrow's call. Chain id, escrow address, escrow id, `createdAt`, and the sender are all public, so there is no secret to hide the id. A panel callback would redeploy the shared panel. Neither fits this contract, and both add a call the link path does not have today. `dispute` still only reads the panel.

**Griefing.** A single vote, or one vote on each side, links. The case then resolves under the normal 3-vote rule, and `release` or `refund` follows the table above. Two votes on one side revert `DisputeVotesCast`. That tally is already a decision, which is how a case opened and voted before `createEscrow` (same timestamp, still unresolved) used to be linked and then upheld past the denylist. The party is not stuck: that dispute id is abandoned and a new id with a fresh tally links. A resolved case still cannot be attached (`DisputeAlreadyResolved`). A case opened in an earlier block still cannot (`DisputePredatesEscrow`). A stranger's case still cannot (`DisputeChallengerNotParty`). A stranger still cannot `release` while the party opens the fresh id.

The error name `DisputeVotesCast` is the old zero-vote revert. Its meaning is narrower now: an unoutvotable majority (`UNMOVABLE_PANEL_VOTES`, which is 2), not any vote. The name stays so the existing wallet ABI still recognizes the selector.

Same-block ordering is not visible on chain. A 2-0 tally in the create block is refused for the same reason as a 2-0 tally later: it has already decided the panel. A 1-0 tally in that block links.

## Panel subject

`panelSubject` is `keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt))`. `createdAt` is the timestamp stored by `createEscrow`. `openDispute` must pass that hash as `subjectHash`. `dispute` and the uphold / unwind reads require the same hash.

The bare `escrowId` is not enough. Two escrow deployments can share one `DisputePanel` and can each create the same `escrowId` in the same block, so `createdAt` matches. The escrow address is inside the preimage, so the hashes differ. A ruling opened for one does not link on the other (`InvalidDispute`). Chain id is in the preimage so the same addresses on another chain do not match either.

The hash is public once the escrow exists. A stranger can open a case with the right subject. The link still requires the panel challenger to be the payer or the payee, so that case does not attach. Squatting one dispute id only burns that id. The party opens another. They cannot build the other deployment's subject without that deployment's address.

## What did not change

No storage was added. `Escrow` and the mapping slots are unchanged. No event was added or retyped. `release(bytes32)` and `dispute(bytes32,bytes32)` keep their selectors. `panelSubject(bytes32,uint256)` is an added view. `refund` is still permissionless.

New errors: `ReleaseNotAuthorized`, `NotParty`. `DisputeVotesCast` stays, with the narrower meaning above. The string revert `"not a party"` is gone. `apps/wallet-ux/src/abi/BotAttestationEscrow.json` is regenerated from the forge artifact because CI compares that file to the build. Wallet TypeScript is not edited here. The glossary sentence that still says any vote blocks the link is stale until a wallet follow-up.
