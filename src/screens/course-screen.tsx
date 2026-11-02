import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { messageOf } from "../domain/errors"
import { formatWhen } from "../domain/text"
import { useHost } from "../platform/host"
import {
  createModule,
  getCourse,
  renameCourse,
  renameModule,
  type CourseDetail,
} from "../services/library"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { MakeNotesDialog } from "../components/make-notes-dialog"
import { NameDialog } from "../components/name-dialog"

export function CourseScreen() {
  const { courseId = "" } = useParams()
  const host = useHost()
  const { store } = host
  const { settings, revision } = useLibrary()
  const [course, setCourse] = useState<CourseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useSearchParams()
  const requestedModule = params.get("module")
  const [makeOpen, setMakeOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [moduleOpen, setModuleOpen] = useState(false)
  const [moduleRename, setModuleRename] = useState<string | null>(null)

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
      <div className="max-w-md">
        <h1 className="font-serif text-3xl">Course unavailable</h1>
        <p className="mt-3 text-muted-foreground">{error}</p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/">Back to courses</Link>
        </Button>
      </div>
    )
  }
  if (!course || !settings.homeDirectory) return null

  const filter =
    requestedModule && course.modules.some((module) => module.id === requestedModule)
      ? requestedModule
      : "all"
  const visible = course.notes.filter((note) => filter === "all" || note.moduleId === filter)
  const activeModule = course.modules.find((module) => module.id === filter)

  function showModule(moduleId: string | null) {
    if (!moduleId) setParams({})
    else setParams({ module: moduleId })
  }
  const renaming = course.modules.find((module) => module.id === moduleRename) ?? null

  return (
    <div>
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        Courses
      </Link>
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">{course.name}</h1>
          <button
            type="button"
            className="mt-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => setRenameOpen(true)}
          >
            Rename
          </button>
        </div>
        <Button type="button" className="w-full sm:w-auto" onClick={() => setMakeOpen(true)}>
          Make notes
        </Button>
      </div>
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-2xl">{activeModule ? activeModule.name : "Notes"}</h2>
            {filter !== "all" ? (
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => showModule(null)}
              >
                All notes
              </button>
            ) : null}
          </div>
          {visible.length === 0 ? (
            <div className="mt-8 max-w-md">
              <h3 className="font-serif text-xl">
                {activeModule ? `No notes in ${activeModule.name} yet` : "No notes yet"}
              </h3>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                Make notes from a video or audio file already on this computer. The file stays where it is.
              </p>
            </div>
          ) : (
            <ul className="mt-4 border-t border-border">
              {visible.map((note) => (
                <li key={note.id} className="flex items-center gap-3 border-b border-border">
                  <Link
                    to={`/courses/${course.id}/notes/${note.id}`}
                    className="group block min-w-0 flex-1 py-4 hover:bg-accent/40"
                  >
                    <span className="block font-serif text-xl group-hover:text-primary">{note.title}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {note.moduleName ?? "This course"}
                      {" · "}
                      {formatWhen(note.updatedAt)}
                      {" · "}
                      {note.pdfExists ? "PDF saved" : "PDF missing"}
                    </span>
                  </Link>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={!note.pdfExists}
                    onClick={() => {
                      void host.openPath(note.pdfPath).catch((err: unknown) => setError(messageOf(err)))
                    }}
                  >
                    Open PDF
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-serif text-2xl">Modules</h2>
            <Button type="button" variant="outline" size="sm" onClick={() => setModuleOpen(true)}>
              New
            </Button>
          </div>
          {course.modules.length === 0 ? (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              A module is a folder inside the course, for a unit or topic. Notes can stay on the course itself.
            </p>
          ) : (
            <ul className="mt-4">
              {course.modules.map((module) => (
                <li key={module.id} className="border-b border-border py-3">
                  <button
                    type="button"
                    className={`block text-left text-sm ${filter === module.id ? "text-primary" : "hover:text-primary"}`}
                    onClick={() => showModule(module.id)}
                  >
                    {module.name}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {module.noteCount === 1 ? "1 note" : `${module.noteCount} notes`}
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
                    onClick={() => setModuleRename(module.id)}
                  >
                    Rename
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      <MakeNotesDialog
        open={makeOpen}
        courseId={course.id}
        courseName={course.name}
        modules={course.modules}
        onOpenChange={setMakeOpen}
      />
      <NameDialog
        open={renameOpen}
        title="Rename course"
        description="The folder name follows the course. Notes keep their id."
        initial={course.name}
        confirmLabel="Rename"
        onOpenChange={setRenameOpen}
        onSubmit={async (name) => {
          const next = await renameCourse(store, settings.homeDirectory!, course.id, name)
          setCourse(next)
        }}
      />
      <NameDialog
        open={moduleOpen}
        title="New module"
        description="A module is a subfolder of this course."
        initial=""
        confirmLabel="Create module"
        onOpenChange={setModuleOpen}
        onSubmit={async (name) => {
          await createModule(store, settings.homeDirectory!, course.id, name)
          setCourse(await getCourse(store, settings.homeDirectory!, course.id))
        }}
      />
      <NameDialog
        open={renaming !== null}
        title="Rename module"
        description="The module folder follows this name."
        initial={renaming?.name ?? ""}
        confirmLabel="Rename"
        onOpenChange={(next) => {
          if (!next) setModuleRename(null)
        }}
        onSubmit={async (name) => {
          if (!renaming) return
          const next = await renameModule(
            store,
            settings.homeDirectory!,
            course.id,
            renaming.id,
            name,
          )
          setCourse(next)
          setModuleRename(null)
        }}
      />
    </div>
  )
}
