# Register two Financial-tier test bots on the live Base Sepolia Vault

This runbook registers two test bots on the live Vault so `createEscrow` on the live escrow can get past `InvalidParties`. Spencer signs both registrations from `CORE_TIMELOCK`. An agent session stops at the read-only dry-run.

The live Vault has no bots. `BotAttestationEscrow.createEscrow` reads `Vault.operator(botId)` and reverts `InvalidParties` when that address is the zero address. Binding a payer operator and a payee operator, both at Financial tier, is the fix.

Reads below were taken against `https://sepolia.base.org` (chain id `84532`). Owner, tier, and empty-bot reads ran while the head moved through `47391918`–`47392049`. The register gas figures are from block `47392038`. The `Registered` / `OperatorSet` log scan covers the Vault from its deploy block `47294164` through block `47392049`. Nothing in this file was broadcast.

## Hard stops

1. Spencer sends the two `cast send` transactions himself, from `0x10CC9474b45625ADfd05C209f2518023484878D9`.
2. Agent sessions stop after `cast call`, `cast estimate`, `cast code`, `cast storage`, `cast logs`, and `cast calldata`. They do not run `cast send`, `--broadcast`, or any command with a private key.
3. The send templates use `--account <his-keystore>`. They do not contain `--private-key`.
4. The chain is Base Sepolia only. The RPC is `https://sepolia.base.org`.

## What the source and the chain agree on

`contracts/Vault.sol` at main `34c9d71` is the registration contract. The owner-only write that fixes the escrow check is the six-argument overload:

```solidity
function register(
    bytes32 botId,
    bytes32 weightHash,
    bytes32 behaviorSig,
    bytes32 promptHash,
    Tier tier,
    address operator_
) external onlyOwner
```

Selector `0xb4560e96`. `Tier.Financial` is enum value `3` (`None = 0`, `Chat = 1`, `DataTools = 2`, `Financial = 3`, `Critical = 4`). The five-argument `register` (`0xeea95429`) stores the bot and leaves `operator` at the zero address, so `createEscrow` still reverts `InvalidParties`. Use the six-argument form.

There is no stake, bond, or fee on this call. The argument list has no token and no amount. The function is not payable: a call with `msg.value` of 1 wei reverts with empty revert data. `deployments/base-sepolia.json` leaves `BVT.address` null, and `Vault.register` does not call `BVTFeeRouter`. Spencer does not approve a token and does not attach ETH to the registration.

`onlyOwner` checks `msg.sender == owner()`. On chain that owner is `0x10CC9474b45625ADfd05C209f2518023484878D9`. `pendingOwner()` is the zero address. The same account owns the live Denylist and the live escrow, and it is the escrow's immutable `governance`.

That account is an EIP-7702-delegated EOA. Its code is 23 bytes:

