import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { StudyError, messageOf } from "../domain/errors"
import type { LocalRuntimeStatus, SetupProgress, TranscriptionProgress } from "../domain/localSpeech"
import { SPEECH_MODEL } from "../domain/localSpeech"
import { parentPath } from "../domain/paths"
import type { ProviderId } from "../domain/types"
import { useHost } from "../platform/host"
import {
  assertWritableDirectory,
  createCourse,
  listCourses,
  loadSettings,
  makeNotes,
  saveSettings,
  type CourseSummary,
  type MakeNotesInput,
  type Settings,
} from "../services/library"

export interface Job {
  id: string
  courseId: string
  label: string
  provider: ProviderId
  status: "running" | "error"
  error?: string
  progress?: TranscriptionProgress | null
}

interface LibraryState {
  ready: boolean
  error: string | null
  homeMissing: boolean
  settings: Settings
  courses: CourseSummary[]
  jobs: Job[]
  revision: number
  localStatus: LocalRuntimeStatus | null
  setupProgress: SetupProgress | null
  setupError: string | null
  setupLocal: () => Promise<void>
  reload: () => Promise<void>
  refreshLibrary: () => Promise<void>
  chooseHome: (path: string) => Promise<void>
  setProvider: (provider: ProviderId) => Promise<void>
  addCourse: (name: string) => Promise<CourseSummary>
  startMakeNotes: (input: MakeNotesInput) => void
  dismissJob: (id: string) => void
}

const LibraryContext = createContext<LibraryState | null>(null)

const EMPTY_SETTINGS: Settings = {
  homeDirectory: null,
  provider: "local",
  lastMediaDirectory: null,
}

