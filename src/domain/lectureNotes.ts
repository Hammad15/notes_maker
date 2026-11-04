import { StudyError } from "./errors.ts"
import { restyleInstruction, studyNotesInstruction } from "./groq.ts"
import type { NotesLanguage } from "./language.ts"
import { NOTES_CONTEXT_TOKENS, shapeLocalStudyNotes } from "./localSpeech.ts"
import { formatClock } from "./text.ts"
import type { NoteContent, TranscriptSegment } from "./types.ts"

/**
 * Groq's developer tier allows 8000 tokens per minute for openai/gpt-oss-120b.
 * One request larger than that limit is rejected. Each notes request aims under
 * 6000 so the prompt and the completion still fit.
 */
export const GROQ_TPM_LIMIT = 8000
export const GROQ_REQUEST_TOKEN_BUDGET = 6000

/**
 * Qwen2.5-7B section size. A step up from 4096 so a lecture is fewer chunks.
 * The reply is inside this budget, and the budget stays under the 16384 context.
 */
export const LOCAL_REQUEST_TOKEN_BUDGET = 5120

const TOO_LONG = "That part of the lecture is still too long for one notes request."

type NotesWriter = "groq" | "local"

function requestLimits(writer: NotesWriter): { aim: number; limit: number } {
  if (writer === "local") return { aim: LOCAL_REQUEST_TOKEN_BUDGET, limit: NOTES_CONTEXT_TOKENS }
  return { aim: GROQ_REQUEST_TOKEN_BUDGET, limit: GROQ_TPM_LIMIT }
}

const OUTLINE_COMPLETION_TOKENS = 1200
const SUMMARY_COMPLETION_TOKENS = 500
const FILL_COMPLETION_TOKENS = 1500
const REQUEST_FRAMING_TOKENS = 32
const PACK_MARGIN_TOKENS = 80

/** A pause this long, before a new utterance, is a silence boundary. */
export const SILENCE_GAP_SECONDS = 0.8

export interface ChatMessage {
  role: "system" | "user"
  content: string
}

export interface NoteStyle {
  preset: string | null
  prompt: string
}

export interface LectureNotesRequest {
  language: NotesLanguage
  content: NoteContent
  style?: NoteStyle | null
  complete: (messages: ChatMessage[], maxCompletionTokens: number) => Promise<string>
  onStep?: (done: number, total: number) => void
  /** Cloud names Groq in errors. Local names the notes model. */
  writer?: "groq" | "local"
}

interface SpeechUnit {
  start: number
  end: number
  text: string
  /** A chunk may end here: a finished sentence, or silence before a new utterance. */
  boundary: boolean
}

interface TimeRange {
  start: number
  end: number
}

interface LectureSection {
  title: string
  ranges: TimeRange[]
}

interface MarkdownBlock {
  title: string
  body: string
}

