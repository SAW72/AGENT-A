# BotAttestationEscrow on Base Sepolia

`BotAttestationEscrow` is **live** on Base Sepolia against the live core stack. Gate B is **seated** on the live `DisputePanel` (`arbitratorCount` is 3). This file records that state. It does not deploy anything by itself.

**SIMULATE is not live.** `forge script` without `--broadcast` forks Base Sepolia and prints the calls. Nothing is sent. A green simulation is not a deployment. Do not paste a simulated address over the live book.

**HARD STOP**

- Agents do not pass `--broadcast` or `--resume`.
- Do not touch Ethereum mainnet. Every script here reverts on chainid `1`.
- Do not redeploy Denylist, Vault, or DisputePanel. Gate A is done. Gate B is seated. Use the live addresses below.
- Do not broadcast an escrow redeploy until the Auditor re-audit PASSES and the Verifier APPROVES. Spencer broadcasts. Agents do not.
- Do not change `BotAttestationEscrow.address` in `deployments/base-sepolia.json` in the prepare PR. Wiring is a separate PR after the human broadcast.
- Do not deploy BVT in this pack.
- Do not call `createEscrow` from an agent session.

The escrow on this branch includes the H-1 fix and the ESC-M-1 dispute-link checks. The contract already at `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` does not. An escrow-only redeploy is how that bytecode gets on Base Sepolia. This pack does not change Denylist, Vault, or DisputePanel bytecode.

Landed order: Gate B was seated (block 47299643), then escrow was created and `transferOwnership` ran (block 47299930), then `CORE_TIMELOCK` called `acceptOwnership` (block 47300275).

## Live addresses (chainid 84532)

| Role | Address |
| --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| BotAttestationEscrow | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` |
| CORE_TIMELOCK | `0x10CC9474b45625ADfd05C209f2518023484878D9` |

`BotAttestationEscrow.owner()` is `CORE_TIMELOCK`. `pendingOwner` is the zero address. `acceptOwnership` is complete.

`DisputePanel.owner()` is `CORE_TIMELOCK`. Gate B is seated: `arbitratorCount` is **3**. `openDispute` reverts `panel not seated` only if that count later drops below 3.

| # | Arbitrator | Seat tx (block 47299643) |
| --- | --- | --- |
| 1 | `0xD5ee9fA366C3698b34204722c635989E5197B018` | `0xa97b518ad87489ab1d45ec4bef5e548c1d4bf3b9c940552e8cba1752fed7553c` |
| 2 | `0xF4253A3a3C102Ee59e38b2AA92989C3232eDcC30` | `0xf1ad4d9221b2393863d9bc6a72c1a716cf389532d2cfa63fd4df682303ed6df6` |
| 3 | `0xB87Ed5F74276AC6172ef53fE866675093F75936E` | `0xa1f8f0fb6ad78dd2d9fd9d33dabf9cde5b73195a1b292869e7d96cc985cb79a3` |

Escrow create tx `0x700d9bac95e8833bd7e93721a88d689a0fb839c9e6108858c52560eae111948e` and `transferOwnership` tx `0x00aaef315f23de346bfe63e77e0f04d3fbcadc370b0db21bb7abb8f8e12c40f2` are both block 47299930. `acceptOwnership` tx `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` is block 47300275. The escrow is linked to DisputePanel `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`. Canonical copy: [`deployments/base-sepolia.json`](../deployments/base-sepolia.json).

`CORE_TIMELOCK` (`0x10CC9474b45625ADfd05C209f2518023484878D9`) is an EOA with EIP-7702 delegation to `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b`, not a timelock contract. `getMinDelay` reverts. It is the same account that owns the live Denylist and Vault. `onlyOwner` is `msg.sender == owner()`. A transaction whose sender is `CORE_TIMELOCK` is the owner call. See [`script/OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md).

Liability `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` and InsuranceFund `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` stay as they are. This pack does not call them.

## Escrow simulate env

`script/DeployBotAttestationEscrow.s.sol` reads these. All four addresses are required and must be the live rows above. The script reverts on any other Denylist, Vault, panel, or `CORE_TIMELOCK`. It deploys only `BotAttestationEscrow`. The deployer is `msg.sender`, which `forge` sets from `--sender` on a dry run and from `--account` plus `--sender` on a broadcast. The script does not read a signing key from the environment. `CORE_TIMELOCK` must not equal the deployer.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
```

| Variable | Meaning |
| --- | --- |
| `DENYLIST` | Live Denylist above. The script does not redeploy it. |
| `VAULT` | Live Vault above. The script does not redeploy it. |
| `DISPUTE_PANEL` | Live DisputePanel above. The script does not redeploy it. |
| `CORE_TIMELOCK` | Immutable escrow `governance` and Ownable2Step pending owner. EOA with EIP-7702 delegation, not a timelock contract. |
| `BASE_SEPOLIA_RPC_URL` | Base Sepolia RPC. Chainid must be `84532`. Any other chain reverts. |

## Escrow simulate (not live)

Dry-run sender is `0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001` (`SIMULATE_SENDER`), the public burn EOA. No private key. No `--broadcast`. Forge checks that sender's real balance while estimating gas, and this address already holds dust on Base Sepolia. It is not the deployer Spencer will use, and it is not `CORE_TIMELOCK`.

```bash
forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url https://sepolia.base.org \
  --sender 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
