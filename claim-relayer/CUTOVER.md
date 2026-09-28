# Claim-relayer cutover

Spencer runs every step below, in the order printed. That order is 0 through 5, then 7, then 8. Step 6 is printed after step 8, and it is a later pause, not the resume. Nothing in this repository deploys, broadcasts, or stores a secret. Placeholders are names only. Do not paste a real secret into git, a shell history you keep, or this file. Do not put a real secret in a test request.

`main` is `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787`, the squash merge of PR #46. #46 was merged from `05fe6fa77f2b1380d148d289b4ba45ced68625e3`. `cfac34a` is the calldata-binding commit under that PR head (`fix(relayer): bind claim calldata and drop unsafe relay actions`). It is not a rebase marker, and it is not the commit on `main`. Step 0 stops the process that is running now. That process can still be the pre-merge build (`da47d9a12d64cd4bea4b6fce0b2166b4c55a0427`) until Render deploys `a66ef64`.

The Render service is `bot-verifier-claim-relayer`. Copy the hostname from the dashboard. The example below is `https://bot-verifier-claim-relayer.onrender.com`. Wallet UX is the Cloudflare Pages project `agent-a-wallet-ux` (`https://agent-a-wallet-ux.pages.dev`). That project is Direct Upload. It has no git connection, and Cloudflare does not build it.

Set this once. Later commands use `$BASE`. Do not set it again.

```bash
BASE=https://bot-verifier-claim-relayer.onrender.com
```

## 0. Interim stop, now

Do this before the cutover, against the process that is already running.

`main` reads two env vars that stop a live submit. Both are read only when the process starts. A value of `1`, `true`, `yes`, or `on` is on. Anything else, including `0` or empty, is off.

Preferred, in one Render save: set `KILL_SWITCH` to `1` and delete `ADMIN_SECRET`. Then choose Save and deploy once. Do not leave `ADMIN_SECRET` for a second save. Deleting it is the preferred option. With it unset, unpause is a noop and the env `KILL_SWITCH` holds.

Anyone who already ran the old step 0, which set only `KILL_SWITCH` and did not delete `ADMIN_SECRET`, must do one more Render save that deletes `ADMIN_SECRET` and keeps `KILL_SWITCH=1`. Then run the check below.

After that save and deploy, confirm `ADMIN_SECRET` is gone. This request sends no `x-admin-secret` and no `Authorization` header:

```bash
curl -sS -X POST "$BASE/v1/admin/pause"
```

`$BASE` is the relayer from the top of this runbook. On `a66ef64`, `claim-relayer/app.mjs` lines 218–231 return **200** when `config.adminSecret` is empty, and they return before `engage()` or `release()`. `JSON.stringify` of that body, with the switch on, is:

```json
{"ok":true,"noop":true,"killSwitch":true,"docs":"ADMIN_SECRET is unset. Pause and unpause do not change the kill switch. Set ADMIN_SECRET to gate those routes. KILL_SWITCH=1 still starts the process paused."}
```

A **200** with `"ok":true` and `"noop":true` means `ADMIN_SECRET` is gone. That is what you want. `"killSwitch"` in that body is the current in-memory switch, so it is `true` after this save. A **401** `{"ok":false,"error":"unauthorized"}` (lines 233–235) means `ADMIN_SECRET` is still set. Stop, and delete it in the dashboard. Do not call unpause.

`POST /v1/claims` and `POST /v1/claims/quote` then return **503** `{"ok":false,"error":"kill_switch"}` before the body is read. Health stays **200**.

```bash
curl -fsS "$BASE/health"
```

Confirm `"killSwitch": true`. `KILL_SWITCH` does not change `liveSubmit`. If the live gate was already open, health still shows `"liveSubmit": true` and `"mode": "live"` while the switch is on. The field that proves this stop is `killSwitch`.

`POST /v1/admin/unpause` can undo a kill switch while `ADMIN_SECRET` is still set. The admin routes are registered before the kill-switch check, so a paused process still accepts them. On `a66ef64` (`claim-relayer/app.mjs`):

