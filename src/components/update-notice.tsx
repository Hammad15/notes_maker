import { useEffect, useState } from "react"
import { newerInstaller, RELEASES_URL, type InstallerUpdate } from "../domain/updates"
import { useHost } from "../platform/host"
import { Button } from "@/components/ui/button"

let openedDownload: string | null = null

export function UpdateNotice() {
  const host = useHost()
  const [update, setUpdate] = useState<InstallerUpdate | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

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
    <div className="border-b border-border bg-card px-4 py-3">
      <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <p role="status" className="min-w-0 text-sm">
          Create Notes {update.version} is available. The installer download is opening.
        </p>
        <Button
          type="button"
          className="w-fit shrink-0"
          aria-label={`Open the download of Create Notes ${update.version}`}
          onClick={() => {
            setOpenError(null)
            void host.openUrl(update.downloadUrl).catch((err: unknown) => {
              setOpenError(err instanceof Error ? err.message : "Could not open the download.")
            })
          }}
        >
          Open the download
        </Button>
      </div>
      {openError ? (
        <p role="alert" className="mx-auto mt-2 w-full max-w-4xl text-sm text-destructive">
          {openError}
        </p>
      ) : null}
    </div>
  )
}
