# CORE_TIMELOCK migration

`CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by `TimelockController` (this runbook).

Mainnet is not in scope. Do not set `ALLOW_MAINNET`. Chain ids `8453` (Base) and `1` (Ethereum) revert unless that flag is `1`. The deploy target is Base Sepolia (`84532`). A testnet `TIMELOCK_MIN_DELAY` may be short, for example `300`. A delay under 48 hours logs a warning only when `chainid` is `8453`.

This runbook does not create a Safe. `SAFE_ADDRESS` is an existing Safe that already has code. The scripts never read `PRIVATE_KEY`. Broadcast uses a Foundry keystore (`--account` and `--sender`) and `vm.startBroadcast()` with no key. Agents do not pass `--broadcast`.

## What the book owns today

`script/MigrateOwnershipToTimelock.s.sol` reads every address in `deployments/base-sepolia.json`, then `owner()` and `pendingOwner()` on chain. It acts only on rows whose live owner is `CORE_TIMELOCK`, plus the one non-owner privilege below. Null BVT slots are skipped. This table is a Base Sepolia reading taken while writing the script. The script re-reads at run time.

| Contract | Address | Ownership | In the handoff |
| --- | --- | --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| Liability | `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| InsuranceFund | `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| BotAttestationEscrow | `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, with the governance limit below |
| superseded Denylist | `0xF0f260967D377E07Bdd7840862508ddB23C012b8` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| superseded Vault | `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` | Ownable2Step, owner `0x5D467FA00eC0E92044f779e495a17db66c5964aa`, pending `CORE_TIMELOCK` | yes: the EOA accepts, then queues the timelock |
| retired BotAttestationEscrow | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, with the same governance limit |
| BVT, BVTStaking, BVTFeeRouter, BVTTimelock, BVTGovernor | null | not deployed | skipped |

`DisputePanel.isArbitrator(CORE_TIMELOCK)` is false. No enumerated contract grants `CORE_TIMELOCK` an AccessControl role.

### Not migrated cleanly: immutable escrow `governance`

Live escrow `0x1069…298d` and retired escrow `0x1412…284c` store `governance() == CORE_TIMELOCK`. That address is immutable. `createEscrow` reverts `FundingBeforeGovernance` unless `owner() == governance`. `setDenylist`, `setVault`, and `setDisputePanel` revert `NotGovernance` unless the caller is `governance` and `owner()` is `governance`.

After `owner` moves to the `TimelockController`, neither the EOA nor the timelock can call those four functions. `release`, `refund`, `withdraw`, and `withdrawTo` are not owner-gated and keep working. A new escrow, constructed with `governance` set to the `TimelockController`, is required before anyone can create another escrow or retarget the denylist, vault, or panel. This script does not deploy that escrow.

### Immediate `setOwner` risk

Liability, InsuranceFund, and DisputePanel have no `pendingOwner`. Step 1 calls `setOwner(newTimelock)` in the same transaction. There is no accept step and no timelock delay on that handoff. The risk is the handoff itself: the EOA can name any new owner in one transaction. Once the owner is the timelock, later owner calls wait for `TIMELOCK_MIN_DELAY`.

Ownable2Step rows stay owned by the current owner until the timelock's `acceptOwnership` executes. Until that accept, `CORE_TIMELOCK` can still replace `pendingOwner`.

## 0. Deploy the controller

Import the deployer keystore out of band. Do not put the key in the environment.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export SAFE_ADDRESS=<existing-safe-with-code>
export TIMELOCK_MIN_DELAY=300
# Optional. Unset, or address(0), means anyone can execute after the delay.
# A non-zero value should be the Safe.
# export TIMELOCK_EXECUTOR=$SAFE_ADDRESS
```

Simulate. This command does not broadcast.

```bash
forge script script/DeployTimelock.s.sol:DeployTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --sender 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001
```

Spencer deploys. This is the one deploy broadcast.

```bash
forge script script/DeployTimelock.s.sol:DeployTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <deployer-account> \
  --sender <deployer-address> \
  --broadcast
```

Proposers are `[SAFE_ADDRESS]`. OpenZeppelin v5.7.0 also grants that Safe `CANCELLER_ROLE`. `admin` is `address(0)`. `DEFAULT_ADMIN_ROLE` is held by the timelock contract, not by an EOA. Record the logged address as `NEW_TIMELOCK`. Do not write it into `deployments/base-sepolia.json` in this change.

## 1. Transfer, signed by the EOA

`MIGRATION_STEP=transfer` (the default). The script skips a row whose `owner` is already `NEW_TIMELOCK` and whose `pendingOwner` is zero, and it skips an Ownable2Step row already pending `NEW_TIMELOCK`. Re-running it is safe.

Simulate. This command does not broadcast. On a fork it pranks `CORE_TIMELOCK` and prints the accept batch from the simulated state.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export MIGRATION_STEP=transfer
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Spencer sends step 1 from the `CORE_TIMELOCK` keystore. `--sender` is `0x10CC9474b45625ADfd05C209f2518023484878D9`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export MIGRATION_STEP=transfer
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <core-timelock-account> \
  --sender 0x10CC9474b45625ADfd05C209f2518023484878D9 \
  --broadcast
```