- Unset (`config.adminSecret` empty, line 218): lines 218–231 return **200** `{"ok":true,"noop":true,"killSwitch":...}` and return before `release()`. The switch does not change. The `docs` string says `KILL_SWITCH=1` still starts the process paused.
- Set, and the request matches `x-admin-secret` or `Authorization: Bearer` (`adminAuthorized`, lines 30–34): line 238 calls `killSwitch.release()`. `claim-relayer/killSwitch.mjs` lines 13–15 set the in-memory flag to false. The response is **200** `{"ok":true,"noop":false}`.
- Set, and the secret does not match: lines 233–235 return **401** `unauthorized`.

The env var is read only at process start (`claim-relayer/config.mjs` line 234, `claim-relayer/server.mjs` line 18). The next start with `KILL_SWITCH=1` comes up paused. Unpause does not edit the env var. With `ADMIN_SECRET` unset, unpause cannot call `release()`, so the env value holds for that process. The same route on the pre-merge process `da47d9a` is `claim-relayer/app.mjs` lines 194–223 (the `POST /v1/admin/pause` and `POST /v1/admin/unpause` block, through its closing brace). Do not call unpause from this runbook.

Alternate: set `LIVE_SUBMIT` to `0`, and still delete `ADMIN_SECRET` in that same save.

Health then shows `"liveSubmit": false`, `"mode": "fixture"`, and `liveSubmitBlockers` containing `live_submit_off`. A request with `live: true` returns **409** `live_submit_blocked` and `txHash` null. A claim with no live flag still returns **200** as a fixture. This stops broadcasts. It does not stop fixture traffic. `SPENCER_RUN_AUTH=0` also forces `liveSubmit` false (`spencer_run_auth_required`). The check for this alternate is `"liveSubmit": false`.

`POST /v1/admin/pause` is not this stop. Rotate `ADMIN_SECRET` only in step 4, and only if you need the admin routes later. Do not put a value back in this step.

If you cannot set `KILL_SWITCH` or `LIVE_SUBMIT`:

- Delete `CLAIM_API_SECRET` on the Render service and redeploy, and still delete `ADMIN_SECRET` in that same save. On the pre-merge process `da47d9a`, the claim-secret refusal runs only after the live gate is already open: a live claim then returns **503** `claim_api_secret_required` and nothing is broadcast. If `LIVE_SUBMIT` is already `0`, the process never reaches that check. The live claim is already **409** `live_submit_blocked`. Deleting `CLAIM_API_SECRET` is not an extra stop in that case. `a66ef64` does not read `CLAIM_API_SECRET` at all.
- Suspend the service in the Render dashboard (`bot-verifier-claim-relayer` → Suspend). That is a platform control. This code has no suspend flag, and `/health` stops answering.

Leave `KILL_SWITCH=1` and leave `ADMIN_SECRET` unset for the deploy in step 2. Do not set `KILL_SWITCH` to `0` before step 7. If the alternate (`LIVE_SUBMIT=0`) was used, leave `LIVE_SUBMIT=0` and leave `ADMIN_SECRET` unset, and do not expect `"killSwitch": true`. Health for that stop is `"liveSubmit": false` and `"mode": "fixture"`, with `live_submit_off` in `liveSubmitBlockers`. On `a66ef64`, `healthPayload` (`claim-relayer/config.mjs` lines 251–270) sets `liveSubmit` from `config.liveSubmit.allowed`, and `liveSubmitStatus` (lines 53–72) pushes `live_submit_off` when `LIVE_SUBMIT` is off. If the fallback was used (`CLAIM_API_SECRET` deleted, and neither `KILL_SWITCH` nor `LIVE_SUBMIT` was changed), the step 2 deploy of `a66ef64` comes up open. That is harmless: `a66ef64` ignores the old secret, and old-bundle requests get **400** `intent_required`.

## 1. Delete the claim secret before any build

Do this before step 2 builds the Pages bundle. Vite inlines `VITE_*` from the shell or from GitHub Actions. The Pages project env is not the build env. Deleting a Pages variable does not rewrite a bundle that is already uploaded.

