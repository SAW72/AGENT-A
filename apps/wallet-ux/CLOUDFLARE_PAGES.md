# Cloudflare Pages (wallet UX)

The Pages project `agent-a-wallet-ux` (https://agent-a-wallet-ux.pages.dev) is a Direct Upload project. It has no git connection. Cloudflare does not build it, and environment variables set in the Cloudflare dashboard are not used at build time.

Wallet UX is a static Vite app. The claim relayer stays on Render (`claim-relayer/`, service `bot-verifier-claim-relayer`). It is not a Pages or Workers app. Escrow submits go out through the connected wallet unless `VITE_CLAIM_RELAYER_URL` is set, in which case escrow actions can also be posted live to that Base Sepolia relayer.

[`wrangler.toml`](wrangler.toml) records the project name and `pages_build_output_dir = "./dist"`. That file is not a git connection. Cloudflare does not read it to build the site.

## Manual deploy

Publish from GitHub with **Actions → Deploy wallet-ux → Run workflow** on `main`. The workflow is [`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml). `on` is `workflow_dispatch` only, so a push or a pull request does not publish. The run deploys the ref it is dispatched on. Choose `main`.

The job uses Node.js 22, the same version as the `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and as `.node-version` in this directory. It checks out that ref, then in `apps/wallet-ux` runs `npm ci`, `npm test`, and `npm run build`, checks `dist/assets`, and uploads `dist` with `cloudflare/wrangler-action` v3.15.0 (`9acf94ace14e7dc412b076f2c5c20b8ce93c79cd`). That release installs Wrangler 3.90.0. The upload command is `pages deploy dist --project-name=agent-a-wallet-ux --branch=main`, plus the commit hash of the dispatched ref.

The workflow does nothing until Spencer adds the Cloudflare secrets below. If `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is empty, the job fails before `npm ci` and does not upload.

| Name | Where | Role |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Repository secret | API token with **Pages:Edit** scope only. Wrangler uses it to upload `dist`. |
| `CLOUDFLARE_ACCOUNT_ID` | Repository secret | Cloudflare account that owns `agent-a-wallet-ux`. |
| `VITE_CLAIM_API_SECRET` | Repository secret | Passed into `npm run build`. See the warning below. |
| `VITE_CLAIM_RELAYER_URL` | Repository variable | Passed into `npm run build`. Public Base Sepolia claim-relayer URL, for example `https://bot-verifier-claim-relayer.onrender.com`. Leave unset to keep submits wallet-direct. |

`VITE_BASE_SEPOLIA_RPC_URL` is optional and is not passed by the workflow. Leave it unset to use `https://sepolia.base.org`. Any URL must answer `eth_chainId` with `84532`.

## Warning

> **Warning:** Any `VITE_` variable is embedded in the public JavaScript bundle. `VITE_CLAIM_API_SECRET` is not confidential and must not be relied on as relayer authentication. A separate relayer-auth fix is tracked as a mainnet blocker.

`VITE_CLAIM_API_SECRET` is sent as `x-claim-secret` on live `POST /v1/claims`. It is not `ADMIN_SECRET` and it is not the relayer private key. Anyone who can load the site can read the value from the built JavaScript.

Do not put `PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SPENCER_RUN_AUTH`, `LIVE_SUBMIT`, or `ADMIN_SECRET` on this workflow or on the Pages project. Those belong to Foundry or the Render claim relayer, not this static app. Dashboard environment variables would not be applied at build time anyway.

`BASE_SEPOLIA_RPC_URL` at the repo root is for Foundry and the claim relayer. This app does not read it.

When `VITE_CLAIM_RELAYER_URL` is set, the Render service must allow the Pages origin in `CORS_ORIGINS` (`https://agent-a-wallet-ux.pages.dev`, or the custom domain) and must allow the `x-claim-secret` request header. The claim-relayer Blueprint example includes that Pages origin. Live claims are Base Sepolia (chain id 84532) only. Ethereum mainnet and Base mainnet are refused before the request is sent.

## Local command

From `apps/wallet-ux`, with `VITE_CLAIM_RELAYER_URL` and `VITE_CLAIM_API_SECRET` set in the environment:

```bash
npm ci && npm run build && npx wrangler pages deploy dist --project-name=agent-a-wallet-ux --branch=main
```

That is the same upload the workflow performs. `dist/` is gitignored. The same warning applies: both `VITE_` values are embedded in the public bundle.

A build check that does not upload:

```bash
cd apps/wallet-ux
npm ci
npm test
npm run build
```

## Bundle guard

The workflow fails the deploy unless `dist/assets` contains the live BotAttestationEscrow `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` (case-insensitive) and both of these phrases from `src/`:

- `Submitting through the claim relayer` (`src/relayer.ts`)
- `Submit through the claim relayer, or from your wallet.` (`src/FlowPreview.tsx`)

The retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` is intentionally bundled as a blocked/superseded address. The guard does not fail when that address is present.

After the upload, the job downloads the deployment URL (`deployment-url` from wrangler-action), fetches `index.html` and each `/assets/*.js` file it references, and runs those same two checks on the served JavaScript. Either check failing fails the job.

## Project settings

| Setting | Value |
| --- | --- |
| Project name | `agent-a-wallet-ux` |
| Production URL | `https://agent-a-wallet-ux.pages.dev` |
| Git connection | None. Direct Upload. |
| Who builds | GitHub Actions, or the local command above. Cloudflare does not build. |
| Dashboard env vars at build time | Unused. |
| Build output directory | `dist` |
| Node.js | `22` |

`pages_build_output_dir = "./dist"` matches the Vite `dist` output.

### SPA

[`public/_redirects`](public/_redirects) is:

```
/* /index.html 200
```

Vite copies that file to `dist/_redirects`. The app is one page today. Keep this rule if client routes are added later so those paths serve `index.html`.

## Address book

The app imports [`src/base-sepolia.json`](src/base-sepolia.json). That file is a copy of [`deployments/base-sepolia.json`](../../deployments/base-sepolia.json) committed inside `apps/wallet-ux`. Vite does not import `../../../deployments/base-sepolia.json`, so a build rooted at `apps/wallet-ux` still works when the parent directory is not on the build path.

`npm run dev` and `npm run build` run `scripts/sync-book.mjs`. When the repo-root book is visible, the script refreshes `src/base-sepolia.json`. When it is not visible, the script keeps the committed copy. Either way the book must be Base Sepolia (`chainId` 84532, `network` `base-sepolia`). After a book change in the full repo, run `npm run sync-book` and commit `src/base-sepolia.json`. `npm test` fails if the two files differ.

`src/book.ts` `FALLBACK_PIN` matches the live book. The app uses the pin only when the copied JSON fails validation. Superseded Denylist and Vault addresses stay blocked. The retired escrow `0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c` (ESC-M-1 redeploy, retired 2026-09-26) stays blocked too.

Live slots:

| Contract | Address |
| --- | --- |
| coreTimelock | `0x10CC9474b45625ADfd05C209f2518023484878D9` |
| Denylist | `0xeE76876bECcFc1B58fC06fF4E654a517d784B224` |
| Vault | `0x1463D664fA467FBCDA4B05443434494f05e565bc` |
| DisputePanel | `0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb` |
| BotAttestationEscrow | `0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d` |
