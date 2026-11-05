import { messageOf, StudyError } from "./errors.ts"
import type { TranscriptSegment } from "./types.ts"

/** Shown when a different recording replaces the one that is already running. */
export const TRANSCRIPTION_REPLACED = "Transcription was replaced by a different recording."

/**
 * Files the Set up local notes button downloads into %LOCALAPPDATA%\Study Notes.
 * Keep the Rust copy in src-tauri/src/local_runtime.rs on these same bytes.
 */
export const SPEECH_MODEL = {
  name: "ggml-base.en",
  file: "ggml-base.en.bin",
  bytes: 147_964_211,
  sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
} as const

/** Faster local speech. English for this build; another language adds its own file. */
export const TINY_MODEL = {
  name: "ggml-tiny.en",
  file: "ggml-tiny.en.bin",
  bytes: 77_704_715,
  sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
} as const

export type SpeechPace = "faster" | "clearer"

export function speechPace(value: unknown): SpeechPace {
  return value === "faster" ? "faster" : "clearer"
}

export function speechModel(pace: SpeechPace): typeof SPEECH_MODEL | typeof TINY_MODEL {
  return pace === "faster" ? TINY_MODEL : SPEECH_MODEL
}

/** Setup downloads the speech model for the selected speed, not both. */
export function speechModelsForSetup(pace: SpeechPace): Array<typeof SPEECH_MODEL | typeof TINY_MODEL> {
  return [speechModel(pace)]
}

/** Bytes the Set up local notes button still has to download. */
export function setupDownloadBytes(
  missing: readonly LocalRuntimeStatus["missing"][number][],
  pace: SpeechPace,
): number {
  const need = new Set(missing)
  let bytes = 0
  if (need.has("ffmpeg") || need.has("ffprobe")) bytes += FFMPEG_BUNDLE.zipBytes
  if (need.has("engine")) bytes += WHISPER_ENGINE.zipBytes
  if (need.has("model")) bytes += speechModel(pace).bytes
  if (need.has("notesEngine")) bytes += LLAMA_ENGINE.zipBytes
  if (need.has("notes")) bytes += NOTES_MODEL.bytes
  return bytes
}

/** Disk space for the setup screen, in binary units. */
export function formatByteSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = safe
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.round(value)} B`
  const shown = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

/** Names a setup download without the file name on disk. */
export function setupStepLabel(phase: SetupProgress["phase"]): string {
  switch (phase) {
    case "ffmpeg":
      return "Downloading the speech tools"
    case "engine":
      return "Downloading the speech engine"
    case "model":
      return "Downloading the speech model"
    case "notesEngine":
      return "Downloading the notes engine"
    case "notes":
      return "Downloading the notes model"
    case "config":
      return "Saving local setup"
  }
}

export const WHISPER_ENGINE = {
  version: "1.9.2",
  file: "whisper-cli.exe",
  exeBytes: 479_232,
  zipUrl: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip",
  zipBytes: 8_194_445,
  zipSha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
} as const

export const FFMPEG_BUNDLE = {
  version: "9.0.2",
  zipUrl: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
  zipBytes: 114_768_076,
  zipSha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
} as const

/**
 * Local study notes. Qwen2.5-7B-Instruct Q4_K_M, run by llama.cpp b10599.
 * The Qwen repo splits this quant, so setup downloads the single-file Q4_K_M.
 * The GGUF sha256 is the Hugging Face LFS oid. The engine lives in bin/notes
 * so its ggml DLLs do not replace the speech engine.
 * Keep the Rust copy in src-tauri/src/local_runtime.rs on these same bytes.
 */
export const NOTES_MODEL = {
  name: "Qwen2.5-7B-Instruct",
  file: "qwen2.5-7b-instruct-q4_k_m.gguf",
  bytes: 4_683_074_240,
  sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423",
  url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
} as const

export const LOCAL_HARDWARE_NOTE =
  "Suggested CPU specs: 4-core CPU and 16 GB RAM. Lesser builds should also work, just slower."

export const LLAMA_ENGINE = {
  version: "b10599",
  file: "llama-cli.exe",
  zipUrl: "https://github.com/ggml-org/llama.cpp/releases/download/b10599/llama-b10599-bin-win-cpu-x64.zip",
  zipBytes: 18_061_865,
  zipSha256: "d95eff420538b372273c5ee82258e238cc955ee3b5135443503d1fa4a38d8308",
} as const

/** llama-cli.exe is a stub. These sizes are the files that must sit beside it. */
export const LLAMA_ENGINE_FILES = [
  { file: "llama-cli.exe", bytes: 9_216 },
  { file: "llama-cli-impl.dll", bytes: 3_258_368 },
  { file: "llama.dll", bytes: 2_996_224 },
  { file: "llama-common.dll", bytes: 7_740_416 },
  { file: "ggml.dll", bytes: 86_016 },
  { file: "ggml-base.dll", bytes: 773_632 },
  { file: "ggml-cpu-x64.dll", bytes: 870_912 },
] as const

/** Context passed to the local notes model. Requests stay under this. */
export const NOTES_CONTEXT_TOKENS = 16_384

export interface LocalNotesMessage {
  role: "system" | "user"
  content: string
}

const NOTES_LOG_LINE = /^(?:llama_|ggml_|main:|build:|print_info:|load_backend:)/
const TIMESTAMPED_TRANSCRIPT_LINE = /^\[\d{1,2}:\d{2}(?::\d{2})?\](?:\s|$)/
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?`

