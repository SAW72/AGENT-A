# Denylist + Vault redeploy (Base Sepolia)

Step (a) of the approved tip-bytecode cutover. This deploys a **new** `Denylist` and a **new** `Vault` bound to it. It leaves the live contracts in place.

Agents simulate. **Spencer alone broadcasts.**

Do not re-run `script/Deploy.s.sol` for this cutover. That script also deploys Liability, InsuranceFund, and DisputePanel. This cutover uses `script/DeployDenylist.s.sol` only.

The live Denylist `0xF0f260967D377E07Bdd7840862508ddB23C012b8` (deploy tx `0x739331697a228684f18a69c54d312baa7557dfcb92c7875c48fa7b2e4c84a429`) is pre–PR #10 bytecode: bool mappings and `Denylisted(bytes32,string,uint256)`. Tip source uses `Listing`, `Listed`, `Unlisted`, `Bucket`, `everListed`, and `listing()`. There is no proxy. The new contracts are separate addresses.

`DeployDenylist` does not read or write that live address. `MigrateDenylistListings` refuses it as `NEW_DENYLIST`. Reads of the old contract are view calls, and only through `OLD_DENYLIST` set in the environment.

## Simulate (no broadcast)

Env:

| Name | Required | Meaning |
| --- | --- | --- |
| `PRIVATE_KEY` | yes | Deployer key. Funded on Base Sepolia. Never commit it. |
| `CORE_TIMELOCK` | yes | Timelock or multisig that will own both new contracts. Non-zero, and not the deployer. |
| `BASE_SEPOLIA_RPC_URL` | yes, on the CLI | RPC for `--rpc-url`. The Solidity script does not read this variable. It checks `block.chainid` from that RPC. |

Chain guard, same style as `script/Deploy.s.sol`: Base Sepolia **84532** only. Ethereum mainnet (`1`) always reverts. Ethereum Sepolia (`11155111`) is a one-line `ALLOWED_CHAIN_ID` switch. Do not remove the mainnet check.

```bash
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
# export PRIVATE_KEY in your shell. Do not commit it. Do not paste it into a PR.
# export CORE_TIMELOCK=0x...   # must not be the deployer

forge script script/DeployDenylist.s.sol:DeployDenylist --rpc-url $BASE_SEPOLIA_RPC_URL -vvvv
```

The script logs `chainid`, the new `Denylist` address, the new `Vault` address, and `CORE_TIMELOCK`.

What it deploys, in order:

1. `new Denylist()`
2. `new Vault(address(newDenylist))`
3. `transferOwnership(CORE_TIMELOCK)` on the Denylist (Ownable2Step)
4. `transferOwnership(CORE_TIMELOCK)` on the Vault (Ownable2Step)

It does not deploy Liability, InsuranceFund, DisputePanel, BotAttestationEscrow, or BVT. It does not migrate listings. It does not call `acceptOwnership`. The deployer remains `owner` until the timelock accepts. `pendingOwner` is `CORE_TIMELOCK`.

### Spencer broadcast

Spencer runs this locally when the simulate looks right. Agents do not add `--broadcast`.

```bash
forge script script/DeployDenylist.s.sol:DeployDenylist \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  -vvvv
```

After the create transactions, copy the logged addresses into the placeholders below. Then do (A) and (B). Spencer updates `deployments/base-sepolia.json` and the address table in `contracts/README.md` with those real addresses and the broadcast tx hashes. This PR does not invent them.

After cutover, the old Denylist `0xF0f260967D377E07Bdd7840862508ddB23C012b8` and the old Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` are superseded. Leave them in the address book until that update. Liability, InsuranceFund, and DisputePanel stay on their current addresses. Escrow is still undeployed; when it is deployed, `DENYLIST` and `VAULT` must be the new pair. The old Vault keeps pointing at the old Denylist.

The new Vault starts with an empty bot registry. This procedure does not copy `Vault` bot rows.

Listing history is not copied either. A replayed id on the new Denylist starts at `timesListed = 1`, with `lastListedBy` equal to the timelock and timestamps from the migration block. The old contract remains the historical record.

## A) CORE_TIMELOCK `acceptOwnership`

Placeholders, filled from the simulate/broadcast logs:

```bash
export NEW_DENYLIST=0xNEW_DENYLIST
export NEW_VAULT=0xNEW_VAULT
export CORE_TIMELOCK=0xCORE_TIMELOCK
export BASE_SEPOLIA_RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
```

Confirm the handoff is waiting. `owner` is still the deployer. `pendingOwner` is `CORE_TIMELOCK`.

```bash
cast call "$NEW_DENYLIST" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_DENYLIST" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_VAULT" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_VAULT" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`acceptOwnership()` calldata is selector `0x79ba5097` (no arguments). `msg.sender` must be `pendingOwner()`. The deployer key cannot accept.

