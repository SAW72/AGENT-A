# Agent BV — Bot Verifier: Base Sepolia reputation indexer spec

Status: DRAFT spec, docs only. Build and staging only. No indexer code, no deploy, no transactions.
Rules follow the Tokenomics design note v2 (2026-09-26). Every point value, floor, and cap is a Tokenomics **GUESS** and is loaded from [config/reputation/sepolia.json](../../config/reputation/sepolia.json), never hard-coded. Event details: [EVENT_MAP.md](./EVENT_MAP.md).

Gate: do not merge or run against live data until Blockchain Verifier APPROVE and Spencer's GO via BOB.

## 1. Ledgers

| Ledger | Contents |
|---|---|
| `bot-verifier-sepolia-reputation` | Usage outcomes O1 to O5 and ADJ |
| `bot-verifier-sepolia-arbitrator-rep` | Arbitrator outcomes A1, A2 and ADJ |

The two ledgers are never summed, in storage, API, or UI. Points are off-chain, Steward-operated, non-transferable, and may be adjusted or cancelled.

## 2. Inputs

- chainId `84532` only. Refuse to start (and refuse any RPC whose `eth_chainId` is not `0x14a34`) on any other chain, explicitly including `1` and `8453`.
- Addresses and start blocks come from config (`contracts.*.address`, `contracts.*.start_block`). Usage and arbitrator outcomes read only Escrow, DisputePanel and Vault logs. Denylist logs are read for enforcer signals only and never create points.
- Register every topic0 listed in EVENT_MAP.md, including **both** shapes of Escrow `VaultUpdated` and `DisputePanelUpdated` (1-field live, 4-field `main`). Decode by `(address, topic0)`. Unknown topic0 values are logged and skipped, never fatal.
- Block header timestamps (`eth_getBlockByNumber`) are the only time source. Never use wall-clock time or `expiresAt` alone for "created at".

## 3. Log scanning

- `eth_getLogs` with `address = [Escrow, DisputePanel, Vault, Denylist]` and no topic filter, in ranges of **at most 625 blocks** (`scan.max_block_range`). `https://sepolia.base.org` returns HTTP 413 for ranges of 1250 blocks or more. On 413 or timeout, halve the range and retry; never skip a range.
- Start at the lowest configured start block (`47253020`) on first run; resume from the last fully processed block afterwards.
- Two cursors: `safe_cursor` (up to the `safe` tag) and `final_cursor` (up to the `finalized` tag). Nothing past `safe` is ingested.
- Persist every raw log with `(block_number, block_hash, tx_hash, tx_index, log_index, address, topics, data, block_timestamp)`.

## 4. Finality and reorgs

