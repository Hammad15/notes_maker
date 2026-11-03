import { useEffect, useState } from "react"
import { newerInstaller, RELEASES_URL, type InstallerUpdate } from "../domain/updates"
import { useHost } from "../platform/host"
import { Button } from "@/components/ui/button"

let openedDownload: string | null = null

export function UpdateNotice() {
  const host = useHost()
  const [update, setUpdate] = useState<InstallerUpdate | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(RELEASES_URL, {
          signal: controller.signal,
          headers: { Accept: "application/vnd.github+json" },
        })
        if (!response.ok) return
        const found = newerInstaller(await response.json())
        if (!found || controller.signal.aborted) return
        setUpdate(found)
        if (openedDownload === found.downloadUrl) return
        openedDownload = found.downloadUrl
        void host.openUrl(found.downloadUrl).catch(() => undefined)
      } catch {
        // A missed check stays quiet. Startup does not wait on GitHub.
      }
    })()
    return () => controller.abort()
  }, [host])

  if (!update) return null
  return (
    <div role="status" aria-live="polite" className="border-b border-border bg-card px-4 py-3">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm">
          Create Notes {update.version} is available. The installer download is opening.
        </p>
        <Button type="button" className="w-fit" onClick={() => void host.openUrl(update.downloadUrl).catch(() => undefined)}>
          Open the download
        </Button>
      </div>
    </div>
  )
}
