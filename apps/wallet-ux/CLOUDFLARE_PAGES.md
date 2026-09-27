# Cloudflare Pages (wallet UX)

The Pages project `agent-a-wallet-ux` (https://agent-a-wallet-ux.pages.dev) is a Direct Upload project. It has no git connection. Cloudflare does not build it, and environment variables set in the Cloudflare dashboard are not used at build time.

Wallet UX is a static Vite app. The claim relayer stays on Render (`claim-relayer/`, service `bot-verifier-claim-relayer`). It is not a Pages or Workers app. A default deploy does not embed the claim secret, so the site has no relayer submit. Escrow submits go out through the connected wallet.

[`wrangler.toml`](wrangler.toml) records the project name and `pages_build_output_dir = "./dist"`. That file is not a git connection. Cloudflare does not read it to build the site.

## Manual deploy

Publish from GitHub with **Actions → Deploy wallet-ux → Run workflow** on `main`. The workflow is [`.github/workflows/deploy-wallet-ux.yml`](../../.github/workflows/deploy-wallet-ux.yml). `on` is `workflow_dispatch` only, so a push or a pull request does not publish. Leave the input `embed_claim_secret` at its default, `false`.

The job runs only when `github.ref` is `refs/heads/main`. Its first step exits with an error if that ref is anything else. The job uses the GitHub Environment `production`. Spencer should restrict that environment's deployment branches to `main`, and can add required reviewers so a run waits for approval before it uploads.

The job token permission is `contents: read`. It uses Node.js 22, from `.node-version` in this directory. There is no `.nvmrc`, and `package.json` has no `engines` field. That is the same major as the `wallet-ux` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). The job checks out that ref, then in `apps/wallet-ux` runs `npm ci`, `npm test`, and `npm run build`. Checkout is `actions/checkout` v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`). Node setup is `actions/setup-node` v7.0.0 (`820762786026740c76f36085b0efc47a31fe5020`). The job timeout is 15 minutes.

Upload uses `cloudflare/wrangler-action` v4.1.3 (`953926a2e2182532811c01a25e53647d93bf07c0`), the latest v4 release. That release installs Wrangler 4 by default. The action is not given `gitHubToken`, and the workflow does not grant `deployments: write`.

Direct Upload has no native promote. The job first uploads `dist` with `--branch=preview-<run id>`. It downloads that deployment's `index.html` and JavaScript and runs the bundle checks. Only after those checks pass does it upload the same `dist` again with `--branch=main`. That second upload is the production deployment. Both commands also pass the commit hash of the dispatched ref.

The workflow does nothing until Spencer adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. If either is empty, the job fails before `npm ci` and does not upload. A default run does not pass `VITE_CLAIM_API_SECRET` into the build.

| Name | Where | Role |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Repository secret | API token with **Pages:Edit** scope only. Wrangler uses it to upload `dist`. |
| `CLOUDFLARE_ACCOUNT_ID` | Repository secret | Cloudflare account that owns `agent-a-wallet-ux`. |
| `VITE_CLAIM_RELAYER_URL` | Repository variable | Passed into every `npm run build`. Public Base Sepolia claim-relayer URL, for example `https://bot-verifier-claim-relayer.onrender.com`. |
| `embed_claim_secret` | Workflow input, boolean, default `false` | When `false`, the build env does not include `VITE_CLAIM_API_SECRET`. When `true`, the job prints a warning and passes `secrets.VITE_CLAIM_API_SECRET` into that build only. |
| `VITE_CLAIM_API_SECRET` | Repository secret | Used only when `embed_claim_secret` is `true`. See the warning below. |

`VITE_BASE_SEPOLIA_RPC_URL` is optional and is not passed by the workflow. Leave it unset to use `https://sepolia.base.org`. Any URL must answer `eth_chainId` with `84532`.

### Default deploy: no relayer submit

With `embed_claim_secret` left `false`, the built site has no relayer submit. Wallet submit still works.

When `VITE_CLAIM_RELAYER_URL` is set and the secret is unset, the relayer button stays visible and disabled. `relayerButtonModel` in [`src/relayer.ts`](src/relayer.ts) returns `{ visible: true, disabled: true, note: RELAYER_SECRET_NOTE }` from the `if (!input.secret)` branch. The note is: "This app is missing the claim secret, so the claim relayer stays off. Use your wallet to submit instead." [`src/FlowPreview.tsx`](src/FlowPreview.tsx) `onRelayer` returns before any post when `relayer.secret` is missing. The test "disables the button with an explanation when the secret is missing or the relayer is paused" in [`src/relayer.test.ts`](src/relayer.test.ts) expects `visible: true`, `disabled: true`, and `note: RELAYER_SECRET_NOTE`.

