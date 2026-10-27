import { renderPdf } from "../domain/pdf"
import { parseNoteFile, writeFrontmatter, type NoteMeta } from "../domain/frontmatter"
import { LocalSetupError, StudyError } from "../domain/errors"
import { assertUsableFolderName, folderNameFromDisplay, isReservedFolder } from "../domain/names"
import { fileName, joinPath } from "../domain/paths"
import { createProvider, type Entitlement } from "../domain/providers"
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
  newModuleName: string | null
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
}

function settingsPath(appData: string): string {
  return joinPath(appData, "settings.json")
}

function licensePath(appData: string): string {
  return joinPath(appData, "license.json")
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
    }
  } catch {
    return { ...EMPTY_SETTINGS }
  }
}

export async function saveSettings(store: FileStore, settings: Settings): Promise<void> {
  await writeJson(store, settingsPath(await store.appDataDir()), settings)
}

export async function readEntitlement(store: FileStore): Promise<Entitlement> {
  const text = await store.readText(licensePath(await store.appDataDir()))
  if (!text) return { entitled: false, source: "missing" }
  try {
    const json = JSON.parse(text) as { entitled?: unknown }
    return { entitled: json.entitled === true, source: "license" }
  } catch {
    return { entitled: false, source: "license" }
  }
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

export async function makeNotes(store: FileStore, input: MakeNotesInput): Promise<NoteInfo> {
  const course = await findCourse(store, input.home, input.courseId)
  if (input.provider === "local") {
    const runtime = await store.localStatus()
    if (!runtime.ready) throw new LocalSetupError()
  }
  const stat = await store.stat(input.mediaPath)
  if (!stat || stat.isDir || !isMediaFile(input.mediaPath)) {
    throw new StudyError("Choose a video or audio file.", "MEDIA")
  }
  const entitlement = await readEntitlement(store)
  const provider = createProvider(input.provider, entitlement)
  const probe = await store.probeMedia(input.mediaPath)
  const noteId = crypto.randomUUID()
  const title = titleFromMediaPath(input.mediaPath)
  const transcript =
    provider.id === "local"
      ? await transcribeLocal(store, input.mediaPath, { noteId, title, probe })
      : provider.transcribe({ noteId, title, probe })

  let moduleId: string | null = null
  let moduleName: string | null = null
  let notesDir = joinPath(course.path, "notes")
  if (input.newModuleName !== null) {
    const created = await createModule(store, input.home, input.courseId, input.newModuleName)
    moduleId = created.id
    moduleName = created.name
    notesDir = joinPath(created.path, "notes")
  } else if (input.moduleId) {
    const existing = course.modules.find((item) => item.id === input.moduleId)
    if (!existing) throw new StudyError("That module is not in this course.", "MODULE")
    moduleId = existing.id
    moduleName = existing.name
    notesDir = joinPath(existing.path, "notes")
  }

  const filedAt = new Date().toISOString()
  const body = provider.compose(
    contentFrom(
      title,
      course.name,
      moduleName,
      filedAt,
      transcript.durationSeconds,
      transcript.segments,
      transcript.chapters,
      transcript.transcribed,
    ),
  )
  const meta: NoteMeta = {
    id: noteId,
    title,
    courseId: course.id,
    moduleId,
    createdAt: filedAt,
    updatedAt: filedAt,
    provider: provider.id,
  }
  const stemBase = folderNameFromDisplay(title) || "Notes"
  const stem = await uniqueFileStem(store, notesDir, stemBase)
  const markdownPath = joinPath(notesDir, `${stem}.md`)
  const pdfPath = joinPath(notesDir, `${stem}.pdf`)
  const study = joinPath(course.path, ".study")
  await store.mkdir(notesDir)
  await store.mkdir(joinPath(study, "transcripts"))
  await store.mkdir(joinPath(study, "sources"))
  await store.mkdir(joinPath(study, "history"))
  await store.setHidden(study)
  await store.writeText(
    joinPath(study, "transcripts", `${noteId}.json`),
    `${JSON.stringify(transcript, null, 2)}\n`,
  )
  const source: SourceRecord = {
    noteId,
    mediaPath: input.mediaPath,
    courseId: course.id,
    moduleId,
  }
  await store.writeText(joinPath(study, "sources", `${noteId}.json`), `${JSON.stringify(source, null, 2)}\n`)
  await store.writeText(markdownPath, writeFrontmatter(meta, body))
  await store.writeBytes(pdfPath, await renderPdf(body))
  await touchCourse(store, course, filedAt)
  return {
    id: noteId,
    title,
    fileStem: stem,
    markdownPath,
    pdfPath,
    pdfExists: true,
    moduleId,
    moduleName,
    createdAt: filedAt,
    updatedAt: filedAt,
    provider: provider.id,
    hasHistory: false,
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
  const entitlement = await readEntitlement(store)
  const provider = createProvider(input.provider, entitlement)
  const body = provider.restyle(
    contentFrom(
      note.title,
      note.courseName,
      note.moduleName,
      note.createdAt,
      note.durationSeconds,
      note.segments,
      note.chapters,
      note.transcriptProduced,
    ),
    input.preset,
    input.prompt,
  )
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
    provider: provider.id,
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
