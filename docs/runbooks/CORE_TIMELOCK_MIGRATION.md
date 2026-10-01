# CORE_TIMELOCK migration

`CORE_TIMELOCK` `0x10CC9474b45625ADfd05C209f2518023484878D9` is an EOA (with EIP-7702 delegation), not a timelock; to be replaced by `TimelockController` (this runbook).

Mainnet is not in scope. Do not set `ALLOW_MAINNET`. `DeployTimelock` runs only on chainid `84532` (Base Sepolia) or `31337` (Anvil). Every other chain reverts unless `ALLOW_MAINNET=1`. The migration script still reverts on chain ids `8453` and `1` unless that same flag is set. A testnet `TIMELOCK_MIN_DELAY` may be short, for example `300`. A delay under 48 hours logs a warning only when `chainid` is `8453`.

This runbook does not create a Safe. `SAFE_ADDRESS` is an existing Safe that already has code. The scripts never read `PRIVATE_KEY`. Broadcast uses a Foundry keystore (`--account` and `--sender`) and `vm.startBroadcast()` with no key. Agents do not pass `--broadcast`.

## What the book owns today

`script/MigrateOwnershipToTimelock.s.sol` reads every address in `deployments/base-sepolia.json`, then `owner()` and `pendingOwner()` on chain. It acts only on rows whose live owner is `CORE_TIMELOCK`, plus the one non-owner privilege below. A row whose `governance()` is `CORE_TIMELOCK` is skipped unless `MIGRATE_ESCROWS=1`. Null BVT slots are skipped. This table is a Base Sepolia reading taken while writing the script. The script re-reads at run time.

| Contract | Address | Ownership | In the handoff |
| --- | --- | --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| Liability | `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| InsuranceFund | `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` | immediate `setOwner`, owner `CORE_TIMELOCK` | yes, immediate, no delay on the handoff |
| BotAttestationEscrow | `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | skipped unless `MIGRATE_ESCROWS=1` |
| superseded Denylist | `0xF0f260967D377E07Bdd7840862508ddB23C012b8` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | yes, then timelock `acceptOwnership` |
| superseded Vault | `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` | Ownable2Step, owner `0x5D467FA00eC0E92044f779e495a17db66c5964aa`, pending `CORE_TIMELOCK` | yes: the EOA accepts, then queues the timelock |
| retired BotAttestationEscrow | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` | Ownable2Step, owner `CORE_TIMELOCK`, pending `0` | skipped unless `MIGRATE_ESCROWS=1` |
| BVT, BVTStaking, BVTFeeRouter, BVTTimelock, BVTGovernor | null | not deployed | skipped |

`DisputePanel.isArbitrator(CORE_TIMELOCK)` is false. No enumerated contract grants `CORE_TIMELOCK` an AccessControl role.

### Escrows are opt-in

Live escrow `0x1069…298d` and retired escrow `0x1412…284c` store `governance() == CORE_TIMELOCK`. That address is immutable. `createEscrow` reverts `FundingBeforeGovernance` unless `owner() == governance`. `setDenylist`, `setVault`, and `setDisputePanel` revert `NotGovernance` unless the caller is `governance` and `owner()` is `governance`.

The default is to skip both. The log says why: immutable governance; migrating bricks `createEscrow` and the setters. `postCheck` accepts those rows still owned by `CORE_TIMELOCK` while `MIGRATE_ESCROWS` is unset.

Set `MIGRATE_ESCROWS=1` only when that brick is intentional. After `owner` moves to the `TimelockController`, neither the EOA nor the timelock can call those four functions. `release`, `refund`, `withdraw`, and `withdrawTo` are not owner-gated and keep working. A new escrow, constructed with `governance` set to the `TimelockController`, is required before anyone can create another escrow or retarget the denylist, vault, or panel. This script does not deploy that escrow. With the flag set, `postCheck` requires both escrows on the timelock with `pendingOwner == 0`.

### Immediate `setOwner` risk

Liability, InsuranceFund, and DisputePanel have no `pendingOwner`. Step 1 calls `setOwner(newTimelock)` in the same transaction. There is no accept step and no timelock delay on that handoff. The risk is the handoff itself: the EOA can name any new owner in one transaction. Once the owner is the timelock, later owner calls wait for `TIMELOCK_MIN_DELAY`.

Ownable2Step rows stay owned by the current owner until the timelock's `acceptOwnership` executes. Until that accept, `CORE_TIMELOCK` can still replace `pendingOwner`.

## 0. Deploy the controller

Import the deployer keystore out of band. Do not put the key in the environment.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export SAFE_ADDRESS=<existing-safe-with-code>
export TIMELOCK_MIN_DELAY=300
# Testnet may leave TIMELOCK_EXECUTOR unset. address(0) is an open executor: anyone can execute after the delay.
# Mainnet, if it is ever in scope, should set the Safe as the executor. Do not leave mainnet open.
# export TIMELOCK_EXECUTOR=$SAFE_ADDRESS
```