/** Overestimates tokens so a request planned at 6000 stays under the 8000 limit. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const byChars = Math.ceil(trimmed.length / 3)
  const byWords = Math.ceil(trimmed.split(/\s+/).length * 1.5)
  return Math.max(byChars, byWords)
}

export function requestTokens(messages: Array<{ content: string }>, completionTokens: number): number {
  const input = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  return input + REQUEST_FRAMING_TOKENS + Math.max(0, completionTokens)
}

function endsSentence(text: string): boolean {
  return /[.!?]["')\]]*$/.test(text.trim())
}

function abbreviationBefore(text: string, index: number): boolean {
  const before = text.slice(0, index)
  if (/\d$/.test(before)) return true
  return /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e|St|No)\s*$/i.test(before)
}

export function splitSentences(text: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== "." && char !== "!" && char !== "?") continue
    if (char === "." && abbreviationBefore(text, index)) continue
    let end = index + 1
    while (end < text.length && /["')\]]/.test(text[end])) end += 1
    const after = text.slice(end)
    if (after.length > 0 && !/^\s/.test(after)) continue
    const sentence = text.slice(start, end).trim()
    if (sentence) parts.push(sentence)
    start = end
    index = end - 1
  }
  const rest = text.slice(start).trim()
  if (rest) parts.push(rest)
  return parts
}

function isBoundary(text: string, nextText: string | null, gapAfter: number | null): boolean {
  if (endsSentence(text)) return true
  if (gapAfter == null || gapAfter < SILENCE_GAP_SECONDS) return false
  if (!nextText) return true
  // A lowercase continuation is still the same sentence, even after a pause.
  return /^[A-Z0-9"“(]/.test(nextText.trim())
}

function spokenSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((left, right) => left.start - right.start || left.end - right.end)
}

function buildUnits(segments: TranscriptSegment[]): SpeechUnit[] {
  const spoken = spokenSegments(segments)
  const units: SpeechUnit[] = []
  for (let index = 0; index < spoken.length; index += 1) {
    const segment = spoken[index]
    const sentences = splitSentences(segment.text)
    if (sentences.length === 0) continue
    const span = Math.max(0, segment.end - segment.start)
    const weights = sentences.map((sentence) => Math.max(1, sentence.length))
    const total = weights.reduce((sum, weight) => sum + weight, 0)
    let cursor = segment.start
    sentences.forEach((sentence, sentenceIndex) => {
      const last = sentenceIndex === sentences.length - 1
      const share = span * (weights[sentenceIndex] / total)
      const start = cursor
      const end = last ? segment.end : cursor + share
      cursor = end
      const nextSegment = spoken[index + 1]
      const nextText = last
        ? nextSegment
          ? (splitSentences(nextSegment.text)[0] ?? null)
          : null
        : sentences[sentenceIndex + 1]
      const gapAfter = last ? (nextSegment ? nextSegment.start - segment.end : null) : 0
      units.push({
        start,
        end,
        text: sentence,
        boundary: isBoundary(sentence, nextText, gapAfter),
      })
    })
  }
  return units
}

function unitCost(unit: SpeechUnit): number {
  return estimateTokens(`[${formatClock(unit.start)}] ${unit.text}`) + 1
}

/**
 * Pack speech so a chunk ends on silence or a finished sentence.
 * A pause inside a sentence stays with that sentence.
 */
export function packSpeech(segments: TranscriptSegment[], maxTokens: number): TranscriptSegment[][] {
  const units = buildUnits(segments)
  if (units.length === 0) return []
  const limit = Math.max(1, maxTokens)
  const groups: SpeechUnit[][] = []
  let current: SpeechUnit[] = []
  let tokens = 0
  const flush = () => {
    if (current.length === 0) return
    groups.push(current)
    current = []
    tokens = 0
  }
  for (const unit of units) {
    const cost = unitCost(unit)
    if (current.length > 0 && tokens + cost > limit && current[current.length - 1].boundary) flush()
    current.push(unit)
    tokens += cost
  }
  flush()
  return groups.map((group) => group.map((unit) => ({ start: unit.start, end: unit.end, text: unit.text })))
}

export function packParagraphs(paragraphs: string[], maxTokens: number): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let tokens = 0
  const limit = Math.max(1, maxTokens)
  for (const paragraph of paragraphs) {
    const text = paragraph.trim()
    if (!text) continue
    const cost = estimateTokens(text) + 1
    if (current.length > 0 && tokens + cost > limit) {
      groups.push(current)
      current = []
      tokens = 0
    }
    current.push(text)
    tokens += cost
  }
  if (current.length > 0) groups.push(current)
  return groups
}

function timedTranscript(segments: TranscriptSegment[]): string {
  return spokenSegments(segments)
    .map((segment) => `[${formatClock(segment.start)}] ${segment.text}`)
    .join("\n")
}

function chunkTitle(chunk: TranscriptSegment[]): string {
  const start = chunk[0]?.start ?? 0
  const end = chunk[chunk.length - 1]?.end ?? start
  return `${formatClock(start)} to ${formatClock(end)}`
}

function bodyBudget(system: string, header: string, completionTokens: number, writer: NotesWriter): number {
  const overhead = estimateTokens(system) + estimateTokens(header) + completionTokens + REQUEST_FRAMING_TOKENS + PACK_MARGIN_TOKENS
  return Math.max(120, requestLimits(writer).aim - overhead)
}