```text
0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

The address after `0xef0100` is `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` (the delegate recorded in `test/LiveDenylistVault.t.sol`). `getMinDelay()` reverts. `schedule(address,uint256,bytes,bytes32,bytes32,uint256)` reverts. There is no `TimelockController` delay. A transaction from this account runs immediately.

`register` also calls `denylist.check(weightHash, behaviorSig, promptHash)` and requires `MatchLevel.None` (`0`). Any other level reverts with the string `bot is denylisted`. The live Denylist is `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`, which is what `Vault.denylist()` returns. Both test fingerprints below return `0`.

The Vault's executable runtime bytecode matches `forge build` of `contracts/Vault.sol` (solc `0.8.20`, optimizer on, 200 runs). Codesize is `2799`. The trailing CBOR records solc `0.8.20`. The 32-byte IPFS metadata hash differs from a fresh compile on this machine; the opcodes before that CBOR match. The deployed bytecode contains selectors for both `register` overloads, `setOperator`, `bots`, `operator`, `tierMaxPermissions`, `grantAccess`, `burn`, `owner`, and `denylist`.

The live Denylist executable bytecode matches `contracts/Denylist.sol` as of `78e3ba0` (the source that was current when this pair was deployed). Current `main` adds `InvalidBucket` on `remove` / `everListed` / `listing`. `check()` itself is unchanged. Registration only calls `check()`.

`tierMaxPermissions` on the live Vault:

| Tier | uint8 | max permissions |
| --- | --- | --- |
| None | 0 | 0 |
| Chat | 1 | 1 |
| DataTools | 2 | 2 |
| Financial | 3 | 3 |
| Critical | 4 | 4 |

No bot is registered. `Registered(bytes32,uint8,uint256)` topic `0x2578fc74812af5cd47b15f759eb9c5fc42c617d359b4974992d25e50fba91add` and `OperatorSet(bytes32,address)` topic `0x9efccfdeeb35d36624f8546b14ab72aa768151985ee15f2f7dfce288348baaa3` have zero logs from block `47294164` through block `47392049`. The public RPC allows 1,000 blocks per `eth_getLogs`, so the scan was one window at a time. `bots` for the two ids below is empty (`registeredAt = 0`, `active = false`, tier `0`) and `operator` is the zero address.

## What createEscrow actually checks

`createEscrow(bytes32 escrowId, address payee, bytes32 payerBotId, bytes32 payeeBotId, uint256 durationSeconds)` on `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` reverts `InvalidParties` (`0xb6e500fe`) unless all of these hold:

1. `payee` is not the zero address, and `payee` is not `msg.sender`.
2. Both bot ids are non-zero, and they are different from each other.
3. `vault.operator(payerBotId) == msg.sender`. The payer is whoever sends `createEscrow`.
4. `vault.operator(payeeBotId) == payee`. The payee argument is the payee bot's operator.

After that, `_verifyBot` requires each bot to be active, tier `>= Financial` (`3`), `grantAccess(botId, 3) == true`, and `denylist.check` of the stored fingerprint equal to `None`. A Financial bot with max permissions `3` passes `grantAccess(botId, 3)`.

Bot A is the payer bot. Its operator is the address that will send `createEscrow`. Bot B is the payee bot. Its operator is the `payee` argument.

## Addresses

| Role | Address |
| --- | --- |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| BotAttestationEscrow | `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` |
| CORE_TIMELOCK (sender) | `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| Payer operator, relayer variant | `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` |
| Payee operator | Spencer fills this in. The dry-run stand-in is `0x000000000000000000000000000000000000bEEF`. |

The relayer address is the public hot wallet in `deployments/base-sepolia.json` (`claimRelayerWallet`), `claim-relayer/.env.example` (`RELAYER_ADDRESS`), and `claim-relayer/README.md`. No private key is stored there.

The payee test wallet is not in the repo. `0x000000000000000000000000000000000000bEEF` is only a non-zero stand-in so the dry-run has an address. Replace it with the real payee wallet before sending. Sending the stand-in binds that address as the payee party.

Spencer may use his own wallet as the payer operator instead of the relayer. `createEscrow` must then be sent from that same wallet. The resolved calldata in this file uses the relayer.

## Bot id rule

The Vault does not derive `botId`. The owner passes a `bytes32`, and that id is permanent. A second `register` for the same id reverts `already registered`, including after `burn`.

These two smoke ids are `cast keccak` of a fixed ASCII string (raw bytes, not ABI-encoded):

```bash
cast keccak "agent-bv:base-sepolia:p1d:bot-a:payer"
# 0xa450ef44f1712ad6894a0dabb8a29774918db7452510d9b422e553bdded40532

cast keccak "agent-bv:base-sepolia:p1d:bot-b:payee"
# 0xc84705852089ffaea2c5bda0b1dbcba6aae7f3d876cc4e49dcdf2ea2ff780e94
```

Fingerprints use the same rule. They are the values `denylist.check` and, later, `_verifyBot` read. They are not the bot id.