function timestampPatterns(): RegExp[] {
  return [
    new RegExp(String.raw`\[\s*${CLOCK}\s*\]`, "gi"),
    new RegExp(String.raw`\(\s*${CLOCK}(?:\s*(?:to|through|–|—|-)\s*${CLOCK})?\s*\)`, "gi"),
    new RegExp(String.raw`\b(?:from|between|at)\s+${CLOCK}\s*(?:to|through|and|–|—|-)\s*${CLOCK}\b`, "gi"),
    new RegExp(String.raw`\b${CLOCK}\s*(?:to|through|–|—|-)\s*${CLOCK}\b`, "gi"),
    new RegExp(
      String.raw`\b(?:at|from|around|about|near|after|before|until|till|starting|ending)\s+(?:the\s+)?${CLOCK}(?:\s+(?:mark|point))?\b`,
      "gi",
    ),
    new RegExp(String.raw`\b(?:timestamp|time)\s+${CLOCK}\b`, "gi"),
    new RegExp(
      String.raw`\b(?:(?:at|from|around|near)\s+)?(?:this|that|the)\s+(?:point|part|moment|timestamp)\s+in\s+the\s+(?:recording|video|audio)\b`,
      "gi",
    ),
    new RegExp(String.raw`\b(?:earlier|later)\s+in\s+the\s+(?:recording|video|audio)\b`, "gi"),
    new RegExp(String.raw`\b(?:this|that|the)\s+timestamps?\b`, "gi"),
    new RegExp(String.raw`\btimestamps?\b`, "gi"),
    new RegExp(String.raw`\b${CLOCK}\b`, "gi"),
  ]
}

/** The reply after the last Assistant marker. The prompt before it is not notes. */
function textAfterLastAssistant(raw: string): string {
  let end = -1
  const token = /<\|im_start\|>\s*assistant\b[^\S\n]*/gi
  for (const match of raw.matchAll(token)) {
    if (match.index == null) continue
    end = Math.max(end, match.index + match[0].length)
  }
  const lineMarker = /^\s*assistant\s*:\s*/gim
  for (const match of raw.matchAll(lineMarker)) {
    if (match.index == null) continue
    end = Math.max(end, match.index + match[0].length)
  }
  return end < 0 ? raw : raw.slice(end)
}

/** Drop llama.cpp logs, the echoed prompt, and timestamped transcript lines. */
export function cleanNotesReply(raw: string): string {
  const kept = textAfterLastAssistant(raw.replace(/\u0000/g, ""))
  const withoutTokens = kept.replace(/<\|im_end\|>/g, "")
  const lines = withoutTokens.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim()
    if (NOTES_LOG_LINE.test(trimmed)) return false
    if (TIMESTAMPED_TRANSCRIPT_LINE.test(trimmed)) return false
    return true
  })
  return shapeLocalStudyNotes(lines.join("\n"))
}

/** One line with recording times and "at this point in the recording" removed. */
function stripTimestampText(text: string): string {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? ""
  let body = text.slice(indent.length)
  for (const pattern of timestampPatterns()) body = body.replace(pattern, " ")
  body = body.replace(/[ \t]{2,}/g, " ").trim()
  body = body.replace(/\s+([,.;:!?])/g, "$1")
  body = body.replace(/\(\s*\)|\[\s*\]/g, "").trim()
  body = body.replace(/^(?:[-*•+]|\d+[.)])\s*$/g, "").trim()
  if (!body) return ""
  return `${indent}${body}`
}

