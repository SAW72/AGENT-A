# Claim relayer (Base Sepolia)

Gas and ops service for the Agent A (Agent Auditor) claim flow. Default mode is **fixtures / dry-run**. Live claim submits are unlocked only on Base Sepolia when `LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1`. `npm run readonly` is a separate read-only check (`eth_chainId`, `eth_getCode`, `eth_call` only).

Public funding wallet (address only): `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` (`…31861`). The same EOA is booked as `claimRelayerWallet` in `deployments/base-sepolia.json`. It is not a contract. The hosted service derives it from `RELAYER_PRIVATE_KEY`. Never commit the private key.

`BotAttestationEscrow` is booked in `deployments/base-sepolia.json` at `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. The indexer and relayer start block is the deploy block `47345163` (`BOOKED_SEPOLIA_ESCROW_START_BLOCK`, also `BotAttestationEscrow.startBlock` in the address book). When `ESCROW_ADDRESS` is unset, health reports `escrowBooked: true` and that address (`escrowSource: "address_book"`) with `escrowStartBlock: 47345163` and `escrowStartBlockSource: "address_book"`. BVT is still null. Set `ESCROW_ADDRESS` to the zero address to force `escrowBooked: false` (`escrowStartBlockSource: "unbooked"`).

The booked start block is used only when the configured escrow is that booked contract (address-book block, or the constant when the book omits one). An `ESCROW_ADDRESS` override that points at a different contract does not inherit `47345163`. Set `ESCROW_START_BLOCK` to a non-negative integer for that contract, or leave it unset. Unset means `escrowStartBlock: null` and `escrowStartBlockSource: "unset"` on `/health`, plus a startup log. It does not mean block 0. A JSON `null`, an empty string, or a missing book `deployBlock` / `startBlock` is missing, not block 0. A present non-integer or negative `ESCROW_START_BLOCK` refuses to boot (`invalid_escrow_start_block`).

Config load refuses any adopted address (escrow env or book, denylist, vault, dispute panel) that matches `retired.*`, `superseded.*`, or the wallet-ux superseded pins. Comparison ignores case and checksum. The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). Setting it as `ESCROW_ADDRESS` fails at boot: `retired_or_superseded_address`, and the message names that address and the current booked address `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`.

## HARD STOP

- **Base Sepolia only** (chain id **84532**). Ethereum mainnet (`1`), Base mainnet (`8453`), and every other chain are refused at boot and on every request. There is no mainnet send path.
- **Live submit is off unless every gate passes:** `CHAIN_ID=84532`, `LIVE_SUBMIT=1`, `SPENCER_RUN_AUTH=1`, and the escrow is the booked Sepolia contract `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d`. Health then reports `liveSubmit: true`, `mode: "live"`, and `liveSubmitBlockers: []`. Any missing gate keeps `liveSubmit: false`.
- **Agents do not `--broadcast`.** Do not add forge broadcast scripts. Do not deploy Escrow or BVT from here. Live submit sends one escrow transaction through the relayer key. It does not deploy contracts.
- **Never invent balances.** Quote amounts are echoed from the client. This service does not read wallet balances.
- **Never commit secrets or private keys.** `RELAYER_PRIVATE_KEY` is a runtime environment variable only. It is read only when live submit is allowed, it is not written to disk or to the JSONL log, and it is stripped from errors.

## Run locally

```bash
cd claim-relayer
cp .env.example .env
# edit .env if you want; empty defaults are enough for fixtures
set -a
source .env
set +a
npm start
```

Listens on `127.0.0.1:8790` unless `HOST` or Render's `PORT` is set. Render must bind `0.0.0.0`.

```bash
npm test
```

Tests use Node's built-in runner. They do not touch the network.

## Fixture mode

`LIVE_SUBMIT` and `SPENCER_RUN_AUTH` default to `0`. Quote routes stay dry-run. Claim routes without `live: true` stay dry-run even after the gate opens.

`GET /health` and `GET /v1/health` (HTTP 200 even when the kill switch is on). Default blockers:

```json
{
  "ok": true,
  "chainId": 84532,
  "network": "base-sepolia",
  "killSwitch": false,
  "mode": "fixture",
  "stub": true,
  "fixture": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "escrowSource": "address_book",
  "escrowStartBlock": 47345163,
  "escrowStartBlockSource": "address_book",
  "relayerAddress": "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
  "liveSubmit": false,
  "liveSubmitRequested": false,
  "liveSubmitBlockers": ["spencer_run_auth_required", "live_submit_off"]
}
```

When `LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1` on chain 84532 with that escrow, the same route reports `mode: "live"`, `liveSubmit: true`, `fixture: false`, `stub: false`, and `liveSubmitBlockers: []`. No private key is included.

## Wallet UX API (provisional)

Stable shapes for parallel Wallet UX work. Extra fields below are part of this scaffold's contract.

### `POST /v1/claims/quote`

Request:

```json
{ "payer": "0x1111111111111111111111111111111111111111", "payee": "0x2222222222222222222222222222222222222222", "amountWei": "1000", "claimId": "claim-1" }
```

`amountWei` and `claimId` are optional. `amountWei` is a base-10 integer string (echoed, not a balance). If `claimId` is omitted the service mints `fixture-` plus 16 hex chars. Optional `chainId` must be `84532`.

Response:

```json
{
  "claimId": "claim-1",
  "payer": "0x1111111111111111111111111111111111111111",
  "payee": "0x2222222222222222222222222222222222222222",
  "amountWei": "1000",
  "fixture": true,
  "expiresAt": "2026-09-25T20:00:00.000Z",
  "chainId": 84532,
  "mode": "fixture",
  "dryRun": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "relayerAddress": "0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861",
  "relayerNonce": "0",
  "calldata": null,
  "calldataStatus": "action_required"
}
```

`expiresAt` is ISO-8601 UTC. `amountWei` is omitted when the request omitted it. `relayerNonce` is an in-memory reservation for that `claimId` (same id refreshes the same nonce until expiry).

### `POST /v1/claims`

Request `{ "claimId": "claim-1" }`. Optional `payer`, `payee`, `amountWei`, `chainId`.

Fixture response while Escrow is booked and Spencer has not authorized a run:

```json
{
  "ok": true,
  "mode": "fixture",
  "claimId": "claim-1",
  "txHash": null,
  "reason": "escrow_booked_spencer_run_auth_required",
  "dryRun": true,
  "escrowBooked": true,
  "escrowAddress": "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d",
  "calldata": null,
  "calldataStatus": "action_required"
}
```

Set `action` to `createEscrow`, `release`, `refund`, or `dispute` to get real calldata. `valueWei` is `msg.value` for `createEscrow` and `"0"` otherwise. It is not an ABI argument.

A claim that does not set `live: true`, `liveSubmit: true`, or `mode` to `"live"` or `"broadcast"` stays a dry run (`txHash: null`). With the gate closed, `reason` is `escrow_not_booked`, `escrow_not_booked_sepolia`, `escrow_booked_spencer_run_auth_required`, or `live_submit_off`. With the gate open, that dry run uses `reason: "dry_run"`.

A live claim while the gate is closed returns **409** `live_submit_blocked` and `txHash: null`. A live claim while the gate is open signs with `RELAYER_PRIVATE_KEY` and returns `mode: "live"` plus the transaction hash. Quotes never broadcast. A live flag on `POST /v1/claims/quote` is **409** `quote_does_not_broadcast` once the gate is open, and the closed-gate refusal before that. `KILL_SWITCH=1` still returns **503** `kill_switch` for quote and claim before any send.

### Live claim auth (`CLAIM_API_SECRET`)

When `liveSubmit` is allowed, `POST /v1/claims` that sets `live: true`, `liveSubmit: true`, or `mode` to `"live"` or `"broadcast"` must present `CLAIM_API_SECRET`. This secret is separate from `ADMIN_SECRET`. Send it as `x-claim-secret` or `Authorization: Bearer <secret>`. The compare is timing-safe.

- Missing or wrong secret: **401** `{ "ok": false, "error": "unauthorized" }`. Nothing is broadcast.
- `CLAIM_API_SECRET` unset while live submit is allowed: **503** `{ "ok": false, "error": "claim_api_secret_required" }`. Fail closed. Nothing is broadcast.
- Fixture claims (no live flag) stay unauthenticated, including when the gate is open.
- Quotes stay dry-run and do not require the claim secret.

`x-admin-secret` does not authorize a live claim. `x-claim-secret` does not authorize pause or unpause.

CORS preflight allows `content-type`, `x-admin-secret`, `authorization`, and `x-claim-secret`. Set `CORS_ORIGINS` to the Wallet UX origin when that app calls this service, for example `https://agent-a-wallet-ux.pages.dev`.

