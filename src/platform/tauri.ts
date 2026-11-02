import { messageOf } from "../domain/errors"
import type { SetupProgress, TranscriptionProgress } from "../domain/localSpeech"
import { MEDIA_EXTENSIONS } from "../domain/text"
import { createRemoteStore } from "./remoteStore"
import type { Host } from "./types"

async function tauriCall<T>(request: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core")
  try {
    return await invoke<T>("desktop_call", { request })
  } catch (error) {
    if (error instanceof Error && error.message.trim()) throw error
    throw new Error(messageOf(error))
  }
}

function selectedPath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value
  return null
}

export function createTauriHost(): Host {
  const store = createRemoteStore(tauriCall)
  return {
    nativeDialogs: true,
    store,
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
      try {
        await openPath(path)
      } catch (error) {
        // The plugin refuses a canonical Windows path, or the command is missing
        // from the window capability. The desktop command opens that same file.
        try {
          await tauriCall({ op: "openPath", path })
        } catch (fallback) {
          if (/not allowed/i.test(messageOf(error))) throw fallback
          throw error
        }
      }
    },
    watchTranscription: async (onProgress) => {
      const { listen } = await import("@tauri-apps/api/event")
      const stop = await listen<TranscriptionProgress>("local-transcribe-progress", (event) => {
        onProgress(event.payload)
      })
      return () => {
        stop()
      }
    },
    setupLocal: async (pace, onProgress) => {
      let unlisten = () => {}
      if (onProgress) {
        const { listen } = await import("@tauri-apps/api/event")
        const stop = await listen<SetupProgress>("local-setup-progress", (event) => {
          onProgress(event.payload)
        })
        unlisten = () => {
          stop()
        }
      }
      try {
        return await store.setupLocal(pace)
      } finally {
        unlisten()
      }
    },
  }
}
