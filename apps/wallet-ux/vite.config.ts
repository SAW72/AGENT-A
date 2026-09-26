import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, type Plugin } from "vitest/config"
import react from "@vitejs/plugin-react"
import { applyBrandHtml, brandManifestSource } from "./src/brand.ts"

function brandPlugin(): Plugin {
  const serveManifest = (req: { url?: string }, res: { setHeader: (name: string, value: string) => void; end: (body: string) => void }, next: () => void) => {
    const path = req.url?.split("?")[0]
    if (path !== "/manifest.webmanifest") {
      next()
      return
    }
    res.setHeader("Content-Type", "application/manifest+json")
    res.end(brandManifestSource())
  }
  return {
    name: "wallet-brand",
    transformIndexHtml(html) {
      return applyBrandHtml(html)
    },
    configureServer(server) {
      server.middlewares.use(serveManifest)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveManifest)
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: brandManifestSource(),
      })
    },
  }
}

const port = Number(process.env.PORT) || 5173
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

// Address book import is src/base-sepolia.json (inside this app).
// scripts/sync-book.mjs refreshes it from the repo root when that file is visible.

export default defineConfig({
  plugins: [react(), brandPlugin()],
  server: {
    host: "0.0.0.0",
    port,
    fs: { allow: [repoRoot] },
  },
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 4173,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