## Error codes

| HTTP | `error` | When |
| --- | --- | --- |
| 503 | `kill_switch` | Kill switch is on. Quote and claim are refused. Health stays 200. |
| 503 | `claim_api_secret_required` | Live submit is allowed and `CLAIM_API_SECRET` is unset. The live claim is refused before broadcast. |
| 503 | `relayer_key_missing` | Live submit is allowed, the claim secret matched, but `RELAYER_PRIVATE_KEY` is unset. Nothing is signed. |
| 502 | `broadcast_failed` | The Sepolia RPC rejected the send, or gas estimation reverted. `txHash` is null. `senderConstraint` says who the contract requires. |
| 409 | `live_submit_blocked` | Client asked for a live transaction and the gate is closed, or asked a quote to broadcast. `reason` is `escrow_not_booked`, `escrow_not_booked_sepolia`, `escrow_booked_spencer_run_auth_required`, `live_submit_off`, or `quote_does_not_broadcast`. |
| 400 | `action_not_claim` | `action` is not `createEscrow`, `release`, `refund`, or `dispute`. Governance setters are refused. |
| 400 | `invalid_bytes32` | `escrowId` / bot id / `disputeId` is not a non-zero bytes32. |
| 400 | `invalid_duration` | `durationSeconds` is outside `1..2592000` (`30 days` on the contract). |
| 400 | `value_not_allowed` | `amountWei` was sent with `release`, `refund`, or `dispute`. |
| 400 | `mainnet_refused` | `chainId` is `1` or `8453`. |
| 400 | `wrong_chain` | Any chain other than `84532`. |
| 400 | `invalid_address` | `payer` or `payee` is missing or not a 20-byte hex address. |
| 400 | `invalid_parties` | Payer and payee are the same address. |
| 400 | `invalid_amount` | `amountWei` is not a positive integer. |
| 400 | `invalid_claim_id` | Claim id missing on submit, or an unexpected shape. |
| 400 | `invalid_json` | Body is not a JSON object. |
| 401 | `unauthorized` | Admin route called with the wrong `ADMIN_SECRET`, or a live claim (gate open) without a matching `CLAIM_API_SECRET`. |
| 404 | `not_found` | Unknown path. |