function completionFor(messages: ChatMessage[], preferred: number, writer: NotesWriter): number {
  const { aim, limit } = requestLimits(writer)
  const input = requestTokens(messages, 0)
  if (preferred < 64 || input + preferred > aim || input + preferred > limit) {
    throw new StudyError(TOO_LONG, "NOTES")
  }
  return preferred
}

function requestFits(messages: ChatMessage[], preferred: number, writer: NotesWriter): boolean {
  try {
    completionFor(messages, preferred, writer)
    return true
  } catch (error) {
    if (error instanceof StudyError && error.message === TOO_LONG) return false
    throw error
  }
}

function splitText(text: string): [string, string] | null {
  const trimmed = text.trim()
  if (trimmed.length < 2) return null
  const midpoint = Math.floor(trimmed.length / 2)
  let cut = trimmed.lastIndexOf("\n", midpoint)
  if (cut < 1) cut = trimmed.lastIndexOf(" ", midpoint)
  if (cut < 1) cut = midpoint
  const left = trimmed.slice(0, cut).trim()
  const right = trimmed.slice(cut).trim()
  if (!left || !right || left.length >= trimmed.length || right.length >= trimmed.length) return null
  return [left, right]
}

function splitSegments(segments: TranscriptSegment[]): [TranscriptSegment[], TranscriptSegment[]] | null {
  const spoken = spokenSegments(segments)
  if (spoken.length === 0) return null
  if (spoken.length === 1) {
    const only = spoken[0]
    const halves = splitText(only.text)
    if (!halves) return null
    const mid = only.start + (only.end - only.start) / 2
    return [
      [{ start: only.start, end: mid, text: halves[0] }],
      [{ start: mid, end: only.end, text: halves[1] }],
    ]
  }
  let total = 0
  const costs = spoken.map((segment) => {
    const cost = Math.max(1, estimateTokens(segment.text))
    total += cost
    return cost
  })
  let running = 0
  let index = 1
  for (let cursor = 0; cursor < spoken.length - 1; cursor += 1) {
    running += costs[cursor]
    index = cursor + 1
    if (running >= total / 2) break
  }
  const left = spoken.slice(0, index)
  const right = spoken.slice(index)
  if (left.length === 0 || right.length === 0) return null
  return [left, right]
}

async function completeWithinBudget(
  complete: LectureNotesRequest["complete"],
  messages: ChatMessage[],
  preferred: number,
  writer: NotesWriter,
): Promise<string> {
  const completion = completionFor(messages, preferred, writer)
  return complete(messages, completion)
}

export function headingKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function cleanRange(start: unknown, end: unknown): TimeRange | null {
  const from = typeof start === "number" ? start : typeof start === "string" ? Number(start) : Number.NaN
  const to = typeof end === "number" ? end : typeof end === "string" ? Number(end) : Number.NaN
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return from <= to ? { start: from, end: to } : { start: to, end: from }
}

function rangesOf(row: { ranges?: unknown; start?: unknown; end?: unknown }): TimeRange[] {
  if (Array.isArray(row.ranges)) {
    const ranges: TimeRange[] = []
    for (const item of row.ranges) {
      if (!item || typeof item !== "object") continue
      const range = item as { start?: unknown; end?: unknown }
      const cleaned = cleanRange(range.start, range.end)
      if (cleaned) ranges.push(cleaned)
    }
    if (ranges.length > 0) return ranges
  }
  const single = cleanRange(row.start, row.end)
  return single ? [single] : []
}

function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim()
  try {
    return JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf("{")
    const end = stripped.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function collapseSections(sections: LectureSection[]): LectureSection[] {
  const order: string[] = []
  const map = new Map<string, LectureSection>()
  for (const section of sections) {
    const title = section.title.replace(/\s+/g, " ").trim()
    const key = headingKey(title)
    if (!key) continue
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { title, ranges: [...section.ranges] })
      order.push(key)
      continue
    }
    existing.ranges.push(...section.ranges)
  }
  return order.map((key) => map.get(key)!)
}

