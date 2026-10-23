import { MEDIA_EXTENSIONS } from "../domain/text"
import { createRemoteStore } from "./remoteStore"
import type { Host } from "./types"

async function tauriCall<T>(request: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>("desktop_call", { request })
}

function selectedPath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value
  return null
}

export function createTauriHost(): Host {
  return {
    nativeDialogs: true,
    store: createRemoteStore(tauriCall),
    pickDirectory: async () => {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Choose a folder",
      })
      return selectedPath(picked)
    },
    pickMedia: async (directory) => {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({
        directory: false,
        multiple: false,
        title: "Choose video or audio",
        defaultPath: directory || undefined,
        filters: [
          {
            name: "Video or audio",
            extensions: MEDIA_EXTENSIONS.map((extension) => extension.slice(1)),
          },
        ],
      })
      return selectedPath(picked)
    },
    openPath: async (path) => {
      const { openPath } = await import("@tauri-apps/plugin-opener")
      await openPath(path)
    },
  }
}