/**
 * Every local study-notes reply: bullets in each section, including the opening,
 * and no clock time, bracketed time, or phrase that points at a time in the recording.
 */
export function shapeLocalStudyNotes(markdown: string): string {
  const lines = markdown.replace(/\u0000/g, "").split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line.trimEnd())
    if (heading) {
      const title = stripTimestampText(heading[2]).trim()
      if (!title) continue
      out.push(`${heading[1]} ${title}`)
      continue
    }
    const stripped = stripTimestampText(line)
    if (!stripped.trim()) {
      out.push("")
      continue
    }
    const body = stripped.trim()
    if (/^\|/.test(body) || /^([-*_])\1{2,}$/.test(body)) {
      out.push(stripped.trimEnd())
      continue
    }
    const indent = /^[ \t]*/.exec(stripped)?.[0] ?? ""
    const item = body.replace(/^(?:[-*•+]|\d+[.)])\s+/, "")
    out.push(item ? `${indent}- ${item}` : "")
  }
  return out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** A recording this long must not come back in under a minute. 57 minutes qualifies. */
export const LONG_RECORDING_SECONDS = 30 * 60
export const MIN_LONG_ELAPSED_MS = 60_000

const NON_SPEECH =
  /^(?:\[(?:blank_audio|music|noise|silence|laughter|applause)\]|\((?:blank audio|silence|music|noise|laughter|applause)\)|♪+)$/i

export interface LocalRuntimeStatus {
  ready: boolean
  model: string
  missing: Array<"ffmpeg" | "ffprobe" | "engine" | "model" | "notesEngine" | "notes" | "config">
}

export interface SetupProgress {
  phase: "ffmpeg" | "engine" | "model" | "notesEngine" | "notes" | "config"
  label: string
  received: number
  total: number | null
}

export interface TranscriptionResult {
  segments: TranscriptSegment[]
  durationSeconds: number | null
  elapsedMs: number
  model: string
}

export interface TranscriptionProgress {
  phase: "reading" | "transcribing" | "writing"
  label: string
  percent: number | null
  jobId?: string
  startedMs?: number | null
  /** Finished notes-model steps. The writing countdown uses these, not the 90–99 bar. */
  writingDone?: number | null
  writingTotal?: number | null
  writingStartedMs?: number | null
}

/** The recording plus where the notes will be filed. */
export interface TranscriptionTarget {
  mediaPath: string
  courseId: string
  moduleId: string | null
  moduleName: string | null
}

export interface TranscriptionRequest extends TranscriptionTarget {
  jobId: string
  home: string
  newModuleName: string | null
  pace: SpeechPace
  language: string
}

export interface ActiveTranscription extends TranscriptionRequest {
  id: string
  phase: TranscriptionProgress["phase"]
  label: string
  percent: number | null
  transcribeStartedMs?: number | null
}

export interface SavedTranscription extends ActiveTranscription {
  pid: number | null
  stderrPath: string
  stdoutPath: string
  jsonPath: string
  wavPath: string
  startedMs: number
  durationSeconds: number | null
  pace: SpeechPace
  language: string
  transcribeStartedMs: number
}

export interface WhisperProcess {
  pid: number
  executablePath: string
  commandLine: string
}

export type ResumePlan =
  | { action: "attach"; pid: number }
  | { action: "reuse" }
  | { action: "continue" }
  | { action: "start" }

/**
 * Clearer uses half the logical processors, at least one.
 * Faster uses every logical processor.
 * Keep the Rust copy in src-tauri/src/local_runtime.rs on this same count.
 */
export function whisperThreadCount(logicalCpus: number, pace: SpeechPace = "clearer"): number {
  const cpus = Number.isFinite(logicalCpus) ? Math.max(1, Math.floor(logicalCpus)) : 1
  if (pace === "faster") return cpus
  if (cpus <= 1) return 1
  return Math.max(1, Math.floor(cpus / 2))
}

export function sameSavedRecording(
  source: { mediaPath: string; courseId: string; moduleId: string | null },
  target: { mediaPath: string; courseId: string; moduleId: string | null; newModuleName: string | null },
): boolean {
  if (target.newModuleName?.trim()) return false
  if (source.courseId !== target.courseId) return false
  if (normalizeMediaPath(source.mediaPath) !== normalizeMediaPath(target.mediaPath)) return false
  return (source.moduleId ?? null) === (target.moduleId ?? null)
}

