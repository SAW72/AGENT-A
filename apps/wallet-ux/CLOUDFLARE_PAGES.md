# Cloudflare Pages (wallet UX)

The Pages project `agent-a-wallet-ux` (https://agent-a-wallet-ux.pages.dev) is a Direct Upload project. It has no git connection. Cloudflare does not build it, and environment variables set in the Cloudflare dashboard are not used at build time.

Wallet UX is a static Vite app. The claim relayer stays on Render (`claim-relayer/`, service `bot-verifier-claim-relayer`). It is not a Pages or Workers app. The claim API secret is retired. This workflow never embeds one. The page does not embed a claim secret. Escrow submits go out through the connected wallet unless `VITE_CLAIM_RELAYER_URL` is set, in which case escrow actions can also be posted live to that Base Sepolia relayer. The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret.

[`wrangler.toml`](wrangler.toml) records the project name and `pages_build_output_dir = "./dist"`. That file is not a git connection. Cloudflare does not read it to build the site.

## Before the first deploy

GitHub auto-creates a missing environment the first time a job names it, and that auto-created environment has no protection. Create the `production` environment before the first **Run workflow**, or that first dispatch is unreviewed.

1. Create the GitHub Environment named `production` (Settings → Environments) before any `workflow_dispatch`.
2. Restrict that environment's deployment branches to `main` only.
3. Add SAW72 as a required reviewer.
4. Protect the `main` branch: require a pull request before merging, block force pushes, and block deletion.
5. On that `production` environment, store `CLOUDFLARE_API_TOKEN` (Pages:Edit scope only) and `CLOUDFLARE_ACCOUNT_ID` as environment secrets. Never store them as repository secrets. Spencer: delete any existing repository-level copies of those values.
6. Store `VITE_CLAIM_RELAYER_URL` as a `production` environment variable (the public Base Sepolia claim-relayer URL, for example `https://bot-verifier-claim-relayer.onrender.com`). Spencer: delete any existing repository variable of the same name.
7. `VITE_CLAIM_API_SECRET` is retired. It must not exist anywhere: not as a repository secret, not as a `production` environment secret or variable, and not as a Cloudflare Pages environment variable. Spencer: delete any existing copy.

## Manual deploy

Publish from GitHub with **Actions → Deploy wallet-ux → Run workflow** on `main`, only after the checklist above. The workflow is [`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml). `on` is `workflow_dispatch` only, so a push or a pull request does not publish. The workflow has no input that can embed a claim secret.

The job runs only when `github.ref` is `refs/heads/main`. Its first step exits with an error if that ref is anything else. The job uses the GitHub Environment `production`, so it reads that environment's secrets and variables.

The job token permission is `contents: read`. It uses Node.js 22, from `.node-version` in this directory. There is no `.nvmrc`, and `package.json` has no `engines` field. That is the same major as the `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). The job checks out that ref, then in `apps/wallet-ux` runs `npm ci`, `npm test`, and `npm run build`. Checkout is `actions/checkout` v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`). Node setup is `actions/setup-node` v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`). The job timeout is 15 minutes.

Upload uses `cloudflare/wrangler-action` v4.1.3 (`953926a2e2182532811c01a25e53647d93bf07c0`), the latest v4 release. That release installs Wrangler 4 by default. The action is not given `gitHubToken`, and the workflow does not grant `deployments: write`.

Direct Upload has no native promote. The job first uploads `dist` with `--branch=preview-<run id>`. It downloads that deployment's `index.html` and JavaScript and runs the bundle checks. Only after those checks pass does it upload the same `dist` again with `--branch=main`. That second upload is the production deployment. Both commands also pass the commit hash of the dispatched ref.

After that, the job tries `wrangler pages deployment delete <preview deployment id> --project-name=agent-a-wallet-ux --force`, including when a later step failed (`if: always()`). `continue-on-error: true` means a cleanup failure does not fail a production deploy that already succeeded. Cloudflare will not delete the latest deployment on a branch, and `preview-<run id>` has only that one deployment, so the delete is expected to be refused. Pages does not expire preview deployments on its own. Each run can leave that single preview deployment in place: it is not the `main` production alias, and preview responses send `X-Robots-Tag: noindex`. Delete it from the dashboard only after another deployment exists on that same branch. Until then, leave it.

The workflow does nothing until the `production` environment has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If either is empty, the job fails before `npm ci` and does not upload. The build env is `VITE_CLAIM_RELAYER_URL` only. `VITE_CLAIM_API_SECRET` is retired and is not passed in.

