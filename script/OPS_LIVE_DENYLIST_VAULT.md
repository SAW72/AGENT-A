# Live Denylist and Vault ops

Operator pack for the **live** Base Sepolia pair. These scripts call the contracts that are already deployed. They do not deploy, upgrade, or change Denylist or Vault bytecode.

**HARD STOP:** no `--broadcast` from agents. No escrow. No BVT. No Denylist or Vault redeploy. No mainnet.

Canonical addresses: [`deployments/base-sepolia.json`](../deployments/base-sepolia.json). Wallet and relayer ABI: [`contracts/interfaces/IVault.sol`](../contracts/interfaces/IVault.sol).

## Live addresses (chainid 84532)

| Role | Address |
| --- | --- |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| CORE_TIMELOCK (owner of both) | `0x10CC9474b45625ADfd05C209f2518023484878D9` |

Gate A is done. `owner()` is `CORE_TIMELOCK` and `pendingOwner()` is the zero address on both. `Vault.denylist()` is the live Denylist. Listing migration from the previous denylist was empty (0 Exact / 0 Signature / 0 Prompt), so this pair starts with no active listings and no bots.

The previous pair is still on chain and is **not** a target:

| Role | Superseded address |
| --- | --- |
| Denylist | `0xF0f260967D377E07Bdd7840862508ddB23C012b8` |
| Vault | `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` |

The scripts revert if `DENYLIST`, `VAULT`, or `CORE_TIMELOCK` is anything except the live row above, including the superseded pair. The old Vault still points at the old Denylist.

`CORE_TIMELOCK` is the Ownable2Step owner. On chain that account's code is an EIP-7702 delegation (`EIP7702StatelessDeleGator` 1.3.0). It is not an OpenZeppelin `TimelockController`: there is no `schedule` / `getMinDelay` on it. `onlyOwner` checks `msg.sender == owner()`. A transaction whose sender is `CORE_TIMELOCK` is the owner call.

## Env

Keys and RPC come from the environment only. Never commit `PRIVATE_KEY`.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
```

| Variable | Used by | Meaning |
| --- | --- | --- |
| `DENYLIST` | every op | Live Denylist. Vault ops also require it, and revert if `Vault.denylist()` differs. |
| `VAULT` | Vault ops | Live Vault. |
| `CORE_TIMELOCK` | every op | Must equal `owner()` and the live timelock above. |
| `LISTING_ID` | Denylist ops | `bytes32` weight hash, behavior signature, or prompt hash. `bytes32(0)` reverts `ZeroId`. |
| `BUCKET` | `OpsDenylistRemove` | `Exact`, `Signature`, or `Prompt`. |
| `BOT_ID` | Vault ops | `bytes32` bot id. |
| `WEIGHT_HASH`, `BEHAVIOR_SIG`, `PROMPT_HASH` | register | Fingerprint passed to `denylist.check`. |
| `TIER` | register | `None`, `Chat`, `DataTools`, `Financial`, or `Critical`. |
| `OPERATOR` | six-arg register | Non-zero address bound as `operator[botId]`. |
| `PRIVATE_KEY` | Spencer `--broadcast` only | Must be the key for `CORE_TIMELOCK`. Omit it for simulate. |

Ordinals, if you build calldata by hand:

| Enum | Name | Value |
| --- | --- | --- |
| `Denylist.Bucket` | Exact, Signature, Prompt | 0, 1, 2 |
| `Denylist.MatchLevel` | None, PromptBlock, SignatureBlock, ExactBlock | 0, 1, 2, 3 |
| `Vault.Tier` | None, Chat, DataTools, Financial, Critical | 0, 1, 2, 3, 4 |

## Simulate vs Spencer broadcast

Default path is simulate. `forge script` without `--broadcast` forks Base Sepolia, checks the live addresses, and `prank`s `CORE_TIMELOCK` for the one owner call. Nothing is sent. No `PRIVATE_KEY`.

```bash
forge script script/OpsDenylist.s.sol:OpsDenylistAddExact --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The log line `SIMULATE; no transaction will be sent` is the dry run. State you see after the call exists only inside that process.

