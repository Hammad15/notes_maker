import { useState } from "react"
import { messageOf } from "../domain/errors"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"

export function OpeningScreen() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1 bg-primary" />
      <div className="mx-auto flex min-h-[calc(100vh-4px)] max-w-lg flex-col justify-center px-6">
        <p className="font-serif text-3xl">Opening Study Notes…</p>
      </div>
    </div>
  )
}

export function StartupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1 bg-primary" />
      <div className="mx-auto flex min-h-[calc(100vh-4px)] max-w-lg flex-col justify-center gap-4 px-6">
        <h1 className="font-serif text-3xl">Study Notes could not open</h1>
        <p className="text-muted-foreground">{message}</p>
        <Button type="button" className="w-fit" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

export function SetupScreen({ missing }: { missing: boolean }) {
  const host = useHost()
  const { chooseHome } = useLibrary()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function choose(path: string) {
    setBusy(true)
    setError(null)
    try {
      await chooseHome(path)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function browse() {
    setError(null)
    if (!host.nativeDialogs) {
      setError(WINDOWS_DIALOG_REQUIRED)
      return
    }
    try {
      const picked = await host.pickDirectory()
      if (picked) await choose(picked)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1 bg-primary" />
      <div className="mx-auto flex min-h-[calc(100vh-4px)] max-w-lg flex-col justify-center px-6 py-16">
        <p className="text-xs font-medium tracking-[0.18em] text-primary uppercase">Study Notes</p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight">Choose a home folder</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Courses are folders in one place on this computer. Study Notes remembers the location.
        </p>
        {missing ? (
          <p className="mt-4 text-sm text-destructive">
            The home folder is no longer there. Choose a folder to keep courses in.
          </p>
        ) : null}
        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
        <Button type="button" size="lg" className="mt-8 w-fit" disabled={busy} onClick={() => void browse()}>
          {busy ? "Saving…" : "Choose folder"}
        </Button>
      </div>
    </div>
  )
}
