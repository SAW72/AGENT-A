# Claim-relayer cutover

Spencer runs every step below, in the order printed. That order is 0 through 5, then 7, then 8. Step 6 is printed after step 8, and it is a later pause, not the resume. Nothing in this repository deploys, broadcasts, or stores a secret. Placeholders are names only. Do not paste a real secret into git, a shell history you keep, or this file. Do not put a real secret in a test request.

Step 0 is for the relayer that is deployed now: `main` at `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427`. It is not for PR #46. The later steps are for the EIP-712 relayer at `05fe6fa77f2b1380d148d289b4ba45ced68625e3` (PR #46): the rebase onto `main` (`cfac34a`) plus the B-1 wallet-ux fix.

The Render service is `bot-verifier-claim-relayer`. Copy the hostname from the dashboard. The example below is `https://bot-verifier-claim-relayer.onrender.com`. Wallet UX is the Cloudflare Pages project `agent-a-wallet-ux` (`https://agent-a-wallet-ux.pages.dev`). That project is Direct Upload. It has no git connection, and Cloudflare does not build it.

## 0. Interim stop, now

Do this before the cutover, against the process that is already running.

`main` reads two env vars that stop a live submit. Both are read only when the process starts. In the Render dashboard, set the var, then choose Save and deploy. `GET /health` and `GET /v1/health` stay up and report the result. A value of `1`, `true`, `yes`, or `on` is on. Anything else, including `0` or empty, is off.

Preferred: set `KILL_SWITCH` to `1`.

`POST /v1/claims` and `POST /v1/claims/quote` then return **503** `{"ok":false,"error":"kill_switch"}` before the body is read. Health stays **200**.

```bash
BASE=https://bot-verifier-claim-relayer.onrender.com
curl -fsS "$BASE/health"
```

Confirm `"killSwitch": true`. `KILL_SWITCH` does not change `liveSubmit`. If the live gate was already open, health still shows `"liveSubmit": true` and `"mode": "live"` while the switch is on. The field that proves this stop is `killSwitch`.

Alternate: set `LIVE_SUBMIT` to `0`.

Health then shows `"liveSubmit": false`, `"mode": "fixture"`, and `liveSubmitBlockers` containing `live_submit_off`. A request with `live: true` returns **409** `live_submit_blocked` and `txHash` null. A claim with no live flag still returns **200** as a fixture. This stops broadcasts. It does not stop fixture traffic. `SPENCER_RUN_AUTH=0` also forces `liveSubmit` false (`spencer_run_auth_required`). The check for this alternate is `"liveSubmit": false`.

`POST /v1/admin/pause` is not this stop. On `main`, if `ADMIN_SECRET` is unset, that route returns **200** `{"ok":true,"noop":true}` and does not change the switch.

If you cannot set `KILL_SWITCH` or `LIVE_SUBMIT`:

- Delete `CLAIM_API_SECRET` on the Render service and redeploy. On `main`, that refusal runs only after the live gate is already open: a live claim then returns **503** `claim_api_secret_required` and nothing is broadcast. If `LIVE_SUBMIT` is already `0`, the process never reaches that check. The live claim is already **409** `live_submit_blocked`. Deleting the secret is not an extra stop in that case.
- Suspend the service in the Render dashboard (`bot-verifier-claim-relayer` → Suspend). That is a platform control. This code has no suspend flag, and `/health` stops answering.

Leave `KILL_SWITCH=1` in place for the merge in step 2. Do not set `KILL_SWITCH` to `0` before step 7.

## 1. Delete the claim secret before any build

Do this before step 2 builds the Pages bundle. Vite inlines `VITE_*` from the shell or from GitHub Actions. The Pages project env is not the build env. Deleting a Pages variable does not rewrite a bundle that is already uploaded.

The new relayer (`05fe6fa`) does not read `CLAIM_API_SECRET`. Delete the old value anyway so it is not left on the service. Do not print the value, and do not send it in a request.

Render dashboard → `bot-verifier-claim-relayer` → Environment → delete `CLAIM_API_SECRET` → Save and deploy. Keep `KILL_SWITCH=1`.

GitHub, repo `SAW72/AGENT-B.V.`, repo level and the `production` environment, secrets and variables. List first. Skip a delete when the name is not there.