`a66ef64` (merged from `05fe6fa`) does not read `CLAIM_API_SECRET`. Delete the old value anyway so it is not left on the service. Do not print the value, and do not send it in a request. `ADMIN_SECRET` was deleted in step 0. Do not add it back in this save.

Render dashboard → `bot-verifier-claim-relayer` → Environment → delete `CLAIM_API_SECRET` → Save and deploy. Keep `KILL_SWITCH=1` when that is the step 0 stop. Leave `ADMIN_SECRET` unset. If step 0 used the alternate, keep `LIVE_SUBMIT=0` through this save. Do not set `KILL_SWITCH` just for this delete. If step 0 was the fallback, `CLAIM_API_SECRET` is already gone. Do not put it back. The step 2 deploy of `a66ef64` still comes up open in that case. The health check in step 2 treats that as harmless.

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

1. PR #46 is already squash-merged. `main` is `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787`. It was merged from `05fe6fa77f2b1380d148d289b4ba45ced68625e3`. Do not merge it again.
2. If Auto-Deploy is on, leave the step 0 stop in place and leave `ADMIN_SECRET` unset through that deploy. When that stop is `KILL_SWITCH=1`, the new process reads `KILL_SWITCH` at start, so the deploy comes up paused. When the alternate was used, leave `LIVE_SUBMIT=0` instead of setting `KILL_SWITCH`. When the fallback was used, do not add `KILL_SWITCH` or `LIVE_SUBMIT` for this deploy: `a66ef64` comes up open, which is harmless because `a66ef64` ignores the old secret and old-bundle requests get **400** `intent_required`. If Auto-Deploy is off, the merge does not deploy. Use Manual Deploy of `a66ef64` with that same env.
3. After the deploy finishes, `GET /health` must show `"killSwitch": true` when step 0 set `KILL_SWITCH=1`. If the alternate (`LIVE_SUBMIT=0`) was used, expect `"liveSubmit": false` and `"mode": "fixture"` instead of `"killSwitch": true`. `liveSubmitBlockers` contains `live_submit_off`. If the fallback (`CLAIM_API_SECRET` deleted) was used, this deploy of `a66ef64` comes up open, so `"killSwitch"` is false unless `KILL_SWITCH` was already set. That open process is harmless: `a66ef64` ignores the old secret, and old-bundle requests get **400** `intent_required`. The Render deploy view shows the relayer commit `a66ef64`. That is not the Pages commit. `/health` has no commit field and no build field. Do not look for either in the JSON.
4. Done by Builder. PR #41 (`cursor/wallet-ux-pages-deploy-e3f5`, the Deploy wallet-ux workflow) is rebased onto `a66ef64`. Its head is `c6b4a844378a95f74a575e213991cfac248ef3fc`. QA and Verifier both passed it there. Spencer does not rebase #41 by hand. Wait until that PR is merged, then publish Pages from that `main` commit. The Pages commit is not `a66ef64`.
5. Publish that Pages commit. Either path uses the build env from CI or from the local shell, never from Pages env vars.
   - GitHub: Actions → Deploy wallet-ux → Run workflow. `on` is `workflow_dispatch` only, and the job runs only for `refs/heads/main`. The build receives `VITE_CLAIM_RELAYER_URL` from the `production` environment variable. It must not receive `VITE_CLAIM_API_SECRET`. The workflow uploads with `wrangler pages deploy` twice: first `--branch=preview-<run_id>`, then `--branch=main` with `--commit-hash` set to that commit.
   - Or, from a shell where `VITE_CLAIM_API_SECRET` is unset:

This is the only `cd` in the runbook. The leak check below does not change directory.