```bash
# Bot A
cast keccak "agent-bv:base-sepolia:p1d:bot-a:weight"     # 0xf9cc540627d352529a2568a8400427dcce9b68d2c479a1078148868047218a9f
cast keccak "agent-bv:base-sepolia:p1d:bot-a:behavior"   # 0xe863e38846ffd3f86bda77edd9e0d95097057a57d1b6732047546183048f6edd
cast keccak "agent-bv:base-sepolia:p1d:bot-a:prompt"     # 0xcee6783c2b68ccd68b77fea3b3084b6937c8e881d563a5d72a8c0809b6c49dbb

# Bot B
cast keccak "agent-bv:base-sepolia:p1d:bot-b:weight"     # 0xa7b6c55a356a156e98ecf59c2c84c909ff97c5482028fbd8b419d04630409aea
cast keccak "agent-bv:base-sepolia:p1d:bot-b:behavior"   # 0xa068a50733d40b7c745e9bb98931dffe295f917d9ae98ee78f8abf3c76aaa7da
cast keccak "agent-bv:base-sepolia:p1d:bot-b:prompt"     # 0x3f6dbab9b8cf39f0a13b6e8348f3100e05af1d7d53e95f7fd7e52ac629fcdd6d
```

## Checklist

Set the shell variables, then follow the numbers in order. Steps 1 through 6 are read-only. Step 7 is Spencer's send. Steps 8 and 9 prove the result.

```bash
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export VAULT=0x1463D664fA467FBCDA4B05443434494f05e565bc
export DENYLIST=0xeE76876bECcFc1B58fC06fF4E654a517d784B224
export ESCROW=0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
export CORE_TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9
export PAYER_OPERATOR=0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861
export PAYEE_OPERATOR=0x000000000000000000000000000000000000bEEF   # replace before step 7

export BOT_A=0xa450ef44f1712ad6894a0dabb8a29774918db7452510d9b422e553bdded40532
export WEIGHT_A=0xf9cc540627d352529a2568a8400427dcce9b68d2c479a1078148868047218a9f
export SIG_A=0xe863e38846ffd3f86bda77edd9e0d95097057a57d1b6732047546183048f6edd
export PROMPT_A=0xcee6783c2b68ccd68b77fea3b3084b6937c8e881d563a5d72a8c0809b6c49dbb

export BOT_B=0xc84705852089ffaea2c5bda0b1dbcba6aae7f3d876cc4e49dcdf2ea2ff780e94
export WEIGHT_B=0xa7b6c55a356a156e98ecf59c2c84c909ff97c5482028fbd8b419d04630409aea
export SIG_B=0xa068a50733d40b7c745e9bb98931dffe295f917d9ae98ee78f8abf3c76aaa7da
export PROMPT_B=0x3f6dbab9b8cf39f0a13b6e8348f3100e05af1d7d53e95f7fd7e52ac629fcdd6d

export ESCROW_ID=0xcf49428f2c5d229ad09cd8c4c343539fa4c80199aa43d6d9c900bfff4102686b
```

`ESCROW_ID` is `cast keccak "agent-bv:base-sepolia:p1d:create-escrow-dry-run"`. It is only for the simulation. `usedEscrowIds` for it was `false` at block `47392038`.

1. Confirm the chain, the owner, the tier cap, and that these ids are empty.

```bash
cast chain-id --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "denylist()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "tierMaxPermissions(uint8)(uint8)" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast code "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed in this session:

```text
84532
0x10CC9474b45625ADfd05C209f2518023484878D9
0x0000000000000000000000000000000000000000
0xeE76876bECcFc1B58fC06fF4E654a517d784B224
3
0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b
```

Both `bots` rows were `(0x0, 0x0, 0x0, 0, false, 0)`. Both `operator` reads were `0x0000000000000000000000000000000000000000`.

2. Confirm the fingerprints are clean on the live Denylist. `0` means `MatchLevel.None`.

```bash
cast call "$DENYLIST" "check(bytes32,bytes32,bytes32)(uint8)" \
  "$WEIGHT_A" "$SIG_A" "$PROMPT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$DENYLIST" "check(bytes32,bytes32,bytes32)(uint8)" \
  "$WEIGHT_B" "$SIG_B" "$PROMPT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed output, each call:

```text
0
```

3. Dry-run Bot A (payer operator = relayer) from `CORE_TIMELOCK`. `cast call` returns `0x` when the state change succeeds and the function returns nothing. `cast estimate` returns gas. Neither command sends a transaction.