```bash
cast calldata "acceptOwnership()"
# 0x79ba5097
```

Send that call to **both** new addresses.

When `CORE_TIMELOCK` is an EOA (or a `cast` account / hardware wallet that signs as that address):

```bash
cast send "$NEW_DENYLIST" "acceptOwnership()" --rpc-url "$BASE_SEPOLIA_RPC_URL" --account core-timelock
cast send "$NEW_VAULT" "acceptOwnership()" --rpc-url "$BASE_SEPOLIA_RPC_URL" --account core-timelock
```

When `CORE_TIMELOCK` is a contract, schedule or propose the same call inside that contract. This repo does not assume a particular timelock ABI. Each call is:

| Field | Denylist | Vault |
| --- | --- | --- |
| `to` | `$NEW_DENYLIST` | `$NEW_VAULT` |
| `value` | `0` | `0` |
| `data` | `0x79ba5097` | `0x79ba5097` |

The inner `msg.sender` of `acceptOwnership` must be `$CORE_TIMELOCK`.

Confirm both finished. `owner` is `CORE_TIMELOCK`. `pendingOwner` is `0x0000000000000000000000000000000000000000`.

```bash
cast call "$NEW_DENYLIST" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_DENYLIST" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_VAULT" "owner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$NEW_VAULT" "pendingOwner()(address)" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

## B) Listing migration (old → new)

Replay **currently active** ids only. Do this after (A), when the new Denylist’s owner is `CORE_TIMELOCK`.

Bucket map:

| JSON key | Old getter (still the tip `active` getter) | Tip `Bucket` | Add on the new contract | Selector |
| --- | --- | --- | --- | --- |
| `exact` | `denylistedHashes(bytes32)` | `Exact` = `0` | `addExact(bytes32)` | `0xce0ca67c` |
| `signature` | `denylistedSignatures(bytes32)` | `Signature` = `1` | `addSignature(bytes32)` | `0x6dba4807` |
| `prompt` | `denylistedPrompts(bytes32)` | `Prompt` = `2` | `addPrompt(bytes32)` | `0xcc713216` |

`bytes32(0)` is not a valid id. An id may appear in more than one bucket. Within one bucket, list it once.

### Discover ids on the live pre–PR #10 Denylist

```bash
export OLD_DENYLIST=0xF0f260967D377E07Bdd7840862508ddB23C012b8
```

That bytecode has no successful remove. `remove(bytes32)` reverts `denylist is irreversible`, so every `Denylisted` log is still active. Confirm each id with the mapping before writing it into the file.

Event: `Denylisted(bytes32 indexed hash, string kind, uint256 ts)`.

Topic0: `0xc3aca07de7b538002c2488b9f9a5af73814aa754c0652414e7f4d282259283d6`.

`kind` is the string `exact`, `signature`, or `prompt`.

```bash
# blockNumber of the create tx is --from-block
cast tx 0x739331697a228684f18a69c54d312baa7557dfcb92c7875c48fa7b2e4c84a429 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"

cast logs \
  --from-block <DEPLOY_BLOCK> \
  --to-block latest \
  --address "$OLD_DENYLIST" \
  "Denylisted(bytes32,string,uint256)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Confirm a candidate. Keep it only when the getter returns `true`.

```bash
cast call "$OLD_DENYLIST" "denylistedHashes(bytes32)(bool)" "$ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$OLD_DENYLIST" "denylistedSignatures(bytes32)(bool)" "$ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call "$OLD_DENYLIST" "denylistedPrompts(bytes32)(bool)" "$ID" --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

### Fill the JSON

Copy the empty template and replace the arrays with the confirmed ids. Values are `0x` plus 64 hex characters. The committed template stays empty.

```bash
cp script/denylist-migration.template.json /tmp/denylist-migration.json
```

Shape:

```json
{
  "exact": ["0x1111111111111111111111111111111111111111111111111111111111111111"],
  "signature": [],
  "prompt": []
}
```

The `0x11…` value above is a shape example. Put only ids whose old getter returned `true`.

### Helper (preferred)

`script/MigrateDenylistListings.s.sol` reads that file, checks each id with the old getter, and skips ids that are already active on the new Denylist. It reverts if an id is zero, duplicated inside its bucket, or inactive on `OLD_DENYLIST`. It does not scrape logs and it does not add ids that are absent from the file.

`NEW_DENYLIST` must be tip bytecode (`listing(uint8,bytes32)` returns a `Listing`) and must not be `0xF0f260967D377E07Bdd7840862508ddB23C012b8`. `owner()` must already be `CORE_TIMELOCK` and `pendingOwner()` must be zero.

Simulate, still without `--broadcast`:

```bash
export NEW_DENYLIST=0xNEW_DENYLIST
export OLD_DENYLIST=0xF0f260967D377E07Bdd7840862508ddB23C012b8
export MIGRATION_FILE=/tmp/denylist-migration.json
# PRIVATE_KEY and CORE_TIMELOCK already exported

