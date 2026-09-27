import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"

const secret = process.env.VITE_CLAIM_API_SECRET ?? ""
if (secret.length === 0) {
  console.log("VITE_CLAIM_API_SECRET is empty. Skipped the embedded-secret scan.")
  process.exit(0)
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error("Claim secret scan needs at least one file or directory.")
  process.exit(1)
}

function encodings(value) {
  const standard = Buffer.from(value, "utf8").toString("base64")
  const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_")
  const hex = Buffer.from(value, "utf8").toString("hex")
  const labeled = [
    ["raw", value],
    ["base64", standard],
    ["base64-without-padding", standard.replace(/=+$/, "")],
    ["base64url", urlSafe],
    ["base64url-without-padding", urlSafe.replace(/=+$/, "")],
    ["url", encodeURIComponent(value)],
    ["hex", hex],
    ["hex-uppercase", hex.toUpperCase()],
    ["json", JSON.stringify(value).slice(1, -1)],
  ]
  const seen = new Set()
  const unique = []
  for (const entry of labeled) {
    if (!entry[1] || seen.has(entry[1])) continue
    seen.add(entry[1])
    unique.push(entry)
  }
  return unique
}

function grepQuiet(value, target, recursive) {
  const script = recursive
    ? 'grep -R -q -F -- "$SCAN_VALUE" "$SCAN_PATH"'
    : 'grep -q -F -- "$SCAN_VALUE" "$SCAN_PATH"'
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, SCAN_VALUE: value, SCAN_PATH: target },
    stdio: "ignore",
  })
}

const forms = encodings(secret)
for (const target of targets) {
  const info = statSync(target, { throwIfNoEntry: false })
  if (!info) {
    console.error(`Claim secret scan failed: ${target} does not exist.`)
    process.exit(1)
  }
  const recursive = info.isDirectory()
  for (const [label, value] of forms) {
    const result = grepQuiet(value, target, recursive)
    if (result.status === 0) {
      console.error(
        `Claim secret scan failed: the ${label} form is present in ${target}. The value was not printed.`,
      )
      process.exit(1)
    }
    if (result.status !== 1) {
      console.error(`Claim secret scan failed: grep could not scan ${target} for the ${label} form.`)
      process.exit(1)
    }
  }
}

console.log(`Claim secret scan passed for ${targets.length} path(s). No raw or encoded form was present.`)
