import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  applyBrandHtml,
  brandManifest,
  DESCRIPTION,
  DISCLAIMER_LINE,
  DISPLAY_NAME,
  OPERATOR_LINE,
  PRODUCT_NAME,
  PRODUCT_TITLE,
  TESTNET_LINE,
} from "./brand"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("brand source", () => {
  it("builds the title, footer, and manifest from PRODUCT_NAME", () => {
    expect(DISPLAY_NAME).toBe(`${PRODUCT_NAME} (Agent Bot Verifier)`)
    expect(PRODUCT_TITLE).toBe(DISPLAY_NAME)
    expect(OPERATOR_LINE.startsWith(`${DISPLAY_NAME} is a product of `)).toBe(true)
    expect(DESCRIPTION.startsWith(`${DISPLAY_NAME}:`)).toBe(true)
    expect(DESCRIPTION).toContain("chain id 84532")
    expect(DESCRIPTION).toContain("Testnet only, no mainnet.")
    expect(TESTNET_LINE).toBe("Base Sepolia testnet only")
    expect(DISCLAIMER_LINE).toBe(
      "Experimental testnet tool. Not a certification, safety guarantee, or insurance product. Ethereum mainnet and Base mainnet are refused. This page does not sign EIP-712 claims.",
    )

    const rawHtml = readFileSync(join(root, "index.html"), "utf8")
    expect(rawHtml).not.toContain(PRODUCT_NAME)
    expect(rawHtml).toContain("%PRODUCT_TITLE%")
    expect(rawHtml).toContain("%PRODUCT_DESCRIPTION%")

    const html = applyBrandHtml(rawHtml)
    expect(html).toContain(`<title>${DISPLAY_NAME}</title>`)
    expect(html).toContain(`name="description" content="${DESCRIPTION}"`)
    expect(html).toContain(`property="og:title" content="${DISPLAY_NAME}"`)
    expect(html).toContain(`property="og:site_name" content="${DISPLAY_NAME}"`)
    expect(html).toContain(`property="og:description" content="${DESCRIPTION}"`)
    expect(html).toContain(`name="twitter:title" content="${DISPLAY_NAME}"`)
    expect(html).toContain(`name="twitter:description" content="${DESCRIPTION}"`)
    expect(html).not.toContain("%PRODUCT_TITLE%")
    expect(html).not.toContain("%PRODUCT_DESCRIPTION%")

    const manifest = brandManifest()
    expect(manifest.name).toBe(DISPLAY_NAME)
    expect(manifest.short_name).toBe(PRODUCT_NAME)

    const app = readFileSync(join(root, "src/App.tsx"), "utf8")
    expect(app).toContain("{DISPLAY_NAME}")
    expect(app).toContain("{OPERATOR_LINE}")
    expect(app).toContain("{TESTNET_LINE}")
    expect(app).toContain("{DISCLAIMER_LINE}")
    expect(app).not.toContain(PRODUCT_NAME)
    expect(app).not.toContain(DISPLAY_NAME)
  })
})
