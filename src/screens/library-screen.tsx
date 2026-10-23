import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { formatWhen } from "../domain/text"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { NameDialog } from "../components/name-dialog"

export function LibraryScreen() {
  const { courses, addCourse, refreshLibrary } = useLibrary()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-4xl tracking-tight">Courses</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {courses.length === 0
              ? "A folder for each class."
              : courses.length === 1
                ? "1 class"
                : `${courses.length} classes`}
          </p>
        </div>
        <Button type="button" onClick={() => setOpen(true)}>
          New course
        </Button>
      </div>
      {courses.length === 0 ? (
        <div className="mt-16 max-w-md">
          <h2 className="font-serif text-2xl">No courses yet</h2>
          <p className="mt-3 leading-relaxed text-muted-foreground">
            Create a course for a class. Notes from that class stay in its folder.
          </p>
        </div>
      ) : (
        <ul className="mt-10 border-t border-border">
          {courses.map((course) => (
            <li key={course.id} className="border-b border-border">
              <Link
                to={`/courses/${course.id}`}
                className="group block py-5 transition-colors hover:bg-accent/40"
              >
                <span className="block font-serif text-2xl tracking-tight group-hover:text-primary">
                  {course.name}
                </span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {course.noteCount === 0
                    ? "No notes yet"
                    : course.noteCount === 1
                      ? "1 note"
                      : `${course.noteCount} notes`}
                  {" · "}
                  {course.moduleCount === 0
                    ? "No modules"
                    : course.moduleCount === 1
                      ? "1 module"
                      : `${course.moduleCount} modules`}
                  {" · "}
                  {formatWhen(course.updatedAt)}
                </span>
                {course.folderName !== course.name ? (
                  <span className="mt-1 block font-mono text-xs text-muted-foreground">
                    Folder {course.folderName}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <NameDialog
        open={open}
        title="New course"
        description="A course is a folder in your home directory."
        initial=""
        confirmLabel="Create course"
        onOpenChange={setOpen}
        onSubmit={async (name) => {
          await addCourse(name)
        }}
      />
    </div>
  )
}