| Name | Where | Role |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `production` environment secret only. Never a repository secret. | API token with **Pages:Edit** scope only. Wrangler uses it to upload `dist`. Spencer: delete any repository-level copy. |
| `CLOUDFLARE_ACCOUNT_ID` | `production` environment secret only. Never a repository secret. | Cloudflare account that owns `agent-a-wallet-ux`. Spencer: delete any repository-level copy. |
| `VITE_CLAIM_RELAYER_URL` | `production` environment variable. Never a repository variable. | Passed into every `npm run build`. The relayer button stays off until `GET /health` is up and not paused. The connected wallet signs the claim. Do not set a claim secret. Spencer: delete any repository-level copy. |
| `VITE_CLAIM_API_SECRET` | Retired. Must not exist anywhere. | Do not set a claim secret on Pages. Not a repository secret, not a `production` environment secret or variable, and not a Cloudflare Pages environment variable. Spencer: delete any existing copy. |

`VITE_BASE_SEPOLIA_RPC_URL` is optional and is not passed by the workflow. Leave it unset to use `https://sepolia.base.org`. Any URL must answer `eth_chainId` with `84532`.

### Relayer submit

The claim API secret is retired. Do not set a claim secret on Pages. Relayer authentication is EIP-712 signed intents (PR #46). The connected wallet signs the claim. Live submit is authorized by the wallet signature, not a shared secret. Wallet submit still works. This workflow does not pass a claim secret into the build.

## Warning

> **Warning:** Any `VITE_` variable is embedded in the public JavaScript bundle. `VITE_CLAIM_API_SECRET` is retired and must not be set. A value of that name in the bundle is not confidential and is not relayer authentication. Relayer authentication is EIP-712 signed intents (PR #46).

Do not put `PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SPENCER_RUN_AUTH`, `LIVE_SUBMIT`, or `ADMIN_SECRET` on this workflow or on the Pages project. Those belong to Foundry or the Render claim relayer, not this static app. Dashboard environment variables would not be applied at build time anyway.

`BASE_SEPOLIA_RPC_URL` at the repo root is for Foundry and the claim relayer. This app does not read it.

`x-claim-secret` is retired with the claim API secret. When `VITE_CLAIM_RELAYER_URL` is set, the Render service must allow the Pages origin in `CORS_ORIGINS` (`https://agent-a-wallet-ux.pages.dev`, or the custom domain). The claim-relayer Blueprint example includes that Pages origin. Live claims are Base Sepolia (chain id 84532) only. Ethereum mainnet and Base mainnet are refused before the request is sent. The page does not embed a claim secret.

## Local command

From `apps/wallet-ux`, with `VITE_CLAIM_RELAYER_URL` set if you want the relayer URL in the build. Leave `VITE_CLAIM_API_SECRET` unset. That name is retired.

```bash
npm ci && npm run build && npx wrangler pages deploy dist --project-name=agent-a-wallet-ux --branch=main
```

`dist/` is gitignored. The workflow's own upload is two steps, preview branch then `main`, because direct upload has no promote. A local upload with `--branch=main` publishes production directly and skips the preview checks.

Do not set `VITE_CLAIM_API_SECRET` for a local build. Spencer: delete any existing copy. Do not set a claim secret on Pages. The connected wallet signs the claim.

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

The job also fails if `dist` or a served bundle contains the header `x-claim-secret` or the literal string `VITE_CLAIM_API_SECRET`. The header match is case-insensitive. Both markers are also rejected in these encodings: standard base64 with and without padding, URL-safe base64 with and without padding, URL-encoding, hex (lowercase and uppercase), and JSON escaping. The scan does not read a secret from the environment. There is no input that skips it.

[`scripts/guard-escrow-addresses.mjs`](scripts/guard-escrow-addresses.mjs) imports `ADDRESSES`, `FALLBACK_PIN`, and `SUPERSEDED`. `SUPERSEDED` in [`src/book.ts`](src/book.ts) is the blocked-address list. The script requires `ADDRESSES.botAttestationEscrow` and `FALLBACK_PIN.botAttestationEscrow` to be the live escrow, and `SUPERSEDED.botAttestationEscrow` to be the retired escrow. It fails if any live `ADDRESSES` slot is the retired escrow.

The retired address also appears in the top-level `notes` string of [`src/base-sepolia.json`](src/base-sepolia.json), which records that the previous escrow is retired. That sentence is not the `SUPERSEDED` literal, so the bundle does not contain the address only inside the blocked-list literal. The script allowlists three client sources: the `SUPERSEDED` entry, `retired.BotAttestationEscrow.address`, and that notes sentence. Any other client occurrence fails the job. The built `dist` and each served bundle must contain the retired address exactly as many times as those allowlisted sources. At this commit that count is 3.

After each upload, the job reads the `deployment-url` output and fetches `/`. Served `index.html` must reference the same `/assets/*` hashes as the built `dist/index.html`. The check then downloads those `/assets/*.js` files and any same-directory `./chunk.js` imports. The retired-address count and the claim-secret scan run on `index.html` together with that JavaScript, so an address or secret that appears only in the HTML still fails the job. A failed check stops the job before the production upload, or fails the job if the production upload already happened.

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
