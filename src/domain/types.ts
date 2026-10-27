export type ProviderId = "local" | "cloud"

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  noteId: string
  provider: ProviderId
  createdAt: string
  durationSeconds: number | null
  transcribed: boolean
  segments: TranscriptSegment[]
  chapters: ChapterMark[]
  model?: string
  elapsedMs?: number
}

export interface ChapterMark {
  start: number
  end: number
  title: string
}

export interface MediaProbe {
  size: number
  durationSeconds: number | null
  title: string | null
  chapters: ChapterMark[]
}

export interface DirEntry {
  name: string
  kind: "dir" | "file"
}

export interface FileStat {
  size: number
  isDir: boolean
  modifiedMs: number
}

export interface SourceRecord {
  noteId: string
  mediaPath: string
  courseId: string
  moduleId: string | null
}

export type Preset = "concise" | "bullets" | "paragraphs" | "table"

export interface NoteContent {
  title: string
  courseName: string
  moduleName: string | null
  filedAt: string
  durationSeconds: number | null
  segments: TranscriptSegment[]
  chapters: ChapterMark[]
  transcriptProduced: boolean
}