export function parseOutline(text: string): LectureSection[] {
  const parsed = extractJson(text)
  const found: LectureSection[] = []
  if (parsed && typeof parsed === "object") {
    const rows = (parsed as { sections?: unknown }).sections
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row !== "object") continue
        const record = row as { title?: unknown; ranges?: unknown; start?: unknown; end?: unknown }
        const title = typeof record.title === "string" ? record.title.trim() : ""
        if (!title) continue
        found.push({ title, ranges: rangesOf(record) })
      }
    }
  }
  if (found.length === 0) {
    for (const line of text.split(/\n+/)) {
      const match = line.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*\|\s*(.+)$/)
      if (!match) continue
      const range = cleanRange(Number(match[1]), Number(match[2]))
      const title = match[3].replace(/\s+/g, " ").trim()
      if (!range || !title) continue
      found.push({ title, ranges: [range] })
    }
  }
  return collapseSections(found)
}

function containsMid(range: TimeRange, mid: number): boolean {
  return mid >= range.start && mid <= range.end
}

function coverLecture(
  sections: LectureSection[],
  segments: TranscriptSegment[],
): Array<{ title: string; segments: TranscriptSegment[] }> {
  const spoken = spokenSegments(segments)
  const timed = sections.some((section) => section.ranges.length > 0)
  if (!timed) {
    const chunks = splitEvenly(spoken, sections.length)
    return sections.map((section, index) => ({ title: section.title, segments: chunks[index] ?? [] }))
  }
  const buckets = sections.map((section) => ({ title: section.title, segments: [] as TranscriptSegment[] }))
  for (const segment of spoken) {
    const mid = (segment.start + segment.end) / 2
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < sections.length; index += 1) {
      for (const range of sections[index].ranges) {
        if (containsMid(range, mid)) {
          best = index
          bestDistance = 0
          break
        }
        const distance = mid < range.start ? range.start - mid : mid - range.end
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      }
      if (bestDistance === 0) break
    }
    buckets[best].segments.push(segment)
  }
  return buckets
}

function splitEvenly(segments: TranscriptSegment[], count: number): TranscriptSegment[][] {
  if (count <= 1) return [segments]
  const total = Math.max(1, estimateTokens(timedTranscript(segments)))
  const target = Math.max(1, Math.ceil(total / count))
  const chunks = packSpeech(segments, target)
  if (chunks.length <= count) return chunks
  const groups: TranscriptSegment[][] = Array.from({ length: count }, () => [])
  chunks.forEach((chunk, index) => {
    const bucket = Math.min(count - 1, Math.floor((index * count) / chunks.length))
    groups[bucket].push(...chunk)
  })
  return groups
}

function outlineSystem(language: NotesLanguage): string {
  return [
    "Build one outline of the whole lecture before any section is written.",
    "You are given the full lecture, or compact summaries that cover it from start to finish.",
    "Name every sustained subject, from the start of the lecture through the end. Do not skip a subject that has its own stretch of speech.",
    "A topic that shows up in more than one part is still one section.",
    "Give each section a range that includes the events and every spoken date for that subject.",
    'Return JSON only, with this shape: {"sections":[{"title":"Supply and demand","ranges":[{"start":0,"end":90}]}]}',
    "Times are seconds. A section may have more than one range when the topic returns later.",
    "Do not write bullets, headings, or a transcript.",
    `Write the titles in ${language.name}.`,
  ].join(" ")
}

function summarySystem(language: NotesLanguage): string {
  return [
    "Write a compact summary of this part of the lecture. This is not the study note.",
    "Cover each subject in order, in at most 120 words.",
    "Keep every spoken date, year, month, named time period, name, and count. Do not drop one to stay shorter. Do not invent dates.",
    "Put the start and end seconds in the first line as START-END | summary.",
    "No headings and no transcript.",
    `Write in ${language.name}.`,
  ].join(" ")
}

/** Shorter than Groq's study-notes prompt. Qwen copies a long prompt and the transcript. */
export function localStudyNotesPrompt(language: NotesLanguage): string {
  return `Write study notes in ${language.name}. Study notes only. Use bullets. Do not copy transcript lines. Do not mention timestamps. Cut repeated points.`
}