- An entry is `provisional` when all of its source logs are at or below the `safe` block, and becomes `final` when all of its source logs are at or below the `finalized` block. (Design v2 cites Builder's measurement of about 21 minutes from latest to `finalized`; not independently verified.)
- On each pass, re-read the canonical block hash for every stored block between `final_cursor` and `safe_cursor`. If a stored `block_hash` is no longer canonical: drop that block's raw logs, set every `provisional` entry derived from them to `cancelled` with `cancel_reason = "reorg"`, rewind `safe_cursor` to the fork point, and rescan. Re-derived entries get the same semantic `entry_id` and are re-inserted as `provisional`.
- `final` entries are never rewritten by the indexer. Only an `ADJ` entry can change them.

## 5. Dedup

- Primary key is the **semantic key** (`entry_id`) plus `ledger`, not `(tx_hash, log_index)`. A reorg can re-include the same transaction at a different logIndex or block, so `(tx_hash, log_index)` alone can double-credit.
  - O1: `botId` + `O1`
  - O2, O3, O4: `escrowId` + outcome code
  - O5 (0 points, flag record only): `disputeId` + `O5`
  - A1, A2: `disputeId` + `voter` + outcome code
- On insert, if an entry with the same key exists: if its `block_hash` is still canonical, skip (idempotent); if not, replace it via the reorg path above.
- `escrowId` is single-use on-chain (`usedEscrowIds`), so each escrow counts once whether it came wallet-direct or through the claim relayer.

## 6. Derived state (rebuilt from events)

- **Escrow record** per `escrowId`: from `EscrowCreated` (payer, payee, payerBotId, payeeBotId, amount, expiresAt, create block timestamp), plus optional `EscrowDisputed(disputeId)` and a terminal `EscrowReleased` or `EscrowRefunded` with its block timestamp. Ordering is by `(block_number, log_index)`.
- **Dispute record** per `disputeId`: `DisputeOpened(subjectHash, challenger)`, up to 3 `VoteCast(voter, support)`, optional `DisputeResolved(upheld)`.
- **Operator at block**: for each botId, the ordered list of `OperatorSet(botId, account)` events. The operator of botId at block B is the `account` of the last `OperatorSet` at or before B (by block, then logIndex). Every operator write emits `OperatorSet`, so this is complete. An `eth_call Vault.operator(botId)` at block B is a cross-check only.
- **Fingerprint to botId map** (denylist signals): botIds are enumerable from `Registered`. For each new botId, call `Vault.bots(botId)` once (any block after registration; the hashes are fixed) and index `weightHash`, `behaviorSig`, `promptHash` -> botId. A `Listed(id, bucket, ...)` whose `id` matches maps to that botId, then to its operator via operator-at-block. This is an enforcer signal with 0 points.

## 7. Usage rules (ledger `bot-verifier-sepolia-reputation`)

Parties for O2, O3, O4 are always taken from `EscrowCreated.payer` / `.payee`, never from `tx.from` or `msg.sender`, because `release` and `refund` are permissionless.

### O1. Bot onboarded (+`points.O1` to the operator; GUESS 10)
- Trigger: the **first** `OperatorSet` ever seen for a botId (the 6-arg `register` emits it in the same tx after `Registered`; the 5-arg `register` sets no operator, so the credit waits for a later `setOperator`).
- Credit `wallet = OperatorSet.account`, `bot_id = botId`.
- Every later `OperatorSet` for the same botId (rotation) earns 0.

### O2. Escrow completed without dispute (+`points.O2_payer` / +`points.O2_payee`; GUESS 5 / 5)
Join `EscrowCreated` -> `EscrowReleased` on `escrowId`. Credit only if all hold:
- no `EscrowDisputed` has **ever** been recorded for that escrowId (a released escrow can no longer be disputed, so this is final at release);
- `EscrowCreated.amount >= floors.min_amount_wei` (GUESS 0.0001 ETH);
- `release_block_timestamp - create_block_timestamp >= floors.o2_min_create_to_release_seconds` (GUESS 300).

### O3. Refund path exercised (+`points.O3_payer`, payee 0; GUESS 1 / 0)
Join `EscrowCreated` -> `EscrowRefunded` on `escrowId`. Credit only if all hold:
- the escrow was **never** disputed (no `EscrowDisputed` for that escrowId). `EscrowRefunded` does not say which path produced it, so any ever-disputed escrow is excluded;
- set duration `EscrowCreated.expiresAt - create_block_timestamp >= floors.o3_min_set_duration_seconds` (GUESS 3600). The contract allows 1 s;
- `amount >= floors.min_amount_wei`;
- at most `caps.o3_per_wallet_per_day` (1) per payer wallet per day, and it counts toward `caps.escrows_per_wallet_per_day` (5).

### O4. Dispute path completed (+`points.O4_payer` / +`points.O4_payee`; GUESS 2 / 2)
Credit when **all three** exist, in **any order** of arrival:
1. `EscrowDisputed(escrowId, disputeId)`;
2. `DisputeResolved(disputeId, ...)` for that same disputeId;
3. a terminal `EscrowReleased` or `EscrowRefunded` for that escrowId.

Implementation: evaluate O4 each time any of the three events for the pair is ingested, and emit the entry when the last one lands. The chain allows `DisputeResolved` **before** `EscrowDisputed` (`dispute()` only needs the panel dispute to exist). The disputeId-to-escrowId join can also be cross-checked through `DisputeOpened.subjectHash == escrowId`.
- A disputed escrow refunded through the expiry backstop with no `DisputeResolved` earns 0.
- No flagger-specific credit; nothing depends on `tx.from`.
- At most `caps.o4_per_wallet_per_day` (1) per wallet per day.

### O5. Standalone dispute (0 points; flag record only)
- A `DisputeOpened` whose `subjectHash` is not an escrow, or whose subject escrow is no longer Open without ever having been linked through `EscrowDisputed`.
- Track `DisputeOpened.challenger`. If one challenger has `>= flags.o5_standalone_disputes_threshold` (GUESS 3) standalone disputes within `flags.o5_window_days` (GUESS 7), raise a flag to the enforcer hook (section 11). No points change.

## 8. Arbitrator rules (ledger `bot-verifier-sepolia-arbitrator-rep`)

Only disputes tied to an escrow through `EscrowDisputed` count, in any order. Every resolved dispute has exactly 3 votes.

- **A1** (+`points.A1_per_vote`; GUESS 3): a `VoteCast` on an escrow-linked dispute that resolved.
- **A2** (+`points.A2_match_bonus`; GUESS 2): additionally when `VoteCast.support == DisputeResolved.upheld`.
- **Per-transaction scoring.** Score after processing all logs of a transaction, not at the moment `DisputeResolved` is seen: the resolving vote's tx emits `DisputeResolved` at logIndex n and its own `VoteCast` at n+1. When the dispute becomes resolved, score all 3 votes (earlier txs plus the resolving tx). If the `EscrowDisputed` link arrives in a later tx, score then (any order).
- Cap: `caps.arbitrator_points_per_day` (30) per arbitrator per day. Manual enforcer cancel (ADJ) for collusion or missed duties.
- This track pays no BVT, no USD, and nothing from the InsuranceFund. AI can assist or co-seat, but humans stay in Gate B.

## 9. Caps and anti-gaming (checklist #12, all GUESS, config defaults)

Applied in block order (block_number, log_index) at credit time. Proposed (not in design v2): an entry over a cap is stored with `points = 0` and a `capped` note so the history stays explainable.
- Usage points: 20 per wallet per day, 20 per botId per day.
- At most 5 counted escrows per wallet per day (O2 plus O3).
- Same payer/payee pair: at most 2 per day, 10 lifetime.
- 500 usage points per wallet per season.
- No decay in v1.
- Arbitrator ledger: 30 per arbitrator per day.
- Slashing: the enforcer cancels points with manual ADJ entries until #9 names an owner and a written abuse policy.
- "Day" and "season" boundaries are config values (`caps.day_boundary`, `caps.season`); design v2 does not define them yet.

## 10. Ledger entry schema (matches design v2 section 6)

| Field | Type | Notes |
|---|---|---|
| `entry_id` | string | Semantic key: O1 = botId; O2/O3/O4 = escrowId + outcome code; A1/A2 = disputeId + voter (+ code) |
| `ledger` | enum | `bot-verifier-sepolia-reputation` or `bot-verifier-sepolia-arbitrator-rep` |
| `chain_id` | int | Always `84532` |
| `wallet` | address | Credited wallet |
| `bot_id` | bytes32, nullable | Where one applies |
| `outcome_code` | enum | `O1`..`O5`, `A1`, `A2`, `ADJ` |
| `points` | signed int | Negative only for `ADJ` |
| `status` | enum | `provisional`, `final`, `cancelled` |
| `source_contract` | address | |
| `event_names` | string[] | All events joined for this entry |
| `tx_hash`, `log_index`, `block_number`, `block_hash`, `block_timestamp` | | Of the log that completed the entry |
| `escrow_id`, `dispute_id` | bytes32, nullable | Where they apply |
| `rule_version`, `config_version` | string | So caps and weights can change without rewriting history |
| `cancel_reason`, `cancelled_by` | string, nullable | For `ADJ` and cancelled entries |

## 11. Hook interfaces (spec-level stubs only; no implementation in this PR)

All hooks are pure interfaces. Until their checklist item closes, each returns its "pending" default and the entry stays eligible for staging only.

```
// #7 OFAC / sanctions eligibility (OPEN: Lawyer + ops)
interface EligibilityScreen {
  screen(wallet: Address, atBlock: number): { eligible: boolean; reason?: string; provider?: string }
}
// default: { eligible: true, reason: "pending-#7" } in staging; public launch blocked until #7 closes

// #9 Sybil / abuse enforcer (OPEN: Spencer names owner, Lawyer reviews policy)
interface AbuseEnforcer {
  flag(signal: { kind: "O5_REPEAT" | "DENYLIST_LISTED" | "BOT_BURNED" | "PAIR_CAP" | "OTHER"; wallet?: Address; botId?: Bytes32; refs: string[] }): void
  cancel(entryId: string, reason: string, by: string): AdjEntry   // writes an ADJ entry
}

// #11 Disclaimer and AS IS links (OPEN: wired at UI time, Lawyer confirms surfaces)
interface DisclaimerLinks {
  links(): { masterDisclaimer?: Url; bvtSecuritiesDisclaimer?: Url; asIs?: Url; notInvestment?: Url }
}
// the read API returns these slots, empty until #11 closes

// #12 Caps (OPEN: Spencer locks section 9 values)
interface CapPolicy {
  configVersion(): string
  apply(candidate: LedgerEntry, history: LedgerView): { points: number; capped: boolean; capName?: string }
}
```

## 12. Non-goals

- Points are off-chain and non-transferable. No token conversion, no redemption, no claim, no sale, no staking, and no fee payment in points.
- No link to BVT (supply, fee router, staking, or any BVT contract).
- $0 protocol fees; no list, unban, register, or check fees in points or BVT.
- No mainnet. Base Sepolia (84532) only.
- No AI-vs-AI arbitration; humans stay in Gate B.
- No new on-chain ledger contract, no contract change, no redeploy.
- No Stranded / GasRescue data in either direction; no combined dashboards.

## 13. Known limits

- **Flagger identity is not derivable.** `EscrowDisputed` does not log `msg.sender`, and `tx.from` is wrong for smart accounts, EIP-7702 accounts, batched calls, and the claim relayer. Not needed, because flagging is not penalized or credited in design v2. Penalizing it later would need `address indexed flaggedBy` on `EscrowDisputed`, which means an Escrow redeploy.
- **No attestation / challenge-window primitive exists on-chain.** "Undisputed completion" is detected positively as `EscrowReleased` with no `EscrowDisputed`, never inferred from elapsed time or silence. An attestation with a challenge window would need a new contract.
- No business events exist live yet, so event ordering is verified from source and bytecode only.

## 14. Open questions (not resolved by this spec)

These are flagged for Tokenomics / Spencer, not decided here:
1. Design v2 section 6 says to read "only from the three contract addresses" (Vault, Escrow, DisputePanel). This spec also reads Denylist logs and calls `Vault.bots()` for enforcer signals only, with 0 points. Confirm that is acceptable.
2. O5 "subject is not an escrow" is only knowable as of now: escrowIds are caller-chosen, so a dispute can be opened on an escrowId that is created later and then linked. O5 classification (and the repeat-use flag) should stay provisional while the subject could still become an Open escrow.
3. O4 any-order: a dispute can be resolved before it is linked. An upheld pre-resolved dispute lets a party move Open -> Disputed -> Released immediately (skipping expiry and re-verification); an unwind lets Disputed -> Refunded happen before expiry. Needs 3 arbitrator votes, so it is not free, but it is a collusion path worth a cap review.
4. O1 credits the first `OperatorSet` even if the bot was `Burned` first (`setOperator` checks registration, not `active`), and regardless of tier. Decide whether to gate on `active` and tier >= Financial.
5. Relayer-operated bots: if the claim relayer wallet is a bot's Vault operator, `EscrowCreated.payer` is the relayer and it would receive the points. Decide eligibility.
6. Day boundary (UTC by block timestamp is the proposed default) and season length are not defined in design v2.
7. O4 pays both parties regardless of ruling, including the party the panel ruled against; A2 has a herding incentive because votes are public as they land. Both are design choices to confirm when caps lock.
