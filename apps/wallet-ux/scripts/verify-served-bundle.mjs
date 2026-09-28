import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function runGuard(args) {
  const result = spawnSync("node", args, { encoding: "utf8" })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) {
    console.error(`Verify failed: could not run the bundle guard (${result.error.message}).`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function referencedAssets(html) {
  return [...new Set([...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((match) => match[0]))].sort()
}

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
const distIndexPath = process.env.DIST_INDEX ?? "dist/index.html"
let builtHtml = ""
try {
  builtHtml = readFileSync(distIndexPath, "utf8")
} catch {
  console.error(`Verify failed: built index ${distIndexPath} is missing.`)
  process.exit(1)
}
const expectedAssets = referencedAssets(builtHtml)
const servedAssets = referencedAssets(html)
if (expectedAssets.length === 0 || expectedAssets.join("\n") !== servedAssets.join("\n")) {
  console.error(
    `Verify failed: served index.html does not reference the built asset hashes. Built: ${expectedAssets.join(", ") || "(none)"}. Served: ${servedAssets.join(", ") || "(none)"}.`,
  )
  process.exit(1)
}
console.log(`Served index.html references the built asset hashes: ${servedAssets.join(", ")}.`)
const pending = servedAssets.filter((assetPath) => assetPath.endsWith(".js"))
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
    for (const match of text.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)) {
      if (!seen.has(match[0])) pending.push(match[0])
    }
    for (const match of text.matchAll(/["'`]\.\/([A-Za-z0-9._-]+\.js)["'`]/g)) {
      const assetPath = `/assets/${match[1]}`
      if (!seen.has(assetPath)) pending.push(assetPath)
    }
  }
  writeFileSync(bundlePath, `${html}\n${javascript}`)

  runGuard([
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "scripts/guard-escrow-addresses.mjs",
    bundlePath,
  ])

  if (process.env.EMBED_CLAIM_SECRET === "true") {
    console.log("embed_claim_secret is true. Skipped the served claim-secret scan.")
  } else {
    runGuard(["scripts/guard-claim-secret.mjs", bundlePath])
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log(`Served bundle at ${base} passed the escrow, phrase, and claim-secret checks.`)
