import { useEffect, useState } from "react"
import type { Connector } from "wagmi"

export function useConnectorChainId(connector: Connector | undefined, connected: boolean): number | null {
  const [chainId, setChainId] = useState<number | null>(null)

  useEffect(() => {
    if (!connector || !connected) {
      setChainId(null)
      return
    }

    let stopped = false
    const pull = () => {
      void connector.getChainId().then(
        (id) => {
          if (!stopped) setChainId(id)
        },
        () => {
          if (!stopped) setChainId(null)
        },
      )
    }

    const onChange = (payload: { chainId?: number }) => {
      if (typeof payload.chainId === "number") setChainId(payload.chainId)
      else pull()
    }

    pull()
    connector.emitter.on("change", onChange)
    const timer = window.setInterval(pull, 2000)
    return () => {
      stopped = true
      connector.emitter.off("change", onChange)
      window.clearInterval(timer)
    }
  }, [connector, connected])

  return chainId
}
