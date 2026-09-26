import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const brand = readFileSync(join(root, "src/brand.ts"), "utf8")
const productName = brand.match(/export const PRODUCT_NAME = "([^"]+)"/)?.[1]
const descriptor = brand.match(/export const DESCRIPTOR = "([^"]+)"/)?.[1]
if (!productName || !descriptor) {
  console.error("Brand check could not read PRODUCT_NAME and DESCRIPTOR from src/brand.ts")
  process.exit(1)
}

const title = `${productName} — ${descriptor}`
const html = readFileSync(join(root, "dist/index.html"), "utf8")
const manifest = JSON.parse(readFileSync(join(root, "dist/manifest.webmanifest"), "utf8"))
const js = readdirSync(join(root, "dist/assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFileSync(join(root, "dist/assets", name), "utf8"))
  .join("\n")

const checks = [
  [html.includes(`<title>${title}</title>`), "dist title"],
  [html.includes(`${title}:`), "dist description"],
  [html.includes("chain id 84532"), "dist chain id"],
  [html.includes("Testnet only, no mainnet."), "dist testnet framing"],
  [html.includes(`property="og:title" content="${title}"`), "dist og:title"],
  [html.includes(`property="og:site_name" content="${title}"`), "dist og:site_name"],
  [html.includes(`name="twitter:title" content="${title}"`), "dist twitter:title"],
  [!html.includes("%PRODUCT_TITLE%"), "dist has no title token"],
  [manifest.name === title, "manifest name"],
  [manifest.short_name === productName, "manifest short_name"],
  [js.includes(productName), "bundle product name"],
  [js.includes("is a product of Steward of the King LLC, an Ohio (USA) limited liability company."), "bundle footer"],
  [js.includes(descriptor), "bundle descriptor"],
]

const misses = checks.filter(([ok]) => !ok).map(([, label]) => label)
if (misses.length > 0) {
  console.error(`Brand check failed: ${misses.join(", ")}`)
  process.exit(1)
}
console.log(`Brand check passed for ${title}`)