`--broadcast` and `--resume` are **Spencer-only**. The script sends only when `PRIVATE_KEY` addresses to `CORE_TIMELOCK`. Any other key reverts before `startBroadcast` (`OpsLive: PRIVATE_KEY is not the live owner; Spencer only`). Agents must not pass `--broadcast`.

```bash
# Spencer, on his machine, with the CORE_TIMELOCK key in the environment.
forge script script/OpsDenylist.s.sol:OpsDenylistAddExact \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast
```

Chain guard on every script: chainid `1` reverts `OpsLive: mainnet forbidden`. Any chain other than `84532` reverts `OpsLive: Base Sepolia (84532) only`. There is no Sepolia switch on these scripts. The live addresses exist on Base Sepolia.

## Denylist commands

`LISTING_ID` is one id in one bucket. The same `bytes32` can be listed in more than one bucket. `remove` names the bucket.

```bash
export LISTING_ID=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

forge script script/OpsDenylist.s.sol:OpsDenylistAddExact --rpc-url "$BASE_SEPOLIA_RPC_URL"
forge script script/OpsDenylist.s.sol:OpsDenylistAddSignature --rpc-url "$BASE_SEPOLIA_RPC_URL"
forge script script/OpsDenylist.s.sol:OpsDenylistAddPrompt --rpc-url "$BASE_SEPOLIA_RPC_URL"

export BUCKET=Exact   # or Signature, or Prompt
forge script script/OpsDenylist.s.sol:OpsDenylistRemove --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`addPrompt` stores a prompt hash. `check` then returns `PromptBlock` (ordinal 1) when no stronger active match exists. That level blocks `Vault.register`. It is not a review queue.

`remove` clears `active` for that bucket. `timesListed`, `firstListedAt`, and `everListed` stay. The log prints `active`, `everListed`, and `timesListed` after the call.

## Vault commands

Register reads `DENYLIST` as well as `VAULT`, and reverts if the vault's denylist pointer is not that address.

```bash
export BOT_ID=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export WEIGHT_HASH=0x1111111111111111111111111111111111111111111111111111111111111111
export BEHAVIOR_SIG=0x2222222222222222222222222222222222222222222222222222222222222222
export PROMPT_HASH=0x3333333333333333333333333333333333333333333333333333333333333333
export TIER=Financial

# five-arg. operator stays address(0)
forge script script/OpsVault.s.sol:OpsVaultRegister --rpc-url "$BASE_SEPOLIA_RPC_URL"

# six-arg. binds OPERATOR in the same call
export OPERATOR=0x000000000000000000000000000000000000bEEF
forge script script/OpsVault.s.sol:OpsVaultRegisterWithOperator --rpc-url "$BASE_SEPOLIA_RPC_URL"

forge script script/OpsVault.s.sol:OpsVaultBurn --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`burn` sets `active` false. The same `BOT_ID` cannot be registered again (`already registered`). Burn does not write the denylist. Listing the fingerprint is a separate Denylist op.

A relayer that is not `CORE_TIMELOCK` cannot send these calls. [`IVault`](../contracts/interfaces/IVault.sol) is the ABI a wallet uses to encode them and to read `bots`, `operator`, `grantAccess`, `denylist`, `owner`, and `pendingOwner`. The transaction still has to come from the owner.

## Cast recipes

Reads (anyone):

