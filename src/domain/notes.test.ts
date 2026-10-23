import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { renderFull, renderRestyle } from "./compose"
import { EntitlementError } from "./errors"
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
}

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
    expect(full).toContain("Mitosis begins")
    expect(full).toContain("| Time | Notes |")

    const bullets = renderRestyle(content, "bullets", "")
    expect(bullets).toContain("- Course: Biology 101")
    expect(bullets).not.toContain("## Transcript")

    const focused = renderRestyle(content, "table", "exam review")
    expect(focused).toContain("Focus: exam review")
    expect(focused).toContain("| 0:00–1:00 | Mitosis begins |")

    const prompted = renderRestyle(content, null, "Keep the sequence")
    expect(prompted).toContain("## Keep the sequence")
    expect(() => renderRestyle(content, null, "  ")).toThrow(/preset or write a prompt/)
  })

  it("writes a PDF beside the markdown", async () => {
    const bytes = await renderPdf(renderFull(content))
    expect(Buffer.from(bytes).toString("latin1").startsWith("%PDF")).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(500)
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThan(0)
  })
})

describe("providers", () => {
  it("refuses cloud notes until an entitlement exists", () => {
    const cloud = createProvider("cloud", { entitled: false, source: "missing" })
    expect(() =>
      cloud.transcribe({
        noteId: "n",
        title: "Lecture 3",
        probe: { size: 1, durationSeconds: 1, title: null, chapters: [] },
      }),
    ).toThrow(EntitlementError)
    const entitled = createProvider("cloud", { entitled: true, source: "license" })
    expect(entitled.transcribe({
      noteId: "n",
      title: "Lecture 3",
      probe: { size: 1, durationSeconds: 1, title: null, chapters: [] },
    }).provider).toBe("cloud")
    const local = createProvider("local", { entitled: false, source: "missing" })
    expect(local.compose(content)).toContain("Lecture 3")
  })
})
