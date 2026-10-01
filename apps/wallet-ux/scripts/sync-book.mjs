import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, "..")
const source = join(appRoot, "..", "..", "deployments", "base-sepolia.json")
const destDir = join(appRoot, "src")
const dest = join(destDir, "base-sepolia.json")

function assertSepoliaBook(book, label) {
  if (book.chainId !== 84532 || book.network !== "base-sepolia") {
    throw new Error(
      `Refusing address book (${label}): expected Base Sepolia chainId 84532, got chainId=${book.chainId} network=${book.network}`,
    )
  }
}

if (!existsSync(source)) {
  if (!existsSync(dest)) {
    throw new Error(
      "src/base-sepolia.json is missing and deployments/base-sepolia.json is not visible from this build root",
    )
  }
  assertSepoliaBook(JSON.parse(readFileSync(dest, "utf8")), "src/base-sepolia.json")
  console.log("deployments/base-sepolia.json not visible; using src/base-sepolia.json (chainId 84532)")
  process.exit(0)
}

const book = JSON.parse(readFileSync(source, "utf8"))
assertSepoliaBook(book, "deployments/base-sepolia.json")
mkdirSync(destDir, { recursive: true })
copyFileSync(source, dest)
console.log("Copied deployments/base-sepolia.json -> src/base-sepolia.json (chainId 84532)")