Startup with `CHAIN_ID` other than `84532` refuses to boot (`mainnet_refused` or `wrong_chain`). `RELAYER_KEY_FILE` / `RELAYER_PRIVATE_KEY_FILE` refuse to boot. A retired or superseded escrow, denylist, vault, or dispute panel refuses to boot (`retired_or_superseded_address`). A non-integer or negative `ESCROW_START_BLOCK` on a non-booked escrow refuses to boot (`invalid_escrow_start_block`). Keys stay in the environment.

## Kill switch

`KILL_SWITCH=1` starts paused. `POST /v1/admin/pause` and `POST /v1/admin/unpause` require header `x-admin-secret` or `Authorization: Bearer` matching `ADMIN_SECRET`.

If `ADMIN_SECRET` is unset, those routes return HTTP 200 and do **not** change the switch:

```json
{ "ok": true, "noop": true, "killSwitch": false, "docs": "ADMIN_SECRET is unset. ..." }
```

## Nonce store and logs

Reservations live in memory for one process. Render must run **one web instance**. Do not turn on horizontal scaling. A restart clears reservations; this stub does not read a pending nonce from chain.

`CLAIM_LOG_PATH` is append-only JSONL (default `./data/claims.jsonl`). Records are allowlisted. Private keys, secrets, and nested objects are dropped. On Render the disk is ephemeral, so use `/tmp/...` and expect the file to vanish on restart.

## Claim calldata

