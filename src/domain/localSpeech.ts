import { StudyError } from "./errors"
import type { TranscriptSegment } from "./types"

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

/** A recording this long must not come back in under a minute. 57 minutes qualifies. */
export const LONG_RECORDING_SECONDS = 30 * 60
export const MIN_LONG_ELAPSED_MS = 60_000

const NON_SPEECH =
  /^(?:\[(?:blank_audio|music|noise|silence|laughter|applause)\]|\((?:blank audio|silence|music|noise|laughter|applause)\)|♪+)$/i

export interface LocalRuntimeStatus {
  ready: boolean
  model: string
  missing: Array<"ffmpeg" | "ffprobe" | "engine" | "model" | "config">
}

export interface SetupProgress {
  phase: "ffmpeg" | "engine" | "model" | "config"
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