/** Seconds left from a start time and a percent that is already underway. */
export function remainingSeconds(
  startedMs: number | null | undefined,
  percent: number | null | undefined,
  now = Date.now(),
): number | null {
  if (startedMs == null || percent == null) return null
  if (!Number.isFinite(startedMs) || !Number.isFinite(percent)) return null
  if (percent <= 0 || percent >= 100) return null
  const elapsed = now - startedMs
  if (elapsed < 1000) return null
  const remaining = Math.round((elapsed / (percent / 100) - elapsed) / 1000)
  if (!Number.isFinite(remaining) || remaining < 0) return null
  return remaining
}

export function formatRemaining(seconds: number): string {
  if (seconds < 60) return "less than a minute left"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest === 0) return hours === 1 ? "about 1 hour left" : `about ${hours} hours left`
  return `about ${hours} hr ${rest} min left`
}

export function normalizeMediaPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

/**
 * Same recording and the same course or module. A different file, course, or
 * module starts a new transcription. A module chosen by name matches that
 * module later chosen from the list when only one side has an id.
 */
export function sameTranscriptionJob(a: TranscriptionTarget, b: TranscriptionTarget): boolean {
  if (normalizeMediaPath(a.mediaPath) !== normalizeMediaPath(b.mediaPath)) return false
  if (a.courseId !== b.courseId) return false
  const aCourse = !a.moduleId && !a.moduleName?.trim()
  const bCourse = !b.moduleId && !b.moduleName?.trim()
  if (aCourse || bCourse) return aCourse && bCourse
  if (a.moduleId && b.moduleId) return a.moduleId === b.moduleId
  const aName = a.moduleName?.trim().toLocaleLowerCase() ?? ""
  const bName = b.moduleName?.trim().toLocaleLowerCase() ?? ""
  return aName.length > 0 && aName === bName
}

/** Transcription uses 0–90. Writing the notes uses 90–99, so 100 is only the finished file. */
export const TRANSCRIPTION_PERCENT_END = 90

export function scaleTranscriptionPercent(percent: number | null | undefined): number | null {
  if (percent == null || !Number.isFinite(percent)) return null
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.round((clamped / 100) * TRANSCRIPTION_PERCENT_END)
}

/**
 * Raw 0–100 while a speech chunk is still running.
 * The value stays inside this chunk's slice and does not reach the slice end early.
 */
export function chunkTranscriptionPercent(
  doneChunks: number,
  chunkCount: number,
  elapsedMs: number,
  budgetMs: number,
): number {
  if (chunkCount <= 0) return 0
  const start = (doneChunks / chunkCount) * 100
  const end = ((doneChunks + 1) / chunkCount) * 100
  const fraction = Math.min(0.95, Math.max(0, elapsedMs / Math.max(1, budgetMs)))
  return Math.max(0, Math.min(99, Math.round(start + (end - start) * fraction)))
}

/**
 * Short heartbeat for a notes request that has no step count yet.
 * Reaches 99 after 20 seconds, so it must not drive the writing countdown.
 */
export function notesRunPercent(elapsedMs: number, afterTranscription: boolean): number {
  const budget = 20_000
  const elapsed = Math.max(0, elapsedMs)
  if (!afterTranscription) {
    if (elapsed < 1000) return 0
    return Math.min(95, Math.max(1, Math.round((elapsed / budget) * 95)))
  }
  return Math.min(99, TRANSCRIPTION_PERCENT_END + Math.round((elapsed / budget) * 9))
}

/** A running notes step eases through its own slice and stops short of the next one. */
const WRITING_STEP_EASE_MS = 12 * 60 * 1000

function writingStepFraction(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.min(0.9, 1 - Math.exp(-elapsedMs / WRITING_STEP_EASE_MS))
}

/**
 * Bar position from finished notes steps, plus the step that is still running.
 * 90–99 after transcription, otherwise 1–95. The running step never fills its slice.
 */
export function writingPercent(
  done: number,
  total: number,
  afterTranscription: boolean,
  stepElapsedMs = 0,
): number {
  const safeDone = Number.isFinite(done) ? Math.max(0, done) : 0
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0
  const steps = Math.max(1, safeTotal)
  const finished = Math.min(safeDone, steps)
  const running = finished < steps
  const start = finished / steps
  const end = running ? (finished + 1) / steps : 1
  const position = running ? start + (end - start) * writingStepFraction(stepElapsedMs) : 1
  if (afterTranscription) {
    return Math.min(99, TRANSCRIPTION_PERCENT_END + Math.round(position * (99 - TRANSCRIPTION_PERCENT_END)))
  }
  if (position <= 0) return 1
  return Math.min(95, Math.max(1, Math.round(position * 95)))
}