On Base Sepolia the open executor is acceptable. For mainnet, set `TIMELOCK_EXECUTOR` to `SAFE_ADDRESS` so only the Safe can execute. Mainnet is not in scope for this runbook.

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

`MIGRATION_STEP=transfer` (the default). Before any ownership call, the script reads `SAFE_ADDRESS` and reverts unless `NEW_TIMELOCK` has code, `getMinDelay() > 0`, the Safe holds `PROPOSER_ROLE`, the timelock holds `DEFAULT_ADMIN_ROLE`, and neither `CORE_TIMELOCK` nor the sender holds `DEFAULT_ADMIN_ROLE`. The script skips a row whose `owner` is already `NEW_TIMELOCK` and whose `pendingOwner` is zero, and it skips an Ownable2Step row already pending `NEW_TIMELOCK`. It also skips both escrows unless `MIGRATE_ESCROWS=1`. Re-running it is safe.

Simulate. This command does not broadcast. On a fork it pranks `CORE_TIMELOCK` and prints the accept batch from the simulated state.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export SAFE_ADDRESS=<existing-safe-with-code>
export MIGRATION_STEP=transfer
# export MIGRATE_ESCROWS=1
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Spencer sends step 1 from the `CORE_TIMELOCK` keystore. `--sender` is `0x10CC9474b45625ADfd05C209f2518023484878D9`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export SAFE_ADDRESS=<existing-safe-with-code>
export MIGRATION_STEP=transfer
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <core-timelock-account> \
  --sender 0x10CC9474b45625ADfd05C209f2518023484878D9 \
  --broadcast
```

For the superseded Vault, this transaction calls `acceptOwnership` (the EOA is `pendingOwner`) and then `transferOwnership(NEW_TIMELOCK)`.

## 2. Timelock accepts Ownable2Step ownership

Do not broadcast this step. The same `NEW_TIMELOCK` checks as step 1 run before any calldata is printed. After step 1, print the batch. The targets are only rows whose `pendingOwner` is already `NEW_TIMELOCK`. Escrow rows are omitted unless `MIGRATE_ESCROWS=1`.

```bash
export NEW_TIMELOCK=<timelock-from-step-0>
export SAFE_ADDRESS=<existing-safe-with-code>
export MIGRATION_STEP=accept
forge script script/MigrateOwnershipToTimelock.s.sol:MigrateOwnershipToTimelock \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log is the Safe proposal. Predecessor is `bytes32(0)`. Salt is `keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1")`. Delay is `getMinDelay()`. Each payload is `acceptOwnership()` (`0x79ba5097`). Values are `0`.

The Safe calls `scheduleBatch(targets, values, payloads, predecessor, salt, delay)` on `NEW_TIMELOCK`. After the delay, `executeBatch(targets, values, payloads, predecessor, salt)` runs. On this testnet, an open executor (`TIMELOCK_EXECUTOR` unset or `address(0)`) means any account can execute. For mainnet, deploy with `TIMELOCK_EXECUTOR` set to the Safe so only the Safe can execute.

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

It reverts unless every in-scope row has `owner() == NEW_TIMELOCK` and `pendingOwner() == 0`, and no enumerated non-escrow contract still has `CORE_TIMELOCK` as `owner` or `pendingOwner`. With `MIGRATE_ESCROWS` unset, the two escrows may still be owned by `CORE_TIMELOCK`. With `MIGRATE_ESCROWS=1`, those two must be on the timelock and `pendingOwner` must be zero. Immutable `governance` is unchanged either way.

## Kill switch / rollback

Nothing is instant once the timelock owns a contract. `transferOwnership`, `setOwner`, and every other owner call wait for `getMinDelay()` before they can execute. Cancelling a waiting operation does not undo one that has already executed.

