import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { renderFull, renderRestyle } from "./compose"
import { renderTranscript, studySections } from "./studyNotes"
import { CloudNotesError, LocalSetupError, StudyError, messageOf } from "./errors"
import { parseNoteFile, writeFrontmatter } from "./frontmatter"
import { assertUsableFolderName, folderNameFromDisplay } from "./names"
import { parentPath } from "./paths"
import { renderPdf } from "./pdf"
import { createProvider } from "./providers"
import type { NoteContent } from "./types"

const content: NoteContent = {
  title: "Lecture 3",
  courseName: "Biology 101",
  moduleName: "Cells",
  filedAt: "2026-10-22T15:00:00.000Z",
  durationSeconds: 125,
  segments: [
    { start: 0, end: 60, text: "Mitosis begins" },
    { start: 60, end: 125, text: "The cell divides" },
  ],
  chapters: [],
  transcriptProduced: true,
}

const filedOnly: NoteContent = {
  title: "ISC 102 U01",
  courseName: "ISGS 102",
  moduleName: null,
  filedAt: "2026-10-22T15:00:00.000Z",
  durationSeconds: 57 * 60,
  segments: [{ start: 0, end: 0, text: "ISC 102 U01" }],
  chapters: [],
  transcriptProduced: false,
}

describe("command failures", () => {
  it("shows the desktop command text instead of a generic failure", () => {
    expect(messageOf("Unknown request transcribeMedia.")).toBe("Unknown request transcribeMedia.")
    expect(messageOf({ message: "Could not read that recording." })).toBe(
      "Could not read that recording.",
    )
    expect(messageOf(new StudyError("No speech was found in that recording.", "TRANSCRIPT"))).toBe(
      "No speech was found in that recording.",
    )
    expect(messageOf("  ")).toBe("Something went wrong.")
    expect(messageOf(null)).toBe("Something went wrong.")
  })
})

describe("folder names", () => {
  it("strips characters Windows rejects", () => {
    expect(folderNameFromDisplay("Biology: 101")).toBe("Biology 101")
    expect(folderNameFromDisplay("a/b")).toBe("ab")
  })

  it("rejects an empty name and reserved folders", () => {
    expect(assertUsableFolderName("Cells")).toBe("Cells")
    expect(() => assertUsableFolderName("   ")).toThrow(/Name the folder/)
    expect(() => assertUsableFolderName(":::")).toThrow(/letters or numbers/)
    expect(() => assertUsableFolderName("notes")).toThrow(/reserved/)
    expect(() => assertUsableFolderName(".study")).toThrow(/reserved/)
  })

  it("avoids Windows device names", () => {
    expect(folderNameFromDisplay("CON")).toBe("CON course")
    expect(folderNameFromDisplay("aux.mp3")).toBe("aux.mp3 course")
  })
})

describe("paths", () => {
  it("finds the parent on Windows and Unix", () => {
    expect(parentPath("/tmp/study/lecture.mp4")).toBe("/tmp/study")
    expect(parentPath("/tmp")).toBe("/")
    expect(parentPath("/")).toBeNull()
    expect(parentPath("C:\\Videos\\lecture.mp4")).toBe("C:\\Videos")
    expect(parentPath("C:\\lecture.mp4")).toBe("C:\\")
    expect(parentPath("C:\\")).toBeNull()
  })
})

describe("notes", () => {
  it("round-trips frontmatter", () => {
    const file = writeFrontmatter(
      {
        id: "note-1",
        title: 'Say "hello"',
        courseId: "course-1",
        moduleId: null,
        createdAt: "2026-10-22T15:00:00.000Z",
        updatedAt: "2026-10-22T15:00:00.000Z",
        provider: "local",
      },
      "# Say \"hello\"\n",
    )
    const parsed = parseNoteFile(file)
    expect(parsed?.meta.title).toBe('Say "hello"')
    expect(parsed?.meta.moduleId).toBeNull()
    expect(parsed?.body).toContain("# Say")
  })

  it("writes a study note and restyles it", () => {
    const full = renderFull(content)
    expect(full).toContain("# Lecture 3")
    expect(full).toContain("## Mitosis begins")
    expect(full).toContain("The cell divides")
    expect(full).not.toContain("| Time | Notes |")
    expect(full).not.toContain("## Transcript")
    expect(full).not.toContain("0:00")

    const bullets = renderRestyle(content, "bullets", "")
    expect(bullets).toContain("Biology 101")
    expect(bullets).toContain("- The cell divides.")
    expect(bullets).not.toContain("## Transcript")

    const focused = renderRestyle(content, "table", "exam review")
    expect(focused).toContain("Focus: exam review")
    expect(focused).toContain("| Topic | Points |")
    expect(focused).toContain("The cell divides")
    expect(focused).not.toContain("0:00")

    const prompted = renderRestyle(content, null, "Keep the sequence")
    expect(prompted).toContain("## Keep the sequence")
    expect(prompted).toContain("The cell divides")
    expect(() => renderRestyle(content, null, "  ")).toThrow(/preset or write a prompt/)
  })

  it("files a note when no transcript was produced", () => {
    const note = renderFull(filedOnly)
    expect(note).toContain("# ISC 102 U01")
    expect(note).toContain("57 minutes")
    expect(note).toContain("No transcript was produced.")
    expect(note).not.toContain("speech model")
    expect(note).not.toContain("## Transcript")
    expect(note).not.toContain("| Time | Notes |")
    expect(note).not.toContain("0:00")
    const bullets = renderRestyle(filedOnly, "bullets", "")
    expect(bullets).not.toContain("## Transcript")
    expect(bullets).toContain("No transcript was produced.")
    const chapters = renderFull({
      ...filedOnly,
      chapters: [{ start: 0, end: 120, title: "Introduction" }],
    })
    expect(chapters).toContain("## Chapters")
    expect(chapters).toContain("Introduction")
    expect(chapters).toContain("not a transcript")
    expect(chapters).not.toContain("## Transcript")
  })

  it("writes a PDF beside the markdown", async () => {
    const bytes = await renderPdf(renderFull(content))
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF")).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(500)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThan(0)
  })

  it("writes a PDF the course can open for a 57-minute transcript", async () => {
    const segments = Array.from({ length: 228 }, (_, index) => ({
      start: index * 15,
      end: index * 15 + 14,
      text: `Point ${index + 1} explains a distinct idea about how the cell divides and what to remember for the exam.`,
    }))
    const bytes = await renderPdf(
      renderFull({
        ...filedOnly,
        durationSeconds: 57 * 60,
        segments,
        transcriptProduced: true,
      }),
    )
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-")
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThan(1)
  })
})

