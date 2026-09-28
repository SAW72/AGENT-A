import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertBundle,
  assertConfiguredEscrow,
  GuardError,
  LIVE_ESCROW,
  PHRASES,
  RETIRED_ESCROW,
} from "./guard-escrow-addresses.mjs"

const SENTINEL = 'sl?m=n "'
const temps = []

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "wallet-ux-guard-"))
  temps.push(directory)
  return directory
}

function bundleSource(retiredCount) {
  return [LIVE_ESCROW, ...PHRASES, ...Array.from({ length: retiredCount }, () => RETIRED_ESCROW)].join("\n")
}

function writeBundle(retiredCount) {
  const directory = tempDir()
  mkdirSync(join(directory, "assets"))
  writeFileSync(join(directory, "assets", "app.js"), bundleSource(retiredCount))
  return directory
}

function runNode(script, args, env) {
  return spawnSync("node", ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  })
}

function runNodeAsync(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

function secretForms(value) {
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

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

describe("guard-escrow-addresses", () => {
  it("accepts the configured book and a bundle with three retired occurrences", () => {
    const cli = runNode("scripts/guard-escrow-addresses.mjs", [])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain(LIVE_ESCROW)
    expect(cli.stdout).toContain("SUPERSEDED.botAttestationEscrow is " + RETIRED_ESCROW)
    expect(() => assertBundle(writeBundle(3), 3)).not.toThrow()
  })

  it("fails when the bundle has four retired occurrences instead of three", () => {
    const directory = writeBundle(4)
    expect(() => assertBundle(directory, 3)).toThrow(GuardError)
    expect(() => assertBundle(directory, 3)).toThrow(/4 time\(s\).*3 time\(s\)/)
  })

  it("fails when the configured escrow is not the live address", () => {
    expect(() =>
      assertConfiguredEscrow(
        { botAttestationEscrow: "0x0000000000000000000000000000000000000001" },
        { botAttestationEscrow: LIVE_ESCROW },
        { botAttestationEscrow: RETIRED_ESCROW },
      ),
    ).toThrow(/not the live escrow/)
  })
})

describe("guard-claim-secret", () => {
  it("skips an empty secret and passes when the sentinel is absent", () => {
    const empty = runNode("scripts/guard-claim-secret.mjs", ["package.json"], { VITE_CLAIM_API_SECRET: "" })
    expect(empty.status).toBe(0)
    expect(empty.stdout).toContain("Skipped the embedded-secret scan")

    const clean = tempDir()
    writeFileSync(join(clean, "clean.txt"), "no secret here")
    const passed = runNode("scripts/guard-claim-secret.mjs", [join(clean, "clean.txt")], {
      VITE_CLAIM_API_SECRET: SENTINEL,
    })
    expect(passed.status).toBe(0)
    expect(passed.stdout).not.toContain(SENTINEL)
    expect(passed.stderr).not.toContain(SENTINEL)
  })

  it("fails for each encoded form without printing the value", () => {
    const forms = secretForms(SENTINEL)
    expect(forms.map(([label]) => label)).toEqual([
      "raw",
      "base64",
      "base64-without-padding",
      "base64url",
      "base64url-without-padding",
      "url",
      "hex",
      "hex-uppercase",
      "json",
    ])
    for (const [label, value] of forms) {
      const directory = tempDir()
      const file = join(directory, "leak.txt")
      writeFileSync(file, `prefix ${value} suffix`)
      const result = runNode("scripts/guard-claim-secret.mjs", [file], { VITE_CLAIM_API_SECRET: SENTINEL })
      expect(result.status, label).not.toBe(0)
      expect(result.stderr, label).toContain(`the ${label} form is present`)
      expect(result.stderr, label).not.toContain(SENTINEL)
      expect(result.stdout, label).not.toContain(SENTINEL)
      expect(result.stderr, label).not.toContain(value)
    }
  })
})

describe("verify-served-bundle", () => {
  const hash = "app-abc123"

  function fixture({ servedHtml, javascript, secret = "" }) {
    const directory = tempDir()
    const built = `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">`
    writeFileSync(join(directory, "built.html"), built)
    const served = servedHtml ?? built
    const files = new Map([
      ["/", served],
      [`/assets/${hash}.js`, javascript ?? bundleSource(3)],
      [`/assets/${hash}.css`, "body{}"],
    ])
    return { directory, files, secret }
  }

  async function verify(setup) {
    const server = await listen((request, response) => {
      const body = setup.files.get(request.url ?? "")
      if (body === undefined) {
        response.writeHead(404)
        response.end("missing")
        return
      }
      response.writeHead(200, { "content-type": "text/html" })
      response.end(body)
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const result = await runNodeAsync("scripts/verify-served-bundle.mjs", [], {
      DEPLOYMENT_URL: `http://127.0.0.1:${port}`,
      DIST_INDEX: join(setup.directory, "built.html"),
      EMBED_CLAIM_SECRET: "false",
      VITE_CLAIM_API_SECRET: setup.secret,
    })
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    return result
  }

  it("passes when index.html matches the built hashes and the bundle count is 3", async () => {
    const result = await verify(fixture({}))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`/assets/${hash}.js`)
    expect(result.stdout).toContain("retired escrow count 3")
  })

  it("fails when served index.html references a different asset hash", async () => {
    const result = await verify(
      fixture({
        servedHtml: '<script src="/assets/app-deadbeef.js"></script><link href="/assets/app-deadbeef.css">',
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("does not reference the built asset hashes")
  })

  it("fails when index.html adds a fourth retired address", async () => {
    const result = await verify(
      fixture({
        servedHtml: `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${RETIRED_ESCROW}`,
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("4 time(s)")
    expect(result.stderr).toContain("3 time(s)")
  })

  it("fails when index.html contains the claim secret", async () => {
    const result = await verify(
      fixture({
        servedHtml: `<script src="/assets/${hash}.js"></script><link href="/assets/${hash}.css">${SENTINEL}`,
        secret: SENTINEL,
      }),
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("the raw form is present")
    expect(result.stderr).not.toContain(SENTINEL)
    expect(result.stdout).not.toContain(SENTINEL)
  })
})
