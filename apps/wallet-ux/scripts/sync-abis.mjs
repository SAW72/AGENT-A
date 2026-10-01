import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..", "..")
const outDir = join(repoRoot, "out")
const destDir = join(here, "..", "src", "abi")

const files = [
  ["Denylist.sol/Denylist.json", "Denylist.json"],
  ["Vault.sol/Vault.json", "Vault.json"],
  ["IVault.sol/IVault.json", "IVault.json"],
  ["DisputePanel.sol/DisputePanel.json", "DisputePanel.json"],
  ["Liability.sol/Liability.json", "Liability.json"],
  ["InsuranceFund.sol/InsuranceFund.json", "InsuranceFund.json"],
]

mkdirSync(destDir, { recursive: true })

for (const [src, dest] of files) {
  const artifactPath = join(outDir, src)
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`Forge artifact has no abi array: ${artifactPath}`)
  }
  writeFileSync(join(destDir, dest), `${JSON.stringify(artifact.abi, null, 2)}\n`)
}

const gen = spawnSync("bash", [join(repoRoot, "scripts", "gen-escrow-abi.sh")], { stdio: "inherit" })
if (gen.status !== 0) {
  process.exit(gen.status ?? 1)
}

console.log(`Wrote ${files.length} ABIs from out/ to src/abi/`)