describe("study notes", () => {
  const lecture: NoteContent = {
    ...content,
    title: "Cell biology",
    segments: [
      { start: 0, end: 8, text: "Um so, today we're going to talk about cell division." },
      { start: 8, end: 20, text: "Mitosis, mitosis is the process where the cell divides." },
      { start: 20, end: 32, text: "Uh the cell divides. The cell divides into two daughter cells." },
      { start: 32, end: 40, text: "[Music] na na na la la la" },
      { start: 40, end: 55, text: "Next, photosynthesis. Plants convert light into chemical energy." },
      { start: 55, end: 70, text: "Chlorophyll absorbs that light." },
      { start: 70, end: 78, text: "Thank you. Thanks for watching." },
    ],
  }

  it("turns a transcript into topics, subtopics, and nested points", () => {
    const note = renderFull(lecture)
    expect(note).toContain("## Cell division")
    expect(note).toContain("### Mitosis")
    expect(note).toContain("- Mitosis is the process where the cell divides.")
    expect(note).toContain("  - The cell divides into two daughter cells.")
    expect(note).toContain("### Photosynthesis")
    expect(note).toContain("- Plants convert light into chemical energy.")
    expect(note).toContain("  - Chlorophyll absorbs that light.")
    expect(note.toLowerCase()).not.toContain("um ")
    expect(note.toLowerCase()).not.toContain("na na")
    expect(note.toLowerCase()).not.toContain("thanks for watching")
    expect(note).not.toContain("| Time |")
    expect(studySections(lecture.segments).some((section) => section.level === 3)).toBe(true)
  })

  it("drops vocals-only gibberish and keeps the transcript separate", () => {
    const music: NoteContent = {
      ...content,
      segments: [
        { start: 0, end: 12, text: "na na na la la la [Music]" },
        { start: 12, end: 20, text: "Thanks for watching." },
      ],
    }
    const note = renderFull(music)
    expect(note).toContain("No lecture points were found in this recording.")
    expect(note.toLowerCase()).not.toContain("na na")
    expect(note).not.toContain("## Transcript")
    expect(renderTranscript(music.segments)).toContain("na na na")
    expect(renderTranscript(lecture.segments)).toContain("Mitosis, mitosis is")
  })
})

describe("providers", () => {
  it("keeps cloud notes unavailable in this build", () => {
    const cloud = createProvider("cloud")
    const probe = { size: 1, durationSeconds: 1, title: null, chapters: [] }
    expect(new CloudNotesError().message).toBe("Cloud notes are not available in this build.")
    expect(() => cloud.transcribe({ noteId: "n", title: "Lecture 3", probe })).toThrow(CloudNotesError)
    expect(() => cloud.compose(content)).toThrow(CloudNotesError)
    expect(() => cloud.restyle(content, "bullets", "")).toThrow(CloudNotesError)
    const local = createProvider("local")
    expect(() =>
      local.transcribe({
        noteId: "n",
        title: "ISC 102 U01",
        probe: { size: 57726700, durationSeconds: 3420, title: null, chapters: [] },
      }),
    ).toThrow(LocalSetupError)
    expect(() => local.compose({ ...filedOnly, durationSeconds: 3420 })).toThrow(LocalSetupError)
    expect(() => local.compose(content)).toThrow(LocalSetupError)
    expect(() => local.restyle(content, "bullets", "")).toThrow(LocalSetupError)
  })
})
