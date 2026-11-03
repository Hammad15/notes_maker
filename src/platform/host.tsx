import { isTauri } from "@tauri-apps/api/core"
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createBrowserHost } from "./browser"
import { createTauriHost } from "./tauri"
import type { Host } from "./types"

const HostContext = createContext<Host | null>(null)

function detectHost(): Host {
  if (typeof window === "undefined") return createBrowserHost()
  const runtime = window as Window & { __TAURI_INTERNALS__?: unknown }
  if (isTauri() || "__TAURI_INTERNALS__" in runtime) return createTauriHost()
  return createBrowserHost()
}

export function HostProvider({ children }: { children: ReactNode }) {
  const host = useMemo(() => detectHost(), [])
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error("Create Notes is missing its desktop host.")
  return host
}
