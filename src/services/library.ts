import { NOTES_CANCELLED, notesWereCancelled, pathsToRemoveOnCancel } from "../domain/cancelNotes"
import { withNoteHeader } from "../domain/compose"
import { renderPdf } from "../domain/pdf"
import { parseNoteFile, writeFrontmatter, type NoteMeta } from "../domain/frontmatter"
import { CloudNotesError, LocalSetupError, StudyError } from "../domain/errors"
import { restyleInstruction } from "../domain/groq"
import { writeLectureNotes, type NoteStyle } from "../domain/lectureNotes"
import { localLanguageSupported, notesLanguage } from "../domain/language"
import {
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
  languageCode: string
  tourDismissed: boolean
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
  languageCode: "en",
  tourDismissed: false,
}

let pendingSettingsWrite: Promise<void> = Promise.resolve()

const cancelledJobs = new Set<string>()

/** The progress cancel control asks the in-flight run to stop and roll back. */
export function requestNoteCancel(jobId: string): void {
  if (jobId) cancelledJobs.add(jobId)
}

function throwIfNoteCancelled(jobId: string | undefined): void {
  if (jobId && cancelledJobs.has(jobId)) throw new StudyError(NOTES_CANCELLED, "CANCELLED")
}

function forgetNoteCancel(jobId: string | undefined): void {
  if (jobId) cancelledJobs.delete(jobId)
}

function settingsPath(appData: string): string {
  return joinPath(appData, "settings.json")
}

async function writeJson(store: FileStore, path: string, value: unknown): Promise<void> {
  await store.writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function loadSettings(store: FileStore): Promise<Settings> {
  const text = await store.readText(settingsPath(await store.appDataDir()))
  if (!text) return { ...EMPTY_SETTINGS }
  let json: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_SETTINGS }
    json = parsed as Record<string, unknown>
  } catch {
    return { ...EMPTY_SETTINGS }
  }
  const languageCode = json.languageCode
  const settings: Settings = {
    homeDirectory: typeof json.homeDirectory === "string" ? json.homeDirectory : null,
    provider: json.provider === "cloud" ? "cloud" : "local",
    lastMediaDirectory: typeof json.lastMediaDirectory === "string" ? json.lastMediaDirectory : null,
    speechPace: speechPace(json.speechPace),
    languageCode: typeof languageCode === "string" && languageCode.trim() ? languageCode.trim() : "en",
    tourDismissed: json.tourDismissed === true,
  }
  if (Object.prototype.hasOwnProperty.call(json, "groqApiKey")) await saveSettings(store, settings)
  return settings
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

