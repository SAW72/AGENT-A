/** Product name. Change this line to swap the working name. */
export const PRODUCT_NAME = "Agent-BV"

export const DESCRIPTOR = "Bot Verifier"

export const PRODUCT_TITLE = `${PRODUCT_NAME} — ${DESCRIPTOR}`

export const TESTNET_LINE = "Base Sepolia testnet only"

export const OPERATOR_LINE = `${PRODUCT_NAME} is a product of Steward of the King LLC, an Ohio (USA) limited liability company.`

export const DESCRIPTION = `${PRODUCT_TITLE}: read-only Gate A status and claim tools on Base Sepolia testnet (chain id 84532). Testnet only, no mainnet.`

const HTML_TOKENS: Record<string, string> = {
  "%PRODUCT_TITLE%": PRODUCT_TITLE,
  "%PRODUCT_DESCRIPTION%": DESCRIPTION,
}

export function applyBrandHtml(html: string): string {
  return Object.entries(HTML_TOKENS).reduce((result, [token, value]) => result.replaceAll(token, value), html)
}

export function brandManifest() {
  return {
    name: PRODUCT_TITLE,
    short_name: PRODUCT_NAME,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }
}

export function brandManifestSource(): string {
  return `${JSON.stringify(brandManifest(), null, 2)}\n`
}
