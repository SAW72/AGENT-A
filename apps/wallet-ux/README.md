# Agent-BV (Agent Bot Verifier)

Gate A status for the Agent-BV (Agent Bot Verifier) contracts on **Base Sepolia (chain id 84532)**.

This app connects an injected wallet (MetaMask), checks the wallet chain, and reads the live contracts through a Base Sepolia RPC. Claim and dispute forms build calldata, then the connected wallet can submit that calldata when it is on Base Sepolia. Ethereum mainnet (chain id 1) and Base mainnet (chain id 8453) are refused. There is no mainnet config.

## Run locally

```bash
cd apps/wallet-ux
npm install
npm run dev
```

The dev server listens on `0.0.0.0` and port `5173`, or `$PORT` when that is set. Open the printed local URL.

```bash
npm test
npm run build
```

`src/base-sepolia.json` is the address book this app bundles. `npm run dev` and `npm run build` refresh it from `deployments/base-sepolia.json` when that file is visible. Run `npm run sync-book` and commit `src/base-sepolia.json` after a book change. Publishing notes: [`CLOUDFLARE_PAGES.md`](CLOUDFLARE_PAGES.md). The Pages project is not created from this repo.

Optional live read (hits the public Base Sepolia RPC):

```bash
SEPOLIA_SMOKE=1 npm test
```

## RPC

Reads use the public endpoint `https://sepolia.base.org` unless you set `VITE_BASE_SEPOLIA_RPC_URL`. Copy `.env.example` to `.env` and point that variable at another Base Sepolia endpoint. The app calls `eth_chainId` first and refuses the endpoint when the result is not `84532`.

`BASE_SEPOLIA_RPC_URL` in the repo root `.env` is for Foundry. This app does not read it, and it never reads `PRIVATE_KEY`.

## What you should see

1. Connect MetaMask and switch the wallet to Base Sepolia.
2. Denylist and Vault: `owner()` is CORE_TIMELOCK `0x10CC9474b45625ADfd05C209f2518023484878D9`, `pendingOwner()` is none, and Vault `denylist()` is the pinned Denylist `0xeE76876bECcFc1B58fC06fF4E654a517d784B224`.
3. DisputePanel: Gate B is seated when `arbitratorCount` is at least `PANEL_SIZE` (3). Below that, the page says **panel not seated / Gate B not seated**.
4. BotAttestationEscrow shows the book address and read-only owner, pending owner, governance, funding gate, and linked `disputePanel()`. Lookup by escrow id is a view call. Create, release, refund, openDispute, and dispute build calldata. **Submit on Base Sepolia** sends that calldata with the connected wallet (`chainId` 84532). With no wallet, or on any other chain, the control stays disabled and is labeled with the refusal. `createEscrow` still succeeds only when that wallet is the payer's Vault operator. If `VITE_CLAIM_RELAYER_URL` is set, escrow actions can also be posted live to that Base Sepolia claim relayer (`POST /v1/claims`, `live: true`). `VITE_CLAIM_API_SECRET` is sent as `x-claim-secret` when set. A secret in this static build is a soft deterrent only. `openDispute` stays on the connected wallet. Unset `VITE_CLAIM_RELAYER_URL` keeps submits wallet-direct. BVT stays **not deployed on Sepolia yet**.
5. On any other wallet network the banner blocks the page and contract reads stay off. Switch back to Base Sepolia to read again.

With no wallet connected, the same contract rows still load from the pinned Base Sepolia RPC. Connecting on the wrong chain pauses those reads so they are not shown next to another network.

## Address book

Live slots are read from [`src/base-sepolia.json`](src/base-sepolia.json), the in-app copy of [`deployments/base-sepolia.json`](../../deployments/base-sepolia.json). A Pages build with root directory `apps/wallet-ux` imports that file and does not reach outside this package. `src/book.ts` keeps the corrected Gate A pin and uses it only if that file is missing, is not chain id 84532, or points a live slot at `superseded`. Superseded addresses are never read.

Ops notes for the live pair: [`script/OPS_LIVE_DENYLIST_VAULT.md`](../../script/OPS_LIVE_DENYLIST_VAULT.md). Vault reads use the wallet ABI hook in `contracts/interfaces/IVault.sol` (`src/abi/IVault.json`).

The current book matches:

| Contract | Address |
| --- | --- |
| coreTimelock | `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| Liability | `0x554Caf5a214B8d70D675C09186C5EAE24FEB7307` |
| InsuranceFund | `0x19fc26B36Cb2031062eD90C19db64b3b09753ab8` |
| BotAttestationEscrow | `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` |

The superseded Denylist `0xF0f260967D377E07Bdd7840862508ddB23C012b8` and Vault `0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7` are recorded only so the UI cannot treat them as live. BVT stays `null`.

Liability and InsuranceFund are included because `deployments/base-sepolia.json` still lists them and the live `owner` / `insurance()` / `liability()` links agree with that book. Rows are owner, balance, and the cross-link.

## ABIs

`src/abi/*.json` is the `abi` array from `forge build` artifacts under `out/`. Regenerate after a contract change:

```bash
forge build
cd apps/wallet-ux
npm run sync-abis
```

Do not hand-edit those JSON files.
