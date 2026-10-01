# Go live checklist

This is what "live" means at each stage. Do not skip stages.

## Stage 0 — local (ready now)
- [x] Clone the repo
- [x] `python pipeline/end_to_end_runner.py --target stub`
- [x] `python meta_audit/meta_audit_runner.py --primary audit_report.json`
- [x] `export STAMP_API_KEY=dev-only-local-key` then `uvicorn api.stamp_api:app --host 0.0.0.0 --port 8080`
- [x] `pytest tests/`

Privileged stamp writes (`POST /v1/bots`, denylist, history) are rejected without `STAMP_API_KEY` (401 if wrong/missing header; 503 if the env key is unset). Public GET/access-check stay readable.

## Stage 1 — live model audit (you can do this today)
- [ ] Set `XAI_API_KEY` (env only). Optional: `XAI_API_BASE=https://api.x.ai/v1` (HTTPS, env-only; no client-supplied base)
- [ ] Run `python pipeline/end_to_end_runner.py --target grok --bot-id grok-001`
- [ ] Keyword scores are demo-only. For an attestation-grade report use `--scorer llm --require-attestation` (or `ALLOW_KEYWORD_ATTESTATION=1` for an explicit demo exception)
- [ ] Register with `X-API-Key: $STAMP_API_KEY`. `fingerprint_hash` must equal `sha256(canonical(fingerprint))`
- [ ] Hit `GET /v1/bots/grok-001/stamp` (add `?attestation=true` only when the run is attestation-grade)

## Stage 2 — testnet contracts

Base Sepolia (**84532**) only. Mainnet always reverts. Agents do not `--broadcast`. Keys stay in the environment.

- [ ] `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts`
- [ ] `forge build && forge test`
- [ ] **(1) Core** — `script/Deploy.s.sol`. Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (required, ≠ deployer). Inside the script: Denylist → Vault(denylist) → Liability(`address(0)`) → InsuranceFund(liability) → `bindInsurance` → DisputePanel. Then `transferOwnership(CORE_TIMELOCK)` on Denylist and Vault (OZ **Ownable2Step** — ownership does not move until CORE_TIMELOCK calls `acceptOwnership`). CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by TimelockController ([runbook](docs/runbooks/CORE_TIMELOCK_MIGRATION.md)). `setOwner(CORE_TIMELOCK)` on InsuranceFund, Liability, and DisputePanel is immediate.
- [ ] **(1a) Denylist + Vault redeploy** — `script/DeployDenylist.s.sol` replaces the live pre–PR #10 Denylist with tip bytecode. Env: `PRIVATE_KEY`, `CORE_TIMELOCK` (≠ deployer). Simulate only until Spencer broadcasts: `forge script script/DeployDenylist.s.sol:DeployDenylist --rpc-url $BASE_SEPOLIA_RPC_URL -vvvv`. Then `acceptOwnership` on both new contracts and migrate active listings. See `script/DEPLOY_DENYLIST.md`. Do not re-run `Deploy.s.sol` for this cutover. Agents do not `--broadcast`. Spencer fills `deployments/base-sepolia.json` after a real broadcast.
- [x] **Panel seat (Gate B)** — seated on the live DisputePanel. `arbitratorCount` is 3: `0xD5ee9fA366C3698b34204722c635989E5197B018`, `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30`, `0xB87Ed5F74276AC6172ef53fE866675093F75936E`. Seat txs are in block 47299643. `openDispute` reverts `panel not seated` if the count later drops below 3. Agents do not `--broadcast`. See `script/DEPLOY_ESCROW_BASE_SEPOLIA.md`.
- [x] **(2) Escrow** — live `BotAttestationEscrow` `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (ESC-M-1 redeploy, deploy tx `0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa`, block 47345163, commit `444c427`). Linked DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. `transferOwnership` is `0xbffb1df647a1ecc3ec0ab479956b0564de0efe58d1664e0aad3c61a28fd76da8`. `acceptOwnership` is complete (`0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9`, block 47345442, status 1, from `CORE_TIMELOCK`). `owner` is `CORE_TIMELOCK` and `pendingOwner` is zero. The previous escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is retired (ESC-M-1 redeploy, retired 2026-09-26). Its own `acceptOwnership` was already complete (`0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983`, block 47300275). Agents do not `--broadcast`.
- [ ] **(3) Optional BVT** — `script/DeployBVT.s.sol`. Env: `BVT_GUARDIAN` (required, non-zero, ≠ deployer). Optional `BVT_INSURANCE_SINK`, `BVT_TREASURY`.
- [x] Record addresses and deploy txs in `deployments/base-sepolia.json` and `contracts/README.md` (core and escrow are filled; BVT is still null)
- [ ] Point the stamp API at those addresses
- [ ] Bootstrap operators via `BVTStaking.bootstrapOperator` — not a public sale

## Stage 3 — first institution
- [ ] **Disclaimer / Terms / Privacy live on stamp surfaces** (`DISCLAIMER.md`, `TERMS.md`, `PRIVACY.md`, and `GET /v1/disclaimer`) before any first-institution reliance
- [ ] One crypto-native bank / neobank / payment processor as **optional experimental** anchor tenant (stamp is not a certification they can "require")
- [ ] They call `/v1/access/check` before granting a bot financial permissions
- [ ] One real incident drill: file a claim, run the waterfall on testnet (experimental settlement design — not insurance; not a lawsuit waiver)

## What is NOT live yet
- TEE attestation against a real enclave
- Auditor staking and slash on mainnet
- Private scenario vault encryption at rest
- Cross-chain light clients
- Formal proofs in Certora (invariants are written; proofs are not)

Those are Stage 4. Do not wait for Stage 4 to start Stage 1.
