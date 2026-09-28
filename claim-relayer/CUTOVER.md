# Claim-relayer cutover

Spencer runs every step below, in order. Nothing in this repo deploys, broadcasts, or stores a secret. Placeholders are names only. Do not paste a real secret into git, a shell history you keep, or this file.

This procedure is for the EIP-712 relayer in PR #46, checked against commit `c95e0d0cf79699215d4e18c5fda7cc26d10e14e5`. The copy of the service on `main` before that revision still requires `CLAIM_API_SECRET` and the `x-claim-secret` header. Do not run the steps against that older process.

Use the hostname shown on the Render service `bot-verifier-claim-relayer`. The example below is `https://bot-verifier-claim-relayer.onrender.com`. Wallet UX is the Cloudflare Pages project `agent-a-wallet-ux` (`https://agent-a-wallet-ux.pages.dev`).

## a) Deploy the new relayer and the rebuilt Pages bundle together

Deploy both from the same signed-intent commit. Do not set `VITE_CLAIM_API_SECRET` on the Pages build.

They have to move together. The old Pages bundle (`index-CkV_YTRw.js`) posts `POST /v1/claims` with `live: true` and the header `x-claim-secret`. The new relayer does not read `CLAIM_API_SECRET` or that header. Once live submit is unlocked (`LIVE_SUBMIT=1` and `SPENCER_RUN_AUTH=1`), that old body has no `intent` and the new relayer returns **400** `intent_required` with `txHash: null`. Nothing is broadcast.

The other split fails closed too. The new bundle does not send `x-claim-secret`. The old relayer still requires that header and returns **401** `unauthorized`, or **503** `claim_api_secret_required` if `CLAIM_API_SECRET` is already unset.

Pick a quiet moment and publish both back to back. Until they match, release and refund from the page fail closed and do not broadcast.

1. Render dashboard → service `bot-verifier-claim-relayer` → Manual Deploy → the signed-intent commit. The service root is `claim-relayer`, build `npm install --omit=dev`, start `npm start`.
2. Cloudflare dashboard → Workers & Pages → `agent-a-wallet-ux`. Production branch is `main`, root directory `apps/wallet-ux`, build command `npm ci && npm run build`, output `dist`. Publish that same commit to production. `VITE_CLAIM_API_SECRET` must be absent for Production and Preview before this build. Leave `VITE_CLAIM_RELAYER_URL` as it is if it already points at the Render service.

Local check of the bundle you are about to publish, from a shell where `VITE_CLAIM_API_SECRET` is unset:

```bash
cd apps/wallet-ux
unset VITE_CLAIM_API_SECRET
npm ci
npm run build
grep -R -E 'x-claim-secret|VITE_CLAIM_API_SECRET' dist && echo 'STILL PRESENT' || echo 'absent'
```

`absent` is the result you want. `dist/` is gitignored. Do not commit it.

After both deploys are live, confirm the served production page. Vite inlines `VITE_*` at build time, so this check is against the URL users actually load:

```bash
curl -fsS https://agent-a-wallet-ux.pages.dev/ | grep -oE '/assets/[^" ]+\.js'
```

Fetch each path that prints. The old file name must not appear, and neither string may appear in the JavaScript:

```bash
curl -fsS https://agent-a-wallet-ux.pages.dev/ | grep -F index-CkV_YTRw.js && echo 'OLD BUNDLE' || echo 'old bundle name absent'
curl -fsS "https://agent-a-wallet-ux.pages.dev/assets/<file>.js" | grep -E 'x-claim-secret|VITE_CLAIM_API_SECRET' && echo 'STILL PRESENT' || echo 'absent'
```

With the kill switch off, this request distinguishes the new relayer and does not broadcast. Expect **400** `intent_required` only when live submit is already unlocked. When the gate is still closed the same body is **409** `live_submit_blocked` on both the old and the new process, so use the CORS check as well.

