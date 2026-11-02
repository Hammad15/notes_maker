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
import type { LocalRuntimeStatus, SetupProgress, TranscriptionProgress, TranscriptionTarget } from "../domain/localSpeech"
import {
  forwardProgress,
  sameTranscriptionJob,
  scaleTranscriptionPercent,
  speechModel,
  speechPace,
  transcriptionWasReplaced,
  type SpeechPace,
} from "../domain/localSpeech"
import { recordMakeNotesFailure } from "../domain/notesLog"
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
  mediaPath: string
  moduleId: string | null
  moduleName: string | null
  label: string
  provider: ProviderId
  status: "running" | "error"
  error?: string
  progress?: TranscriptionProgress | null
}

interface Pipeline {
  target: TranscriptionTarget
  id: string
  promise: Promise<void>
}

const pipelines: Pipeline[] = []

function targetOf(input: MakeNotesInput): TranscriptionTarget {
  return {
    mediaPath: input.mediaPath,
    courseId: input.courseId,
    moduleId: input.moduleId,
    moduleName: input.moduleName,
  }
}

function mergeProgress(job: Job, progress: TranscriptionProgress): Job {
  if (progress.jobId && progress.jobId !== job.id) return job
  if (job.progress?.phase === "writing" && progress.phase !== "writing") return job
  if (progress.phase === "reading") {
    return {
      ...job,
      progress: {
        ...progress,
        percent: null,
        startedMs: progress.startedMs ?? job.progress?.startedMs ?? null,
      },
    }
  }
  const current = job.progress?.percent ?? null
  const incoming =
    progress.phase === "writing" ? progress.percent : scaleTranscriptionPercent(progress.percent)
  return {
    ...job,
    progress: {
      ...progress,
      percent: forwardProgress(current, incoming),
      startedMs: progress.startedMs ?? job.progress?.startedMs ?? null,
    },
  }
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
  setSpeechPace: (pace: SpeechPace) => Promise<void>
  setGroqKey: (groqApiKey: string) => Promise<void>
  addCourse: (name: string) => Promise<CourseSummary>
  startMakeNotes: (input: MakeNotesInput) => void
  dismissJob: (id: string) => void
}

const LibraryContext = createContext<LibraryState | null>(null)

const EMPTY_SETTINGS: Settings = {
  homeDirectory: null,
  provider: "local",
  lastMediaDirectory: null,
  speechPace: "clearer",
  groqApiKey: "",
  languageCode: "en",
}