```bash
gh secret list --repo SAW72/AGENT-B.V.
gh secret list --repo SAW72/AGENT-B.V. --env production
gh variable list --repo SAW72/AGENT-B.V.
gh variable list --repo SAW72/AGENT-B.V. --env production
gh secret delete VITE_CLAIM_API_SECRET --repo SAW72/AGENT-B.V.
gh secret delete VITE_CLAIM_API_SECRET --repo SAW72/AGENT-B.V. --env production
gh variable delete VITE_CLAIM_API_SECRET --repo SAW72/AGENT-B.V.
gh variable delete VITE_CLAIM_API_SECRET --repo SAW72/AGENT-B.V. --env production
```

Cloudflare dashboard → Workers & Pages → `agent-a-wallet-ux` → Settings → Environment variables. Delete `VITE_CLAIM_API_SECRET` under Production and under Preview, whether the row is plain or encrypted. Those rows are not read at build time. They still have to be gone.

If you use Wrangler for an encrypted secret, from a machine that is already logged in:

```bash
npx wrangler pages secret list --project-name agent-a-wallet-ux
npx wrangler pages secret delete VITE_CLAIM_API_SECRET --project-name agent-a-wallet-ux
```

Then look at both Production and Preview in the dashboard again.

## 2. Merge #46 first, then publish Pages from that same commit

`agent-a-wallet-ux` is Direct Upload. Cloudflare does not build it from git. Do not look for a Pages git production branch or a Pages build command.

`claim-relayer/render.yaml` does not set `autoDeploy`. The file is a reference Blueprint under `claim-relayer/`, not `render.yaml` at the repo root, so merging does not change the running service's auto-deploy setting. Render's Blueprint default, if this file were applied, is auto-deploy on when the key is omitted. That default is not what controls the service that already exists. Check the dashboard: `bot-verifier-claim-relayer` → Settings → Build & Deploy → Auto-Deploy.

1. Merge PR #46 to `main` first. The relayer commit is `05fe6fa77f2b1380d148d289b4ba45ced68625e3` until GitHub adds a merge commit.
2. If Auto-Deploy is on, leave `KILL_SWITCH=1` through that merge. The new process reads `KILL_SWITCH` at start, so the deploy comes up paused. If Auto-Deploy is off, the merge does not deploy. Use Manual Deploy on that same commit, still with `KILL_SWITCH=1`.
3. After the deploy finishes, `GET /health` must show `"killSwitch": true`. The Render dashboard's deployed commit is the #46 merge. `/health` has no commit field and no build field. Do not look for either in the JSON.
4. Rebase PR #41 (`cursor/wallet-ux-pages-deploy-e3f5`, the Deploy wallet-ux workflow) onto #46 / `main`, then merge #41. That rebase conflicts in `apps/wallet-ux/CLOUDFLARE_PAGES.md`. Builder does the rebase as a PR update, and the updated PR is re-gated. Spencer does not rebase #41 by hand. The Pages publish runs only after that merge, from the `main` commit that contains both.
5. Publish that same commit. Either path uses the build env from CI or from the local shell, never from Pages env vars.
   - GitHub: Actions → Deploy wallet-ux → Run workflow. `on` is `workflow_dispatch` only, and the job runs only for `refs/heads/main`. The build receives `VITE_CLAIM_RELAYER_URL` from the `production` environment variable. It must not receive `VITE_CLAIM_API_SECRET`. The workflow uploads with `wrangler pages deploy` twice: first `--branch=preview-<run_id>`, then `--branch=main` with `--commit-hash` set to that commit.
   - Or, from a shell where `VITE_CLAIM_API_SECRET` is unset:

```bash
cd apps/wallet-ux
unset VITE_CLAIM_API_SECRET
npm ci
npm test
npm run build
npx wrangler pages deploy dist --project-name=agent-a-wallet-ux --branch=main --commit-hash=<main-sha> --commit-dirty=false
```

A local `--branch=main` upload publishes production directly. The workflow's preview branch is the path that runs the served-bundle check before production.

Keep `KILL_SWITCH=1` through this publish and the leak checks below. Step 7 is the first step that sets it to `0`. While it is on, quote and claim return **503** `kill_switch` before any of the split-version behavior below.

