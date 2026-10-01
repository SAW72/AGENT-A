const HEX_64 = /^[0-9a-fA-F]{64}$/

/** 32 cryptographically random bytes. Not derived from a claim id or the clock. */
export function randomBytes32(
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes)
  },
): `0x${string}` {
  const bytes = new Uint8Array(32)
  fill(bytes)
  if (bytes.every((byte) => byte === 0)) bytes[31] = 1
  let hex = "0x"
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex as `0x${string}`
}

export function parseBytes32(raw: string): `0x${string}` | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed
  if (!HEX_64.test(hex)) return null
  return `0x${hex.toLowerCase()}`
}

const MATCH_LEVELS = ["None", "PromptBlock", "SignatureBlock", "ExactBlock"] as const

export function matchLevelLabel(level: number): string {
  return MATCH_LEVELS[level] ?? `Unknown(${level})`
}