/**
 * Seconds left from finished notes steps.
 * No estimate until one step has finished. A percent pinned at 99 is not a rate.
 */
export function writingRemainingSeconds(
  startedMs: number | null | undefined,
  done: number | null | undefined,
  total: number | null | undefined,
  now = Date.now(),
): number | null {
  if (startedMs == null || done == null || total == null) return null
  if (!Number.isFinite(startedMs) || !Number.isFinite(done) || !Number.isFinite(total)) return null
  if (done <= 0 || total <= 0 || done >= total) return null
  const elapsed = now - startedMs
  if (elapsed < 1000) return null
  const remaining = Math.round((elapsed * (total - done)) / done / 1000)
  if (!Number.isFinite(remaining) || remaining < 0) return null
  return remaining
}

function writingStepsKnown(progress: TranscriptionProgress): boolean {
  return progress.phase === "writing" && typeof progress.writingTotal === "number"
}

/**
 * The bar shows a percent only when that percent is known.
 * Writing shows its step percent before a step finishes. The countdown waits.
 */
export function barPercent(progress?: TranscriptionProgress | null, now = Date.now()): number | null {
  if (progress?.percent == null) return null
  if (writingStepsKnown(progress)) {
    if (progress.percent <= 0) return null
    return progress.percent
  }
  if (remainingSeconds(progress.startedMs, progress.percent, now) == null) return null
  return progress.percent
}

/** Keep the higher percent. Progress from the one running process must not go backward. */
export function forwardProgress(current: number | null, next: number | null): number | null {
  if (next == null || !Number.isFinite(next)) return current
  const value = Math.trunc(next)
  if (value < 0 || value > 100) return current
  if (current == null) return value
  return value < current ? current : value
}

export function transcriptionWasReplaced(error: unknown): boolean {
  return messageOf(error).includes("replaced by a different recording")
}

export function parseProcessSnapshot(snapshot: string): WhisperProcess[] {
  const processes: WhisperProcess[] = []
  for (const line of snapshot.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [pidText, executablePath = "", commandLine = ""] = line.split("\t")
    const pid = Number(pidText.trim())
    if (!Number.isInteger(pid) || pid <= 0) continue
    processes.push({ pid, executablePath, commandLine })
  }
  return processes
}

function normalizeExecutable(value: string): string {
  return normalizeMediaPath(value).replace(/"/g, "")
}

/**
 * whisper-cli processes started from this app's own engine.
 * The pid of the in-progress job is kept. Every other match is stopped.
 * A whisper-cli that is not this app's copy is left alone.
 */
export function whisperPidsToStop(
  processes: WhisperProcess[],
  ownExecutable: string,
  keepPid: number | null,
): number[] {
  const own = normalizeExecutable(ownExecutable)
  if (!own) return []
  const stop: number[] = []
  for (const process of processes) {
    if (process.pid === keepPid) continue
    const executable = normalizeExecutable(process.executablePath)
    const command = normalizeExecutable(process.commandLine)
    if (executable === own || command.includes(own)) stop.push(process.pid)
  }
  return stop
}

export function planResume(
  saved: (TranscriptionTarget & { pid: number | null; jsonReady: boolean }) | null,
  requested: TranscriptionTarget,
  processes: WhisperProcess[],
  ownExecutable: string,
): ResumePlan {
  if (!saved || !sameTranscriptionJob(saved, requested)) return { action: "start" }
  if (saved.pid && whisperPidsToStop(processes, ownExecutable, null).includes(saved.pid)) {
    return { action: "attach", pid: saved.pid }
  }
  if (saved.jsonReady) return { action: "reuse" }
  return { action: "continue" }
}

export function parseSavedTranscription(raw: string): SavedTranscription | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const row = parsed as Partial<SavedTranscription>
  if (!row.id || !row.mediaPath || !row.courseId || !row.home) return null
  const phase = row.phase === "reading" || row.phase === "writing" ? row.phase : "transcribing"
  return {
    id: row.id,
    jobId: row.id,
    mediaPath: row.mediaPath,
    home: row.home,
    courseId: row.courseId,
    moduleId: row.moduleId ?? null,
    moduleName: row.moduleName ?? null,
    newModuleName: row.newModuleName ?? null,
    pace: speechPace(row.pace),
    language: typeof row.language === "string" && row.language.trim() ? row.language.trim() : "en",
    transcribeStartedMs: typeof row.transcribeStartedMs === "number" ? row.transcribeStartedMs : 0,
    phase,
    label: row.label || "Transcribing the recording",
    percent: typeof row.percent === "number" ? forwardProgress(null, row.percent) : null,
    pid: typeof row.pid === "number" && row.pid > 0 ? row.pid : null,
    stderrPath: row.stderrPath || "",
    stdoutPath: row.stdoutPath || "",
    jsonPath: row.jsonPath || "",
    wavPath: row.wavPath || "",
    startedMs: typeof row.startedMs === "number" ? row.startedMs : 0,
    durationSeconds: typeof row.durationSeconds === "number" ? row.durationSeconds : null,
  }
}