forge script script/MigrateDenylistListings.s.sol:MigrateDenylistListings \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  -vvvv
```

The script logs the pending ids. When `PRIVATE_KEY` is not `CORE_TIMELOCK`, it stops there and broadcasts nothing. That is the expected simulate for a contract timelock.

Spencer broadcasts the adds only when the signing key **is** `CORE_TIMELOCK` (an EOA owner). Agents do not.

```bash
forge script script/MigrateDenylistListings.s.sol:MigrateDenylistListings \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast \
  -vvvv
```

When `CORE_TIMELOCK` is a contract, do not broadcast that script. Schedule one call per pending id from the timelock. `msg.sender` must be the owner. Value is `0`. Target is `$NEW_DENYLIST` (never the old address).

```bash
cast calldata "addExact(bytes32)" "$ID"
cast calldata "addSignature(bytes32)" "$ID"
cast calldata "addPrompt(bytes32)" "$ID"
```

A bash loop that only prints calldata (it does not send):

```bash
# exact.txt: one 0x-prefixed bytes32 per line, already confirmed denylistedHashes == true
while IFS= read -r id; do
  [ -z "$id" ] && continue
  active=$(cast call "$OLD_DENYLIST" "denylistedHashes(bytes32)(bool)" "$id" --rpc-url "$BASE_SEPOLIA_RPC_URL")
  [ "$active" = "true" ] || { echo "refuse inactive exact $id"; exit 1; }
  cast calldata "addExact(bytes32)" "$id"
done < exact.txt
```

Use `denylistedSignatures` + `addSignature` for signature ids, and `denylistedPrompts` + `addPrompt` for prompt ids.

Adds are separate transactions. If one reverts, rerun the helper. Ids already active on the new contract are omitted. `addExact` on an active id reverts `AlreadyListed`, so the file must not list the same id twice in one bucket.

### Tip-native path (later migrations)

Use this when the source contract is tip bytecode, not the live pre–PR #10 deployment.

Event:

```solidity
Listed(bytes32 indexed id, Bucket indexed bucket, address indexed actor, uint256 timestamp, uint64 timesListed)
```

Canonical topic0 is `keccak256("Listed(bytes32,uint8,address,uint256,uint64)")` =

`0x9e202313ab265067bd141ce7ac995ac72378854bf1309fd27ff1ed7884d1ee0a`.

`Bucket` is encoded as `uint8`: `Exact = 0`, `Signature = 1`, `Prompt = 2`.

```bash
cast logs \
  --from-block <NEW_DEPLOY_BLOCK> \
  --to-block latest \
  --address "$SOURCE_DENYLIST" \
  "Listed(bytes32,uint8,address,uint256,uint64)" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

`Unlisted` uses the same argument types (`topic0` `0x2d23df7334e8c5a0e332bab82c73ba47a6a0c6762ce1588267f09c18159bec39`). A later `Unlisted` clears `active` and leaves `timesListed` unchanged. Keep a logged id only when the stored row is still active:

```bash
cast call "$SOURCE_DENYLIST" \
  "listing(uint8,bytes32)(bool,uint64,uint64,uint64,uint64,address,address)" \
  "$BUCKET" "$ID" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

The first field is `active`. The same fact is `denylistedHashes` / `denylistedSignatures` / `denylistedPrompts` on tip bytecode, which is what the helper checks. Put only `active == true` rows in the JSON, then run the helper with `OLD_DENYLIST` set to that source. The helper still refuses the live pre–PR #10 address as the destination.

## Address book

Do not put simulated addresses into `deployments/base-sepolia.json`. After Spencer’s broadcast, update:

- `Denylist.address` and `Denylist.deployTx`
- `Vault.address` and `Vault.deployTx`
- `notes`, including that `0xF0f260967D377E07Bdd7840862508ddB23C012b8` is superseded

Also update the address table in `contracts/README.md` from the same broadcast output.