They still have to move together once the switch comes off. The old Pages bundle posts `POST /v1/claims` with `live: true` and the header `x-claim-secret`. The #46 relayer does not read `CLAIM_API_SECRET` or that header. With the live gate open, that body has no `intent` and returns **400** `intent_required` with `txHash` null. Nothing is broadcast. The other split fails closed too. The new bundle does not send `x-claim-secret`. The `main` relayer still requires it and returns **401** `unauthorized`, or **503** `claim_api_secret_required` if the secret is already unset and the live gate is open.

### Leak check

Run this on `dist/` before upload, and again on the JavaScript the production URL serves. Do not search for the real secret. The pattern below matches a shape, not a value.

```bash
cd apps/wallet-ux
grep -REic -e 'x-claim-secret|VITE_CLAIM_API_SECRET' dist
grep -REc -e 'VITE_[A-Z_]*(SECRET|KEY|TOKEN)["'\'']?[[:space:]]*:[[:space:]]*["'\''`][^"'\''`]{16,}' dist
```

Both commands print a line count per file and nothing else. Do not drop `-c`. Do not add `-o` or `-n`. A line count above 0 is a hit. `0` is clean.

The second pattern is exactly:

```
VITE_[A-Z_]*(SECRET|KEY|TOKEN)["']?\s*:\s*["'`][^"'`]{16,}
```

The runnable command uses `[[:space:]]` in place of `\s` because macOS `/usr/bin/grep` is BSD grep and `\s` in `-E` is not guaranteed there; `[[:space:]]` is the same match. It covers a backtick literal as well as single quotes, double quotes, and a quoted key. The portable command was validated with `grep -REc` by line counts only: a bad fixture of four lines counted 4, and a clean sample counted 0. The check must never print the match.

Fetch the served page the same way. `index-CkV_YTRw.js` must not appear. A failed or empty fetch is not an absent result.

```bash
set -o pipefail
if ! page=$(curl -fsS https://agent-a-wallet-ux.pages.dev/) || [ -z "$page" ]; then
  echo 'FETCH FAILED' >&2
else
  if printf '%s\n' "$page" | grep -F index-CkV_YTRw.js; then
    echo 'OLD BUNDLE'
  else
    echo 'old bundle name absent'
  fi
  printf '%s\n' "$page" | grep -oE '/assets/[^" ]+\.js' || echo 'NO ASSET SCRIPT' >&2
fi
```

Download each path into a file and run the same two `grep` commands on that file. Do not treat a failed download as clean.

PR #41's `scripts/guard-claim-secret.mjs` rejects the header name and `VITE_CLAIM_API_SECRET`, including base64, hex, and URL encodings of those names. It does not read a secret from the environment. Pattern 2 matches a long literal beside a `VITE_*(SECRET|KEY|TOKEN)` key. It does not match a literal beside the claim header. The workflow is not on `main` until #41 merges, so run the grep yourself on any build you upload before that.

### Health check after both sides are up

```bash
curl -fsS "$BASE/health"
```

On the #46 process, while step 0 is still in force, expect `"ok": true` and `"killSwitch": true`. `"liveSubmit"` follows the live gate, not the kill switch. It is `true`, and `"mode"` is `"live"`, only when `LIVE_SUBMIT` and `SPENCER_RUN_AUTH` are both on and the escrow is the booked Sepolia contract. Otherwise `"liveSubmit"` is `false` and `"mode"` is `"fixture"`. `/health` does not include a build id or a commit. Confirm the commit in the Render deploy view, and confirm the Pages deployment is the `--commit-hash` you passed (or the workflow's `github.sha`).

Do not send a live claim in this step, and do not set `KILL_SWITCH` to `0` here. The dummy **400** `intent_required` request is in step 7, after the resume.

The CORS check does not depend on the gate. On #46, `access-control-allow-headers` is `content-type,x-admin-secret,authorization`. It does not list `x-claim-secret`.

```bash
curl -sS -D - -o /dev/null -X OPTIONS "$BASE/v1/claims" \
  -H 'origin: https://agent-a-wallet-ux.pages.dev' \
  -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: content-type'
```

Do not send `access-control-request-headers` that include a secret value. The header name in that CORS request is optional. The #46 allow-list is enough to tell the processes apart: the `main` relayer's allow-list includes `x-claim-secret`, and #46's does not. You can request `content-type,x-claim-secret` as names only. There is no value to replay.

## 3. Purge deployments that still serve index-CkV_YTRw.js

Dashboard → Workers & Pages → `agent-a-wallet-ux` → Deployments. Each row has a branch and a URL of the form `https://<deployment-id>.agent-a-wallet-ux.pages.dev`. Production also answers at `https://agent-a-wallet-ux.pages.dev`.

```bash
npx wrangler pages deployment list --project-name agent-a-wallet-ux
```

For each host:

```bash
set -o pipefail
if ! page=$(curl -fsS "https://<deployment-id>.agent-a-wallet-ux.pages.dev/") || [ -z "$page" ]; then
  echo 'FETCH FAILED' >&2
elif printf '%s\n' "$page" | grep -F index-CkV_YTRw.js; then
  echo 'OLD BUNDLE'
else
  echo 'old bundle name absent'
fi
```

`OLD BUNDLE` means that deployment still serves the old bundle, usually as `/assets/index-CkV_YTRw.js`. `FETCH FAILED` is not an absent result. Do not delete from a failed fetch.

Delete a matched deployment from the row, or:

```bash
npx wrangler pages deployment delete <DEPLOYMENT_ID> --project-name agent-a-wallet-ux
```

A normal delete refuses the latest deployment on a branch. Publish the new bundle on that branch first, then delete the older one. Do not delete the new production deployment.

Where supported, force-delete a preview that is still the latest on its branch. The API is `DELETE /accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}?force=true`. Current Wrangler documents the same switch as `--force` (alias `-f`): delete even if the deployment has an active alias (`https://developers.cloudflare.com/workers/wrangler/commands/pages/`).

```bash
npx wrangler pages deployment delete <DEPLOYMENT_ID> --project-name agent-a-wallet-ux --force
```

The Pages preview docs still say the latest deployment on a branch cannot be deleted. If the force delete is refused, do not keep retrying it.

The Deploy wallet-ux workflow (PR #41) uploads `--branch=preview-<run_id>` and then tries to delete that deployment with `--force`. `preview-<run_id>` has only that one deployment, so it is the latest on its branch. The workflow marks that step `continue-on-error`. Pages does not expire those previews. Each dispatch can leave one behind, and they pile up.

If a preview still cannot be deleted, Cloudflare Access on preview URLs remains the fallback (Zero Trust → Access, or the Pages project's Access policy). Preview responses already send `X-Robots-Tag: noindex`. Access is what stops them being world-readable. Disabling preview deployments (Workers & Pages → `agent-a-wallet-ux` → Settings) stops later uploads from adding public previews. Neither Access nor that setting is a relayer code path.

## 4. Rotate ADMIN_SECRET if it ever shared a value with CLAIM_API_SECRET

If you are not certain the two values were different, rotate `ADMIN_SECRET`. Do not print it. Do not echo it. Do not put it in a test.

On a Mac, the value goes to the clipboard and not to the terminal:

```bash
openssl rand -hex 32 | pbcopy
```

Paste from the clipboard into a password manager, then into the Render dashboard, then clear the clipboard. 1Password (`op`) and Bitwarden (`bw`) can take the same `openssl` stdout on stdin so the value is never printed. Use that instead of `pbcopy` if the CLI is already signed in. Do not run `echo`, `cat`, or `openssl rand` without a pipe.

Render dashboard → `bot-verifier-claim-relayer` → Environment → set `ADMIN_SECRET` to that new value → Save and deploy. Keep `KILL_SWITCH=1` if step 0 is still in force.

On both `main` and #46, `ADMIN_SECRET` gates only `POST /v1/admin/pause` and `POST /v1/admin/unpause`, via `x-admin-secret` or `Authorization: Bearer`. It does not authorize a live claim. While it is unset, those routes return **200** `{"ok":true,"noop":true}` and do not change the switch. They do not return 503. Do not call unpause from this runbook.

## 5. Stay paused

Do not set `KILL_SWITCH` to `0` here. Do not call `POST /v1/admin/unpause`. The old rate-limit test is not this step. It is step 8, and it runs only after step 7. Next is step 7. Step 6, the durable stop, is printed after step 8 so it is not run while the cutover is still paused.

## 7. Resume

Do this only after the Pages publish and every post-cutover check above has passed: the served bundle line counts are 0, old deployments that still serve `index-CkV_YTRw.js` are gone or covered by Access, and the #46 merge commit shown in the Render deploy view is the one you published. Leave `KILL_SWITCH` at `1` until those checks have passed. This is the only step that sets `KILL_SWITCH` to `0`.

Render dashboard → `bot-verifier-claim-relayer` → Environment → set `KILL_SWITCH` to `0`.

If step 0 used the alternate stop, restore those vars to the values they had before step 0, in the same save:

- If you set `LIVE_SUBMIT` to `0`, set it back to its pre-step-0 value.
- If you set `SPENCER_RUN_AUTH` to `0`, set it back to its pre-step-0 value.

If you did not change them, do not change them now. Then Save and deploy. One deploy covers every var you changed.

```bash
curl -fsS "$BASE/health"
```

Confirm `"killSwitch": false`.

On #46, `healthPayload` in `claim-relayer/config.mjs` (lines 251–270) sets the `liveSubmit` field from `config.liveSubmit.allowed` and sets `mode` to `"live"` only when that is true. Otherwise `mode` is `"fixture"`. `liveSubmitStatus` (lines 53–72) allows the gate only when the chain id is 84532, the escrow is the booked Sepolia contract, `LIVE_SUBMIT` is on, and `SPENCER_RUN_AUTH` is on. `KILL_SWITCH` does not change `liveSubmit` or `mode`. When the restored values open that gate, confirm `"liveSubmit": true` and `"mode": "live"`. If a blocker remains, `"liveSubmit"` stays false, `"mode"` stays `"fixture"`, and `liveSubmitBlockers` names it (`live_submit_off`, `spencer_run_auth_required`, or an escrow or chain blocker). `liveSubmitRequested` is true when the `LIVE_SUBMIT` flag itself is on, even if another blocker remains.

After this resume, leave `KILL_SWITCH` at `0` while the service should keep serving. Step 6 is how to pause again later.

The version check uses a dummy body. It has no `intent` and no `x-claim-secret`. It cannot broadcast.

```bash
curl -sS -D - -o /tmp/claim-cutover-body.txt -X POST "$BASE/v1/claims" \
  -H 'content-type: application/json' \
  --data '{"action":"release","claimId":"0x1111111111111111111111111111111111111111111111111111111111111111","live":true}'
```

Expect **400** `intent_required` only when `"killSwitch"` is false and `"liveSubmit"` is true. When the gate is closed the same body is **409** `live_submit_blocked`. When the switch is on it is **503** `kill_switch`.

## 8. Post-resume rate-limit check

Run this only after step 7. `GET /health` must already show `"killSwitch": false`. Do not set `KILL_SWITCH` to `0` in this step, and do not set it back to `1` for the check. If it is still true, stop. The response would be **503** `kill_switch` before the IP bucket, and the test would prove nothing.

The per-IP bucket is on `POST /v1/claims` only, after the kill switch and before the body is parsed. `POST /v1/claims/quote` has no per-IP bucket. Do not use the quote route.

Render appends the connecting client to `X-Forwarded-For`. The relayer keeps the rightmost hop. `X-Real-IP` and Cloudflare headers are not read. A test to localhost does not append that hop, so a spoofed header would become the client. Use the public service.

The default is `CLAIM_RATE_IP=30` per `CLAIM_RATE_WINDOW_SEC=60`. Do not send 30 requests. Set `CLAIM_RATE_IP` to `2`, choose Save and deploy, then send four requests immediately. Leave `KILL_SWITCH`, `LIVE_SUBMIT`, and `SPENCER_RUN_AUTH` as step 7 left them.

The body is a dummy. It has no `live` flag, no signature, and no secret header. It cannot broadcast.

```bash
BASE=https://bot-verifier-claim-relayer.onrender.com
body='{"claimId":"cutover-rate-check"}'
for n in 1 2 3; do
  echo "request $n"
  curl -sS -D - -o /tmp/claim-rate-body.txt -X POST "$BASE/v1/claims" \
    -H 'content-type: application/json' \
    --data "$body"
  echo
done
echo "spoofed left hop"
curl -sS -D - -o /tmp/claim-rate-body.txt -X POST "$BASE/v1/claims" \
  -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.50' \
  --data "$body"
```

Requests 1 and 2 are **200**, `mode` `fixture`, `txHash` null. Request 3 is **429** `{"ok":false,"error":"rate_limited"}`. Request 4, with `203.0.113.50` on the left, is **429** as well. That address is documentation-only. It does not get its own bucket.

Delete the `CLAIM_RATE_IP` override afterward so the default of 30 returns. Save and deploy. Do not change `KILL_SWITCH` in that save. The bucket is in memory, and that restart clears it.

## 6. Durable stop

Run this only after step 7, and only when quote and claim traffic should stop again. During the cutover, `KILL_SWITCH` is already `1` from step 0, so do not run this step before step 7. This section sets `KILL_SWITCH` to `1`. It does not set `KILL_SWITCH` to `0`.

Render dashboard → `bot-verifier-claim-relayer` → Environment → `KILL_SWITCH` = `1` → Save and deploy.

`1`, `true`, `yes`, and `on` start the process paused. Any other value starts it open. Editing `claim-relayer/render.yaml` in git does not change the running service.

While the switch is on, on the #46 process:

- `GET /health` and `GET /v1/health` stay **200** with `"killSwitch": true`. There is still no build or commit field.
- `POST /v1/claims` and `POST /v1/claims/quote` return **503** `{"ok":false,"error":"kill_switch"}` before the body is read and before the per-IP bucket.
- Pause and unpause still run. They are not behind the switch.

```bash
curl -fsS "$BASE/health"
curl -sS -D - -o /tmp/claim-kill-body.txt -X POST "$BASE/v1/claims" \
  -H 'content-type: application/json' \
  --data '{}'
```

The claim response is **503** `kill_switch`. The body is an empty JSON object. It is not a signed claim and it carries no secret.

Do not set `KILL_SWITCH` to `0` in this step. Step 7 is the only step that does that. To undo a later stop, repeat step 7.

`POST /v1/admin/unpause` clears the switch in the current process only, and only when `ADMIN_SECRET` is set. Do not call unpause from this runbook. Do not call it before step 7, and do not call it with the real secret. If `KILL_SWITCH` is still `1`, the next start turns the switch back on.

## What the code does not do

Step 0 was checked against `main` at `da47d9a12d64cd4bea4b6fce0b2166b4c55a0427`. The later steps were checked against `05fe6fa77f2b1380d148d289b4ba45ced68625e3`.

- `main` does support `KILL_SWITCH` and `LIVE_SUBMIT`, and `/health` does report `killSwitch` and `liveSubmit`. The suspend action and a missing `CLAIM_API_SECRET` are fallbacks, not replacements for those fields.
- `/health` does not report a git commit or a build id, on `main` or on #46.
- `KILL_SWITCH=1` does not set `liveSubmit` to false.
- `LIVE_SUBMIT=0` does not refuse fixture claims. They stay **200**.
- Deleting `CLAIM_API_SECRET` on `main` returns **503** `claim_api_secret_required` only when live submit is already allowed. #46 does not read `CLAIM_API_SECRET` at all.
- Pause and unpause return **200** `noop` when `ADMIN_SECRET` is unset. They do not return 503.
- `POST /v1/claims/quote` has no per-IP limit.
- The IP bucket map is not pruned.
- Admin routes have no rate limit.
- A replayed `(sender, nonce)` on #46 is **409** `nonce_replay`. The response does not return the original transaction hash.
- There is no broadcast mutex and no viem `nonceManager` anywhere under `claim-relayer/`. `already known` and `nonce too low` are transient markers in `claim-relayer/retry.mjs` (lines 56 and 52). `withClaimRetry` retries them (lines 101–124). `broadcast.mjs` applies that retry only to the already-signed `eth_sendRawTransaction` (lines 183–189). The relayer does not call `eth_getTransactionByHash`.
- There is no fee bump, and no Render Key Value nonce store.
- `claim-relayer/render.yaml` does not set `autoDeploy`, and merging it does not toggle auto-deploy on the existing service.
- Disabling preview deployments and Cloudflare Access are dashboard controls. The relayer does not implement them.
