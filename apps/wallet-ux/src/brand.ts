/** Product name. Change this line to swap the working name. */
export const PRODUCT_NAME = "Agent.BV"

/** Full display form. Title, header, manifest name, and the footer use this. */
export const DISPLAY_NAME = `${PRODUCT_NAME} (Agent Bot Verifier)`

export const PRODUCT_TITLE = DISPLAY_NAME

export const TESTNET_LINE = "Base Sepolia testnet only"

export const OPERATOR_LINE = `${DISPLAY_NAME} is a product of Steward of the King LLC, an Ohio (USA) limited liability company.`

export const DISCLAIMER_LINE = "Experimental testnet tool. Not a certification, safety guarantee, or insurance product. Ethereum mainnet and Base mainnet are refused. This page does not sign EIP-712 claims."

export const DESCRIPTION = `${DISPLAY_NAME}: read-only Gate A status and claim tools on Base Sepolia testnet (chain id 84532). Testnet only, no mainnet.`

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