const NOT_READY: LocalRuntimeStatus = {
  ready: false,
  model: SPEECH_MODEL.name,
  missing: ["ffmpeg", "ffprobe", "engine", "model", "config"],
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const host = useHost()
  const { store } = host
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [homeMissing, setHomeMissing] = useState(false)
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [courses, setCourses] = useState<CourseSummary[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [revision, setRevision] = useState(0)
  const [localStatus, setLocalStatus] = useState<LocalRuntimeStatus | null>(null)
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const refreshCourses = useCallback(
    async (home: string) => {
      const next = await listCourses(store, home)
      setCourses(next)
      setHomeMissing(false)
    },
    [store],
  )

  const reload = useCallback(async () => {
    setError(null)
    const loaded = await loadSettings(store)
    settingsRef.current = loaded
    setSettings(loaded)
    try {
      setLocalStatus(await store.localStatus())
    } catch {
      setLocalStatus(NOT_READY)
    }
    if (!loaded.homeDirectory) {
      setHomeMissing(false)
      setCourses([])
      return
    }
    try {
      await refreshCourses(loaded.homeDirectory)
    } catch (err) {
      if (err instanceof StudyError && err.code === "HOME_MISSING") {
        setHomeMissing(true)
        setCourses([])
        return
      }
      throw err
    }
  }, [refreshCourses, store])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await reload()
      } catch (err) {
        if (!cancelled) setError(messageOf(err))
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  const refreshLibrary = useCallback(async () => {
    const home = settingsRef.current.homeDirectory
    if (!home) return
    try {
      await refreshCourses(home)
    } catch (err) {
      if (err instanceof StudyError && err.code === "HOME_MISSING") {
        setHomeMissing(true)
        setCourses([])
      }
    }
  }, [refreshCourses])

  const chooseHome = useCallback(
    async (path: string) => {
      await assertWritableDirectory(store, path)
      const next = { ...settingsRef.current, homeDirectory: path }
      await saveSettings(store, next)
      settingsRef.current = next
      setSettings(next)
      setHomeMissing(false)
      await refreshCourses(path)
    },
    [refreshCourses, store],
  )

  const setProvider = useCallback(
    async (provider: ProviderId) => {
      const next = { ...settingsRef.current, provider }
      settingsRef.current = next
      setSettings(next)
      await saveSettings(store, next)
    },
    [store],
  )

  const addCourse = useCallback(
    async (name: string) => {
      const home = settingsRef.current.homeDirectory
      if (!home) throw new StudyError("Choose a home folder first.", "HOME")
      const course = await createCourse(store, home, name)
      await refreshCourses(home)
      return course
    },
    [refreshCourses, store],
  )

  const startMakeNotes = useCallback(
    (input: MakeNotesInput) => {
      const label = input.mediaPath.split(/[\\/]/).pop() || "recording"
      const id = crypto.randomUUID()
      setJobs((current) => [
        ...current,
        { id, courseId: input.courseId, label, provider: input.provider, status: "running" },
      ])
      void (async () => {
        const parent = parentPath(input.mediaPath)
        if (parent && parent !== settingsRef.current.lastMediaDirectory) {
          const next = { ...settingsRef.current, lastMediaDirectory: parent }
          settingsRef.current = next
          setSettings(next)
          try {
            await saveSettings(store, next)
          } catch {
            // The notes can still be filed if settings fail to update.
          }
        }
        let stopWatch = () => {}
        try {
          if (input.provider === "local" && host.watchTranscription) {
            stopWatch = await host.watchTranscription((progress) => {
              setJobs((current) =>
                current.map((job) =>
                  job.id === id && job.progress?.phase !== "writing" ? { ...job, progress } : job,
                ),
              )
            })
          }
          await makeNotes(store, input, {
            onWriting: () => {
              setJobs((current) =>
                current.map((job) =>
                  job.id === id
                    ? {
                        ...job,
                        progress: {
                          phase: "writing",
                          label: "Writing the notes and PDF",
                          percent: null,
                        },
                      }
                    : job,
                ),
              )
            },
          })
          setJobs((current) => current.filter((job) => job.id !== id))
        } catch (err) {
          setJobs((current) =>
            current.map((job) =>
              job.id === id ? { ...job, status: "error", error: messageOf(err) } : job,
            ),
          )
        } finally {
          stopWatch()
          setRevision((value) => value + 1)
          const home = settingsRef.current.homeDirectory
          if (!home) return
          try {
            await refreshCourses(home)
          } catch (err) {
            if (err instanceof StudyError && err.code === "HOME_MISSING") {
              setHomeMissing(true)
              setCourses([])
            }
          }
        }
        })()
    },
    [host, refreshCourses, store],
  )

  const dismissJob = useCallback((id: string) => {
    setJobs((current) => current.filter((job) => job.id !== id))
  }, [])

  const setupLocal = useCallback(async () => {
    setSetupError(null)
    setSetupProgress({
      phase: "config",
      label: "Setting up local notes…",
      received: 0,
      total: null,
    })
    try {
      const status = await host.setupLocal((progress) => setSetupProgress(progress))
      setLocalStatus(status)
      if (!status.ready) setSetupError("Local notes are not ready yet.")
    } catch (err) {
      setSetupError(messageOf(err))
      try {
        setLocalStatus(await store.localStatus())
      } catch {
        setLocalStatus(NOT_READY)
      }
    } finally {
      setSetupProgress(null)
    }
  }, [host, store])

  const value = useMemo<LibraryState>(
    () => ({
      ready,
      error,
      homeMissing,
      settings,
      courses,
      jobs,
      revision,
      localStatus,
      setupProgress,
      setupError,
      setupLocal,
      reload,
      refreshLibrary,
      chooseHome,
      setProvider,
      addCourse,
      startMakeNotes,
      dismissJob,
    }),
    [
      ready,
      error,
      homeMissing,
      settings,
      courses,
      jobs,
      revision,
      localStatus,
      setupProgress,
      setupError,
      setupLocal,
      reload,
      refreshLibrary,
      chooseHome,
      setProvider,
      addCourse,
      startMakeNotes,
      dismissJob,
    ],
  )

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

export function useLibrary(): LibraryState {
  const value = useContext(LibraryContext)
  if (!value) throw new Error("Study Notes is missing its library.")
  return value
}
