import { NavLink } from "react-router-dom"
import { MISSING_GROQ_KEY } from "../domain/errors"
import { barPercent, localJobMessage, speechModel, type SpeechPace } from "../domain/localSpeech"
import { truncateMiddle } from "../domain/paths"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useState } from "react"

function setupPercent(received: number, total: number | null): string {
  if (!total || total <= 0) return ""
  return ` ${Math.min(100, Math.round((received / total) * 100))}%`
}

function ProviderSwitch() {
  const { settings, setProvider, setSpeechPace, setGroqKey, localStatus, setupProgress, setupError, setupLocal } =
    useLibrary()
  const [error, setError] = useState<string | null>(null)
  const localReady = localStatus?.ready === true
  const keyMissing = settings.groqApiKey.trim().length === 0
  const pace = settings.speechPace
  return (
    <fieldset className="grid gap-2">
      <legend className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Notes
      </legend>
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
        {(["local", "cloud"] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={settings.provider === id}
            className={`rounded-md px-2 py-1.5 text-sm ${
              settings.provider === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => {
              setError(null)
              void setProvider(id).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not save the setting.")
              })
            }}
          >
            {id === "local" ? "Local" : "Cloud"}
          </button>
        ))}
      </div>
      {settings.provider === "local" ? (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {localReady
              ? `On this computer, using ${speechModel(pace).name}. Those words become study notes.`
              : "On this computer. One button downloads the speech model for the speed you choose."}
          </p>
          <div className="grid gap-1">
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Speed</p>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {(["faster", "clearer"] as const satisfies readonly SpeechPace[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={pace === id}
                  disabled={setupProgress !== null}
                  className={`rounded-md px-2 py-1.5 text-sm ${
                    pace === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => {
                    setError(null)
                    void setSpeechPace(id).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : "Could not save the speed.")
                    })
                  }}
                >
                  {id === "faster" ? "Faster" : "Clearer"}
                </button>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Chosen once. Faster uses the tiny English model and more processor cores. Clearer keeps the base English
              model and fewer cores.
            </p>
          </div>
        </>
      ) : (
        <div className="grid gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Groq transcribes the recording and writes the study notes. This developer setting is temporary.
          </p>
          <Label htmlFor="groq-api-key">Groq API key</Label>
          <Input
            id="groq-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.groqApiKey}
            placeholder="Paste a Groq key"
            onChange={(event) => {
              setError(null)
              void setGroqKey(event.target.value).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not save the key.")
              })
            }}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {keyMissing
              ? MISSING_GROQ_KEY
              : "The key stays in Study Notes settings on this computer. It is not saved in the course."}
          </p>
        </div>
      )}
      {settings.provider === "local" && localStatus && !localReady ? (
        <Button
          type="button"
          className="w-full"
          disabled={setupProgress !== null}
          aria-busy={setupProgress !== null}
          onClick={() => void setupLocal()}
        >
          {setupProgress ? "Setting up…" : "Set up local notes"}
        </Button>
      ) : null}
      {settings.provider === "local" && !localStatus ? (
        <p className="text-xs text-muted-foreground">Checking local notes…</p>
      ) : null}
      {setupProgress ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {setupProgress.label}
          {setupPercent(setupProgress.received, setupProgress.total)}
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {setupError ? <p className="text-xs text-destructive">{setupError}</p> : null}
    </fieldset>
  )
}

function JobBanner() {
  const { jobs, dismissJob } = useLibrary()
  if (jobs.length === 0) return null
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-2 px-5 pt-5 md:px-10">
      {jobs.map((job) =>
        job.status === "running" ? (
          <div
            key={job.id}
            role="status"
            aria-live="polite"
            className="rounded-lg border border-border bg-card px-4 py-3 text-sm"
          >
            <p>{localJobMessage(job.label, job.progress)}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary"
                style={{ width: `${barPercent(job.progress) ?? 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              This window stays open until the notes and PDF are saved.
            </p>
          </div>
        ) : (
          <div
            key={job.id}
            role="alert"
            className="flex items-start justify-between gap-4 rounded-lg border border-destructive/40 bg-card px-4 py-3 text-sm"
          >
            <p>
              Could not write notes for {job.label}. {job.error}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => dismissJob(job.id)}>
              Dismiss
            </Button>
          </div>
        ),
      )}
    </div>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { settings, chooseHome } = useLibrary()
  const host = useHost()
  const [homeError, setHomeError] = useState<string | null>(null)
  const home = settings.homeDirectory

  async function changeHome() {
    setHomeError(null)
    if (!host.nativeDialogs) {
      setHomeError(WINDOWS_DIALOG_REQUIRED)
      return
    }
    try {
      const picked = await host.pickDirectory()
      if (!picked) return
      await chooseHome(picked)
    } catch (err) {
      setHomeError(err instanceof Error ? err.message : "Could not use that folder.")
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1 bg-primary" />
      <div className="md:grid md:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-6 border-b border-sidebar-border bg-sidebar px-5 py-5 md:min-h-[calc(100vh-4px)] md:border-r md:border-b-0">
          <div>
            <div className="flex items-center gap-2">
              <img src="/favicon.svg" alt="" width={28} height={28} className="size-7" />
              <p className="font-serif text-xl tracking-tight">Study Notes</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">One computer, one student.</p>
          </div>
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `text-sm ${isActive ? "text-primary" : "text-foreground hover:text-primary"}`
            }
          >
            Courses
          </NavLink>
          <div className="grid gap-2">
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
              Home
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground" title={home ?? ""}>
              {home ? truncateMiddle(home, 32) : "No folder yet"}
            </p>
            <button
              type="button"
              className="w-fit text-left text-xs text-foreground underline-offset-4 hover:underline"
              onClick={() => void changeHome()}
            >
              Change home folder
            </button>
            {homeError ? <p className="text-xs text-destructive">{homeError}</p> : null}
          </div>
          <div className="md:mt-auto">
            <ProviderSwitch />
          </div>
        </aside>
        <div className="min-w-0">
          <JobBanner />
          <div className="mx-auto w-full max-w-4xl px-5 py-8 md:px-10 md:py-10">{children}</div>
        </div>
      </div>
    </div>
  )
}