```

The log line `SIMULATE; no transaction will be sent` is the dry run. The address printed for `BotAttestationEscrow` exists only inside that process. Do not paste it into the address book.

Chain guard: chainid `1` reverts `DeployEscrow: mainnet forbidden`. Any chain other than `84532` reverts. There is no Ethereum Sepolia switch unless someone edits `ALLOWED_CHAIN_ID` on purpose. Do not.

## ESC-M-1 escrow-only redeploy (conditional GO)

Spencer gave a conditional GO for an **escrow-only** redeploy on Base Sepolia (chainid `84532`) once the Auditor re-audit PASSES and the Verifier APPROVES. This section is the runbook. It does not broadcast. A human broadcasts. Do not update `deployments/base-sepolia.json` until a follow-up wiring PR after that broadcast.

The script deploys one `BotAttestationEscrow` and calls `transferOwnership(CORE_TIMELOCK)`. Constructor arguments are the live Denylist, Vault, DisputePanel, and `CORE_TIMELOCK`. It does not deploy a new Denylist, Vault, or panel. `acceptOwnership` is a second transaction from `CORE_TIMELOCK`, not from the deployer, and not inside the deploy script.

### Keystore (one time, on the human machine)

Spencer's signing uses a Foundry keystore. No key on the command line, and no signing key in the environment. `cast wallet import --interactive` prompts for the key and stores it in the local keystore.

```bash
cast wallet import agentbv-deployer --interactive
cast wallet address --account agentbv-deployer
```

Import the `CORE_TIMELOCK` account the same way when that key is available on this machine:

```bash
cast wallet import core-timelock --interactive
```

If that account lives in a browser wallet, skip the `core-timelock` import. After the source is verified, `acceptOwnership()` can be sent from Basescan's Write Contract tab instead.

`<DEPLOYER_ADDRESS>` below is the address printed by `cast wallet address --account agentbv-deployer`. It must not be `CORE_TIMELOCK`.

### Broadcast (human only, after Auditor PASS and Verifier APPROVE)

Check out main at the squash-merge commit of PR #30 so the on-chain code matches main:

```bash
git checkout <MAIN_MERGE_SHA>
```

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

forge script script/DeployBotAttestationEscrow.s.sol:DeployBotAttestationEscrow \
  --rpc-url https://sepolia.base.org \
  --account agentbv-deployer \
  --sender <DEPLOYER_ADDRESS> \
  --broadcast
```

Record the new address as `NEW_ESCROW` and the create transaction as `DEPLOY_TX` from the broadcast receipt. Leave the book address `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` in place until the wiring PR. Broadcast from Foundry's default sender `0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38` or from the simulate burn address reverts `DeployEscrow: pass --account and --sender`.

### acceptOwnership (CORE_TIMELOCK, not the deployer)

`CORE_TIMELOCK` is the pending owner.

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast send "$NEW_ESCROW" "acceptOwnership()" --rpc-url https://sepolia.base.org --account core-timelock
```

Before this call, `owner()` is the deployer and `pendingOwner()` is `CORE_TIMELOCK`. After it, `owner()` is `0x10CC9474b45625ADfd05C209f2518023484878D9` and `pendingOwner()` is the zero address.

### Verify (Sourcify, then Basescan via Etherscan v2)

Compiler settings match `foundry.toml`: solc `0.8.20`, optimizer on, 200 runs, `cancun`. Basescan verification reads `ETHERSCAN_API_KEY` from the environment. Never commit it. Set it in the shell without echoing it:

```bash
read -s ETHERSCAN_API_KEY && export ETHERSCAN_API_KEY
```

```bash
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"
export DEPLOY_TX="<DEPLOY_TX_HASH>"
CTOR_ARGS="$(cast abi-encode "constructor(address,address,address,address)" \
  0xeE76876bECcFc1B58fC06fF4E654a517d784B224 \
  0x1463D664fA467FBCDA4B05443434494f05e565bc \
  0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb \
  0x10CC9474b45625ADfd05C209f2518023484878D9)"

