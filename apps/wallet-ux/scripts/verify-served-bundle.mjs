import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const deploymentUrl = (process.env.DEPLOYMENT_URL ?? "").trim()
if (!deploymentUrl) {
  console.error("Verify failed: deployment URL is empty.")
  process.exit(1)
}

const base = deploymentUrl.replace(/\/$/, "")
const indexResponse = await fetch(`${base}/`)
if (!indexResponse.ok) {
  console.error(`Verify failed: index responded ${indexResponse.status}.`)
  process.exit(1)
}
const html = await indexResponse.text()
const assetPattern = /\/assets\/[A-Za-z0-9._-]+\.js/g
const pending = [...new Set([...html.matchAll(assetPattern)].map((match) => match[0]))]
if (pending.length === 0) {
  console.error("Verify failed: deployed index HTML does not reference /assets/*.js.")
  process.exit(1)
}

const directory = mkdtempSync(join(tmpdir(), "wallet-ux-served-"))
const bundlePath = join(directory, "served.js")
try {
  const seen = new Set()
  let javascript = ""
  while (pending.length > 0) {
    const assetPath = pending.pop()
    if (!assetPath || seen.has(assetPath)) continue
    seen.add(assetPath)
    console.log(`Fetching ${assetPath}`)
    const response = await fetch(`${base}${assetPath}`)
    if (!response.ok) {
      console.error(`Verify failed: could not download ${assetPath} (${response.status}).`)
      process.exit(1)
    }
    const text = await response.text()
    javascript += `${text}\n`
    for (const match of text.matchAll(assetPattern)) {
      if (!seen.has(match[0])) pending.push(match[0])
    }
    for (const match of text.matchAll(/["'`]\.\/([A-Za-z0-9._-]+\.js)["'`]/g)) {
      const assetPath = `/assets/${match[1]}`
      if (!seen.has(assetPath)) pending.push(assetPath)
    }
  }
  writeFileSync(bundlePath, javascript)

  const escrow = spawnSync(
    "node",
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/guard-escrow-addresses.mjs", bundlePath],
    { stdio: "inherit" },
  )
  if (escrow.status !== 0) process.exit(escrow.status ?? 1)

  if (process.env.EMBED_CLAIM_SECRET === "true") {
    console.log("embed_claim_secret is true. Skipped the served claim-secret scan.")
  } else {
    const secretScan = spawnSync("node", ["scripts/guard-claim-secret.mjs", bundlePath], { stdio: "inherit" })
    if (secretScan.status !== 0) process.exit(secretScan.status ?? 1)
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log(`Served bundle at ${base} passed the escrow, phrase, and claim-secret checks.`)