export async function assertWritableDirectory(store: FileStore, dir: string): Promise<void> {
  const stat = await store.stat(dir)
  if (!stat?.isDir) throw new StudyError("Choose a folder.", "HOME")
  const probe = joinPath(dir, ".study-notes-write-test")
  try {
    await store.writeText(probe, "ok")
  } catch {
    throw new StudyError("Create Notes cannot save courses in that folder.", "HOME")
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

async function notesFromLocal(
  store: FileStore,
  languageCode: string,
  content: NoteContent,
  style?: NoteStyle | null,
  onStep?: (done: number, total: number) => void,
  jobId?: string,
): Promise<string> {
  const body = await writeLectureNotes({
    language: notesLanguage(languageCode),
    content,
    style,
    onStep: (done, total) => {
      throwIfNoteCancelled(jobId)
      onStep?.(done, total)
    },
    writer: "local",
    complete: (messages, maxCompletionTokens) => {
      throwIfNoteCancelled(jobId)
      return store.completeLocal(messages, maxCompletionTokens, jobId)
    },
  })
  return withNoteHeader(content, body)
}

function partialNotePath(filePath: string): string {
  return `${filePath}.partial`
}

/** Stage the note, then copy it into place. Cancel deletes the staged files only. */
async function writeFinishedNote(
  store: FileStore,
  markdownPath: string,
  pdfPath: string,
  markdown: string,
  pdf: Uint8Array,
  jobId: string | undefined,
  incomplete: string[],
): Promise<void> {
  const partialMarkdown = partialNotePath(markdownPath)
  const partialPdf = partialNotePath(pdfPath)
  incomplete.push(partialMarkdown, partialPdf)
  await store.writeText(partialMarkdown, markdown)
  await store.writeBytes(partialPdf, pdf)
  throwIfNoteCancelled(jobId)
  await store.writeText(markdownPath, markdown)
  await store.writeBytes(pdfPath, pdf)
  const markdownIndex = incomplete.indexOf(partialMarkdown)
  if (markdownIndex >= 0) incomplete.splice(markdownIndex, 1)
  const pdfIndex = incomplete.indexOf(partialPdf)
  if (pdfIndex >= 0) incomplete.splice(pdfIndex, 1)
  await store.remove(partialMarkdown)
  await store.remove(partialPdf)
}

export async function makeNotes(
  store: FileStore,
  input: MakeNotesInput,
  hooks?: { onWriting?: () => void; onProgress?: (progress: TranscriptionProgress) => void },
): Promise<NoteInfo> {
  if (input.provider === "cloud") throw new CloudNotesError()
  const course = await findCourse(store, input.home, input.courseId)
  const settings = await loadSettings(store)
  const pace = speechPace(settings.speechPace)
  const language = notesLanguage(settings.languageCode)
  const stat = await store.stat(input.mediaPath)
  if (!stat || stat.isDir || !isMediaFile(input.mediaPath)) {
    throw new StudyError("Choose a video or audio file.", "MEDIA")
  }
  if (input.provider === "local") {
    const runtime = await store.localStatus(pace)
    if (!runtime.ready) throw new LocalSetupError()
  }
  const saved = await findSavedTranscript(store, course, input)
  const addingBeside = input.noteChoice === "add" && saved?.note != null
  const probe = await store.probeMedia(input.mediaPath)
  const title = titleFromMediaPath(input.mediaPath)
  const rollback = {
    transcriptionComplete: saved != null,
    partialTranscriptPaths: [] as string[],
    incompleteNotePaths: [] as string[],
    finishedNotePaths: saved?.note ? [saved.note.markdownPath, saved.note.pdfPath] : [],
  }
  try {
  throwIfNoteCancelled(input.jobId)
  let transcript: Transcript
  let existingNote: NoteInfo | null = null
  if (saved) {
    transcript = saved.transcript
    existingNote = addingBeside ? null : saved.note
    rollback.transcriptionComplete = true
  } else {
    if (!localLanguageSupported(language)) {
      throw new StudyError("Local notes in this build use the English speech models.", "LANGUAGE")
    }
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
    rollback.transcriptionComplete = true
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
  throwIfNoteCancelled(input.jobId)
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
    body = await notesFromLocal(store, language.code, content, null, publishWriting, input.jobId)
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
  const markdown = writeFrontmatter(meta, body)
  const pdf = await renderPdf(body)
  if (existingNote) {
    await writeFinishedNote(
      store,
      existingNote.markdownPath,
      existingNote.pdfPath,
      markdown,
      pdf,
      input.jobId,
      rollback.incompleteNotePaths,
    )
    await touchCourse(store, course, updatedAt)
    forgetNoteCancel(input.jobId)
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
  await writeFinishedNote(store, markdownPath, pdfPath, markdown, pdf, input.jobId, rollback.incompleteNotePaths)
  await touchCourse(store, course, updatedAt)
  forgetNoteCancel(input.jobId)
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
  } catch (error) {
    const cancelled = (!!input.jobId && cancelledJobs.has(input.jobId)) || notesWereCancelled(error)
    if (cancelled) {
      for (const target of pathsToRemoveOnCancel(rollback)) {
        try {
          await store.remove(target)
        } catch {
          // The partial file is already gone.
        }
      }
      forgetNoteCancel(input.jobId)
      if (notesWereCancelled(error)) throw error
      throw new StudyError(NOTES_CANCELLED, "CANCELLED")
    }
    forgetNoteCancel(input.jobId)
    throw error
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
  if (input.provider === "cloud") throw new CloudNotesError()
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
  const pace = speechPace(settings.speechPace)
  const runtime = await store.localStatus(pace)
  if (!runtime.ready) throw new LocalSetupError()
  const language = notesLanguage(settings.languageCode)
  let body: string
  if (content.transcriptProduced && content.segments.some((segment) => segment.text.trim())) {
    body = await notesFromLocal(store, language.code, content, {
      preset: input.preset,
      prompt: input.prompt,
    })
  } else {
    const text = await store.completeLocal(
      [
        { role: "system", content: restyleInstruction(language, input.preset, input.prompt) },
        { role: "user", content: note.body },
      ],
      1500,
    )
    body = withNoteHeader(content, text)
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
