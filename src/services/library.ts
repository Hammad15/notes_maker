import { renderFull, renderRestyle, withNoteHeader } from "../domain/compose"
import { renderPdf } from "../domain/pdf"
import { parseNoteFile, writeFrontmatter, type NoteMeta } from "../domain/frontmatter"
import { GroqKeyError, LocalSetupError, StudyError } from "../domain/errors"
import {
  CLOUD_CHUNK_SECONDS,
  CLOUD_WHISPER_SPEED,
  completeChat,
  GROQ_WHISPER_MODEL,
  restyleInstruction,
  transcribeChunk,
  type PreparedAudio,
} from "../domain/groq"
import { writeLectureNotes, type NoteStyle } from "../domain/lectureNotes"
import { localLanguageSupported, notesLanguage } from "../domain/language"
import {
  chunkTranscriptionPercent,
  notesRunPercent,
  sameSavedRecording,
  speechPace,
  TRANSCRIPTION_PERCENT_END,
  type SpeechPace,
  type TranscriptionProgress,
} from "../domain/localSpeech"
import { assertUsableFolderName, folderNameFromDisplay, isReservedFolder } from "../domain/names"
import { fileName, joinPath } from "../domain/paths"
import { isMediaFile, titleFromMediaPath } from "../domain/text"
import type {
  ChapterMark,
  NoteContent,
  Preset,
  ProviderId,
  SourceRecord,
  Transcript,
  TranscriptSegment,
} from "../domain/types"
import type { FileStore } from "../platform/types"
import { transcribeLocal } from "./transcribe"

export interface Settings {
  homeDirectory: string | null
  provider: ProviderId
  lastMediaDirectory: string | null
  speechPace: SpeechPace
  /** Temporary developer setting. Not written into a course. */
  groqApiKey: string
  languageCode: string
}

export interface CourseSummary {
  id: string
  name: string
  folderName: string
  path: string
  noteCount: number
  moduleCount: number
  updatedAt: string
}

export interface ModuleInfo {
  id: string
  name: string
  folderName: string
  path: string
  noteCount: number
}

export interface NoteInfo {
  id: string
  title: string
  fileStem: string
  markdownPath: string
  pdfPath: string
  pdfExists: boolean
  moduleId: string | null
  moduleName: string | null
  createdAt: string
  updatedAt: string
  provider: ProviderId
  hasHistory: boolean
  /** File name of the recording this note was made from, when one is saved. */
  mediaFileName: string | null
}

export interface CourseDetail extends CourseSummary {
  modules: ModuleInfo[]
  notes: NoteInfo[]
}

export interface NoteDocument extends NoteInfo {
  body: string
  courseId: string
  courseName: string
  mediaPath: string | null
  durationSeconds: number | null
  segments: TranscriptSegment[]
  chapters: ChapterMark[]
  transcriptProduced: boolean
}

export interface MakeNotesInput {
  home: string
  courseId: string
  mediaPath: string
  provider: ProviderId
  moduleId: string | null
  moduleName: string | null
  newModuleName: string | null
  /** Set only after the user chooses what to do with a note that is already filed. */
  noteChoice?: "replace" | "add"
  jobId?: string
}

