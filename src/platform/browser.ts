import { DESKTOP_WINDOW_REQUIRED, WINDOWS_DIALOG_REQUIRED } from "./dialogs"
import { createRemoteStore } from "./remoteStore"
import type { Host } from "./types"

async function browserCall<T>(request: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/desktop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  let payload: { ok?: boolean; value?: T; error?: string }
  try {
    payload = (await response.json()) as { ok?: boolean; value?: T; error?: string }
  } catch {
    throw new Error("The local file service did not answer.")
  }
  if (!payload.ok) {
    throw new Error(payload.error || "The local file service refused the request.")
  }
  return payload.value as T
}

export function createBrowserHost(): Host {
  const store = createRemoteStore(browserCall)
  return {
    nativeDialogs: false,
    store,
    pickDirectory: async () => {
      throw new Error(WINDOWS_DIALOG_REQUIRED)
    },
    pickMedia: async () => {
      throw new Error(WINDOWS_DIALOG_REQUIRED)
    },
    openPath: async () => {
      throw new Error(DESKTOP_WINDOW_REQUIRED)
    },
    openUrl: async (url) => {
      if (url.startsWith("mailto:")) {
        window.location.assign(url)
        return
      }
      const opened = window.open(url, "_blank", "noopener,noreferrer")
      if (!opened) throw new Error("The browser blocked that link.")
    },
    startInstaller: async (url) => {
      await browserCall({ op: "startInstaller", url })
    },
    setupLocal: async (pace, onProgress) => {
      onProgress?.({
        phase: "model",
        label: "Setting up local notes…",
        received: 0,
        total: null,
      })
      return store.setupLocal(pace)
    },
  }
}