```bash
cast call "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast estimate "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed at block `47392038`:

```text
0x
177888
```

The same `cast estimate` with `--from` set to the relayer reverts `OwnableUnauthorizedAccount`:

```text
Error: server returned an error response: error code 3: execution reverted, data: "0x118cdaa70000000000000000000000009d1b3e1400d2632d435cb7c0fc131c4f42b31861"
```

`0x118cdaa7` is `OwnableUnauthorizedAccount(address)` and the address is the relayer. The registration has to come from `CORE_TIMELOCK`.

A `cast call` of the same register with `--value 1` from `CORE_TIMELOCK` reverts with no revert data. Leave the value off.

4. Dry-run Bot B the same way, after `PAYEE_OPERATOR` is the real payee wallet. The captured run used the `bEEF` stand-in.

```bash
cast call "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast estimate "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
  --from "$CORE_TIMELOCK" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed with `PAYEE_OPERATOR=0x000000000000000000000000000000000000bEEF` at block `47392038`:

```text
0x
177682
```

Re-run both commands after replacing the stand-in. A non-zero payee that is not the payer operator should succeed the same way. The zero address reverts `zero operator` and stores nothing.

5. Build calldata. Tier stays `3`.

Relayer variant, Bot A. This hex is the full resolved payload (`PAYER_OPERATOR` is the relayer):

```bash
cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR"
```

```text
0xb4560e96a450ef44f1712ad6894a0dabb8a29774918db7452510d9b422e553bdded40532f9cc540627d352529a2568a8400427dcce9b68d2c479a1078148868047218a9fe863e38846ffd3f86bda77edd9e0d95097057a57d1b6732047546183048f6eddcee6783c2b68ccd68b77fea3b3084b6937c8e881d563a5d72a8c0809b6c49dbb00000000000000000000000000000000000000000000000000000000000000030000000000000000000000009d1b3e1400d2632d435cb7c0fc131c4f42b31861
```

Bot B, payee placeholder. Regenerate this after `PAYEE_OPERATOR` is real. The hex below is the `bEEF` stand-in, included so the word layout is visible. The last 32-byte word is the operator.

```bash
cast calldata "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR"
```

```text
0xb4560e96c84705852089ffaea2c5bda0b1dbcba6aae7f3d876cc4e49dcdf2ea2ff780e94a7b6c55a356a156e98ecf59c2c84c909ff97c5482028fbd8b419d04630409aeaa068a50733d40b7c745e9bb98931dffe295f917d9ae98ee78f8abf3c76aaa7da3f6dbab9b8cf39f0a13b6e8348f3100e05af1d7d53e95f7fd7e52ac629fcdd6d0000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000beef
```

If the payer operator is Spencer's wallet instead of the relayer, set `PAYER_OPERATOR` to that wallet and run the Bot A `cast calldata` command again. The selector stays `0xb4560e96`.

6. Show that `createEscrow` reverts `InvalidParties` on the live state, before either registration is sent. `--from` is the relayer because that is the payer. `--value 1000` is 1000 wei. This is a simulation.

```bash
cast call "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)" \
  "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast estimate "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)" \
  "$ESCROW_ID" "$PAYEE_OPERATOR" "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Observed:

```text
Error: execution reverted: InvalidParties

Context:
- server returned an error response: error code 3: execution reverted, data: "0xb6e500fe"
```

`cast estimate` returned the same revert data: `0xb6e500fe`.

7. Spencer sends both registrations. Run this on his machine, after `cast wallet address --account <his-keystore>` prints `0x10CC9474b45625ADfd05C209f2518023484878D9`, and after `PAYEE_OPERATOR` is the real payee wallet. The keystore account is the 7702 EOA. There is no schedule step.

```bash
cast send "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_A" "$WEIGHT_A" "$SIG_A" "$PROMPT_A" 3 "$PAYER_OPERATOR" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <his-keystore>