If `VITE_CLAIM_RELAYER_URL` is also unset, that same function hides the button (`visible: false`). Either way the page does not submit through the relayer.

The relayer-auth fix (EIP-712 signed intents, tracked separately) is what re-enables relayer submit safely. Checking `embed_claim_secret` is not that fix.

## Warning

> **Warning:** Any `VITE_` variable is embedded in the public JavaScript bundle. Turning on `embed_claim_secret` puts `VITE_CLAIM_API_SECRET` in that bundle. The value is not confidential and must not be relied on as relayer authentication. The relayer-auth fix (EIP-712 signed intents, tracked separately) is what re-enables relayer submit safely.

The job log prints that warning before the embed build. `VITE_CLAIM_API_SECRET` would be sent as `x-claim-secret` on live `POST /v1/claims`. It is not `ADMIN_SECRET` and it is not the relayer private key. Anyone who can load the site can read an embedded value from the built JavaScript.

Do not put `PRIVATE_KEY`, `RELAYER_PRIVATE_KEY`, `SPENCER_RUN_AUTH`, `LIVE_SUBMIT`, or `ADMIN_SECRET` on this workflow or on the Pages project. Those belong to Foundry or the Render claim relayer, not this static app. Dashboard environment variables would not be applied at build time anyway.

`BASE_SEPOLIA_RPC_URL` at the repo root is for Foundry and the claim relayer. This app does not read it.

A default deploy does not send `x-claim-secret`, because it does not submit through the relayer. When relayer submit is re-enabled, the Render service must allow the Pages origin in `CORS_ORIGINS` (`https://agent-a-wallet-ux.pages.dev`, or the custom domain) and must allow the `x-claim-secret` request header. The claim-relayer Blueprint example includes that Pages origin. Live claims are Base Sepolia (chain id 84532) only. Ethereum mainnet and Base mainnet are refused before the request is sent.

## Local command

From `apps/wallet-ux`, with `VITE_CLAIM_RELAYER_URL` set if you want the disabled relayer button, and with `VITE_CLAIM_API_SECRET` unset:

```bash
npm ci && npm run build && npx wrangler pages deploy dist --project-name=agent-a-wallet-ux --branch=main
```

That matches a default build (`embed_claim_secret` false): the upload has no relayer submit. `dist/` is gitignored. The workflow's own upload is two steps, preview branch then `main`, because direct upload has no promote. A local upload with `--branch=main` publishes production directly and skips the preview checks.

Setting `VITE_CLAIM_API_SECRET` for a local build embeds it in the public bundle, the same as checking `embed_claim_secret`. Leave it unset. Relayer submit comes back with the EIP-712 signed-intent work, tracked separately.

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

When `embed_claim_secret` is false and `VITE_CLAIM_API_SECRET` is non-empty, the job also fails if `dist` or a served bundle contains that secret. The scan uses `grep -F -q` with the value in the environment and does not print it. It checks the raw value and these encodings: standard base64 with and without padding, URL-safe base64 with and without padding, URL-encoding, hex (lowercase and uppercase), and JSON escaping. An empty secret skips that scan. The scan does not run when `embed_claim_secret` is true.

[`scripts/guard-escrow-addresses.mjs`](scripts/guard-escrow-addresses.mjs) imports `ADDRESSES`, `FALLBACK_PIN`, and `SUPERSEDED`. `SUPERSEDED` in [`src/book.ts`](src/book.ts) is the blocked-address list. The script requires `ADDRESSES.botAttestationEscrow` and `FALLBACK_PIN.botAttestationEscrow` to be the live escrow, and `SUPERSEDED.botAttestationEscrow` to be the retired escrow. It fails if any live `ADDRESSES` slot is the retired escrow.

The retired address also appears in the top-level `notes` string of [`src/base-sepolia.json`](src/base-sepolia.json), which records that the previous escrow is retired. That sentence is not the `SUPERSEDED` literal, so the bundle does not contain the address only inside the blocked-list literal. The script allowlists three client sources: the `SUPERSEDED` entry, `retired.BotAttestationEscrow.address`, and that notes sentence. Any other client occurrence fails the job. The built `dist` and each served bundle must contain the retired address exactly as many times as those allowlisted sources. At this commit that count is 3.

After each upload, the job reads the `deployment-url` output, fetches `index.html`, the `/assets/*.js` files it references, and any same-directory `./chunk.js` imports, and runs the live-escrow, phrase, retired-address count, and claim-secret checks on that JavaScript. A failed check stops the job before the production upload, or fails the job if the production upload already happened.

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