function notReady(pace: SpeechPace): LocalRuntimeStatus {
  return {
    ready: false,
    model: speechModel(pace).name,
    missing: ["ffmpeg", "ffprobe", "engine", "model", "notesEngine", "notes", "config"],
  }
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
      setLocalStatus(await store.localStatus(speechPace(loaded.speechPace)))
    } catch {
      setLocalStatus(notReady(speechPace(loaded.speechPace)))
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

  const setSpeechPace = useCallback(
    async (pace: SpeechPace) => {
      const next = { ...settingsRef.current, speechPace: pace }
      settingsRef.current = next
      setSettings(next)
      await saveSettings(store, next)
      try {
        setLocalStatus(await store.localStatus(pace))
      } catch {
        setLocalStatus(notReady(pace))
      }
    },
    [store],
  )

  const setGroqKey = useCallback(
    async (groqApiKey: string) => {
      const next = { ...settingsRef.current, groqApiKey }
      settingsRef.current = next
      setSettings(next)
      await saveSettings(store, next)
    },
    [store],
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
      const target = targetOf(input)
      if (input.provider === "local" && pipelines.some((item) => sameTranscriptionJob(item.target, target))) {
        return
      }
      const claimedId = crypto.randomUUID()
      const pipeline: Pipeline = { target, id: claimedId, promise: Promise.resolve() }
      if (input.provider === "local") pipelines.push(pipeline)
      const run = async () => {
        let id: string = claimedId
        let initial: TranscriptionProgress | null = null
        if (input.provider === "local") {
          try {
            const saved = await store.activeTranscription()
            if (saved && sameTranscriptionJob(saved, target)) {
              id = saved.id
              pipeline.id = saved.id
              initial = {
                phase: saved.phase,
                label: saved.label,
                percent: saved.percent,
                jobId: saved.id,
                startedMs: saved.transcribeStartedMs || null,
              }
            }
          } catch {
            // The banner can still show the new request.
          }
        }
        const label = input.mediaPath.split(/[\\/]/).pop() || "recording"
        setJobs((current) => {
          const kept = current.filter((job) => {
            if (job.status !== "running" || job.provider !== "local") return job.id !== id
            return sameTranscriptionJob(job, target) && job.id === id
          })
          if (kept.some((job) => job.id === id)) {
            return kept.map((job) => (job.id === id && initial ? { ...job, progress: initial } : job))
          }
          return [
            ...kept,
            {
              id,
              courseId: input.courseId,
              mediaPath: input.mediaPath,
              moduleId: input.moduleId,
              moduleName: input.moduleName,
              label,
              provider: input.provider,
              status: "running",
              progress: initial,
            },
          ]
        })
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
              setJobs((current) => current.map((job) => (job.id === id ? mergeProgress(job, progress) : job)))
            })
          }
          await makeNotes(store, { ...input, jobId: id }, {
            onProgress: (progress) => {
              setJobs((current) => current.map((job) => (job.id === id ? mergeProgress(job, progress) : job)))
            },
            onWriting: () => {
              setJobs((current) =>
                current.map((job) => {
                  if (job.id !== id) return job
                  const previous = job.progress?.percent ?? null
                  const continued = previous != null && previous > 0
                  return {
                    ...job,
                    progress: {
                      phase: "writing",
                      label: "Writing the notes and PDF",
                      percent: continued ? Math.min(99, Math.max(previous, 90)) : null,
                      startedMs: job.progress?.startedMs ?? Date.now(),
                      jobId: id,
                    },
                  }
                }),
              )
            },
          })
          setJobs((current) => current.filter((job) => job.id !== id))
        } catch (err) {
          if (transcriptionWasReplaced(err)) {
            setJobs((current) => current.filter((job) => job.id !== id))
            return
          }
          await recordMakeNotesFailure(store, label, err)
          setJobs((current) =>
            current.map((job) =>
              job.id === id ? { ...job, status: "error", error: messageOf(err) } : job,
            ),
          )
        } finally {
          stopWatch()
          if (input.provider === "local") {
            try {
              await store.clearTranscription(id)
            } catch {
              // The next launch reads whatever job file is still there.
            }
          }
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
      }
      pipeline.promise = run().finally(() => {
        const index = pipelines.indexOf(pipeline)
        if (index >= 0) pipelines.splice(index, 1)
      })
    },
    [host, refreshCourses, store],
  )

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void (async () => {
      try {
        const saved = await store.activeTranscription()
        if (!saved || cancelled) return
        startMakeNotes({
          home: saved.home,
          courseId: saved.courseId,
          mediaPath: saved.mediaPath,
          provider: "local",
          moduleId: saved.moduleId,
          moduleName: saved.moduleName,
          newModuleName: saved.newModuleName,
        })
      } catch {
        // No transcription was in progress.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, startMakeNotes, store])

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
      const status = await host.setupLocal(speechPace(settingsRef.current.speechPace), (progress) =>
        setSetupProgress(progress),
      )
      setLocalStatus(status)
      if (!status.ready) setSetupError("Local notes are not ready yet.")
    } catch (err) {
      setSetupError(messageOf(err))
      try {
        setLocalStatus(await store.localStatus(speechPace(settingsRef.current.speechPace)))
      } catch {
        setLocalStatus(notReady(speechPace(settingsRef.current.speechPace)))
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
      setSpeechPace,
      setGroqKey,
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
      setSpeechPace,
      setGroqKey,
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
