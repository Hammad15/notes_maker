import { StudyError } from "./errors.ts"
import type { NotesLanguage } from "./language.ts"
import { cleanSpokenText } from "./localSpeech.ts"
import type { TranscriptSegment } from "./types.ts"

/** Groq's host. The path is Groq's compatible API, not an OpenAI account. */
export const GROQ_ORIGIN = "https://api.groq.com"
export const GROQ_TRANSCRIPTIONS_URL = `${GROQ_ORIGIN}/openai/v1/audio/transcriptions`
export const GROQ_CHAT_URL = `${GROQ_ORIGIN}/openai/v1/chat/completions`

export const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
export const GROQ_NOTES_MODEL = "llama-3.3-70b-versatile"

export const CLOUD_CHUNK_BYTES = 20 * 1024 * 1024
export const CLOUD_CHUNK_SECONDS = 540

export interface AudioChunk {
  path: string
  startSeconds: number
}

export interface PreparedAudio {
  chunks: AudioChunk[]
  temporaryDirectory: string | null
}

export function studyNotesInstruction(language: NotesLanguage): string {
  return [
    `Write study notes in ${language.name}.`,
    "Use Markdown headings for topics and bullet points for the ideas.",
    "Leave out filler words, repeated false starts, music, applause, and lines such as thanks for watching.",
    "Do not include a transcript, a timestamp table, or a word-for-word record.",
    "Do not invent facts that are not in the transcript.",
  ].join(" ")
}

export function restyleInstruction(language: NotesLanguage, preset: string | null, prompt: string): string {
  const shape =
    preset === "concise"
      ? "Keep only the main topics."
      : preset === "paragraphs"
        ? "Use short paragraphs under each topic."
        : preset === "table"
          ? "Use a Markdown table with a topic column and a points column."
          : "Use headings for topics and bullets for the points."
  const extra = prompt.trim()
  return [
    `Rewrite these study notes in ${language.name}.`,
    shape,
    extra ? `Also follow this request: ${extra}` : "",
    "Do not add a transcript or filler.",
  ]
    .filter(Boolean)
    .join(" ")
}

export function parseGroqSegments(payload: unknown, offsetSeconds = 0): TranscriptSegment[] {
  if (!payload || typeof payload !== "object") return []
  const record = payload as { segments?: unknown; text?: unknown }
  const segments: TranscriptSegment[] = []
  if (Array.isArray(record.segments)) {
    for (const item of record.segments) {
      if (!item || typeof item !== "object") continue
      const row = item as { start?: unknown; end?: unknown; text?: unknown }
      const text = typeof row.text === "string" ? cleanSpokenText(row.text) : ""
      const start = typeof row.start === "number" && Number.isFinite(row.start) ? row.start : null
      const end = typeof row.end === "number" && Number.isFinite(row.end) ? row.end : null
      if (!text || start == null || end == null || end < start) continue
      segments.push({ start: start + offsetSeconds, end: end + offsetSeconds, text })
    }
  }
  if (segments.length === 0 && typeof record.text === "string") {
    const text = cleanSpokenText(record.text)
    if (text) segments.push({ start: offsetSeconds, end: offsetSeconds, text })
  }
  return segments
}

export function chatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return ""
  const message = (choices[0] as { message?: { content?: unknown } }).message
  return typeof message?.content === "string" ? message.content.trim() : ""
}

function groqErrorMessage(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: { message?: unknown } }).error
  if (typeof error?.message !== "string") return null
  const text = error.message.trim()
  if (!text || (key && text.includes(key))) return null
  return text
}

async function groqPost(
  url: string,
  key: string,
  body: BodyInit,
  jsonBody: boolean,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const host = new URL(url).host
  if (host !== "api.groq.com") {
    throw new StudyError("Cloud notes use Groq.", "GROQ")
  }
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(jsonBody ? { "content-type": "application/json" } : {}),
      },
      body,
    })
  } catch {
    throw new StudyError("Groq could not be reached.", "GROQ")
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new StudyError("Groq refused that API key.", "GROQ")
    }
    const detail = groqErrorMessage(payload, key)
    throw new StudyError(detail || `Groq refused the request (${response.status}).`, "GROQ")
  }
  return payload
}

export async function transcribeChunk(
  key: string,
  bytes: Uint8Array,
  filename: string,
  language: NotesLanguage,
  offsetSeconds: number,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TranscriptSegment[]> {
  const form = new FormData()
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  form.append("file", new Blob([copy]), filename)
  form.append("model", GROQ_WHISPER_MODEL)
  form.append("language", language.code)
  form.append("response_format", "verbose_json")
  form.append("temperature", "0")
  const payload = await groqPost(GROQ_TRANSCRIPTIONS_URL, key, form, false, fetchImpl)
  return parseGroqSegments(payload, offsetSeconds)
}

export async function completeChat(
  key: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const payload = await groqPost(
    GROQ_CHAT_URL,
    key,
    JSON.stringify({
      model: GROQ_NOTES_MODEL,
      temperature: 0.2,
      messages,
    }),
    true,
    fetchImpl,
  )
  const text = chatText(payload)
  if (!text) throw new StudyError("Groq did not return study notes.", "NOTES")
  return text
}