cast send "$VAULT" "register(bytes32,bytes32,bytes32,bytes32,uint8,address)" \
  "$BOT_B" "$WEIGHT_B" "$SIG_B" "$PROMPT_B" 3 "$PAYEE_OPERATOR" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account <his-keystore>
```

Send Bot A first, wait for the receipt, then send Bot B. Each transaction comes from `0x10CC9474b45625ADfd05C209f2518023484878D9`. Gas near the dry-run figures was `177888` for Bot A and `177682` for the `bEEF` stand-in. Re-estimate Bot B after the real payee is filled in.

8. Read the bots back. Tier `3` is Financial. `active` is true. `registeredAt` is the block timestamp, non-zero. Operators match the addresses Spencer passed.

```bash
cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" \
  "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_A" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "grantAccess(bytes32,uint8)(bool)" "$BOT_A" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast call "$VAULT" "bots(bytes32)(bytes32,bytes32,bytes32,uint8,bool,uint256)" \
  "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "operator(bytes32)(address)" "$BOT_B" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$VAULT" "grantAccess(bytes32,uint8)(bool)" "$BOT_B" 3 --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Expected shape for Bot A: the three fingerprints above, then `3`, `true`, a non-zero `registeredAt`, operator `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861`, and `grantAccess` `true`. Bot B is the same shape with its fingerprints and `PAYEE_OPERATOR`.

9. Prove `InvalidParties` is gone.

After both receipts, repeat the step 6 `cast call` and `cast estimate` with no state override. `cast estimate` then returns a gas number. `cast call` returns the escrow id (`bytes32`). That pair is still a simulation: `cast call` and `cast estimate` do not publish the escrow. This runbook does not ask anyone to send `createEscrow`.

