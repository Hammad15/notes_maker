import { NavLink, useNavigate } from "react-router-dom"
import { Plus } from "lucide-react"
import { CLOUD_NOTES_UNAVAILABLE } from "../domain/errors"
import { barPercent, localJobMessage, NOTES_MODEL, speechModel, type SpeechPace } from "../domain/localSpeech"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import { FeedbackDialog } from "./feedback-dialog"
import { FirstRunTour } from "./first-run-tour"
import { NameDialog } from "./name-dialog"

function setupPercent(received: number, total: number | null): string {
  if (!total || total <= 0) return ""
  return ` ${Math.min(100, Math.round((received / total) * 100))}%`
}

function ProviderSwitch() {
  const { settings, setProvider, setSpeechPace, localStatus, setupProgress, setupError, setupLocal } = useLibrary()
  const [error, setError] = useState<string | null>(null)
  const localReady = localStatus?.ready === true
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
              ? `On this computer, using ${speechModel(pace).name}. Study notes are written by ${NOTES_MODEL.name}.`
              : "On this computer. One button downloads the speech model and the notes model."}
          </p>
          <fieldset className="grid gap-1">
            <legend className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Speed</legend>
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
          </fieldset>
        </>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">{CLOUD_NOTES_UNAVAILABLE}</p>
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
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
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
    <div className="h-full min-h-0 bg-background text-foreground">
      <div className="h-full min-h-0 overflow-y-auto md:grid md:grid-cols-[minmax(0,250px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:overflow-hidden">
        <aside
          aria-label="Create Notes"
          className="flex min-w-0 flex-col gap-6 scroll-p-3 border-b border-sidebar-border bg-sidebar px-5 py-5 md:min-h-0 md:overflow-y-auto md:border-r md:border-b-0"
        >
          <div>
            <p className="font-serif text-xl tracking-tight">Create Notes</p>
            <p className="mt-1 text-xs text-muted-foreground">One computer, one student.</p>
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