forge verify-contract \
  --chain 84532 \
  --verifier sourcify \
  --compiler-version 0.8.20 \
  --num-of-optimizations 200 \
  --evm-version cancun \
  --creation-transaction-hash "$DEPLOY_TX" \
  "$NEW_ESCROW" \
  contracts/BotAttestationEscrow.sol:BotAttestationEscrow

forge verify-contract \
  --chain 84532 \
  --verifier etherscan \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=84532" \
  --compiler-version 0.8.20 \
  --num-of-optimizations 200 \
  --evm-version cancun \
  --constructor-args "$CTOR_ARGS" \
  "$NEW_ESCROW" \
  contracts/BotAttestationEscrow.sol:BotAttestationEscrow
```

### Read-only smoke checks

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export NEW_ESCROW="<NEW_ESCROW_ADDRESS>"

cast call "$NEW_ESCROW" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "vault()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "disputePanel()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "denylist()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_ESCROW" "lockedValue()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast balance "$NEW_ESCROW" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected after `acceptOwnership`: `owner` is `0x10CC9474b45625ADfd05C209f2518023484878D9`, `pendingOwner` is `0x0000000000000000000000000000000000000000`, `vault` is `0x1463D664fA467FBCDA4B05443434494f05e565bc`, `disputePanel` is `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb`, `denylist` is `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, `lockedValue` is `0`, and the contract balance is `0`.

`dispute` on an escrow id that was never created reverts `not a party` when the caller is a nonzero address. The zero escrow has payer and payee `address(0)`, and the default state is `Open`, so the party check is the revert. `--from` keeps the caller off `address(0)`.

```bash
cast call "$NEW_ESCROW" \
  "dispute(bytes32,bytes32)" \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  0x0000000000000000000000000000000000000000000000000000000000000002 \
  --from 0x0000000000000000000000000000000000000001 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected revert data is `Error(string)` with `"not a party"`.

## Escrow broadcast that already landed

The broadcast that created `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` already landed. That address stays the book address until the wiring PR. Do not treat a simulation address as a replacement. The conditional redeploy above is a later human broadcast of the ESC-M-1 bytecode, not a rerun of this historical deploy.

## Escrow ownership (complete)

1. `CORE_TIMELOCK` has called `acceptOwnership()` on `BotAttestationEscrow` `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`. `owner` is `CORE_TIMELOCK`. `pendingOwner` is the zero address. The accept tx is `0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983` (block 47300275).
2. The address and create-tx hash are in `BotAttestationEscrow.address` and `BotAttestationEscrow.deployTx` in [`deployments/base-sepolia.json`](../deployments/base-sepolia.json) and in the table in [`contracts/README.md`](../contracts/README.md).
3. `setDenylist`, `setVault`, and `setDisputePanel` revert unless `owner() == governance`, and they revert while `lockedValue != 0`.

`acceptOwnership` was an owner-to-be call from `CORE_TIMELOCK`, same as Gate A on Denylist and Vault. It is not part of the deploy script. Agents do not send it again.

## Gate B — seated

Gate B is seated. `arbitratorCount` is 3. The three arbitrators and seat txs are in the live-address section above. `openDispute` reverts `panel not seated` if `arbitratorCount` drops below 3. The escrow deploy script does not appoint arbitrators. The ops scripts below call the live panel only. They do not deploy a new panel. Agents do not `--broadcast` them.

Same broadcast rule as [`OpsDenylist`](OpsDenylist.s.sol) / [`OpsVault`](OpsVault.s.sol): dry-run `prank`s `CORE_TIMELOCK` and does not read a signing key. `--broadcast` and `--resume` revert unless the signer is `CORE_TIMELOCK`. Those ops scripts still use the older signing path. This escrow redeploy does not. The remaining runbook is [`OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md).

The three live seats are already on the panel. The placeholders below are for a future add or remove. They are not the seated arbitrators. Replace them before any new panel op.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DISPUTE_PANEL=0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

# Replace. These are documentation placeholders, not live arbitrators.
export ARBITRATOR_1=0x0000000000000000000000000000000000000A11
export ARBITRATOR_2=0x0000000000000000000000000000000000000A22
export ARBITRATOR_3=0x0000000000000000000000000000000000000A33
```

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DISPUTE_PANEL` | every panel op | Must be the live panel above. Any other address reverts. |
| `CORE_TIMELOCK` | every panel op | Must be the live owner above, and must equal `owner()`. |
| `ARBITRATOR` | add and remove | One address. |
| `ARBITRATOR_1`, `ARBITRATOR_2`, `ARBITRATOR_3` | seat | Three distinct non-zero addresses. |

### Simulate (not live)

The log line `SIMULATE; no transaction will be sent` is the dry run.