```bash
cast call "$DENYLIST" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DENYLIST" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "denylist()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# MatchLevel uint8. None=0, PromptBlock=1, SignatureBlock=2, ExactBlock=3.
cast call "$DENYLIST" "check(bytes32,bytes32,bytes32)(uint8)" \
  "$WEIGHT_HASH" "$BEHAVIOR_SIG" "$PROMPT_HASH" --rpc-url "$BASE_SEPOLIA_RPC_URL"

# everListed(bucket, id). bucket uint8: Exact=0, Signature=1, Prompt=2.
cast call "$DENYLIST" "everListed(uint8,bytes32)(bool)" 0 "$LISTING_ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DENYLIST" "listing(uint8,bytes32)(bool,uint64,uint64,uint64,uint64,address,address)" \
  0 "$LISTING_ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" \
  "$BOT_ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Calldata for a timelock-owned send. Prefer the forge scripts above. Use `cast calldata` when a wallet needs the payload. There is no `schedule` on `CORE_TIMELOCK`.

```bash
cast calldata "addExact(bytes32)" "$LISTING_ID"
cast calldata "addSignature(bytes32)" "$LISTING_ID"
cast calldata "addPrompt(bytes32)" "$LISTING_ID"
cast calldata "remove(bytes32,uint8)" "$LISTING_ID" 0

cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8)" \
  "$BOT_ID" "$WEIGHT_HASH" "$BEHAVIOR_SIG" "$PROMPT_HASH" 3
cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_ID" "$WEIGHT_HASH" "$BEHAVIOR_SIG" "$PROMPT_HASH" 3 "$OPERATOR"
cast calldata "burn(bytes32)" "$BOT_ID"
```

Spencer send, only from the `CORE_TIMELOCK` key. Agents must not run this. Example:

```bash
cast send "$DENYLIST" "addExact(bytes32)" "$LISTING_ID" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY"
```

A key that is not the owner reverts `OwnableUnauthorizedAccount`. Sending to the superseded addresses updates the wrong contracts. The forge scripts refuse those addresses; raw `cast send` does not, so check `owner()` and `denylist()` first.

## Failure modes

| Revert | When |
| --- | --- |
| `OpsLive: mainnet forbidden` | chainid `1` |
| `OpsLive: Base Sepolia (84532) only` | any other chain, including Ethereum Sepolia and Anvil |
| `OpsLive: DENYLIST unset` / `VAULT unset` / `CORE_TIMELOCK unset` | missing or zero address env |
| `OpsLive: superseded Denylist` / `superseded Vault` | env points at the previous pair |
| `OpsLive: DENYLIST is not the live Base Sepolia Denylist` | env is some other denylist |
| `OpsLive: VAULT is not the live Base Sepolia Vault` | env is some other vault |
| `OpsLive: CORE_TIMELOCK is not the live owner` | env timelock is not the book address |
| `OpsLive: Denylist.owner is not CORE_TIMELOCK` | on-chain owner moved |
| `OpsLive: Vault.owner is not CORE_TIMELOCK` | on-chain owner moved |
| `OpsLive: Vault.denylist is not DENYLIST` | vault points at a different denylist |
| `OpsLive: PRIVATE_KEY is not the live owner; Spencer only` | `--broadcast` with any other key |
| `OpsLive: BUCKET must be Exact, Signature, or Prompt` | bad `BUCKET` (names are case-sensitive; `0` is not accepted) |
| `OpsLive: TIER must be None, Chat, DataTools, Financial, or Critical` | bad `TIER` |
| `ZeroId()` | `LISTING_ID` is `bytes32(0)` on add or remove |
| `AlreadyListed(bucket, id)` | add while that bucket row is `active`. `timesListed` does not increase |
| `NotListed(bucket, id)` | `remove` when that bucket row is not active |
| `OwnableUnauthorizedAccount(account)` | caller is not `owner()` |
| `bot is denylisted` | `register` while `check` is `PromptBlock`, `SignatureBlock`, or `ExactBlock` |
| `already registered` | second `register` for the same `botId`, including after `burn` |
| `zero operator` | six-arg `register` or `setOperator` with `address(0)`. Six-arg register does not store the bot |
| `unknown bot` | `setOperator` before any successful register |
| `not active` | `burn` when the bot is missing or already burned |
| `bot not active` | `grantAccess` when the bot is missing or burned |

`check` itself does not revert on a match and does not emit. It returns a `MatchLevel`. After a successful `remove`, `check` can return `None` for that fingerprint while `everListed` stays true, and `register` can then succeed.
