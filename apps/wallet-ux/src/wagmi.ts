import { createConfig, http } from "wagmi"
import { injected } from "wagmi/connectors"
import { baseSepolia } from "viem/chains"
import { assertSepoliaOnly } from "./guard"
import { rpcUrlFromEnv } from "./read"

assertSepoliaOnly([baseSepolia.id])

export const rpcUrl = rpcUrlFromEnv(import.meta.env.VITE_BASE_SEPOLIA_RPC_URL)

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [injected()],
  transports: {
    [baseSepolia.id]: http(rpcUrl, { timeout: 20_000 }),
  },
  ssr: false,
})

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig
  }
}
