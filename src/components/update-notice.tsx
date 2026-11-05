import { X } from "lucide-react"
import { useEffect, useState } from "react"
import { messageOf } from "../domain/errors"
import { newerInstaller, RELEASES_URL, type InstallerUpdate } from "../domain/updates"
import { useHost } from "../platform/host"
import { Button } from "@/components/ui/button"

/** Lives for this process. A restart reads GitHub again. */
let dismissedUntilRestart = false

export function UpdateNotice() {
  const host = useHost()
  const [update, setUpdate] = useState<InstallerUpdate | null>(null)
  const [dismissed, setDismissed] = useState(dismissedUntilRestart)
  const [phase, setPhase] = useState<"ready" | "downloading" | "started">("ready")
  const [startError, setStartError] = useState<string | null>(null)

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
      } catch {
        // A missed check stays quiet. Startup does not wait on GitHub.
      }
    })()
    return () => controller.abort()
  }, [])

  if (!update) return null
  if (dismissed) return null

  function dismiss() {
    dismissedUntilRestart = true
    setDismissed(true)
  }

  async function confirmInstall() {
    if (!update || phase !== "ready") return
    setPhase("downloading")
    setStartError(null)
    try {
      await host.startInstaller(update.downloadUrl)
      setPhase("started")
    } catch (err: unknown) {
      setPhase("ready")
      setStartError(messageOf(err))
    }
  }

  const status =
    phase === "downloading"
      ? `Downloading the Create Notes ${update.version} installer.`
      : phase === "started"
        ? `The Create Notes ${update.version} installer is starting.`
        : `Create Notes ${update.version} is available.`

  return (
    <div className="border-b border-border bg-card px-4 py-3">
      <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <p role="status" className="min-w-0 text-sm">
          {status}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            className="w-fit shrink-0"
            aria-label={`Download and start the Create Notes ${update.version} installer`}
            disabled={phase !== "ready"}
            onClick={() => {
              void confirmInstall()
            }}
          >
            {phase === "downloading" ? "Downloading…" : phase === "started" ? "Installer started" : "Start installer"}
          </Button>
          <button
            type="button"
            aria-label="Dismiss the update notice"
            className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={dismiss}
          >
            <X className="size-6" aria-hidden="true" />
          </button>
        </div>
      </div>
      {startError ? (
        <p role="alert" className="mx-auto mt-2 w-full max-w-4xl text-sm text-destructive">
          {startError}
        </p>
      ) : null}
    </div>
  )
}
