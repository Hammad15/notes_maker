import { StudyError } from "./errors"
import { formatStudyBody, studySections, type StudySection } from "./studyNotes"
import { formatDurationWords, formatFiledDate, formatRange } from "./text"
import type { NoteContent, Preset, TranscriptSegment } from "./types"

function safeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Untitled recording"
}

function whereLine(content: NoteContent): string {
  return content.moduleName
    ? `${content.courseName}, ${content.moduleName}`
    : content.courseName
}

function metaLine(content: NoteContent): string {
  const parts = [content.courseName]
  if (content.moduleName) parts.push(content.moduleName)
  parts.push(formatFiledDate(content.filedAt))
  const duration = formatDurationWords(content.durationSeconds)
  if (duration) parts.push(duration)
  return parts.join(" · ")
}

function summarySentence(content: NoteContent): string {
  const duration = formatDurationWords(content.durationSeconds)
  const where = whereLine(content)
  const filed = duration
    ? `${safeTitle(content.title)} is filed in ${where}. The recording runs ${duration}.`
    : `${safeTitle(content.title)} is filed in ${where}.`
  if (hasTranscript(content)) return filed
  return `${filed} No transcript was produced.`
}

function transcriptSegments(content: NoteContent): TranscriptSegment[] {
  if (!content.transcriptProduced) return []
  return content.segments.filter((segment) => segment.text.trim())
}

function hasTranscript(content: NoteContent): boolean {
  return transcriptSegments(content).length > 0
}

function outlineLines(content: NoteContent): string[] {
  const spoken = transcriptSegments(content)
  if (spoken.length > 0) {
    return spoken.map((segment) => {
      const text = segment.text.replace(/\s+/g, " ").trim()
      return `- ${formatRange(segment.start, segment.end)} ${text}`
    })
  }
  if (content.chapters.length > 0) {
    return content.chapters.map((chapter) => {
      const text = chapter.title.replace(/\s+/g, " ").trim() || "Untitled chapter"
      return `- ${formatRange(chapter.start, chapter.end)} ${text}`
    })
  }
  return ["- No transcript was produced."]
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "/").replace(/\s+/g, " ").trim()
}

function studyBody(content: NoteContent): string {
  return formatStudyBody(studySections(transcriptSegments(content)))
}

function studyTable(sections: StudySection[]): string[] {
  const rows = sections
    .filter((section) => section.level === 3 || section.bullets.length > 0)
    .map((section) => {
      const points = section.bullets.flatMap((bullet) => [bullet.text, ...bullet.children])
      return `| ${escapeCell(section.title)} | ${escapeCell(points.join(" "))} |`
    })
    .filter((row) => !row.endsWith("|  |"))
  if (rows.length === 0) return ["No lecture points were found in this recording."]
  return ["| Topic | Points |", "| --- | --- |", ...rows]
}

function chapterRows(content: NoteContent): string[] {
  return content.chapters.map((chapter) => {
    const title = escapeCell(chapter.title) || "Untitled chapter"
    return `| ${formatRange(chapter.start, chapter.end)} | ${title} |`
  })
}

function proseBody(content: NoteContent): string {
  const summary = summarySentence(content)
  const segments = transcriptSegments(content)
  if (segments.length === 0) return summary
  if (segments.length === 1) {
    const only = segments[0]
    return `${summary} The transcript line is "${only.text.replace(/\s+/g, " ").trim()}".`
  }
  const sentences = segments
    .map((segment) => {
      const text = segment.text.replace(/\s+/g, " ").trim()
      return `From ${formatRange(segment.start, segment.end)}, ${text}.`
    })
    .join(" ")
  return `${summary}\n\n${sentences}`
}

function heading(content: NoteContent): string {
  return `# ${safeTitle(content.title)}`
}

const NOT_A_TRANSCRIPT = "These are chapter markers from the file, not a transcript."

export function renderFull(content: NoteContent): string {
  const lines = [heading(content), "", metaLine(content), ""]
  if (hasTranscript(content)) {
    lines.push(studyBody(content).trimEnd(), "")
  } else if (content.chapters.length > 0) {
    lines.push(
      "## Summary",
      "",
      summarySentence(content),
      "",
      "## Chapters",
      "",
      ...outlineLines(content),
      "",
      NOT_A_TRANSCRIPT,
      "",
    )
  } else {
    lines.push("## Summary", "", summarySentence(content), "", "## Outline", "", ...outlineLines(content), "")
  }
  return lines.join("\n")
}

