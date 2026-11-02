import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/app-shell"
import { HostProvider } from "./platform/host"
import { CourseScreen } from "./screens/course-screen"
import { NoteScreen } from "./screens/note-screen"
import { OpeningScreen, SetupScreen, StartupError } from "./screens/setup-screen"
import { LibraryProvider, useLibrary } from "./state/library-context"

function CourseHome() {
  const { courses } = useLibrary()
  if (courses.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-serif text-3xl tracking-tight">No courses yet</h1>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          Use the plus button to add a class. Notes from that class stay in its folder.
        </p>
      </div>
    )
  }
  return <Navigate to={`/courses/${courses[0].id}`} replace />
}

function Frame() {
  const { ready, error, homeMissing, settings, reload } = useLibrary()
  if (!ready) return <OpeningScreen />
  if (error && !settings.homeDirectory) {
    return <StartupError message={error} onRetry={() => void reload().catch(() => undefined)} />
  }
  if (!settings.homeDirectory || homeMissing) return <SetupScreen missing={homeMissing} />
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<CourseHome />} />
        <Route path="/courses/:courseId" element={<CourseScreen />} />
        <Route path="/courses/:courseId/notes/:noteId" element={<NoteScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

export default function App() {
  return (
    <HostProvider>
      <LibraryProvider>
        <BrowserRouter>
          <Frame />
        </BrowserRouter>
      </LibraryProvider>
    </HostProvider>
  )
}