```bash
BASE=https://bot-verifier-claim-relayer.onrender.com
curl -sS -D - -o /tmp/claim-cutover-body.txt -X POST "$BASE/v1/claims" \
  -H 'content-type: application/json' \
  --data '{"action":"release","claimId":"0x1111111111111111111111111111111111111111111111111111111111111111","live":true}'
curl -sS -D - -o /dev/null -X OPTIONS "$BASE/v1/claims" \
  -H 'origin: https://agent-a-wallet-ux.pages.dev' \
  -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: content-type,x-claim-secret'
```

On the new relayer, `access-control-allow-headers` is `content-type,x-admin-secret,authorization`. It does not list `x-claim-secret`.

## b) Delete the claim secret

The new process never reads `CLAIM_API_SECRET`. Delete the old value anyway so it is not left on the service. Do not print the value.

Render dashboard → `bot-verifier-claim-relayer` → Environment → delete the key `CLAIM_API_SECRET` → Save, rebuild, and deploy.

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

Cloudflare dashboard → Workers & Pages → `agent-a-wallet-ux` → Settings → Environment variables. Delete `VITE_CLAIM_API_SECRET` under **Production** and under **Preview**, whether the row is a plain variable or an encrypted secret. Deleting it does not rewrite a bundle that is already published. Step (c) removes those.

If you use Wrangler for the encrypted secret, from a machine that is already logged in:

```bash
npx wrangler pages secret list --project-name agent-a-wallet-ux
npx wrangler pages secret delete VITE_CLAIM_API_SECRET --project-name agent-a-wallet-ux
```

Then look at both Production and Preview in the dashboard again. The CLI does not replace that check.

## c) Purge old Pages deployments that still serve index-CkV_YTRw.js

Dashboard → Workers & Pages → `agent-a-wallet-ux` → Deployments. Each row has a branch and a deployment URL of the form `https://<deployment-id>.agent-a-wallet-ux.pages.dev`. Production also answers at `https://agent-a-wallet-ux.pages.dev`.

Or:

```bash
npx wrangler pages deployment list --project-name agent-a-wallet-ux
```

For each deployment host, including preview hosts:

```bash
curl -fsS "https://<deployment-id>.agent-a-wallet-ux.pages.dev/" | grep -F index-CkV_YTRw.js
```

A match means that deployment still serves the old bundle. The script is referenced from `index.html`, usually as `/assets/index-CkV_YTRw.js`.

Delete a matched deployment from the dashboard row, or:

```bash
npx wrangler pages deployment delete <DEPLOYMENT_ID> --project-name agent-a-wallet-ux
```

Cloudflare will not delete the latest deployment on a branch. Publish the new bundle on that branch first, so the old deployment is no longer the latest, and then delete it. Do that for production and for every preview branch whose latest build still contains `index-CkV_YTRw.js`. Do not delete the new production deployment.

## d) Rotate ADMIN_SECRET if it ever shared a value with CLAIM_API_SECRET

If you are not certain the two values were different, rotate `ADMIN_SECRET`.

Generate a new value locally and put it only in the Render dashboard. Do not commit it and do not echo it.

```bash
openssl rand -base64 32
```

Render dashboard → `bot-verifier-claim-relayer` → Environment → set `ADMIN_SECRET` to that new value → Save, rebuild, and deploy.

On this relayer, `ADMIN_SECRET` gates only `POST /v1/admin/pause` and `POST /v1/admin/unpause`. The header is `x-admin-secret`, or `Authorization: Bearer` with the same value. It does not authorize a live claim.

While `ADMIN_SECRET` is unset, those two routes return **200** and do not change the switch:

```json
{ "ok": true, "noop": true, "killSwitch": false, "docs": "ADMIN_SECRET is unset. ..." }
```

They do not return 503. A 503 from the pause route when the secret is unset is not what this code does.

## e) Harmless X-Forwarded-For rate-limit test

Run this against the public Render URL, with the kill switch off. `GET /health` shows `"killSwitch": false`. A paused process returns **503** `kill_switch` before the rate limit, so it cannot show the 429.

The per-IP bucket applies to `POST /v1/claims` only. It runs after the kill switch and before the body is parsed. `POST /v1/claims/quote` has no per-IP bucket. Do not use the quote route for this test.

