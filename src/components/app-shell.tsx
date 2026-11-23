import { NavLink, useNavigate } from "react-router-dom"
import { Plus, X } from "lucide-react"
import { CANCEL_NOTE_HELP } from "../domain/cancelNotes"
import { GROQ_KEY_REQUIRED, messageOf } from "../domain/errors"
import { groqApiKey } from "../domain/groq"
import { barPercent, formatByteSize, localJobMessage, setupDownloadBytes, type SpeechPace } from "../domain/localSpeech"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useEffect, useState } from "react"
import { FeedbackDialog } from "./feedback-dialog"
import { FirstRunTour } from "./first-run-tour"
import { NameDialog } from "./name-dialog"

function setupPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null
  return Math.min(100, Math.round((received / total) * 100))
}

const GROQ_KEY_TIP =
  "Create a key at console.groq.com, then paste it here. It stays on this computer and is sent only to Groq."

function GroqKeyField({ describedBy, pending }: { describedBy?: string; pending?: boolean }) {
  const { groqKeySaved, saveGroqKey, clearGroqKey } = useLibrary()
  const [draft, setDraft] = useState("")
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function shownError(err: unknown): string {
    let text = messageOf(err)
    for (const secret of [draft.trim(), groqApiKey() ?? ""]) {
      if (!secret || !text.includes(secret)) continue
      text = text.split(secret).join("")
    }
    const cleaned = text.replace(/\s{2,}/g, " ").trim()
    return cleaned || "Could not save the Groq API key."
  }

  async function onSave() {
    setError(null)
    setBusy(true)
    try {
      await saveGroqKey(draft)
      setDraft("")
      setReplacing(false)
    } catch (err) {
      setError(shownError(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRemove() {
    setError(null)
    setBusy(true)
    try {
      await clearGroqKey()
      setDraft("")
      setReplacing(false)
    } catch (err) {
      setError(shownError(err))
    } finally {
      setBusy(false)
    }
  }

  const locked = !pending && groqKeySaved && !replacing
  const showField = !pending

  return (
    <div className="grid gap-2">
      <div className="relative flex items-center gap-1.5">
        <label
          htmlFor={showField ? "groq-api-key" : undefined}
          className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase"
        >
          Groq API key
        </label>
        <button
          type="button"
          className="peer inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[10px] leading-none font-serif text-muted-foreground italic outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
          aria-label="About the Groq API key"
          aria-describedby="groq-key-tip"
        >
          <span aria-hidden="true">i</span>
        </button>
        <span id="groq-key-tip" className="sr-only">
          {GROQ_KEY_TIP}
        </span>
        <p
          role="tooltip"
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-full rounded-lg border border-border bg-popover px-2.5 py-2 text-left text-xs leading-relaxed font-sans tracking-normal text-popover-foreground normal-case not-italic shadow-md peer-hover:block peer-focus:block"
        >
          {GROQ_KEY_TIP}
        </p>
      </div>
      {pending ? (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          Checking the saved key…
        </p>
      ) : (
        <Input
          id="groq-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={locked ? (groqApiKey() ?? "") : draft}
          aria-label={locked ? "Saved Groq API key" : undefined}
          aria-disabled={locked || undefined}
          aria-describedby={
            [describedBy, error ? "groq-key-error" : undefined].filter(Boolean).join(" ") || undefined
          }
          readOnly={locked}
          disabled={busy && !locked}
          className={locked ? "cursor-not-allowed bg-input/50 opacity-50 dark:bg-input/80" : undefined}
          onChange={(event) => {
            if (locked) return
            setDraft(event.target.value)
            setError(null)
          }}
        />
      )}
      {pending ? null : !locked ? (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            aria-label="Save Groq API key"
            disabled={busy}
            onClick={() => void onSave()}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          {replacing ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Cancel replacing the Groq API key"
              disabled={busy}
              onClick={() => {
                setDraft("")
                setError(null)
                setReplacing(false)
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            aria-label="Replace Groq API key"
            disabled={busy}
            onClick={() => {
              setError(null)
              setDraft("")
              setReplacing(true)
            }}
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            aria-label="Remove Groq API key"
            disabled={busy}
            onClick={() => void onRemove()}
          >
            Remove
          </Button>
        </div>
      )}
      {error ? (
        <p id="groq-key-error" className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function ProviderSwitch() {
  const {
    settings,
    setProvider,
    setSpeechPace,
    localStatus,
    setupProgress,
    setupError,
    setupLocal,
    groqReady,
    groqKeyKnown,
  } = useLibrary()
  const host = useHost()
  const [error, setError] = useState<string | null>(null)
  const [availableBytes, setAvailableBytes] = useState<number | null>(null)
  const localReady = localStatus?.ready === true
  const pace = settings.speechPace
  const setupShown = settings.provider === "local" && localStatus != null && !localReady
  const requiredBytes = localStatus ? setupDownloadBytes(localStatus.missing, pace) : 0
  const spaceShort = availableBytes != null && requiredBytes > availableBytes
  const setupRatio = setupProgress ? setupPercent(setupProgress.received, setupProgress.total) : null
  useEffect(() => {
    if (!setupShown) return
    let stopped = false
    const read = () => {
      void host
        .freeSpace()
        .then((bytes) => {
          if (!stopped && Number.isFinite(bytes) && bytes >= 0) setAvailableBytes(bytes)
        })
        .catch(() => {
          // Keep the last reading. The next pass retries while this screen is open.
        })
    }
    read()
    const timer = window.setInterval(read, 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [host, setupShown])
  return (
    <fieldset className="grid gap-2">
      <legend className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Notes
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
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
          <fieldset className="mt-3 grid gap-1">
            <legend className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Speed</legend>
            <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
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
              Faster is quicker and the notes can be rougher. Clearer is slower and the notes are better.
            </p>
          </fieldset>
      ) : (
        <div className="mt-3 grid gap-2">
          {groqKeyKnown && !groqReady ? (
            <p id="groq-key-required" className="text-xs leading-relaxed text-muted-foreground">
              {GROQ_KEY_REQUIRED}
            </p>
          ) : null}
          <GroqKeyField
            pending={!groqKeyKnown}
            describedBy={groqKeyKnown && !groqReady ? "groq-key-required" : undefined}
          />
        </div>
      )}
      {setupShown ? (
        <>
          <Button
            type="button"
            className="w-full"
            disabled={setupProgress !== null || spaceShort}
            aria-busy={setupProgress !== null}
            onClick={() => {
              if (spaceShort) return
              void setupLocal()
            }}
          >
            {setupProgress ? "Setting up…" : "Set up local notes"}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {formatByteSize(requiredBytes)} required
            {availableBytes != null ? ` · ${formatByteSize(availableBytes)} available` : " · checking free space"}
          </p>
        </>
      ) : null}
      {settings.provider === "local" && !localStatus ? (
        <p className="text-xs text-muted-foreground">Checking local notes…</p>
      ) : null}
      {setupProgress ? (
        <div className="grid gap-2">
          <p id="local-setup-step" className="text-xs leading-relaxed text-muted-foreground">
            {setupProgress.label}
            {setupRatio != null ? ` ${setupRatio}%` : ""}
          </p>
          <div
            className="h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-labelledby="local-setup-step"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={setupRatio ?? undefined}
          >
            <div className="h-full bg-primary" style={{ width: `${setupRatio ?? 0}%` }} />
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {setupError ? (
        <p className="text-xs text-destructive" role="alert">
          {setupError}
        </p>
      ) : null}
    </fieldset>
  )
}

function JobBanner() {
  const { jobs, dismissJob, cancelJob } = useLibrary()
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
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 flex-1">{localJobMessage(job.label, job.progress)}</p>
              <button
                type="button"
                title={CANCEL_NOTE_HELP}
                aria-label={CANCEL_NOTE_HELP}
                className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => cancelJob(job.id)}
              >
                <X className="size-6" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-full bg-primary"
                style={{ width: `${barPercent(job.progress) ?? 0}%` }}
              />
            </div>
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
  const { settings, chooseHome, courses, addCourse } = useLibrary()
  const host = useHost()
  const navigate = useNavigate()
  const [homeError, setHomeError] = useState<string | null>(null)
  const [courseOpen, setCourseOpen] = useState(false)
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
    <div className="h-full min-h-0 text-foreground">
      <div className="h-full min-h-0 overflow-y-auto md:grid md:grid-cols-[minmax(0,250px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
        <aside
          aria-label="LectureText"
          className="flex min-w-0 flex-col gap-6 scroll-p-3 border-b border-sidebar-border px-5 py-5 md:min-h-0 md:overflow-y-auto md:border-r md:border-b-0"
        >
          <div>
            <p className="font-serif text-xl tracking-tight">LectureText</p>
            <div className="mt-4">
              <FeedbackDialog />
            </div>
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
              Home
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">{home ?? "No folder yet"}</p>
            <button
              type="button"
              className="w-fit rounded-sm text-left text-xs text-foreground underline-offset-4 hover:underline"
              onClick={() => void changeHome()}
            >
              Change home folder
            </button>
            {homeError ? (
              <p className="text-xs text-destructive" role="alert">
                {homeError}
              </p>
            ) : null}
          </div>
          <nav aria-labelledby="courses-heading" data-tour="courses" className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <p id="courses-heading" className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
                Courses
              </p>
              <button
                type="button"
                data-tour="new-course"
                aria-label="New course"
                className="grid size-8 place-items-center rounded-md text-primary-text hover:bg-accent"
                onClick={() => setCourseOpen(true)}
              >
                <Plus className="size-4" />
              </button>
            </div>
            {courses.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">No courses yet.</p>
            ) : (
              <ul className="grid gap-1">
                {courses.map((course) => (
                  <li key={course.id}>
                    <NavLink
                      to={`/courses/${course.id}`}
                      className={({ isActive }) =>
                        `block truncate rounded-sm text-sm ${isActive ? "font-medium text-primary-text underline underline-offset-4" : "text-foreground hover:text-primary-text"}`
                      }
                    >
                      {course.name}
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <div className="md:mt-auto">
            <ProviderSwitch />
          </div>
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 scroll-p-3 md:min-h-0 md:overflow-y-auto">
          <JobBanner />
          <div data-tour="course-page" className="mx-auto w-full min-w-0 max-w-4xl px-5 py-8 md:px-10 md:py-10">
            {children}
          </div>
        </main>
      </div>
      <NameDialog
        open={courseOpen}
        title="New course"
        description="A course is a folder in your home directory."
        initial=""
        confirmLabel="Create course"
        onOpenChange={setCourseOpen}
        onSubmit={async (name) => {
          const created = await addCourse(name)
          navigate(`/courses/${created.id}`)
        }}
      />
      <FirstRunTour />
    </div>
  )
}