```bash
cd apps/wallet-ux
unset VITE_CLAIM_API_SECRET
npm ci
npm test
npm run build
(
  leak=0
  name=$(grep -REic -e 'x-claim-secret|VITE_CLAIM_API_SECRET' dist)
  name_status=$?
  shape=$(grep -REc -e 'VITE_[A-Z_]*(SECRET|KEY|TOKEN)["'\'']?[[:space:]]*:[[:space:]]*["'\''`][^"'\''`]{16,}' dist)
  shape_status=$?
  [ "$name_status" -ne 2 ] && [ "$shape_status" -ne 2 ] || { echo 'LEAK' >&2; exit 1; }
  if [ -n "$name" ] && printf '%s\n' "$name" | grep -v ':0$'; then
    leak=1
  fi
  if [ -n "$shape" ] && printf '%s\n' "$shape" | grep -v ':0$'; then
    leak=1
  fi
  [ "$leak" = 0 ] || { echo 'LEAK' >&2; exit 1; }
)
```

`grep -REc` and `grep -REic` print one line per file, `path:N`. `N` is how many lines in that file matched. It is not a line number. `dist/assets/index-xxxx.js:0` means no matching line in that file. The subshell pipes each result through `grep -v ':0$'`, so only nonzero hits print. Any printed line is a failure: the subshell prints `LEAK` and exits nonzero, and your shell stays open. A clean tree prints nothing and that subshell exits 0. A grep error (exit status 2, for example a missing `dist`) is also `LEAK`. Do not drop `-c`. Do not add `-o` or `-n`. Do not deploy if anything prints. After #41 merges, `node scripts/guard-claim-secret.mjs dist` replaces these greps. Run it from `apps/wallet-ux`.

```bash
npx wrangler pages deploy dist --project-name=agent-a-wallet-ux --branch=main --commit-hash=<pages-main-sha> --commit-dirty=false
```

A local `--branch=main` upload publishes production directly. The workflow's preview branch is the path that runs `verify-served-bundle.mjs` before production. `<pages-main-sha>` is the wallet-ux commit on `main` after #41 merges. It is not the Render commit `a66ef64`.

Keep `KILL_SWITCH=1` through this publish and the leak checks below when that is the step 0 stop. Step 7 is the first step that sets it to `0`. While it is on, quote and claim return **503** `kill_switch` before any of the split-version behavior below. If the alternate (`LIVE_SUBMIT=0`) was used, the health check stays `"liveSubmit": false` instead of `"killSwitch": true`, and a live claim stays **409** `live_submit_blocked`. If the fallback was used, the `a66ef64` process is open and an old-bundle live claim is **400** `intent_required`.

They still have to move together once the switch comes off. The old Pages bundle posts `POST /v1/claims` with `live: true` and the header `x-claim-secret`. `a66ef64` does not read `CLAIM_API_SECRET` or that header. With the live gate open, that body has no `intent` and returns **400** `intent_required` with `txHash` null. Nothing is broadcast. The other split fails closed too. The new bundle does not send `x-claim-secret`. The pre-merge process at `da47d9a` still requires that header and returns **401** `unauthorized`, or **503** `claim_api_secret_required` if the secret is already unset and the live gate is open.

### Leak check

The build block above already counted `dist/`. This snippet checks the JavaScript the deployment serves. It does not `cd`. Do not search for the real secret. Pattern 2 matches a long literal beside a `VITE_*(SECRET|KEY|TOKEN)` key. It does not match a literal beside the claim header.

The canonical pattern is:

```
VITE_[A-Z_]*(SECRET|KEY|TOKEN)["']?\s*:\s*["'`][^"'`]{16,}
```

The snippet uses `[[:space:]]` in place of `\s` because macOS `/usr/bin/grep` is BSD grep and `\s` in `-E` is not guaranteed there; `[[:space:]]` is the same match. It covers a backtick literal as well as single quotes, double quotes, and a quoted key. A bad fixture of four lines counted 4, and a clean sample counted 0. The check must never print the match.

`name /assets/file.js:N` and `shape /assets/file.js:N` use the same `path:N` form as `grep -REc`. The number after the last colon is how many lines in that file matched. It is not a line number. `:0` is clean for that check. The whole snippet is one `( ... )` subshell. `exit`, `trap`, and `set -o pipefail` stay inside it. Pasting it does not close your shell, and it does not drop `$BASE` or the `PAGES_*` exports from step 3. You can save the fenced text as `leak-check.sh` and run `bash leak-check.sh` or `zsh leak-check.sh`. A failure exits nonzero. Only a clean run prints `CLEAN` and exits 0.

The snippet prints `CLEAN` only when at least one real `/assets/*.js` file was checked and every count is 0. It starts from the `/assets/*.js` paths in the HTML, then follows more JavaScript found in those files: absolute `/assets/*.js` paths, and same-directory dynamic imports such as `"./ccip-….js"` (`"./*.js"` quoted with `"`, `'`, or a backtick). That is the same pair of scans as `apps/wallet-ux/scripts/verify-served-bundle.mjs` on #41 (`c6b4a84`). Those chunks are fetched and scanned too. Every other path exits nonzero: `FETCH FAILED` (curl error, redirect, empty body, whitespace-only JavaScript, HTML body, or no script), `OLD BUNDLE`, or `LEAK`. A JavaScript body that is empty or only whitespace is `FETCH FAILED`, including a file whose only bytes are a UTF-8 BOM. A Pages 404 for a missing asset is `index.html`, so a body whose first non-whitespace character is `<` is a failure. A leading UTF-8 BOM is stripped before that test. An Access or auth 302 is a failure. Do not read `CLEAN` out of a failed run.

```bash
(
set -o pipefail
fail() { echo "FETCH FAILED${1:+: $1}" >&2; exit 1; }
origin="${PAGES_ORIGIN:-https://agent-a-wallet-ux.pages.dev}"
origin="${origin%/}"
index_path="${PAGES_INDEX:-/}"
case "$index_path" in
  /*) ;;
  *) index_path="/$index_path" ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
hdr="$tmp/headers"
queue="$tmp/queue"
seen="$tmp/seen"
: > "$queue"
: > "$seen"
bt='`'
dq='"'
sq="'"

fetch() {
  dest="$1"
  url="$2"
  info=$(curl -fsSL -D "$hdr" -o "$dest" -w '%{http_code} %{num_redirects}' "$url") || fail "$url"
  redirects=${info##* }
  [ "$redirects" = "0" ] || fail "redirect $url"
  [ -s "$dest" ] || fail "empty $url"
}

strip_bom() {
  bom=$(od -An -t x1 -N 3 "$1" | tr -d '[:space:]')
  if [ "$bom" = "efbbbf" ]; then
    tail -c +4 "$1" > "$2"
  else
    cp "$1" "$2"
  fi
}

has_payload() {
  strip_bom "$1" "$tmp/stripped" || return 1
  grep -q '[[:graph:]]' "$tmp/stripped"
}

first_char() {
  strip_bom "$1" "$tmp/stripped" || return 1
  awk '{
    sub(/^[[:space:]]+/, "")
    if (length($0) == 0) next
    print substr($0, 1, 1)
    exit
  }' "$tmp/stripped"
}

enqueue() {
  asset="$1"
  [ -n "$asset" ] || return 0
  case "$asset" in
    /assets/*.js) ;;
    *) return 0 ;;
  esac
  if grep -Fxq -- "$asset" "$seen"; then
    return 0
  fi
  printf '%s\n' "$asset" >> "$seen"
  printf '%s\n' "$asset" >> "$queue"
}

html="$tmp/index.html"
fetch "$html" "$origin$index_path"
if grep -F index-CkV_YTRw.js "$html" >/dev/null; then
  echo 'OLD BUNDLE' >&2
  exit 1
fi
while IFS= read -r asset; do
  enqueue "$asset"
done <<ENDASSETS
$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$html" || true)
ENDASSETS
[ -s "$queue" ] || fail "no /assets/*.js"
shape="VITE_[A-Z_]*(SECRET|KEY|TOKEN)[\"'${bt}]?[[:space:]]*:[[:space:]]*[\"'${bt}][^\"'${bt}]{16,}"
rel_re="[${dq}${sq}${bt}]\\./[A-Za-z0-9._-]+\\.js[${dq}${sq}${bt}]"
checked=0
i=1
while :; do
  asset=$(sed -n "${i}p" "$queue")
  [ -n "$asset" ] || break
  i=$((i + 1))
  dest="$tmp/$(basename "$asset")"
  fetch "$dest" "$origin$asset"
  has_payload "$dest" || fail "empty $asset"
  first=$(first_char "$dest")
  [ "$first" != "<" ] || fail "html $asset"
  if grep -F index-CkV_YTRw.js "$dest" >/dev/null; then
    echo 'OLD BUNDLE' >&2
    exit 1
  fi
  name_count=$(grep -Eic -e 'x-claim-secret|VITE_CLAIM_API_SECRET' "$dest" || true)
  shape_count=$(grep -Ec -e "$shape" "$dest" || true)
  printf 'name %s:%s\n' "$asset" "$name_count"
  printf 'shape %s:%s\n' "$asset" "$shape_count"
  [ "$name_count" = "0" ] && [ "$shape_count" = "0" ] || { echo 'LEAK' >&2; exit 1; }
  while IFS= read -r extra; do
    enqueue "$extra"
  done <<ENDEXTRA
$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$dest" || true)
ENDEXTRA
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    enqueue "/assets/$rel"
  done <<ENDREL
$(grep -oE "$rel_re" "$dest" | sed -E "s/^[${dq}${sq}${bt}]\\.\\///; s/[${dq}${sq}${bt}]\$//" || true)
ENDREL
  checked=$((checked + 1))
done
[ "$checked" -ge 1 ] || fail "no js checked"
echo CLEAN
)
```

After #41 merges, the new deployment is also checked by `apps/wallet-ux/scripts/verify-served-bundle.mjs` at `c6b4a844378a95f74a575e213991cfac248ef3fc` on `cursor/wallet-ux-pages-deploy-e3f5`. The workflow runs `node scripts/verify-served-bundle.mjs` from `apps/wallet-ux` on the preview deployment, then again after the production upload. That file is on the #41 branch. It is not on `main` until #41 merges, so run this snippet yourself on any upload before that. `scripts/guard-claim-secret.mjs` rejects the header name and `VITE_CLAIM_API_SECRET`, including base64, hex, and URL encodings of those names. It does not read a secret from the environment.

### Health check after both sides are up

```bash
curl -fsS "$BASE/health"
```

On the `a66ef64` process, while step 0 is still in force, expect `"ok": true` and `"killSwitch": true` when that stop was `KILL_SWITCH=1`. If the alternate (`LIVE_SUBMIT=0`) was used, expect `"liveSubmit": false` and `"mode": "fixture"` instead of `"killSwitch": true`. If the fallback was used, the process came up open, so `"killSwitch"` is false. `"liveSubmit"` follows the live gate, not the kill switch. It is `true`, and `"mode"` is `"live"`, only when `LIVE_SUBMIT` and `SPENCER_RUN_AUTH` are both on and the escrow is the booked Sepolia contract. Otherwise `"liveSubmit"` is `false` and `"mode"` is `"fixture"`. `/health` does not include a build id or a commit. The Render deploy view is the relayer commit `a66ef64`. The Pages deployment is the wallet-ux commit you passed as `--commit-hash` (or the workflow's `github.sha`). Those are different commits.

Do not send a live claim in this step, and do not set `KILL_SWITCH` to `0` here. The dummy **400** `intent_required` request is in step 7, after the resume.

The CORS check does not depend on the gate. On #46, `access-control-allow-headers` is `content-type,x-admin-secret,authorization`. It does not list `x-claim-secret`.

```bash
curl -sS -D - -o /dev/null -X OPTIONS "$BASE/v1/claims" \
  -H 'origin: https://agent-a-wallet-ux.pages.dev' \
  -H 'access-control-request-method: POST' \
  -H 'access-control-request-headers: content-type'
```

Do not send `access-control-request-headers` that include a secret value. The header name in that CORS request is optional. The allow-list tells the processes apart: `da47d9a` includes `x-claim-secret`, and `a66ef64` does not (`content-type,x-admin-secret,authorization`). You can request `content-type,x-claim-secret` as names only. There is no value to replay.

## 3. Purge deployments that still serve index-CkV_YTRw.js

Dashboard → Workers & Pages → `agent-a-wallet-ux` → Deployments. Each row has a branch and a URL of the form `https://<deployment-id>.agent-a-wallet-ux.pages.dev`. Production also answers at `https://agent-a-wallet-ux.pages.dev`.

```bash
npx wrangler pages deployment list --project-name agent-a-wallet-ux
```

For each host, run the leak-check snippet with `PAGES_ORIGIN` set to that origin and `PAGES_INDEX=/`. `OLD BUNDLE` means that deployment still serves `index-CkV_YTRw.js`. Delete those. `FETCH FAILED` and `LEAK` are not an absent result. Do not delete from a failed fetch. `CLEAN` means that host's checked JavaScript had line counts of 0.

```bash
export PAGES_ORIGIN=https://<deployment-id>.agent-a-wallet-ux.pages.dev
export PAGES_INDEX=/
```

Then paste the leak-check snippet, or save it as `leak-check.sh` and run `bash leak-check.sh` or `zsh leak-check.sh`. Do not run it without those two exports. A pasted failure stays in the subshell, so this shell keeps `$BASE` and these exports.

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

If a preview still cannot be deleted, Cloudflare Access on preview URLs remains the fallback (Zero Trust → Access, or the Pages project's Access policy). Preview responses already send `X-Robots-Tag: noindex`. Access is what stops them being world-readable. Leave preview deployments enabled. On `c6b4a84` the workflow uploads `--branch=preview-<run_id>`, runs `scripts/verify-served-bundle.mjs` on that preview, and only then uploads `--branch=main`. Turning preview deployments off stops that check before production.

## 4. Rotate ADMIN_SECRET only if admin routes are needed later

Skip this step during the cutover. Step 0 deleted `ADMIN_SECRET` so unpause stays a noop. Leave it unset until you need `POST /v1/admin/pause` or `POST /v1/admin/unpause` after step 7. Do not put the old value back. A new value re-opens unpause for anyone who has it. Do not print it. Do not echo it. Do not put it in a test.

On a Mac, the value goes to the clipboard and not to the terminal:

```bash
openssl rand -hex 32 | pbcopy
```

Paste from the clipboard into a password manager, then into the Render dashboard, then clear the clipboard. 1Password (`op`) and Bitwarden (`bw`) can take the same `openssl` stdout on stdin so the value is never printed. Use that instead of `pbcopy` if the CLI is already signed in. Do not run `echo`, `cat`, or `openssl rand` without a pipe.

Render dashboard → `bot-verifier-claim-relayer` → Environment → set `ADMIN_SECRET` to that new value → Save and deploy. Do not change `KILL_SWITCH` in that save.

On `a66ef64`, `ADMIN_SECRET` gates only `POST /v1/admin/pause` and `POST /v1/admin/unpause`, via `x-admin-secret` or `Authorization: Bearer`. It does not authorize a live claim. While it is unset, those routes return **200** `{"ok":true,"noop":true}` and do not change the switch (`claim-relayer/app.mjs` lines 218–231). They do not return 503. While it is set, a matching unpause calls `killSwitch.release()` (line 238). Do not call unpause from this runbook.

## 5. Stay paused

Do not set `KILL_SWITCH` to `0` here. Do not call `POST /v1/admin/unpause`. The old rate-limit test is not this step. It is step 8, and it runs only after step 7. Next is step 7. Step 6, the durable stop, is printed after step 8 so it is not run while the cutover is still paused.

## 7. Resume

Do this only after the Pages publish and every post-cutover check above has passed: the leak snippet printed `CLEAN`, and old deployments that still serve `index-CkV_YTRw.js` are gone or covered by Access. Leave `KILL_SWITCH` at `1` until those checks have passed. This is the only step that sets `KILL_SWITCH` to `0`. Leave `ADMIN_SECRET` unset unless step 4 was done on purpose after this resume.

Confirm two commits, in two places. The Render deploy view is the relayer commit `a66ef6439dec6fd2e5ad49d53fa4ce98d373d787`. The Pages deployment is the wallet-ux `main` commit you published. Those are not the same commit. `/health` shows neither.

Render dashboard → `bot-verifier-claim-relayer` → Environment → set `KILL_SWITCH` to `0`.

If step 0 used the alternate stop, restore those vars to the values they had before step 0, in the same save:

- If you set `LIVE_SUBMIT` to `0`, set it back to its pre-step-0 value.
- If you set `SPENCER_RUN_AUTH` to `0`, set it back to its pre-step-0 value.

If you did not change them, do not change them now. Then Save and deploy. One deploy covers every var you changed.

```bash
curl -fsS "$BASE/health"
```

Confirm `"killSwitch": false`.

On `a66ef64`, `healthPayload` in `claim-relayer/config.mjs` (lines 251–270) sets the `liveSubmit` field from `config.liveSubmit.allowed` and sets `mode` to `"live"` only when that is true. Otherwise `mode` is `"fixture"`. `liveSubmitStatus` (lines 53–72) allows the gate only when the chain id is 84532, the escrow is the booked Sepolia contract, `LIVE_SUBMIT` is on, and `SPENCER_RUN_AUTH` is on. `KILL_SWITCH` does not change `liveSubmit` or `mode`. When the restored values open that gate, confirm `"liveSubmit": true` and `"mode": "live"`. If a blocker remains, `"liveSubmit"` stays false, `"mode"` stays `"fixture"`, and `liveSubmitBlockers` names it (`live_submit_off`, `spencer_run_auth_required`, or an escrow or chain blocker). `liveSubmitRequested` is true when the `LIVE_SUBMIT` flag itself is on, even if another blocker remains.

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

Unpause was checked on the pre-merge process `da47d9a` (`claim-relayer/app.mjs` lines 194–223) and on `main` at `a66ef64` (`claim-relayer/app.mjs` lines 217–246). The later relayer behavior was checked on `a66ef64`, the squash of #46 merged from `05fe6fa`. Those `claim-relayer` files match `05fe6fa`.

- `a66ef64` supports `KILL_SWITCH` and `LIVE_SUBMIT`, and `/health` reports `killSwitch` and `liveSubmit`. The suspend action and a missing `CLAIM_API_SECRET` are fallbacks for the pre-merge process, not replacements for those fields.
- `/health` does not report a git commit or a build id.
- `KILL_SWITCH=1` does not set `liveSubmit` to false.
- `LIVE_SUBMIT=0` does not refuse fixture claims. They stay **200**.
- Deleting `CLAIM_API_SECRET` on `da47d9a` returns **503** `claim_api_secret_required` only when live submit is already allowed. `a66ef64` does not read `CLAIM_API_SECRET` at all.
- Pause and unpause return **200** `noop` when `ADMIN_SECRET` is unset, and they do not call `release()`. When it is set, a matching unpause does call `release()`. They do not return 503.
- `POST /v1/claims/quote` has no per-IP limit.
- The IP bucket map is not pruned.
- Admin routes have no rate limit.
- A replayed `(sender, nonce)` on #46 is **409** `nonce_replay`. The response does not return the original transaction hash.
- There is no broadcast mutex and no viem `nonceManager` anywhere under `claim-relayer/`. `already known` and `nonce too low` are transient markers in `claim-relayer/retry.mjs` (lines 56 and 52). `withClaimRetry` retries them (lines 101–124). `broadcast.mjs` applies that retry only to the already-signed `eth_sendRawTransaction` (lines 183–189). The relayer does not call `eth_getTransactionByHash`.
- There is no fee bump, and no Render Key Value nonce store.
- `claim-relayer/render.yaml` does not set `autoDeploy`, and merging it does not toggle auto-deploy on the existing service.
- Cloudflare Access on preview URLs is a dashboard control. The relayer does not implement it. Preview deployments stay enabled so the Deploy wallet-ux workflow can verify the preview before it uploads production.