For the superseded Vault, this transaction calls `acceptOwnership` (the EOA is `pendingOwner`) and then `transferOwnership(NEW_TIMELOCK)`.

## 2. Timelock accepts Ownable2Step ownership

Do not broadcast this step. After step 1, print the batch. The targets are only rows whose `pendingOwner` is already `NEW_TIMELOCK`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export MIGRATION_STEP=accept
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log is the Safe proposal. Predecessor is `bytes32(0)`. Salt is `keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1")`. Delay is `getMinDelay()`. Each payload is `acceptOwnership()` (`0x79ba5097`). Values are `0`.

The Safe calls `scheduleBatch(targets, values, payloads, predecessor, salt, delay)` on `NEW_TIMELOCK`. After the delay, `executeBatch(targets, values, payloads, predecessor, salt)` runs. With an open executor (`TIMELOCK_EXECUTOR` unset or `address(0)`), any account can execute. With the Safe as executor, only the Safe can.

If the remaining set changes, the operation id changes. Cancel the previously scheduled operation from the Safe before scheduling a different batch. `acceptOwnership` on a row that already completed reverts, and that reverts the whole batch.

Immediate `setOwner` rows are not in this batch. Their owner is already the timelock after step 1.

## 3. Post-check

This command does not broadcast.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export MIGRATION_STEP=check
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

It reverts unless every in-scope row has `owner() == NEW_TIMELOCK` and `pendingOwner() == 0`, and no enumerated contract still has `CORE_TIMELOCK` as `owner` or `pendingOwner`. Immutable `governance` is unchanged. The check does not treat that as ownership.

## Outflow paths

Live ETH balances on the enumerated contracts were 0 at the reading above. `lockedValue()` on both escrows was 0. Live `totalOwed()` reverted on `0x1069…298d` (that getter is in the current source; the deployed bytecode did not answer it).

Escrow ETH leaves only through the current source's pull path. No owner function sends the balance.

| Function | Who can trigger it today | Who after migration | Limit |
| --- | --- | --- | --- |
| `release` | While `Open`, the payer only, before `expiresAt`, if both bots still verify. While `Disputed`, the payer or the payee, and only after the panel upholds. Not the owner. | Same. Not the timelock. | Credits `payee` the escrow `amount`. Does not push ETH. |
| `refund` | Anyone, if the escrow is expired while `Open`, the panel ruled an unwind, or an unresolved dispute is past `expiresAt + RULING_GRACE` (7 days). An upheld ruling cannot refund. | Same. | Credits `payer` the escrow `amount`. Does not push ETH. |
| `withdraw` | The credited account, for its whole `pendingWithdrawals` balance. | Same. | That account's credit, sent to itself. |
| `withdrawTo` | The credited account. | Same. | That account's credit, sent to `to`. |
| `createEscrow` | Inflow, and only while `owner() == governance` (`CORE_TIMELOCK`). | Reverts `FundingBeforeGovernance` until a new escrow is deployed with `governance` set to the timelock. | Not an outflow. |

The Vault holds no ETH and has no token balance and no withdrawal function. Owner calls are `register`, `setOperator`, and `burn`. After migration those wait on the Safe plus the delay. `burn` stays irreversible.

Liability can hold ETH (`receive`). `settle` when the liable party is `Owner` sends `claim.amount` to the claimant. Today `CORE_TIMELOCK` files the claim and settles it, up to the contract's ETH balance. After migration only the timelock can, via the Safe, after the delay. The auditor branch reverts. The insurance branch calls `InsuranceFund.payout`.

InsuranceFund can hold ETH (`fund`). `payout` is `onlyLiability`, not the owner. The owner cannot withdraw. ETH leaves only when Liability `settle` calls `payout`, capped by the fund's accounted `balance` and the claim amount. Today that caller path is `CORE_TIMELOCK` as Liability owner. After migration it is the timelock, via the Safe, after the delay.

Denylist and DisputePanel hold no ETH. DisputePanel `setArbitrator` and `setOwner` move with the owner. `CORE_TIMELOCK` is not a seated arbitrator.

After the accept batch, `CORE_TIMELOCK` is not `owner` or `pendingOwner` of any enumerated contract. It remains the immutable `governance` address on both escrows and cannot call the gated functions unless it is also `owner`. It has no remaining owner power on those contracts.