export function localJobMessage(
  fileLabel: string,
  progress?: TranscriptionProgress | null,
  now = Date.now(),
): string {
  if (progress && writingStepsKnown(progress)) {
    const measured = barPercent(progress, now)
    if (measured == null) return `Writing the notes and PDF for ${fileLabel}…`
    const remaining = writingRemainingSeconds(
      progress.writingStartedMs,
      progress.writingDone,
      progress.writingTotal,
      now,
    )
    const suffix = remaining == null ? ` ${measured}%` : ` ${measured}% · ${formatRemaining(remaining)}`
    return `Writing the notes and PDF for ${fileLabel}…${suffix}`
  }
  const measured = barPercent(progress, now)
  const remaining = measured == null ? null : remainingSeconds(progress?.startedMs, measured, now)
  const suffix =
    measured == null || remaining == null ? "" : ` ${measured}% · ${formatRemaining(remaining)}`
  if (progress?.phase === "reading") return `Reading ${fileLabel}…`
  if (progress?.phase === "writing") return `Writing the notes and PDF for ${fileLabel}…${suffix}`
  return `Transcribing ${fileLabel}…${suffix}`
}

export function cleanSpokenText(text: string): string {
  const cleaned = text
    .replace(/<\|[^>]*\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned || NON_SPEECH.test(cleaned)) return ""
  return cleaned
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function timestampSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const millis = Number(match[4].padEnd(3, "0"))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function segmentBounds(item: {
  offsets?: { from?: unknown; to?: unknown }
  timestamps?: { from?: unknown; to?: unknown }
}): { start: number; end: number } | null {
  const fromMs = asNumber(item.offsets?.from)
  const toMs = asNumber(item.offsets?.to)
  if (fromMs != null && toMs != null) return { start: fromMs / 1000, end: toMs / 1000 }
  const start = timestampSeconds(item.timestamps?.from)
  const end = timestampSeconds(item.timestamps?.to)
  if (start == null || end == null) return null
  return { start, end }
}

export function parseWhisperJson(raw: string): TranscriptSegment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new StudyError("The speech model did not write a transcript.", "TRANSCRIPT")
  }
  const items =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { transcription?: unknown }).transcription)
      ? (parsed as { transcription: unknown[] }).transcription
      : null
  if (!items) throw new StudyError("The speech model did not write a transcript.", "TRANSCRIPT")
  const segments: TranscriptSegment[] = []
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const row = item as { text?: unknown; offsets?: { from?: unknown; to?: unknown }; timestamps?: { from?: unknown; to?: unknown } }
    const text = typeof row.text === "string" ? cleanSpokenText(row.text) : ""
    if (!text) continue
    const bounds = segmentBounds(row)
    if (!bounds || bounds.end < bounds.start) continue
    segments.push({ start: bounds.start, end: bounds.end, text })
  }
  return segments
}

export function assertHeardRecording(input: {
  durationSeconds: number | null
  elapsedMs: number
  segments: TranscriptSegment[]
}): void {
  const spoken = input.segments.filter((segment) => segment.text.trim())
  if (spoken.length === 0) {
    throw new StudyError("No speech was found in that recording.", "TRANSCRIPT")
  }
  const duration = input.durationSeconds
  if (duration == null || duration < LONG_RECORDING_SECONDS) return
  if (input.elapsedMs < MIN_LONG_ELAPSED_MS) {
    throw new StudyError(
      "Transcription finished before the speech model could have heard this recording.",
      "TRANSCRIPT",
    )
  }
}
