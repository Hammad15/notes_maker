import { Ops } from "./ops"
import { createRemoteStore } from "./remoteStore"
import type { Host } from "./types"

async function tauriCall<T>(request: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>("desktop_call", { request })
}

export function createTauriHost(): Host {
  return {
    nativeDialogs: true,
    store: createRemoteStore(tauriCall),
    pickDirectory: () => tauriCall<string | null>({ op: Ops.pickDirectory }),
    pickMedia: (directory) =>
      tauriCall<string | null>({
        op: Ops.pickMedia,
        directory: directory ?? null,
      }),
  }
}