function fillSystem(language: NotesLanguage, style: NoteStyle | null, writer: NotesWriter): string {
  if (writer === "local" && !style) return localStudyNotesPrompt(language)
  const shape = style ? restyleInstruction(language, style.preset, style.prompt) : studyNotesInstruction(language)
  const layout =
    style?.preset === "table"
      ? "Return Markdown for this section only. Reuse the section title as the topic."
      : style?.preset === "paragraphs"
        ? "Write this section only, under a level-2 heading that reuses the section title."
        : "Start with a level-2 heading that reuses the section title. Use a bold bullet for each subtopic and indented bullets for the facts under it."
  const density =
    style?.preset === "concise"
      ? ""
      : "Keep the names, numbers, places, counts, sequence of events, and every spoken date in this section. Do not replace that detail with a short overview."
  return [
    shape,
    "The lecture outline is already decided.",
    "Write only the section named below, from the speech that follows.",
    layout,
    density,
    "If that speech does not discuss this section, return no heading and no text.",
    "Do not mention a transcript, a segment, a slice, or missing source material.",
    "Do not write that something is absent.",
    "Do not invent facts.",
    "Do not invent dates.",
    "Do not write the other sections or a second copy of the lecture.",
  ]
    .filter(Boolean)
    .join(" ")
}

function whereLine(content: NoteContent): string {
  return content.moduleName ? `${content.courseName}, ${content.moduleName}` : content.courseName
}

function outlineList(sections: LectureSection[]): string {
  return sections.map((section, index) => `${index + 1}. ${section.title}`).join("\n")
}

function stripFences(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
}

