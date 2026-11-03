import { describe, expect, it } from "vitest"
import { isUnfinishedNoteFile, pathsToRemoveOnCancel } from "./cancelNotes"

describe("cancel rollback", () => {
  it("deletes a partial transcript and leaves a finished note", () => {
    expect(
      pathsToRemoveOnCancel({
        transcriptionComplete: false,
        partialTranscriptPaths: ["/tmp/lecture.json", "/tmp/lecture.wav"],
        incompleteNotePaths: ["/course/notes/Lecture.md.partial"],
        finishedNotePaths: ["/course/notes/Lecture.md", "/course/notes/Lecture.pdf"],
      }),
    ).toEqual(["/tmp/lecture.json", "/tmp/lecture.wav"])
  })

  it("deletes unfinished notes after the transcript is done and keeps that transcript", () => {
    expect(
      pathsToRemoveOnCancel({
        transcriptionComplete: true,
        partialTranscriptPaths: ["/tmp/lecture.json"],
        incompleteNotePaths: ["/course/notes/Lecture.md.partial", "/course/notes/Lecture.pdf.partial"],
        finishedNotePaths: [],
      }),
    ).toEqual(["/course/notes/Lecture.md.partial", "/course/notes/Lecture.pdf.partial"])
  })

  it("treats only staged note files as unfinished", () => {
    expect(isUnfinishedNoteFile("Lecture.md.partial")).toBe(true)
    expect(isUnfinishedNoteFile("Lecture.pdf.partial")).toBe(true)
    expect(isUnfinishedNoteFile("Lecture.md")).toBe(false)
    expect(isUnfinishedNoteFile("Lecture.pdf")).toBe(false)
    expect(isUnfinishedNoteFile("transcript.json")).toBe(false)
  })

  it("does not delete a finished note while replacement notes are unfinished", () => {
    expect(
      pathsToRemoveOnCancel({
        transcriptionComplete: true,
        partialTranscriptPaths: [],
        incompleteNotePaths: [
          "/course/notes/Lecture.md",
          "/course/notes/Lecture.md.partial",
          "/course/notes/Lecture.pdf.partial",
        ],
        finishedNotePaths: ["/course/notes/Lecture.md", "/course/notes/Lecture.pdf"],
      }),
    ).toEqual(["/course/notes/Lecture.md.partial", "/course/notes/Lecture.pdf.partial"])
  })
})
