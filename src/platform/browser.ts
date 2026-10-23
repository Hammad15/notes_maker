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
  return {
    nativeDialogs: false,
    store: createRemoteStore(browserCall),
    pickDirectory: async () => {
      throw new Error(WINDOWS_DIALOG_REQUIRED)
    },
    pickMedia: async () => {
      throw new Error(WINDOWS_DIALOG_REQUIRED)
    },
    openPath: async () => {
      throw new Error(DESKTOP_WINDOW_REQUIRED)
    },
  }
}
