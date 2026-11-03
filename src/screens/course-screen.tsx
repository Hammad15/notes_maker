import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Trash2 } from "lucide-react"
import { messageOf } from "../domain/errors"
import { noteListTitle } from "../domain/noteTitle"
import { useHost } from "../platform/host"
import {
  createModule,
  deleteNote,
  getCourse,
  renameCourse,
  renameModule,
  type CourseDetail,
  type NoteInfo,
} from "../services/library"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { InlineName } from "../components/inline-name"
import { MakeNotesDialog } from "../components/make-notes-dialog"
import { NameDialog } from "../components/name-dialog"

export function CourseScreen() {
  const { courseId = "" } = useParams()
  const host = useHost()
  const { store } = host
  const { settings, revision, refreshLibrary } = useLibrary()
  const [course, setCourse] = useState<CourseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [moduleOpen, setModuleOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const home = settings.homeDirectory
    if (!home || !courseId) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const detail = await getCourse(store, home, courseId)
        if (!cancelled) {
          setCourse(detail)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(messageOf(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [courseId, revision, settings.homeDirectory, store])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [courseId])

  if (loading && !course) {
    return <p className="text-muted-foreground">Reading the course…</p>
  }
  if (error && !course) {
    return (
      <div className="mx-auto max-w-md">
        <h1 className="font-serif text-3xl">Course unavailable</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
      </div>
    )
  }
  if (!course || !settings.homeDirectory) return null

  const current = course
  const home = settings.homeDirectory
  const courseNotes = current.notes.filter((note) => note.moduleId == null)

  async function reload() {
    setCourse(await getCourse(store, home, current.id))
  }

  async function removeNote(note: NoteInfo) {
    const active = document.activeElement
    setError(null)
    setDeletingId(note.id)
    try {
      await deleteNote(store, home, current.id, note.id)
      await reload()
      if (active instanceof HTMLElement && !active.isConnected) document.getElementById("make-notes")?.focus()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <h1 className="min-w-0 flex-1">
          <InlineName
            value={current.name}
            label="Course name"
            className="font-serif text-4xl tracking-tight"
            onRename={async (name) => {
              const next = await renameCourse(store, home, current.id, name)
              setCourse(next)
              await refreshLibrary()
            }}
          />
        </h1>
        <Button
          id="make-notes"
          type="button"
          data-tour="make-notes"
          className="w-full sm:w-auto"
          onClick={() => setMakeOpen(true)}
        >
          Make notes
        </Button>
      </div>
      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {courseNotes.length === 0 && current.modules.length === 0 ? (
        <div className="mt-8">
          <h2 className="font-serif text-xl">No notes yet</h2>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            Make notes from a video or audio file already on this computer. The file stays where it is.
          </p>
        </div>
      ) : (
        <NoteList
          courseId={current.id}
          notes={current.notes}
          visible={courseNotes}
          deletingId={deletingId}
          onOpenPdf={(note) => {
            void host.openPath(note.pdfPath).catch((err: unknown) => setError(messageOf(err)))
          }}
          onDelete={(note) => void removeNote(note)}
        />
      )}
      <section className="mt-10">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-serif text-2xl">Modules</h2>
          <Button type="button" variant="outline" size="sm" aria-label="New module" onClick={() => setModuleOpen(true)}>
            New
          </Button>
        </div>
        {current.modules.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            A module is a folder inside the course, for a unit or topic. Notes can stay on the course itself.
          </p>
        ) : (
          <div className="mt-6 grid gap-8">
            {current.modules.map((module) => {
              const notes = current.notes.filter((note) => note.moduleId === module.id)
              return (
                <section key={module.id}>
                  <h3 className="border-b border-border pb-2">
                    <InlineName
                      value={module.name}
                      label={`Rename ${module.name}`}
                      className="font-serif text-xl"
                      onRename={async (name) => {
                        setCourse(await renameModule(store, home, current.id, module.id, name))
                        await refreshLibrary()
                      }}
                    />
                  </h3>
                  {notes.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No notes in this module yet.</p>
                  ) : (
                    <NoteList
                      courseId={current.id}
                      notes={current.notes}
                      visible={notes}
                      deletingId={deletingId}
                      onOpenPdf={(note) => {
                        void host.openPath(note.pdfPath).catch((err: unknown) => setError(messageOf(err)))
                      }}
                      onDelete={(note) => void removeNote(note)}
                    />
                  )}
                </section>
              )
            })}
          </div>
        )}
      </section>
      <MakeNotesDialog
        open={makeOpen}
        courseId={current.id}
        courseName={current.name}
        modules={current.modules}
        onOpenChange={setMakeOpen}
      />
      <NameDialog
        open={moduleOpen}
        title="New module"
        description="A module is a subfolder of this course."
        initial=""
        confirmLabel="Create module"
        onOpenChange={setModuleOpen}
        onSubmit={async (name) => {
          await createModule(store, home, current.id, name)
          await reload()
        }}
      />
    </div>
  )
}

function NoteList({
  courseId,
  notes,
  visible,
  deletingId,
  onOpenPdf,
  onDelete,
}: {
  courseId: string
  notes: NoteInfo[]
  visible: NoteInfo[]
  deletingId: string | null
  onOpenPdf: (note: NoteInfo) => void
  onDelete: (note: NoteInfo) => void
}) {
  if (visible.length === 0) return null
  return (
    <ul className="mt-4">
      {visible.map((note) => {
        const title = noteListTitle(note, notes)
        return (
          <li key={note.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-3">
            <Link
              to={`/courses/${courseId}/notes/${note.id}`}
              className="group block min-w-0 flex-1 basis-full rounded-sm py-1 sm:basis-auto"
            >
              <span className="block truncate font-serif text-xl group-hover:text-primary-text">{title}</span>
            </Link>
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              aria-label={`Open PDF for ${title}`}
              disabled={!note.pdfExists}
              onClick={() => onOpenPdf(note)}
            >
              Open PDF
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${title}`}
              disabled={deletingId === note.id}
              onClick={() => onDelete(note)}
            >
              <Trash2 />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