function splitByHeading(markdown: string): MarkdownBlock[] {
  const lines = stripFences(markdown).split("\n")
  const blocks: Array<{ title: string; body: string[] }> = []
  let current: { title: string; body: string[] } | null = null
  const preamble: string[] = []
  for (const line of lines) {
    const heading = /^(#{1,2})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      if (current) blocks.push(current)
      else if (preamble.join("").trim()) blocks.push({ title: "", body: [...preamble] })
      current = { title: heading[2].replace(/[#]+$/g, "").trim(), body: [] }
      preamble.length = 0
      continue
    }
    if (current) current.body.push(line)
    else preamble.push(line)
  }
  if (current) blocks.push(current)
  else if (preamble.join("").trim()) blocks.push({ title: "", body: [...preamble] })
  return blocks
    .map((block) => ({ title: block.title, body: block.body.join("\n").trim() }))
    .filter((block) => block.title || block.body)
}

/** A line that only says the source does not discuss the heading. Real facts stay. */
export function isAbsenceDisclaimer(text: string): boolean {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return false
  if (/\bnot in the transcript\b/i.test(line)) return true
  if (/\bdo(?:es)? ?n[o']t contain\b/i.test(line) && /\b(?:transcript|discussion|material|information|source)\b/i.test(line)) {
    return true
  }
  if (/\bno discussion of\b/i.test(line)) return true
  if (/\btranscript segment\b/i.test(line)) return true
  if (/\b(?:provided|this|the) transcript\b/i.test(line) && /\b(?:not|no|nothing|missing|absent|lack|without|does not|doesn't)\b/i.test(line)) {
    return true
  }
  if (
    /\b(?:this|the) (?:segment|slice|excerpt|passage)\b/i.test(line) &&
    /\b(?:not|no|nothing|missing|absent|does not|doesn't|without)\b/i.test(line) &&
    /\b(?:discuss|cover|mention|includ|address|material|information)\b/i.test(line)
  ) {
    return true
  }
  if (/\b(?:missing|absent) (?:source|material|transcript|segment|slice)\b/i.test(line)) return true
  if (/\bsource material\b/i.test(line) && /\b(?:not|no|nothing|missing|absent|lack|without)\b/i.test(line)) return true
  if (/\b(?:nothing|no information|no material|no content) (?:in|on|about|for) (?:this|the) (?:section|heading|topic|part|speech)\b/i.test(line)) {
    return true
  }
  if (/\b(?:is|was|are|were) not (?:discussed|covered|mentioned|present|included|addressed)\b/i.test(line)) return true
  if (/\bnot (?:discussed|covered|mentioned|addressed) in\b/i.test(line)) return true
  return false
}

function withoutDisclaimers(body: string): string {
  const kept: string[] = []
  for (const raw of body.split("\n")) {
    const trimmed = raw.trim()
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("")
      continue
    }
    const marker = raw.match(/^(\s*(?:[-*]|\d+\.)\s+)/)
    const text = trimmed.replace(/^(?:[-*]|\d+\.)\s+/, "")
    if (/^#{1,6}\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#{1,6}\s+/, "")
      if (isAbsenceDisclaimer(title)) continue
      kept.push(raw.trimEnd())
      continue
    }
    const sentences = splitSentences(text)
    const keptSentences = (sentences.length > 0 ? sentences : [text]).filter((sentence) => !isAbsenceDisclaimer(sentence))
    if (keptSentences.length === 0) continue
    const prefix = marker?.[1] ?? ""
    kept.push(`${prefix}${keptSentences.join(" ")}`.trimEnd())
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

function mergeBodies(bodies: string[]): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const body of bodies) {
    for (const line of body.split("\n")) {
      const preserved = line.trimEnd()
      const key = preserved.trim()
      if (!key) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("")
        continue
      }
      if (seen.has(preserved)) continue
      seen.add(preserved)
      lines.push(preserved)
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

export function mergeMarkdownSections(parts: Array<{ markdown: string; title: string }>): string {
  const order: string[] = []
  const map = new Map<string, { title: string; bodies: string[] }>()
  for (const part of parts) {
    const blocks = splitByHeading(part.markdown)
    const usable = blocks.length > 0 ? blocks : [{ title: part.title, body: stripFences(part.markdown) }]
    for (const block of usable) {
      const title = isAbsenceDisclaimer(block.title) ? part.title : block.title || part.title
      if (isAbsenceDisclaimer(title)) continue
      const body = withoutDisclaimers(block.body)
      if (!body) continue
      const key = headingKey(title) || headingKey(part.title) || "notes"
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { title, bodies: [body] })
        order.push(key)
        continue
      }
      existing.bodies.push(body)
    }
  }
  return order
    .map((key) => {
      const block = map.get(key)!
      const body = withoutDisclaimers(mergeBodies(block.bodies))
      if (!body || isAbsenceDisclaimer(block.title)) return ""
      return `## ${block.title}\n\n${body}`
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function tableNote(parts: Array<{ markdown: string; title: string }>): string | null {
  const rows: string[] = []
  for (const part of parts) {
    const blocks = splitByHeading(part.markdown)
    const sources = blocks.length > 0 ? blocks : [{ title: part.title, body: stripFences(part.markdown) }]
    for (const block of sources) {
      const title = (block.title || part.title).replace(/\|/g, "/")
      if (isAbsenceDisclaimer(title)) continue
      const data = withoutDisclaimers(block.body)
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.startsWith("|") && !/^\|\s*-+/.test(line) && !/\btopic\b/i.test(line) && !isAbsenceDisclaimer(line),
        )
      if (data.length > 0) {
        rows.push(...data)
        continue
      }
      const points = withoutDisclaimers(block.body).replace(/\|/g, "/").replace(/\s+/g, " ").trim()
      if (title && points && !isAbsenceDisclaimer(points)) rows.push(`| ${title} | ${points} |`)
    }
  }
  if (rows.length === 0) return null
  return ["| Topic | Points |", "| --- | --- |", ...rows].join("\n")
}

function notesWriter(request: LectureNotesRequest): "groq" | "local" {
  return request.writer === "local" ? "local" : "groq"
}

function emptyNotesMessage(writer: "groq" | "local"): string {
  return writer === "local" ? "The notes model did not return study notes." : "Groq did not return study notes."
}

function emptyOutlineMessage(writer: "groq" | "local"): string {
  return writer === "local"
    ? "The notes model did not return an outline of the lecture."
    : "Groq did not return an outline of the lecture."
}

type NotePiece = { title: string; header: string; chunks: TranscriptSegment[][] }

function localPieces(where: string, title: string, segments: TranscriptSegment[], system: string): NotePiece[] {
  const header = [`Course: ${where}`, `Title: ${title}`, "", "Transcript:"].join("\n")
  const packed = packSpeech(segments, bodyBudget(system, header, FILL_COMPLETION_TOKENS, "local"))
  const groups = packed.length > 0 ? packed : [segments]
  return groups.map((chunk) => ({
    title: chunkTitle(chunk),
    header,
    chunks: [chunk],
  }))
}

async function groqPieces(
  request: LectureNotesRequest,
  where: string,
  title: string,
  segments: TranscriptSegment[],
  system: string,
  progress: Progress,
): Promise<NotePiece[]> {
  const writer = notesWriter(request)
  const sections = await buildOutline(request, where, title, segments, progress)
  if (sections.length === 0) throw new StudyError(emptyOutlineMessage(writer), "NOTES")
  const covered = coverLecture(sections, segments).filter((section) => section.segments.length > 0)
  if (covered.length === 0) throw new StudyError(emptyOutlineMessage(writer), "NOTES")
  const lectureOutline = outlineList(sections)
  return covered.map((section) => {
    const header = [
      `Course: ${where}`,
      `Title: ${title}`,
      "Outline of the whole lecture:",
      lectureOutline,
      `Section: ${section.title}`,
      "Transcript for this section:",
    ].join("\n")
    return {
      title: section.title,
      header,
      chunks: packSpeech(section.segments, bodyBudget(system, header, FILL_COMPLETION_TOKENS, writer)),
    }
  })
}

export async function writeLectureNotes(request: LectureNotesRequest): Promise<string> {
  const writer = notesWriter(request)
  const segments = spokenSegments(request.content.segments)
  if (segments.length === 0) throw new StudyError("No speech was found in that recording.", "TRANSCRIPT")
  const where = whereLine(request.content)
  const title = request.content.title.replace(/\s+/g, " ").trim() || "Untitled recording"
  let done = 0
  let total = 1
  const report = () => request.onStep?.(done, total)
  const plan = (count: number) => {
    total = Math.max(total, count)
    report()
  }
  const finish = () => {
    done += 1
    total = Math.max(total, done)
    report()
  }
  const more = () => {
    total += 1
    report()
  }

  const system = fillSystem(request.language, request.style ?? null, writer)
  const pieces =
    writer === "local"
      ? localPieces(where, title, segments, system)
      : await groqPieces(request, where, title, segments, system, { plan, finish, more })
  const fillCount = pieces.reduce((sum, piece) => sum + piece.chunks.length, 0)
  plan(done + fillCount)

  const written: Array<{ markdown: string; title: string }> = []
  let omitted: StudyError | null = null
  const writeChunk = async (header: string, sectionTitle: string, chunk: TranscriptSegment[]) => {
    const transcript = timedTranscript(chunk)
    if (!transcript.trim()) return
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `${header}\n${transcript}` },
    ]
    if (!requestFits(messages, FILL_COMPLETION_TOKENS, writer)) {
      const parts = splitSegments(chunk)
      if (!parts) throw new StudyError(TOO_LONG, "NOTES")
      more()
      await writeChunk(header, sectionTitle, parts[0])
      await writeChunk(header, sectionTitle, parts[1])
      return
    }
    let text = ""
    try {
      text = (await completeWithinBudget(request.complete, messages, FILL_COMPLETION_TOKENS, writer)).trim()
    } catch (error) {
      if (!omittedSection(error)) throw error
      omitted = error
      finish()
      return
    }
    if (!text) {
      omitted = omitted ?? new StudyError(emptyNotesMessage(writer), "NOTES")
      finish()
      return
    }
    written.push({ markdown: text, title: sectionTitle })
    finish()
  }
  for (const piece of pieces) {
    for (const chunk of piece.chunks) {
      await writeChunk(piece.header, piece.title, chunk)
    }
  }
  if (written.length === 0) {
    throw omitted ?? new StudyError(emptyNotesMessage(writer), "NOTES")
  }
  const merged =
    request.style?.preset === "table"
      ? tableNote(written) || mergeMarkdownSections(written)
      : mergeMarkdownSections(written)
  const cleaned = withoutDisclaimers(merged.replace(/\n## Transcript\b[\s\S]*$/i, "")).trim()
  const notes =
    writer === "local" && request.style?.preset !== "table" && request.style?.preset !== "paragraphs"
      ? shapeLocalStudyNotes(cleaned)
      : cleaned
  if (!notes) {
    const returned = written
      .map((part) => part.markdown.trim())
      .filter(Boolean)
      .join("\n\n")
    throw new StudyError(
      emptyNotesMessage(writer),
      "NOTES",
      omitted?.detail ?? (returned ? `body: ${returned.slice(0, 8000)}` : null),
    )
  }
  return notes
}

function omittedSection(error: unknown): error is StudyError {
  return (
    error instanceof StudyError &&
    error.code === "NOTES" &&
    (error.message === "Groq did not return study notes." ||
      error.message === "The notes model did not return study notes.")
  )
}

interface Progress {
  plan: (count: number) => void
  finish: () => void
  more: () => void
}

async function buildOutline(
  request: LectureNotesRequest,
  where: string,
  title: string,
  segments: TranscriptSegment[],
  progress: Progress,
): Promise<LectureSection[]> {
  const writer = notesWriter(request)
  const system = outlineSystem(request.language)
  const header = `Course: ${where}\nTitle: ${title}\n\nLecture:\n`
  const full = timedTranscript(segments)
  const budget = bodyBudget(system, header, OUTLINE_COMPLETION_TOKENS, writer)
  const compact = estimateTokens(full) > budget
  const source = compact ? await compactLecture(request, where, title, segments, progress) : full
  const outlineSource = async (part: string): Promise<LectureSection[]> => {
    const user = compact
      ? `Course: ${where}\nTitle: ${title}\n\nCompact summaries of the whole lecture, in order:\n${part}`
      : `${header}${part}`
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ]
    if (!requestFits(messages, OUTLINE_COMPLETION_TOKENS, writer)) {
      const halves = splitText(part)
      if (!halves) throw new StudyError(TOO_LONG, "NOTES")
      progress.more()
      const left = await outlineSource(halves[0])
      const right = await outlineSource(halves[1])
      return collapseSections([...left, ...right])
    }
    const text = await completeWithinBudget(request.complete, messages, OUTLINE_COMPLETION_TOKENS, writer)
    return parseOutline(text)
  }
  const sections = await outlineSource(source)
  progress.finish()
  return sections
}

async function compactLecture(
  request: LectureNotesRequest,
  where: string,
  title: string,
  segments: TranscriptSegment[],
  progress: Progress,
): Promise<string> {
  const writer = notesWriter(request)
  const system = summarySystem(request.language)
  const header = `Course: ${where}\nTitle: ${title}\n\nPart of the lecture:\n`
  const summarizePiece = async (piece: string): Promise<string> => {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `${header}${piece}` },
    ]
    if (!requestFits(messages, SUMMARY_COMPLETION_TOKENS, writer)) {
      const halves = splitText(piece)
      if (!halves) throw new StudyError(TOO_LONG, "NOTES")
      progress.more()
      const left = await summarizePiece(halves[0])
      const right = await summarizePiece(halves[1])
      return [left, right].filter(Boolean).join("\n")
    }
    return (await completeWithinBudget(request.complete, messages, SUMMARY_COMPLETION_TOKENS, writer)).trim()
  }
  let pieces = packSpeech(segments, bodyBudget(system, header, SUMMARY_COMPLETION_TOKENS, writer)).map((chunk) =>
    timedTranscript(chunk),
  )
  if (pieces.length === 0) pieces = [timedTranscript(segments)]
  let guard = 0
  const outlineBudgetFor = () =>
    bodyBudget(outlineSystem(request.language), `Course: ${where}\nTitle: ${title}\n\n`, OUTLINE_COMPLETION_TOKENS, writer)
  while (pieces.length > 1 && guard < 4) {
    guard += 1
    const outlineBudget = outlineBudgetFor()
    if (estimateTokens(pieces.join("\n")) <= outlineBudget) break
    progress.plan(pieces.length)
    const summaries: string[] = []
    for (const piece of pieces) {
      summaries.push(await summarizePiece(piece))
      progress.finish()
    }
    const joined = summaries.filter(Boolean).join("\n")
    if (!joined || joined.length >= pieces.join("\n").length) return joined || pieces.join("\n")
    const grouped = packParagraphs(summaries, outlineBudget)
    if (grouped.length === 1) return joined
    pieces = grouped.map((group) => group.join("\n"))
  }
  if (pieces.length === 1 && estimateTokens(pieces[0]) > outlineBudgetFor()) {
    const summary = await summarizePiece(pieces[0])
    progress.finish()
    return summary
  }
  return pieces.join("\n")
}
