import { CloudNotesError, StudyError } from "./errors.ts"
import type { NotesLanguage } from "./language.ts"
import { cleanSpokenText } from "./localSpeech.ts"
import type { TranscriptSegment } from "./types.ts"

/** Groq's host. The path is Groq's compatible API, not an OpenAI account. */
export const GROQ_ORIGIN = "https://api.groq.com"
export const GROQ_TRANSCRIPTIONS_URL = `${GROQ_ORIGIN}/openai/v1/audio/transcriptions`
export const GROQ_CHAT_URL = `${GROQ_ORIGIN}/openai/v1/chat/completions`

export const GROQ_WHISPER_MODEL = "whisper-large-v3-turbo"
/**
 * Production chat model on Groq's developer tier.
 * `llama-3.3-70b-versatile` was shut down for this tier on 2026-08-16.
 * Groq's model list names this id as its replacement, and the API serves it.
 */
export const GROQ_NOTES_MODEL = "openai/gpt-oss-120b"
/** Moves the bar during one speech request. A finished chunk still sets the real slice. */
export const CLOUD_WHISPER_SPEED = 10

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
    "Use a level-2 Markdown heading for each major topic.",
    "Under a heading, use a bold bullet for each subtopic and indented bullets for the facts under it.",
    "Keep the density of the speech: names, numbers, places, counts, and the order of events.",
    "Do not compress a developed account into a short overview, and do not drop a subject the speech develops.",
    "Keep every date, year, month, and named time period that was spoken, including ordinal years and relative timing.",
    "Do not invent dates.",
    "Do not invent facts.",
    "Leave out filler words, repeated false starts, music, applause, and lines such as thanks for watching.",
    "Never mention a transcript. Do not include a timestamp table or a word-for-word record.",
    "Omit a heading that would have no bullets.",
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

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text
      }
      return ""
    })
    .join("")
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
}

/** The study notes or outline Groq returned, including a parsed reasoning field that holds them. */
export function chatText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return ""
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return ""
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== "object") return ""
  const record = message as { content?: unknown; reasoning?: unknown; reasoning_content?: unknown }
  const content = stripThink(textOf(record.content))
  if (content) return content
  const reasoning = stripThink(textOf(record.reasoning ?? record.reasoning_content))
  const heading = reasoning.search(/^##\s+\S/m)
  if (heading >= 0) return reasoning.slice(heading).trim()
  if (/"sections"\s*:/.test(reasoning)) return reasoning
  return ""
}

const LOG_BODY_LIMIT = 8000

export function redactLogText(text: string, secret = ""): string {
  let out = text
  if (secret) out = out.split(secret).join("[redacted]")
  return out
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bgsk_[A-Za-z0-9_-]+\b/g, "[redacted]")
}

/** Model, HTTP status, and response body for a Groq failure. The request is not included. */
export function groqCallDetail(model: string, status: number | null, body: string, secret = ""): string {
  const redacted = redactLogText(body, secret).trim().slice(0, LOG_BODY_LIMIT)
  return [`model: ${model}`, `status: ${status == null ? "none" : String(status)}`, `body: ${redacted || "(empty)"}`].join(
    "\n",
  )
}

function groqErrorMessage(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null
  const error = (payload as { error?: { message?: unknown } }).error
  if (typeof error?.message !== "string") return null
  const text = error.message.trim()
  if (!text || (key && text.includes(key))) return null
  return text
}

/** Drop Groq's billing pitch. The app stays on this key and shortens the request instead. */
export function publicGroqMessage(text: string): string {
  return text
    .replace(/\s*Need more tokens\?[\s\S]*$/i, "")
    .replace(/\s*Upgrade to (?:the )?Dev Tier[\s\S]*$/i, "")
    .trim()
}

function retryWaitMs(message: string | null, response: Response): number {
  const header = response.headers.get("retry-after")
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000))
  }
  const match = message?.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)\s*s/i)
  if (match) return Math.min(60_000, Math.max(0, Math.round(Number(match[1]) * 1000)))
  return 1_000
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

interface GroqHttpResult {
  status: number
  raw: string
  payload: unknown
}

async function groqPost(
  url: string,
  key: string,
  body: BodyInit,
  jsonBody: boolean,
  model: string,
  fetchImpl: typeof fetch,
): Promise<GroqHttpResult> {
  void url
  void key
  void body
  void jsonBody
  void model
  void fetchImpl
  throw new CloudNotesError()
  const host = new URL(url).host
  if (host !== "api.groq.com") {
    throw new StudyError("Cloud notes use Groq.", "GROQ")
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
      throw new StudyError("Groq could not be reached.", "GROQ", groqCallDetail(model, null, "", key))
    }
    const raw = await response.text()
    let payload: unknown = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      payload = null
    }
    if (response.ok) return { status: response.status, raw, payload }
    if (response.status === 401 || response.status === 403) {
      throw new StudyError("Groq refused that API key.", "GROQ", groqCallDetail(model, response.status, raw, key))
    }
    const detail = groqErrorMessage(payload, key)
    const tooLarge = /request too large/i.test(detail ?? "")
    if (jsonBody && response.status === 429 && !tooLarge && attempt < 3) {
      await wait(retryWaitMs(detail, response))
      continue
    }
    const message = publicGroqMessage(detail ?? "") || `Groq refused the request (${response.status}).`
    throw new StudyError(message, "GROQ", groqCallDetail(model, response.status, raw, key))
  }
  throw new StudyError("Groq refused the request.", "GROQ", groqCallDetail(model, null, "", key))
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
  const result = await groqPost(GROQ_TRANSCRIPTIONS_URL, key, form, false, GROQ_WHISPER_MODEL, fetchImpl)
  return parseGroqSegments(result.payload, offsetSeconds)
}

export async function completeChat(
  key: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  fetchImpl: typeof fetch = globalThis.fetch,
  maxCompletionTokens = 1200,
): Promise<string> {
  const result = await groqPost(
    GROQ_CHAT_URL,
    key,
    JSON.stringify({
      model: GROQ_NOTES_MODEL,
      temperature: 0.2,
      reasoning_effort: "low",
      reasoning_format: "parsed",
      max_completion_tokens: maxCompletionTokens,
      messages,
    }),
    true,
    GROQ_NOTES_MODEL,
    fetchImpl,
  )
  const text = chatText(result.payload)
  if (!text) {
    throw new StudyError(
      "Groq did not return study notes.",
      "NOTES",
      groqCallDetail(GROQ_NOTES_MODEL, result.status, result.raw, key),
    )
  }
  return text
}