Before those transactions exist, the same proof needs a state override. `cast` 1.8.3 has no `--state-override` flag. `cast call` has `--override-state-diff` (change listed slots, keep the rest) and `--override-state` (replace the account's storage entirely). Use the diff form. Replacing the whole Vault storage would wipe `owner`, `denylist`, and the tier caps. `cast estimate` rejects `--override-state-diff` (`error: unexpected argument '--override-state-diff' found`). The pre-send proof is `cast call`. A gas number for that same overridden state comes from `eth_estimateGas`, below.

The override writes each `BotRecord` and each `operator`. Mapping base slot for `bots` is `3`. Mapping base slot for `operator` is `4`.

```bash
cast index bytes32 "$BOT_A" 3   # record base
cast index bytes32 "$BOT_A" 4   # operator slot
cast index bytes32 "$BOT_B" 3
cast index bytes32 "$BOT_B" 4
```

`BotRecord` layout from that base: `+0` weight, `+1` behavior, `+2` prompt, `+3` packed `tier` in the low byte and `active` in the next byte, `+4` `registeredAt`. Financial and active pack as `0x0103`. The simulation uses `registeredAt = 1`. The real transaction stores `block.timestamp`. `createEscrow` does not read `registeredAt`.

| Bot | Slot | Value |
| --- | --- | --- |
| A weight | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce6` | `WEIGHT_A` |
| A behavior | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce7` | `SIG_A` |
| A prompt | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce8` | `PROMPT_A` |
| A tier+active | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce9` | `0x0103` |
| A registeredAt | `0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6cea` | `1` |
| A operator | `0x316b25c1a55daae1c3e5c1a467c07723b410db69e64fcca70fd9345218789f42` | relayer |
| B weight | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ca` | `WEIGHT_B` |
| B behavior | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cb` | `SIG_B` |
| B prompt | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cc` | `PROMPT_B` |
| B tier+active | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cd` | `0x0103` |
| B registeredAt | `0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ce` | `1` |
| B operator | `0x7e668be1fdcdb22f1b5523923112ad8ada1b6bf71090e5dde6b1e6d1a7b1c3b5` | `bEEF` stand-in |

A read of `bots(BOT_A)` under those six Bot A slots returns tier `3`, `active = true`, `registeredAt = 1`, and the three fingerprints. `operator(BOT_A)` returns the relayer. `grantAccess(BOT_A, 3)` returns `true`.

The pre-send command, with the `bEEF` stand-in, is:

```bash
cast call "$ESCROW" "createEscrow(bytes32,address,bytes32,bytes32,uint256)(bytes32)" \
  "$ESCROW_ID" 0x000000000000000000000000000000000000bEEF "$BOT_A" "$BOT_B" 3600 \
  --value 1000 --from "$PAYER_OPERATOR" --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --override-state-diff ${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce6:${WEIGHT_A} \
  --override-state-diff ${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce7:${SIG_A} \
  --override-state-diff ${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce8:${PROMPT_A} \
  --override-state-diff ${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6ce9:0x0000000000000000000000000000000000000000000000000000000000000103 \
  --override-state-diff ${VAULT}:0xc8e47342222fab89c5946c90ba96ba2b4e8b67bf206532e021487297375c6cea:0x0000000000000000000000000000000000000000000000000000000000000001 \
  --override-state-diff ${VAULT}:0x316b25c1a55daae1c3e5c1a467c07723b410db69e64fcca70fd9345218789f42:0x0000000000000000000000009d1b3e1400d2632d435cb7c0fc131c4f42b31861 \
  --override-state-diff ${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ca:${WEIGHT_B} \
  --override-state-diff ${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cb:${SIG_B} \
  --override-state-diff ${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cc:${PROMPT_B} \
  --override-state-diff ${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2cd:0x0000000000000000000000000000000000000000000000000000000000000103 \
  --override-state-diff ${VAULT}:0xa11aaed52a7d90a2124d72664ea7e50991d2257c88aad1e46f098e752e9cf2ce:0x0000000000000000000000000000000000000000000000000000000000000001 \
  --override-state-diff ${VAULT}:0x7e668be1fdcdb22f1b5523923112ad8ada1b6bf71090e5dde6b1e6d1a7b1c3b5:0x000000000000000000000000000000000000000000000000000000000000beef
```

That `cast call`, with payee `0x000000000000000000000000000000000000bEEF`, duration `3600`, and value `1000` wei, returned:

```text
0xcf49428f2c5d229ad09cd8c4c343539fa4c80199aa43d6d9c900bfff4102686b
```

That is `ESCROW_ID`. The call returned it, so the simulation passed `InvalidParties` and `_verifyBot`.

`cast rpc eth_estimateGas` with the same `stateDiff` on the Vault returned:

```text
"0x495a3"
```

`0x495a3` is `300451` gas. This node call does not publish a transaction. After it, `operator(BOT_A)` was still the zero address and `usedEscrowIds(ESCROW_ID)` was still `false`.

If the real payee changes, recompute Bot B's operator slot value (the slot number stays the same) and rerun the overridden `cast call` before sending.

## Risks

Registering `0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861` as Bot A's operator makes the relayer the payer party for that bot. Whoever holds the relayer key can call `createEscrow` as that payer and lock ETH under Bot A. The relayer is a party, not only a broadcaster. Using Spencer's own wallet as `PAYER_OPERATOR` keeps that right on his wallet, and `createEscrow` then has to come from that wallet.

`CORE_TIMELOCK` has no delay. The 7702 delegation executes the owner call in the same transaction Spencer signs. The same key can `register`, `setOperator`, and `burn` on this Vault, and it owns the Denylist and the escrow. A bad signature is immediate.

`register` is permanent for a `botId`. `burn` clears `active` and does not free the id. A wrong id cannot be registered again. `setOperator` can point a stored bot at a new non-zero account, and that call is also `onlyOwner` from `0x10CC9474b45625ADfd05C209f2518023484878D9`.

The payer operator and the payee operator have to be different addresses. `createEscrow` reverts `InvalidParties` when `msg.sender == payee`.

The `bEEF` address is a placeholder. A send that still contains it binds `0x000000000000000000000000000000000000bEEF` as Bot B's operator.

These ids and fingerprints are the smoke pair. Listing any of the three hashes on the Denylist later makes `_verifyBot` revert `AttestationFailed` even when the operators still match.

The superseded Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` is a different contract. These registrations go to `0x1463D664fA467FBCDA4B05443434494f05e565bc` only.