interface CourseFile {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

interface ModuleFile {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

const EMPTY_SETTINGS: Settings = {
  homeDirectory: null,
  provider: "local",
  lastMediaDirectory: null,
  speechPace: "clearer",
  groqApiKey: "",
  languageCode: "en",
}

let pendingSettingsWrite: Promise<void> = Promise.resolve()

function settingsPath(appData: string): string {
  return joinPath(appData, "settings.json")
}

async function writeJson(store: FileStore, path: string, value: unknown): Promise<void> {
  await store.writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function loadSettings(store: FileStore): Promise<Settings> {
  const text = await store.readText(settingsPath(await store.appDataDir()))
  if (!text) return { ...EMPTY_SETTINGS }
  try {
    const json = JSON.parse(text) as Partial<Settings>
    return {
      homeDirectory: typeof json.homeDirectory === "string" ? json.homeDirectory : null,
      provider: json.provider === "cloud" ? "cloud" : "local",
      lastMediaDirectory:
        typeof json.lastMediaDirectory === "string" ? json.lastMediaDirectory : null,
      speechPace: speechPace(json.speechPace),
      groqApiKey: typeof json.groqApiKey === "string" ? json.groqApiKey : "",
      languageCode: typeof json.languageCode === "string" && json.languageCode.trim() ? json.languageCode.trim() : "en",
    }
  } catch {
    return { ...EMPTY_SETTINGS }
  }
}

export async function saveSettings(store: FileStore, settings: Settings): Promise<void> {
  const run = pendingSettingsWrite.then(
    async () => writeJson(store, settingsPath(await store.appDataDir()), settings),
    async () => writeJson(store, settingsPath(await store.appDataDir()), settings),
  )
  pendingSettingsWrite = run.then(
    () => undefined,
    () => undefined,
  )
  await run
}

/**
 * The only read of the Groq key. This build uses the developer setting stored
 * in Study Notes settings on this computer. A later build can supply the key
 * from the environment or a provisioned secret in this function, instead of
 * asking the student. Do not read the key anywhere else.
 */
export async function readGroqKey(store: FileStore): Promise<string> {
  await pendingSettingsWrite
  const settings = await loadSettings(store)
  return settings.groqApiKey.trim()
}

export async function assertWritableDirectory(store: FileStore, dir: string): Promise<void> {
  const stat = await store.stat(dir)
  if (!stat?.isDir) throw new StudyError("Choose a folder.", "HOME")
  const probe = joinPath(dir, ".study-notes-write-test")
  try {
    await store.writeText(probe, "ok")
  } catch {
    throw new StudyError("Study Notes cannot save courses in that folder.", "HOME")
  }
  try {
    await store.remove(probe)
  } catch {
    // The folder accepted a file. Leaving the probe is harmless.
  }
}

async function requireHome(store: FileStore, home: string): Promise<void> {
  const stat = await store.stat(home)
  if (!stat?.isDir) throw new StudyError("The home folder is not there.", "HOME_MISSING")
}

function parseCourse(text: string): CourseFile | null {
  try {
    const json = JSON.parse(text) as Partial<CourseFile>
    if (!json.id || !json.name) return null
    return {
      id: json.id,
      name: json.name,
      createdAt: json.createdAt || new Date(0).toISOString(),
      updatedAt: json.updatedAt || json.createdAt || new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

function parseModule(text: string): ModuleFile | null {
  try {
    const json = JSON.parse(text) as Partial<ModuleFile>
    if (!json.id || !json.name) return null
    return {
      id: json.id,
      name: json.name,
      createdAt: json.createdAt || new Date(0).toISOString(),
      updatedAt: json.updatedAt || json.createdAt || new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

async function uniqueChildName(
  store: FileStore,
  parent: string,
  base: string,
  currentName?: string,
): Promise<string> {
  const same = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
  if (currentName && same(base, currentName)) return currentName
  let name = base
  let n = 2
  while (await store.exists(joinPath(parent, name))) {
    name = `${base} (${n})`
    n += 1
    if (n > 200) throw new StudyError("Too many folders already use that name.", "NAME")
  }
  return name
}

async function uniqueFileStem(store: FileStore, dir: string, base: string): Promise<string> {
  let stem = base
  let n = 2
  const taken = async (candidate: string) =>
    (await store.exists(joinPath(dir, `${candidate}.md`))) ||
    (await store.exists(joinPath(dir, `${candidate}.pdf`)))
  while (await taken(stem)) {
    stem = `${base} (${n})`
    n += 1
    if (n > 200) throw new StudyError("Too many notes already use that name.", "NAME")
  }
  return stem
}

function laterIso(left: string, right: string): string {
  return left > right ? left : right
}

async function notesIn(
  store: FileStore,
  dir: string,
  moduleId: string | null,
  moduleName: string | null,
  coursePath: string,
): Promise<NoteInfo[]> {
  if (!(await store.exists(dir))) return []
  const entries = await store.list(dir)
  const notes: NoteInfo[] = []
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".md")) continue
    const markdownPath = joinPath(dir, entry.name)
    const text = await store.readText(markdownPath)
    if (!text) continue
    const parsed = parseNoteFile(text)
    if (!parsed) continue
    const stem = entry.name.slice(0, -3)
    const pdfPath = joinPath(dir, `${stem}.pdf`)
    const historyPath = joinPath(coursePath, ".study", "history", `${parsed.meta.id}.md`)
    const source = await loadSource(store, coursePath, parsed.meta.id)
    notes.push({
      id: parsed.meta.id,
      title: parsed.meta.title,
      fileStem: stem,
      markdownPath,
      pdfPath,
      pdfExists: await store.exists(pdfPath),
      moduleId,
      moduleName,
      createdAt: parsed.meta.createdAt,
      updatedAt: parsed.meta.updatedAt,
      provider: parsed.meta.provider,
      hasHistory: await store.exists(historyPath),
      mediaFileName: source ? fileName(source.mediaPath) : null,
    })
  }
  return notes
}

async function readModules(store: FileStore, coursePath: string): Promise<ModuleInfo[]> {
  const entries = await store.list(coursePath)
  const modules: ModuleInfo[] = []
  for (const entry of entries) {
    if (entry.kind !== "dir" || isReservedFolder(entry.name)) continue
    const path = joinPath(coursePath, entry.name)
    const text = await store.readText(joinPath(path, "module.json"))
    if (!text) continue
    const data = parseModule(text)
    if (!data) continue
    const notes = await notesIn(store, joinPath(path, "notes"), data.id, data.name, coursePath)
    modules.push({
      id: data.id,
      name: data.name,
      folderName: entry.name,
      path,
      noteCount: notes.length,
    })
  }
  modules.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  return modules
}

async function readCourseAt(store: FileStore, coursePath: string): Promise<CourseDetail | null> {
  const text = await store.readText(joinPath(coursePath, "course.json"))
  if (!text) return null
  const data = parseCourse(text)
  if (!data) return null
  const modules = await readModules(store, coursePath)
  const courseNotes = await notesIn(store, joinPath(coursePath, "notes"), null, null, coursePath)
  const moduleNotes: NoteInfo[] = []
  for (const moduleInfo of modules) {
    moduleNotes.push(
      ...(await notesIn(
        store,
        joinPath(moduleInfo.path, "notes"),
        moduleInfo.id,
        moduleInfo.name,
        coursePath,
      )),
    )
  }
  const notes = [...courseNotes, ...moduleNotes].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  )
  const updatedAt = notes.reduce((latest, note) => laterIso(latest, note.updatedAt), data.updatedAt)
  return {
    id: data.id,
    name: data.name,
    folderName: fileName(coursePath),
    path: coursePath,
    noteCount: notes.length,
    moduleCount: modules.length,
    updatedAt,
    modules,
    notes,
  }
}

async function findCourse(
  store: FileStore,
  home: string,
  courseId: string,
): Promise<CourseDetail> {
  await requireHome(store, home)
  const entries = await store.list(home)
  for (const entry of entries) {
    if (entry.kind !== "dir") continue
    const detail = await readCourseAt(store, joinPath(home, entry.name))
    if (detail?.id === courseId) return detail
  }
  throw new StudyError("That course is not in the home folder.", "COURSE")
}

export async function listCourses(store: FileStore, home: string): Promise<CourseSummary[]> {
  await requireHome(store, home)
  const entries = await store.list(home)
  const courses: CourseSummary[] = []
  for (const entry of entries) {
    if (entry.kind !== "dir") continue
    try {
      const detail = await readCourseAt(store, joinPath(home, entry.name))
      if (!detail) continue
      courses.push(detail)
    } catch {
      // Skip a folder that cannot be read.
    }
  }
  courses.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return courses
}

export async function getCourse(
  store: FileStore,
  home: string,
  courseId: string,
): Promise<CourseDetail> {
  return findCourse(store, home, courseId)
}

export async function createCourse(
  store: FileStore,
  home: string,
  displayName: string,
): Promise<CourseSummary> {
  await requireHome(store, home)
  const trimmed = displayName.trim()
  const base = assertUsableFolderName(trimmed)
  const folder = await uniqueChildName(store, home, base)
  const path = joinPath(home, folder)
  const now = new Date().toISOString()
  await store.mkdir(path)
  await writeJson(store, joinPath(path, "course.json"), {
    id: crypto.randomUUID(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
  } satisfies CourseFile)
  const detail = await readCourseAt(store, path)
  if (!detail) throw new StudyError("The course folder could not be read back.", "COURSE")
  return detail
}

export async function renameCourse(
  store: FileStore,
  home: string,
  courseId: string,
  displayName: string,
): Promise<CourseDetail> {
  const course = await findCourse(store, home, courseId)
  const existingText = await store.readText(joinPath(course.path, "course.json"))
  const existing = existingText ? parseCourse(existingText) : null
  const trimmed = displayName.trim()
  const base = assertUsableFolderName(trimmed)
  const folder = await uniqueChildName(store, home, base, course.folderName)
  const nextPath = joinPath(home, folder)
  if (nextPath !== course.path) await store.rename(course.path, nextPath)
  const now = new Date().toISOString()
  await writeJson(store, joinPath(nextPath, "course.json"), {
    id: course.id,
    name: trimmed,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  })
  return findCourse(store, home, courseId)
}

export async function createModule(
  store: FileStore,
  home: string,
  courseId: string,
  displayName: string,
): Promise<ModuleInfo> {
  const course = await findCourse(store, home, courseId)
  const trimmed = displayName.trim()
  const base = assertUsableFolderName(trimmed)
  const folder = await uniqueChildName(store, course.path, base)
  const path = joinPath(course.path, folder)
  const now = new Date().toISOString()
  const data: ModuleFile = {
    id: crypto.randomUUID(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
  }
  await store.mkdir(path)
  await writeJson(store, joinPath(path, "module.json"), data)
  return { id: data.id, name: data.name, folderName: folder, path, noteCount: 0 }
}

export async function renameModule(
  store: FileStore,
  home: string,
  courseId: string,
  moduleId: string,
  displayName: string,
): Promise<CourseDetail> {
  const course = await findCourse(store, home, courseId)
  const moduleInfo = course.modules.find((item) => item.id === moduleId)
  if (!moduleInfo) throw new StudyError("That module is not in this course.", "MODULE")
  const trimmed = displayName.trim()
  const base = assertUsableFolderName(trimmed)
  const folder = await uniqueChildName(store, course.path, base, moduleInfo.folderName)
  const nextPath = joinPath(course.path, folder)
  if (nextPath !== moduleInfo.path) await store.rename(moduleInfo.path, nextPath)
  const text = await store.readText(joinPath(nextPath, "module.json"))
  const current = text ? parseModule(text) : null
  const now = new Date().toISOString()
  await writeJson(store, joinPath(nextPath, "module.json"), {
    id: moduleInfo.id,
    name: trimmed,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  })
  return findCourse(store, home, courseId)
}

async function touchCourse(store: FileStore, course: CourseDetail, updatedAt: string) {
  const text = await store.readText(joinPath(course.path, "course.json"))
  const current = text ? parseCourse(text) : null
  await writeJson(store, joinPath(course.path, "course.json"), {
    id: course.id,
    name: course.name,
    createdAt: current?.createdAt || updatedAt,
    updatedAt,
  })
}

function contentFrom(
  title: string,
  courseName: string,
  moduleName: string | null,
  filedAt: string,
  durationSeconds: number | null,
  segments: TranscriptSegment[],
  chapters: ChapterMark[],
  transcriptProduced: boolean,
): NoteContent {
  return {
    title,
    courseName,
    moduleName,
    filedAt,
    durationSeconds,
    segments,
    chapters,
    transcriptProduced,
  }
}

/** The note already filed for this recording in the chosen course or module. */
export async function findRecordingNote(
  store: FileStore,
  input: {
    home: string
    courseId: string
    mediaPath: string
    moduleId: string | null
    newModuleName: string | null
  },
): Promise<NoteInfo | null> {
  const course = await findCourse(store, input.home, input.courseId)
  const saved = await findSavedTranscript(store, course, input)
  return saved?.note ?? null
}

async function findSavedTranscript(
  store: FileStore,
  course: CourseDetail,
  input: {
    mediaPath: string
    moduleId: string | null
    newModuleName: string | null
  },
): Promise<{ transcript: Transcript; note: NoteInfo | null } | null> {
  const dir = joinPath(course.path, ".study", "sources")
  if (!(await store.exists(dir))) return null
  const entries = await store.list(dir)
  let best: { transcript: Transcript; note: NoteInfo | null; createdAt: string; live: number } | null = null
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.toLowerCase().endsWith(".json")) continue
    const noteId = entry.name.replace(/\.json$/i, "")
    const source = await loadSource(store, course.path, noteId)
    if (
      !source ||
      !sameSavedRecording(source, {
        mediaPath: input.mediaPath,
        courseId: course.id,
        moduleId: input.moduleId,
        newModuleName: input.newModuleName,
      })
    ) {
      continue
    }
    const transcript = await loadTranscript(store, course.path, noteId)
    if (!transcript?.transcribed || !transcript.segments.some((segment) => segment.text.trim())) continue
    const note = course.notes.find((item) => item.id === noteId) ?? null
    const candidate = {
      transcript,
      note,
      createdAt: transcript.createdAt,
      live: note ? 1 : 0,
    }
    if (
      !best ||
      candidate.live > best.live ||
      (candidate.live === best.live && candidate.createdAt > best.createdAt)
    ) {
      best = candidate
    }
  }
  return best ? { transcript: best.transcript, note: best.note } : null
}

function chunkBudgetMs(index: number, chunkCount: number, durationSeconds: number | null): number {
  let seconds = CLOUD_CHUNK_SECONDS
  if (chunkCount <= 1) seconds = durationSeconds && durationSeconds > 0 ? durationSeconds : 60
  else if (index === chunkCount - 1 && durationSeconds != null && durationSeconds > index * CLOUD_CHUNK_SECONDS) {
    seconds = durationSeconds - index * CLOUD_CHUNK_SECONDS
  }
  return Math.max(1000, Math.round((seconds * 1000) / CLOUD_WHISPER_SPEED))
}

async function transcribeWithGroq(
  store: FileStore,
  mediaPath: string,
  key: string,
  languageCode: string,
  durationSeconds: number | null,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<TranscriptSegment[]> {
  const prepared: PreparedAudio = await store.prepareCloudAudio(mediaPath)
  const language = notesLanguage(languageCode)
  const startedMs = Date.now()
  const segments: TranscriptSegment[] = []
  try {
    const chunks = prepared.chunks
    if (chunks.length === 0) throw new StudyError("Could not prepare that recording.", "MEDIA")
    for (let index = 0; index < chunks.length; index += 1) {
      const budgetMs = chunkBudgetMs(index, chunks.length, durationSeconds)
      const chunkStarted = Date.now()
      const publish = (elapsedMs: number) => {
        onProgress?.({
          phase: "transcribing",
          label: "Transcribing the recording",
          percent: chunkTranscriptionPercent(index, chunks.length, elapsedMs, budgetMs),
          startedMs,
        })
      }
      publish(0)
      const timer = setInterval(() => publish(Date.now() - chunkStarted), 1000)
      try {
        const chunk = chunks[index]
        const bytes = await store.readBytes(chunk.path)
        const filename = chunk.path.split(/[\\/]/).pop() || "audio.wav"
        segments.push(...(await transcribeChunk(key, bytes, filename, language, chunk.startSeconds)))
        onProgress?.({
          phase: "transcribing",
          label: "Transcribing the recording",
          percent: Math.round(((index + 1) / chunks.length) * 100),
          startedMs,
        })
      } finally {
        clearInterval(timer)
      }
    }
  } finally {
    for (const chunk of prepared.chunks) {
      if (prepared.temporaryDirectory && chunk.path.startsWith(prepared.temporaryDirectory)) {
        try {
          await store.remove(chunk.path)
        } catch {
          // The prepared audio is in app data, not the course.
        }
      }
    }
  }
  if (!segments.some((segment) => segment.text.trim())) {
    throw new StudyError("No speech was found in that recording.", "TRANSCRIPT")
  }
  return segments
}

async function notesFromGroq(
  key: string,
  languageCode: string,
  content: NoteContent,
  style?: NoteStyle | null,
  onStep?: (done: number, total: number) => void,
): Promise<string> {
  const body = await writeLectureNotes({
    language: notesLanguage(languageCode),
    content,
    style,
    onStep,
    complete: (messages, maxCompletionTokens) => completeChat(key, messages, globalThis.fetch, maxCompletionTokens),
  })
  return withNoteHeader(content, body)
}

export async function makeNotes(
  store: FileStore,
  input: MakeNotesInput,
  hooks?: { onWriting?: () => void; onProgress?: (progress: TranscriptionProgress) => void },
): Promise<NoteInfo> {
  const course = await findCourse(store, input.home, input.courseId)
  const settings = await loadSettings(store)
  const pace = speechPace(settings.speechPace)
  const language = notesLanguage(settings.languageCode)
  const groqKey = input.provider === "cloud" ? await readGroqKey(store) : ""
  if (input.provider === "cloud" && !groqKey) throw new GroqKeyError()
  const stat = await store.stat(input.mediaPath)
  if (!stat || stat.isDir || !isMediaFile(input.mediaPath)) {
    throw new StudyError("Choose a video or audio file.", "MEDIA")
  }
  const saved = await findSavedTranscript(store, course, input)
  const addingBeside = input.noteChoice === "add" && saved?.note != null
  const probe = await store.probeMedia(input.mediaPath)
  const title = titleFromMediaPath(input.mediaPath)
  let transcript: Transcript
  let existingNote: NoteInfo | null = null
  if (saved) {
    transcript = saved.transcript
    existingNote = addingBeside ? null : saved.note
  } else if (input.provider === "cloud") {
    const segments = await transcribeWithGroq(
      store,
      input.mediaPath,
      groqKey,
      language.code,
      probe.durationSeconds,
      hooks?.onProgress,
    )
    transcript = {
      noteId: "",
      provider: "cloud",
      createdAt: new Date().toISOString(),
      durationSeconds: probe.durationSeconds,
      transcribed: true,
      segments,
      chapters: probe.chapters.filter(
        (chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end),
      ),
      model: GROQ_WHISPER_MODEL,
    }
  } else {
    if (!localLanguageSupported(language)) {
      throw new StudyError(
        "Local notes in this build use the English speech models. Cloud can transcribe another language.",
        "LANGUAGE",
      )
    }
    const runtime = await store.localStatus(pace)
    if (!runtime.ready) throw new LocalSetupError()
    const noteId = crypto.randomUUID()
    transcript = await transcribeLocal(store, input.mediaPath, { noteId, title, probe }, {
      jobId: input.jobId || noteId,
      home: input.home,
      courseId: input.courseId,
      moduleId: input.moduleId,
      moduleName: input.moduleName,
      newModuleName: input.newModuleName,
      mediaPath: input.mediaPath,
      pace,
      language: language.code,
    })
  }
  hooks?.onWriting?.()

  let moduleId: string | null = existingNote?.moduleId ?? null
  let moduleName: string | null = existingNote?.moduleName ?? null
  let notesDir = joinPath(course.path, "notes")
  if (!existingNote && input.newModuleName !== null) {
    const created = await createModule(store, input.home, input.courseId, input.newModuleName)
    moduleId = created.id
    moduleName = created.name
    notesDir = joinPath(created.path, "notes")
  } else if (!existingNote && input.moduleId) {
    const existing = course.modules.find((item) => item.id === input.moduleId)
    if (!existing) throw new StudyError("That module is not in this course.", "MODULE")
    moduleId = existing.id
    moduleName = existing.name
    notesDir = joinPath(existing.path, "notes")
  } else if (existingNote?.moduleId) {
    const existing = course.modules.find((item) => item.id === existingNote.moduleId)
    if (existing) notesDir = joinPath(existing.path, "notes")
  }

  const filedAt = existingNote?.createdAt || new Date().toISOString()
  const updatedAt = new Date().toISOString()
  const content = contentFrom(
    existingNote?.title || title,
    course.name,
    moduleName,
    filedAt,
    transcript.durationSeconds ?? probe.durationSeconds,
    transcript.segments,
    transcript.chapters,
    transcript.transcribed,
  )
  const noteId = addingBeside
    ? crypto.randomUUID()
    : existingNote?.id || transcript.noteId || crypto.randomUUID()
  const study = joinPath(course.path, ".study")
  if (!existingNote) {
    await store.mkdir(joinPath(study, "transcripts"))
    await store.mkdir(joinPath(study, "sources"))
    await store.mkdir(joinPath(study, "history"))
    await store.setHidden(study)
    const storedTranscript: Transcript = {
      ...transcript,
      noteId,
      createdAt: addingBeside ? new Date().toISOString() : transcript.createdAt,
    }
    await store.writeText(
      joinPath(study, "transcripts", `${noteId}.json`),
      `${JSON.stringify(storedTranscript, null, 2)}\n`,
    )
    const source: SourceRecord = {
      noteId,
      mediaPath: input.mediaPath,
      courseId: course.id,
      moduleId,
    }
    await store.writeText(joinPath(study, "sources", `${noteId}.json`), `${JSON.stringify(source, null, 2)}\n`)
  }
  const notesStarted = Date.now()
  const afterTranscription = saved == null
  const notesTimer = setInterval(() => {
    hooks?.onProgress?.({
      phase: "writing",
      label: "Writing the notes and PDF",
      percent: notesRunPercent(Date.now() - notesStarted, afterTranscription),
      jobId: input.jobId,
    })
  }, 1000)
  const publishWriting = (done: number, total: number) => {
    const fraction = total > 0 ? Math.min(1, done / total) : 0
    const stepped = afterTranscription
      ? Math.min(99, TRANSCRIPTION_PERCENT_END + Math.round(fraction * (99 - TRANSCRIPTION_PERCENT_END)))
      : fraction <= 0
        ? 0
        : Math.min(95, Math.max(1, Math.round(fraction * 95)))
    const timed = notesRunPercent(Date.now() - notesStarted, afterTranscription)
    hooks?.onProgress?.({
      phase: "writing",
      label: "Writing the notes and PDF",
      percent: Math.max(timed, stepped),
      jobId: input.jobId,
    })
  }
  let body: string
  try {
    body =
      input.provider === "cloud"
        ? await notesFromGroq(groqKey, language.code, content, null, publishWriting)
        : renderFull(content)
  } finally {
    clearInterval(notesTimer)
  }
  const meta: NoteMeta = {
    id: noteId,
    title: content.title,
    courseId: course.id,
    moduleId,
    createdAt: filedAt,
    updatedAt,
    provider: input.provider,
  }
  if (existingNote) {
    await store.writeText(existingNote.markdownPath, writeFrontmatter(meta, body))
    await store.writeBytes(existingNote.pdfPath, await renderPdf(body))
    await touchCourse(store, course, updatedAt)
    return {
      ...existingNote,
      title: content.title,
      updatedAt,
      provider: input.provider,
      pdfExists: true,
      mediaFileName: existingNote.mediaFileName ?? fileName(input.mediaPath),
    }
  }
  const stemBase = folderNameFromDisplay(content.title) || "Notes"
  const stem = await uniqueFileStem(store, notesDir, stemBase)
  const markdownPath = joinPath(notesDir, `${stem}.md`)
  const pdfPath = joinPath(notesDir, `${stem}.pdf`)
  await store.mkdir(notesDir)
  await store.writeText(markdownPath, writeFrontmatter(meta, body))
  await store.writeBytes(pdfPath, await renderPdf(body))
  await touchCourse(store, course, updatedAt)
  return {
    id: noteId,
    title: content.title,
    fileStem: stem,
    markdownPath,
    pdfPath,
    pdfExists: true,
    moduleId,
    moduleName,
    createdAt: filedAt,
    updatedAt,
    provider: input.provider,
    hasHistory: false,
    mediaFileName: fileName(input.mediaPath),
  }
}

async function loadSource(store: FileStore, coursePath: string, noteId: string): Promise<SourceRecord | null> {
  const text = await store.readText(joinPath(coursePath, ".study", "sources", `${noteId}.json`))
  if (!text) return null
  try {
    const json = JSON.parse(text) as Partial<SourceRecord>
    if (!json.noteId || !json.mediaPath || !json.courseId) return null
    return {
      noteId: json.noteId,
      mediaPath: json.mediaPath,
      courseId: json.courseId,
      moduleId: json.moduleId ?? null,
    }
  } catch {
    return null
  }
}

async function loadTranscript(store: FileStore, coursePath: string, noteId: string): Promise<Transcript | null> {
  const text = await store.readText(joinPath(coursePath, ".study", "transcripts", `${noteId}.json`))
  if (!text) return null
  try {
    const json = JSON.parse(text) as Partial<Transcript>
    const transcribed = json.transcribed === true
    const segments = Array.isArray(json.segments)
      ? json.segments.filter(
          (segment): segment is TranscriptSegment =>
            !!segment &&
            typeof segment.text === "string" &&
            typeof segment.start === "number" &&
            typeof segment.end === "number",
        )
      : []
    const chapters = Array.isArray(json.chapters)
      ? json.chapters.filter(
          (chapter): chapter is ChapterMark =>
            !!chapter &&
            typeof chapter.title === "string" &&
            typeof chapter.start === "number" &&
            typeof chapter.end === "number",
        )
      : []
    return {
      noteId: json.noteId || noteId,
      provider: json.provider === "cloud" ? "cloud" : "local",
      createdAt: json.createdAt || new Date(0).toISOString(),
      durationSeconds: typeof json.durationSeconds === "number" ? json.durationSeconds : null,
      transcribed,
      segments: transcribed ? segments : [],
      chapters,
    }
  } catch {
    return null
  }
}

export async function deleteNote(
  store: FileStore,
  home: string,
  courseId: string,
  noteId: string,
): Promise<void> {
  const course = await findCourse(store, home, courseId)
  const note = course.notes.find((item) => item.id === noteId)
  if (!note) throw new StudyError("That note is not in this course.", "NOTE")
  await store.remove(note.markdownPath)
  await store.remove(note.pdfPath)
  const study = joinPath(course.path, ".study")
  await store.remove(joinPath(study, "transcripts", `${noteId}.json`))
  await store.remove(joinPath(study, "sources", `${noteId}.json`))
  await store.remove(joinPath(study, "history", `${noteId}.md`))
  await touchCourse(store, course, new Date().toISOString())
}

export async function readNote(
  store: FileStore,
  home: string,
  courseId: string,
  noteId: string,
): Promise<NoteDocument> {
  const course = await findCourse(store, home, courseId)
  const note = course.notes.find((item) => item.id === noteId)
  if (!note) throw new StudyError("That note is not in this course.", "NOTE")
  const text = await store.readText(note.markdownPath)
  const parsed = text ? parseNoteFile(text) : null
  if (!parsed) throw new StudyError("That note could not be read.", "NOTE")
  const source = await loadSource(store, course.path, noteId)
  const transcript = await loadTranscript(store, course.path, noteId)
  return {
    ...note,
    hasHistory: await store.exists(joinPath(course.path, ".study", "history", `${noteId}.md`)),
    body: parsed.body,
    courseId: course.id,
    courseName: course.name,
    mediaPath: source?.mediaPath ?? null,
    durationSeconds: transcript?.durationSeconds ?? null,
    segments: transcript?.segments ?? [],
    chapters: transcript?.chapters ?? [],
    transcriptProduced: transcript?.transcribed === true,
  }
}

export async function restyleNote(
  store: FileStore,
  input: {
    home: string
    courseId: string
    noteId: string
    provider: ProviderId
    preset: Preset | null
    prompt: string
  },
): Promise<NoteDocument> {
  const note = await readNote(store, input.home, input.courseId, input.noteId)
  const course = await findCourse(store, input.home, input.courseId)
  const settings = await loadSettings(store)
  const content = contentFrom(
    note.title,
    note.courseName,
    note.moduleName,
    note.createdAt,
    note.durationSeconds,
    note.segments,
    note.chapters,
    note.transcriptProduced,
  )
  let body: string
  if (input.provider === "cloud") {
    const key = await readGroqKey(store)
    if (!key) throw new GroqKeyError()
    const language = notesLanguage(settings.languageCode)
    if (content.transcriptProduced && content.segments.some((segment) => segment.text.trim())) {
      body = await notesFromGroq(key, language.code, content, {
        preset: input.preset,
        prompt: input.prompt,
      })
    } else {
      const text = await completeChat(key, [
        { role: "system", content: restyleInstruction(language, input.preset, input.prompt) },
        { role: "user", content: note.body },
      ])
      body = withNoteHeader(content, text)
    }
  } else {
    body = renderRestyle(content, input.preset, input.prompt)
  }
  const current = await store.readText(note.markdownPath)
  if (!current) throw new StudyError("That note could not be read.", "NOTE")
  const historyPath = joinPath(course.path, ".study", "history", `${note.id}.md`)
  await store.mkdir(joinPath(course.path, ".study", "history"))
  await store.setHidden(joinPath(course.path, ".study"))
  await store.writeText(historyPath, current.endsWith("\n") ? current : `${current}\n`)
  const now = new Date().toISOString()
  const meta: NoteMeta = {
    id: note.id,
    title: note.title,
    courseId: note.courseId,
    moduleId: note.moduleId,
    createdAt: note.createdAt,
    updatedAt: now,
    provider: input.provider,
  }
  await store.writeText(note.markdownPath, writeFrontmatter(meta, body))
  await store.writeBytes(note.pdfPath, await renderPdf(body))
  await touchCourse(store, course, now)
  return readNote(store, input.home, input.courseId, input.noteId)
}

export async function undoRestyle(
  store: FileStore,
  home: string,
  courseId: string,
  noteId: string,
): Promise<NoteDocument> {
  const note = await readNote(store, home, courseId, noteId)
  const course = await findCourse(store, home, courseId)
  const historyPath = joinPath(course.path, ".study", "history", `${note.id}.md`)
  const history = await store.readText(historyPath)
  if (!history) throw new StudyError("There is no restyle to undo.", "UNDO")
  const parsed = parseNoteFile(history)
  if (!parsed) throw new StudyError("The previous notes could not be read.", "UNDO")
  await store.writeText(note.markdownPath, history.endsWith("\n") ? history : `${history}\n`)
  await store.writeBytes(note.pdfPath, await renderPdf(parsed.body))
  await store.remove(historyPath)
  return readNote(store, home, courseId, noteId)
}
