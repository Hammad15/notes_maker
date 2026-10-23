import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createBrowserHost } from "./browser"
import { createTauriHost } from "./tauri"
import type { Host } from "./types"

const HostContext = createContext<Host | null>(null)

function detectHost(): Host {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return createTauriHost()
  }
  return createBrowserHost()
}

export function HostProvider({ children }: { children: ReactNode }) {
  const host = useMemo(() => detectHost(), [])
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error("Study Notes is missing its desktop host.")
  return host
}