```bash
# Preferred Gate B batch. Three setArbitrator(account, true) calls.
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelSeat \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

# One add, or one remove.
export ARBITRATOR="$ARBITRATOR_1"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelAdd \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelRemove \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Accounts that already have the requested allowlist bit are skipped. No empty transaction is built for them.

### Broadcast (Spencer only)

Agents must not run this. The signer must be `CORE_TIMELOCK`. A deployer key reverts before `startBroadcast`.

```bash
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelSeat \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

One address at a time, still Spencer-only:

```bash
export ARBITRATOR="$ARBITRATOR_1"
forge script script/OpsDisputePanel.s.sol:OpsDisputePanelAdd \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast

forge script script/OpsDisputePanel.s.sol:OpsDisputePanelRemove \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

### Reads and calldata

```bash
cast call "$DISPUTE_PANEL" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DISPUTE_PANEL" "arbitratorCount()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DISPUTE_PANEL" "isArbitrator(address)(bool)" "$ARBITRATOR_1" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast calldata "setArbitrator(address,bool)" "$ARBITRATOR_1" true
cast calldata "setArbitrator(address,bool)" "$ARBITRATOR_1" false
```

A direct `cast send` of `setArbitrator` is not part of this escrow redeploy. Agents must not run it. The command still lives in [`OPS_LIVE_DENYLIST_VAULT.md`](OPS_LIVE_DENYLIST_VAULT.md) and still uses the older signing path. Check `owner()` first: `cast send` does not enforce the script's address book. After three successful adds, `arbitratorCount` is at least 3 and `openDispute` can succeed. Dropping below 3 makes `openDispute` revert `panel not seated` again.

## Failure modes

| Revert | When |
| --- | --- |
| `OpsLive: mainnet forbidden` | Panel ops on chainid `1` |
| `OpsLive: Base Sepolia (84532) only` | Panel ops on any other chain, including Ethereum Sepolia and Anvil |
| `DeployEscrow: mainnet forbidden` | Escrow deploy on chainid `1` |
| `DeployEscrow: Base Sepolia (84532) only; ...` | Escrow deploy on any other chain |
| `DeployEscrow: CORE_TIMELOCK unset` / `must not be deployer` | Escrow env |
| `DeployEscrow: DENYLIST unset` / `VAULT unset` / `DISPUTE_PANEL unset` | Escrow env missing or zero |
| `DeployEscrow: DENYLIST is not the live Base Sepolia Denylist` | Env denylist is not `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| `DeployEscrow: VAULT is not the live Base Sepolia Vault` | Env vault is not `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| `DeployEscrow: DISPUTE_PANEL is not the live Base Sepolia DisputePanel` | Env panel is not `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| `DeployEscrow: CORE_TIMELOCK is not the live owner` | Env timelock is not `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| `DeployEscrow: pass --account and --sender` | Escrow `--broadcast` from Foundry's default sender or from `SIMULATE_SENDER` |
| `OpsPanel: DISPUTE_PANEL unset` / `ARBITRATOR unset` / `ARBITRATOR_1 unset` (and `_2`, `_3`) | Missing or zero panel-op env |
| `OpsLive: CORE_TIMELOCK unset` | Panel op missing the timelock env |
| `OpsPanel: DISPUTE_PANEL is not the live Base Sepolia DisputePanel` | Env panel is not the live address |
| `OpsLive: CORE_TIMELOCK is not the live owner` | Env timelock is not the book address |
| `OpsPanel: DisputePanel.owner is not CORE_TIMELOCK` | On-chain owner moved |
| `OpsPanel: zero arbitrator` / `duplicate arbitrator` | Seat list |
| `OpsLive` signer is not the live owner | Panel `--broadcast` with any signer other than `CORE_TIMELOCK` |
| `OpsLive: owner unset` | Empty owner passed into the helper |
| `not owner` | `setArbitrator` from anyone except `owner()` |
| `zero arbitrator` | Panel rejects `address(0)` if a call reaches it |
| `panel not seated` | `openDispute` while `arbitratorCount < 3` |
| `FundingBeforeGovernance` | `createEscrow` before `acceptOwnership` |

## Checklist

- [x] Gate B seated (`arbitratorCount` is 3; seat txs in block 47299643)
- [x] Escrow deployed (`0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c`, block 47299930)
- [x] `CORE_TIMELOCK` `acceptOwnership` on the escrow (block 47300275; `pendingOwner` is zero)
- [x] Real escrow address and txs are in `deployments/base-sepolia.json` and `contracts/README.md`
- [x] Agents do not `--broadcast` and do not touch mainnet
- [ ] ESC-M-1 escrow-only redeploy, only after the Auditor re-audit PASSES and the Verifier APPROVES, then Spencer broadcasts
- [ ] Wiring PR updates `deployments/base-sepolia.json` after that broadcast. This PR does not.