function renderConcise(content: NoteContent): string {
  if (hasTranscript(content)) {
    const sections = studySections(transcriptSegments(content)).filter(
      (section) => section.bullets.length > 0 || section.level === 2,
    )
    const shown = sections.slice(0, 3)
    const extra = sections.length - shown.length
    const parts = [heading(content), "", metaLine(content), "", formatStudyBody(shown).trimEnd()]
    if (extra > 0) parts.push("", `- ${extra} later ${extra === 1 ? "topic" : "topics"}.`)
    return `${parts.join("\n")}\n`
  }
  const lines = outlineLines(content)
  const shown = lines.slice(0, 5)
  const extra = lines.length - shown.length
  const parts = [heading(content), "", metaLine(content), "", summarySentence(content), "", ...shown]
  if (extra > 0) {
    parts.push(`- ${extra} later ${extra === 1 ? "section" : "sections"}.`)
  }
  return `${parts.join("\n")}\n`
}

function renderBullets(content: NoteContent): string {
  if (hasTranscript(content)) {
    return `${heading(content)}\n\n${metaLine(content)}\n\n${studyBody(content)}`
  }
  const items = [`- Course: ${content.courseName}`]
  if (content.moduleName) items.push(`- Module: ${content.moduleName}`)
  const duration = formatDurationWords(content.durationSeconds)
  if (duration) items.push(`- Length: ${duration}`)
  items.push(`- Filed: ${formatFiledDate(content.filedAt)}`)
  items.push(...outlineLines(content))
  return `${heading(content)}\n\n${metaLine(content)}\n\n${items.join("\n")}\n`
}

function renderParagraphs(content: NoteContent): string {
  if (!hasTranscript(content)) {
    return `${heading(content)}\n\n${metaLine(content)}\n\n${proseBody(content)}\n`
  }
  const sections = studySections(transcriptSegments(content))
  const prose = sections
    .map((section) => {
      const points = section.bullets.flatMap((bullet) => [bullet.text, ...bullet.children])
      return points.length > 0 ? `${section.title}. ${points.join(" ")}` : section.title
    })
    .join("\n\n")
  return `${heading(content)}\n\n${metaLine(content)}\n\n${prose || "No lecture points were found in this recording."}\n`
}

function renderTable(content: NoteContent): string {
  if (!hasTranscript(content)) {
    const lines = [heading(content), "", metaLine(content), "", summarySentence(content), ""]
    if (content.chapters.length > 0) {
      lines.push("| Time | Chapter |", "| --- | --- |", ...chapterRows(content), "", NOT_A_TRANSCRIPT, "")
    }
    return lines.join("\n")
  }
  return [heading(content), "", metaLine(content), "", ...studyTable(studySections(transcriptSegments(content))), ""].join(
    "\n",
  )
}

function promptHeading(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim()
  const headingText = clean || "Restyle"
  if (headingText.length <= 120) return headingText
  return `${headingText.slice(0, 117).trimEnd()}...`
}

function renderPrompt(content: NoteContent, prompt: string): string {
  const body = hasTranscript(content) ? studyBody(content) : `${proseBody(content)}\n`
  return `${heading(content)}\n\n${metaLine(content)}\n\n## ${promptHeading(prompt)}\n\n${body}`
}

function insertFocus(markdown: string, prompt: string): string {
  const lines = markdown.replace(/\s+$/, "").split("\n")
  let seenTitle = false
  let metaIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (!seenTitle && lines[i].startsWith("# ")) {
      seenTitle = true
      continue
    }
    if (seenTitle && lines[i].trim()) {
      metaIndex = i
      break
    }
  }
  const focus = `Focus: ${prompt.replace(/\s+/g, " ").trim()}`
  if (metaIndex === -1) return `${markdown.trim()}\n\n${focus}\n`
  lines.splice(metaIndex + 1, 0, "", focus)
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`
}

export function renderRestyle(
  content: NoteContent,
  preset: Preset | null,
  prompt: string,
): string {
  const focus = prompt.trim()
  if (!preset && !focus) {
    throw new StudyError("Choose a preset or write a prompt.", "RESTYLE")
  }
  const body = preset
    ? renderPreset(content, preset)
    : renderPrompt(content, focus)
  if (preset && focus) return insertFocus(body, focus)
  return body
}

function renderPreset(content: NoteContent, preset: Preset): string {
  switch (preset) {
    case "concise":
      return renderConcise(content)
    case "bullets":
      return renderBullets(content)
    case "paragraphs":
      return renderParagraphs(content)
    case "table":
      return renderTable(content)
  }
}