Render's proxy appends the connecting client to `X-Forwarded-For`. The relayer keeps only the rightmost hop. A missing header uses the socket address. `X-Real-IP` and Cloudflare headers are not read. A test from your own machine to localhost does not append that hop, so a spoofed header would become the client. Use the public service.

The default is `CLAIM_RATE_IP=30` per `CLAIM_RATE_WINDOW_SEC=60`. Do not send 30 requests. For this check only, set `CLAIM_RATE_IP` to `2` on the Render service, save, rebuild, and deploy, then send four requests immediately. The bucket refills over the 60 second window, so do not wait between them.

The body has no `live`, `liveSubmit`, or `mode`. It stays a dry run (`txHash` null). It does not broadcast.

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

Requests 1 and 2 are **200**, `mode` `fixture`, `txHash` null. Request 3 is **429** `{"ok":false,"error":"rate_limited"}`. Request 4, with a spoofed address on the left of `X-Forwarded-For`, is **429** as well. That spoof does not get its own bucket. `203.0.113.50` is a documentation address.

Then delete the `CLAIM_RATE_IP` override so the process returns to the default of 30. Save, rebuild, and deploy. The bucket is in memory for one process, and that restart clears it.

## f) Durable stop

Set this only when you want quote and claim traffic to stop. Leave it at `0` when the service should keep serving.

Render dashboard → `bot-verifier-claim-relayer` → Environment → `KILL_SWITCH` = `1` → Save, rebuild, and deploy.

`1`, `true`, `yes`, and `on` all start the process paused. Any other value, including `0` or an empty value, starts it open. The flag is read at process start. Editing `claim-relayer/render.yaml` in git does not change the running service. That file is a reference Blueprint and is not applied from the repo root.

While the switch is on:

- `GET /health` and `GET /v1/health` stay **200** and include `"killSwitch": true`.
- `POST /v1/claims` and `POST /v1/claims/quote` return **503** `{"ok":false,"error":"kill_switch"}` before the body is read and before the per-IP bucket.
- `POST /v1/admin/pause` and `POST /v1/admin/unpause` still run. They are not behind the switch.

```bash
BASE=https://bot-verifier-claim-relayer.onrender.com
curl -sS "$BASE/health"
curl -sS -D - -o /tmp/claim-kill-body.txt -X POST "$BASE/v1/claims" \
  -H 'content-type: application/json' \
  --data '{}'
```

The claim response is **503** `kill_switch`.

To undo it, set `KILL_SWITCH` to `0`, then save, rebuild, and deploy. Confirm `"killSwitch": false` on `GET /health`.

`POST /v1/admin/unpause` with `x-admin-secret` releases the switch in the current process only. The next start reads the environment again. If `KILL_SWITCH` is still `1`, a restart or a free-plan spin-down turns the switch back on. The durable off position is `KILL_SWITCH=0` plus a new process.

## What this revision does not do

Checked against `c95e0d0cf79699215d4e18c5fda7cc26d10e14e5`. Do not expect these during the cutover:

- The pause and unpause routes do not return 503 when `ADMIN_SECRET` is unset. They return the 200 no-op in step (d).
- `POST /v1/claims/quote` has no per-IP limit. The bucket in step (e) is only on `POST /v1/claims`.
- The IP bucket map is not pruned. Tokens refill, and the map entry for an IP stays for the life of the process.
- Admin routes have no rate limit.
- A replayed `(sender, nonce)` is **409** `nonce_replay`. The response does not return the original transaction hash.
- There is no broadcast mutex and no viem `nonceManager`. A timeout resends the same signed raw transaction. `already known` and `nonce too low` are retried as transport errors. The relayer does not confirm them with `eth_getTransactionByHash` and does not return `signedHash` for that case.
- There is no fee bump. There is no Render Key Value nonce store. Used nonces live in `/tmp/claim-relayer/intent-nonces.jsonl` on the current Blueprint, and a restart deletes that file.