Calldata is encoded in `escrowCalldata.mjs` from the signatures in `contracts/BotAttestationEscrow.sol`:

| Action | Signature | Value | Who may send it later |
| --- | --- | --- | --- |
| `createEscrow` | `createEscrow(bytes32,address,bytes32,bytes32,uint256)` | `amountWei` as `msg.value` | Payer bot's Vault operator (`vault_operator_must_send`) |
| `release` | `release(bytes32)` | 0 | Anyone (`permissionless`) |
| `refund` | `refund(bytes32)` | 0 | Anyone (`permissionless`) |
| `dispute` | `dispute(bytes32,bytes32)` | 0 | Payer or payee (`party_must_send`) |

Selectors are `keccak256` of those strings. `setDenylist`, `setVault`, and `setDisputePanel` are not claim actions.

The public funding wallet is not assumed to be a Vault operator. A live `createEscrow` is signed by `RELAYER_PRIVATE_KEY` and can revert when that address is not the payer's Vault operator. The response includes `senderConstraint: "vault_operator_must_send"` and does not invent a transaction hash when the send fails. `dispute` can revert unless the signer is the payer or the payee. `release` and `refund` are permissionless.

`npm run readonly` performs `eth_chainId`, `eth_getCode`, and `eth_call` only (`owner`, `governance`, `disputePanel`, `arbitratorCount`). It is not part of `npm test`. It refuses every chain other than 84532.

## Reputation read API (draft)

Off-chain Base Sepolia reputation for Bot Verifier. Design: [`docs/reputation-ledger.md`](../docs/reputation-ledger.md). This does not change `POST /v1/claims` auth.

- `GET /v1/reputation/:address` returns the usage ledger and the arbitrator ledger as separate objects. There is no combined total.
- `GET /v1/reputation/:address/history` pages the same rows. `limit` defaults to 20 and caps at 100.
- Reads are unauthenticated and rate limited. There is no write or admin route. `chainId` other than 84532 is refused, including 1 and 8453.
- Caps are loaded from [`config/reputation/sepolia.json`](../config/reputation/sepolia.json) and labeled `DRAFT/GUESS`. The response always includes the testnet disclaimer and empty disclaimer-link slots.

The in-memory ledger is rebuilt by replaying logs. A cold start on Render wipes it. Nothing here is live chain data.

## Render

See `render.yaml` in this directory. It is a reference Blueprint, not registered at the repo root, so merging it does not create a Render service. Do not apply it until Spencer says GO.

**Apply path (either one, later):**

1. Move or copy this file to the repo root as `render.yaml` and set `rootDir: claim-relayer` on the service.
2. Create the service from this Blueprint in the Render dashboard.

This copy stays under `claim-relayer/` until Spencer asks to move it. Product name is Agent A. The Render service slug stays `bot-verifier-claim-relayer` unless Spencer renames it in the dashboard.

Free plan, one web instance (`numInstances: 1`), no disk, no autoscaling. Render Free spins down after about 15 minutes idle, which is fine for Base Sepolia. Before mainnet, upgrade the plan to Starter (about $7/month) so the relayer stays warm. The app still refuses mainnet; do not set a mainnet chain id in the Blueprint.

`HOST=0.0.0.0`. `LIVE_SUBMIT` and `SPENCER_RUN_AUTH` stay `0` in the Blueprint. To unlock Sepolia submits later in the Render dashboard, set:

```
LIVE_SUBMIT=1
SPENCER_RUN_AUTH=1
CHAIN_ID=84532
```

Put `RELAYER_PRIVATE_KEY` in the dashboard as a secret. Do not bake it into the Blueprint. `BASE_SEPOLIA_RPC_URL` must be a Base Sepolia endpoint. The process checks `eth_chainId` and refuses `1` and `8453` before `eth_sendRawTransaction`.

`CLAIM_API_SECRET` is `sync: false` in the Blueprint. Set it in the dashboard before unlocking live submit. It is not `ADMIN_SECRET`. `CORS_ORIGINS` in the Blueprint includes `https://agent-a-wallet-ux.pages.dev` plus local Vite origins so Wallet UX can send `x-claim-secret`. A secret embedded in the static Pages build is only a soft deterrent.
