import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/app-shell"
import { UpdateNotice } from "./components/update-notice"
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
  let screen = <OpeningScreen />
  if (ready && error && !settings.homeDirectory) {
    screen = <StartupError message={error} onRetry={() => void reload().catch(() => undefined)} />
  } else if (ready && (!settings.homeDirectory || homeMissing)) {
    screen = <SetupScreen missing={homeMissing} />
  } else if (ready) {
    screen = (
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
  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      {ready ? <UpdateNotice /> : null}
      <div className="min-h-0 min-w-0 flex-1">{screen}</div>
    </div>
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