### Cancel a scheduled operation

The Safe holds `CANCELLER_ROLE`. It calls `cancel(bytes32 id)` on `NEW_TIMELOCK`.

For one call, the id is the timelock's pure `hashOperation`:

```text
id = hashOperation(target, value, data, predecessor, salt)
```

For a batch, including the accept batch, the id is `hashOperationBatch`:

```text
id = hashOperationBatch(targets, values, payloads, predecessor, salt)
```

The arguments are the same ones that were scheduled. The migration accept batch uses predecessor `bytes32(0)` and salt `keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1")`. `cancel` succeeds only while the operation is waiting or ready.

### Move ownership back

The Safe proposes a new schedule on `NEW_TIMELOCK`, waits out `getMinDelay()`, then executes. There is no same-transaction return.

- Ownable2Step (`Denylist`, `Vault`, and the superseded pair, plus the escrows if they were opted in): the payload is `transferOwnership(address)` aimed at the return address. After execute, that address is only `pendingOwner`. It must call `acceptOwnership()` itself. Until that call, the timelock remains owner.
- Immediate `setOwner` (Liability, InsuranceFund, DisputePanel): the payload is `setOwner(address)` aimed at the return address. Execute sets the owner in that transaction. The delay is the wait before execute. There is no second accept.

## Outflow paths

Live ETH balances on the enumerated contracts were 0 at the reading above. `lockedValue()` on both escrows was 0. Live `totalOwed()` reverted on `0x1069…298d` (that getter is in the current source; the deployed bytecode did not answer it).

Escrow ETH leaves only through the current source's pull path. No owner function sends the balance.

| Function | Who can trigger it today | Who after migration | Limit |
| --- | --- | --- | --- |
| `release` | While `Open`, the payer only, before `expiresAt`, if both bots still verify. While `Disputed`, the payer or the payee, and only after the panel upholds. Not the owner. | Same. Not the timelock. | Credits `payee` the escrow `amount`. Does not push ETH. |
| `refund` | Anyone, if the escrow is expired while `Open`, the panel ruled an unwind, or an unresolved dispute is past `expiresAt + RULING_GRACE` (7 days). An upheld ruling cannot refund. | Same. | Credits `payer` the escrow `amount`. Does not push ETH. |
| `withdraw` | The credited account, for its whole `pendingWithdrawals` balance. | Same. | That account's credit, sent to itself. |
| `withdrawTo` | The credited account. | Same. | That account's credit, sent to `to`. |
| `createEscrow` | Inflow, and only while `owner() == governance` (`CORE_TIMELOCK`). | Unchanged while the escrows are skipped. With `MIGRATE_ESCROWS=1`, reverts `FundingBeforeGovernance` until a new escrow is deployed with `governance` set to the timelock. | Not an outflow. |

The Vault holds no ETH and has no token balance and no withdrawal function. Owner calls are `register`, `setOperator`, and `burn`. After migration those wait on the Safe plus the delay. `burn` stays irreversible.

Liability can hold ETH (`receive`). `settle` when the liable party is `Owner` sends `claim.amount` to the claimant. Today `CORE_TIMELOCK` files the claim and settles it, up to the contract's ETH balance. After migration only the timelock can, via the Safe, after the delay. The auditor branch reverts. The insurance branch calls `InsuranceFund.payout`.

InsuranceFund can hold ETH (`fund`). `payout` is `onlyLiability`, not the owner. The owner cannot withdraw. ETH leaves only when Liability `settle` calls `payout`, capped by the fund's accounted `balance` and the claim amount. Today that caller path is `CORE_TIMELOCK` as Liability owner. After migration it is the timelock, via the Safe, after the delay.

Denylist and DisputePanel hold no ETH. DisputePanel `setArbitrator` and `setOwner` move with the owner. `CORE_TIMELOCK` is not a seated arbitrator.

After the default accept batch, `CORE_TIMELOCK` is not `owner` or `pendingOwner` of the non-escrow contracts. It still owns both escrows, and it remains their immutable `governance`, so `createEscrow` and the setters keep working for that EOA. With `MIGRATE_ESCROWS=1`, it is not `owner` or `pendingOwner` of those escrows either, and the gated functions revert because `governance` is still the EOA while `owner` is the timelock.
