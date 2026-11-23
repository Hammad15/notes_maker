import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowDown, ArrowUp, ChevronDown, Trash2 } from "lucide-react"
import { messageOf } from "../domain/errors"
import { noteListTitle } from "../domain/noteTitle"
import {
  directionFor,
  nextNoteSort,
  sortModules,
  sortNotes,
  sortOptionName,
  type NoteSortDirection,
  type NoteSortKey,
  type NoteSortSettings,
} from "../domain/noteSort"
import { useHost } from "../platform/host"
import {
  createModule,
  deleteNote,
  generateNotePdf,
  getCourse,
  renameCourse,
  renameModule,
  type CourseDetail,
  type NoteInfo,
} from "../services/library"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { InlineName } from "../components/inline-name"
import { NotePdfButton, openOrGenerateNotePdf } from "../components/note-pdf-button"
import { MakeNotesDialog } from "../components/make-notes-dialog"
import { NameDialog } from "../components/name-dialog"

export function CourseScreen() {
  const { courseId = "" } = useParams()
  const host = useHost()
  const { store } = host
  const { settings, revision, refreshLibrary, setNoteSort } = useLibrary()
  const [course, setCourse] = useState<CourseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [moduleOpen, setModuleOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pdfBusyIds, setPdfBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const pdfBusyRef = useRef(new Set<string>())

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
  const sort: NoteSortSettings = {
    noteSort: settings.noteSort,
    noteSortName: settings.noteSortName,
    noteSortDate: settings.noteSortDate,
  }
  const courseNotes = sortNotes(
    current.notes.filter((note) => note.moduleId == null),
    current.notes,
    sort.noteSort,
    directionFor(sort, sort.noteSort),
  )

  async function reload() {
    setCourse(await getCourse(store, home, current.id))
  }

  function setPdfBusy(id: string, busy: boolean) {
    setPdfBusyIds((current) => {
      const next = new Set(current)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function onPdf(note: NoteInfo) {
    if (pdfBusyRef.current.has(note.id)) return
    setError(null)
    const generating = !note.pdfExists
    if (generating) {
      pdfBusyRef.current.add(note.id)
      setPdfBusy(note.id, true)
    }
    try {
      await openOrGenerateNotePdf({
        pdfExists: note.pdfExists,
        pdfPath: note.pdfPath,
        generate: async () => {
          const next = await generateNotePdf(store, home, current.id, note.id)
          setCourse((shown) => {
            if (!shown) return shown
            return {
              ...shown,
              notes: shown.notes.map((item) =>
                item.id === next.id ? { ...item, pdfExists: next.pdfExists, pdfPath: next.pdfPath } : item,
              ),
            }
          })
          return next
        },
        openPath: (path) => host.openPath(path),
      })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      if (generating) {
        pdfBusyRef.current.delete(note.id)
        setPdfBusy(note.id, false)
      }
    }
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
          Create notes
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
            Create notes from a video or audio file on this computer. The file stays where it is.
          </p>
        </div>
      ) : (
        <NoteList
          courseId={current.id}
          notes={current.notes}
          visible={courseNotes}
          deletingId={deletingId}
          pdfBusyIds={pdfBusyIds}
          onPdf={(note) => void onPdf(note)}
          onDelete={(note) => void removeNote(note)}
        />
      )}
      <section className="mt-10">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="font-serif text-2xl">Modules</h2>
            {current.notes.length > 0 ? (
              <NoteSortMenu
                sort={sort}
                onChoose={(key) => {
                  void setNoteSort(nextNoteSort(sort, key)).catch((err: unknown) => setError(messageOf(err)))
                }}
              />
            ) : null}
          </div>
          <Button type="button" variant="outline" size="sm" aria-label="New module" onClick={() => setModuleOpen(true)}>
            New
          </Button>
        </div>
        {current.modules.length === 0 ? (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            A module is a folder for a unit or topic. Notes can also stay on the course.
          </p>
        ) : (
          <div className="mt-6 grid gap-8">
            {sortModules(current.modules, current.notes, sort.noteSort, directionFor(sort, sort.noteSort)).map((module) => {
              const notes = sortNotes(
                current.notes.filter((note) => note.moduleId === module.id),
                current.notes,
                sort.noteSort,
                directionFor(sort, sort.noteSort),
              )
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
                      pdfBusyIds={pdfBusyIds}
                      onPdf={(note) => void onPdf(note)}
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

function NoteSortMenu({
  sort,
  onChoose,
}: {
  sort: NoteSortSettings
  onChoose: (key: NoteSortKey) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])
  const active = sort.noteSort
  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Sort notes"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="note-sort-menu"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {active === "name" ? "Name" : "Date"}
        <SortArrow direction={directionFor(sort, active)} className="size-3.5" />
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Button>
      {open ? (
        <div
          id="note-sort-menu"
          role="menu"
          aria-label="Sort notes"
          className="absolute right-0 z-20 mt-1 min-w-36 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {(["name", "date"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              aria-label={sortOptionName(sort, key)}
              onClick={() => {
                onChoose(key)
                setOpen(false)
              }}
            >
              <span>{key === "name" ? "Name" : "Date"}</span>
              {sort.noteSort === key ? (
                <SortArrow direction={directionFor(sort, key)} />
              ) : (
                <span className="size-4" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SortArrow({ direction, className = "size-4" }: { direction: NoteSortDirection; className?: string }) {
  const Icon = direction === "asc" ? ArrowUp : ArrowDown
  return <Icon className={className} aria-hidden="true" />
}

function NoteList({
  courseId,
  notes,
  visible,
  deletingId,
  pdfBusyIds,
  onPdf,
  onDelete,
}: {
  courseId: string
  notes: NoteInfo[]
  visible: NoteInfo[]
  deletingId: string | null
  pdfBusyIds: ReadonlySet<string>
  onPdf: (note: NoteInfo) => void
  onDelete: (note: NoteInfo) => void
}) {
  if (visible.length === 0) return null
  return (
    <ul className="mt-4">
      {visible.map((note) => {
        const title = noteListTitle(note, notes)
        const busy = pdfBusyIds.has(note.id)
        return (
          <li key={note.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <Link
              to={`/courses/${courseId}/notes/${note.id}`}
              className="group block min-w-0 flex-1 basis-full rounded-sm py-1 sm:basis-auto"
            >
              <span className="block truncate font-serif text-xl group-hover:text-primary-text">{title}</span>
            </Link>
            <NotePdfButton title={title} busy={busy} pdfExists={note.pdfExists} onClick={() => onPdf(note)} />
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
