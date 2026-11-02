import { describe, expect, it } from "vitest"
import { noteListTitle, type ListedNote } from "./noteTitle"

function note(id: string, title: string, createdAt: string, mediaFileName: string | null): ListedNote {
  return { id, title, createdAt, mediaFileName }
}

describe("note list titles", () => {
  it("adds a suffix when two notes come from the same recording", () => {
    const notes = [
      note("a", "ISC 102 U06", "2026-01-01T00:00:00.000Z", "ISC 102 U06.mp3"),
      note("b", "ISC 102 U06", "2026-01-02T00:00:00.000Z", "ISC 102 U06.mp3"),
      note("c", "Supply", "2026-01-03T00:00:00.000Z", "other.mp3"),
    ]
    expect(noteListTitle(notes[0], notes)).toBe("ISC 102 U06")
    expect(noteListTitle(notes[1], notes)).toBe("ISC 102 U06 (2)")
    expect(noteListTitle(notes[2], notes)).toBe("Supply")
  })

  it("leaves a note alone when the titles already differ", () => {
    const notes = [
      note("a", "Cells", "2026-01-01T00:00:00.000Z", "lecture.mp3"),
      note("b", "Mitosis", "2026-01-02T00:00:00.000Z", "lecture.mp3"),
    ]
    expect(noteListTitle(notes[0], notes)).toBe("Cells")
    expect(noteListTitle(notes[1], notes)).toBe("Mitosis")
  })
})
