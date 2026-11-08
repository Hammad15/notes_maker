import { describe, expect, it } from "vitest"
import type { ListedNote } from "./noteTitle"
import {
  compareNatural,
  DEFAULT_NOTE_SORT,
  nextNoteSort,
  sortModules,
  sortNotes,
  sortOptionName,
} from "./noteSort"

function note(id: string, title: string, createdAt: string, mediaFileName: string | null = null): ListedNote {
  return { id, title, createdAt, mediaFileName }
}

describe("natural note titles", () => {
  it("orders lecture numbers as integers and ignores letter case", () => {
    const notes = [
      note("c", "Lecture 15", "2026-03-01T00:00:00.000Z"),
      note("a", "Lecture 5", "2026-01-01T00:00:00.000Z"),
      note("b", "lecture 10", "2026-02-01T00:00:00.000Z"),
    ]
    expect(sortNotes(notes, notes, "name", "asc").map((item) => item.id)).toEqual(["a", "b", "c"])
    expect(sortNotes(notes, notes, "name", "desc").map((item) => item.id)).toEqual(["c", "b", "a"])
    expect(compareNatural("Week 2", "week 10")).toBeLessThan(0)
    expect(compareNatural("Lecture 05", "lecture 5")).toBe(0)
  })

  it("sorts the title shown in the list, including a duplicate suffix", () => {
    const notes = [
      note("b", "Lecture 5", "2026-01-02T00:00:00.000Z", "lecture.mp3"),
      note("a", "Lecture 5", "2026-01-01T00:00:00.000Z", "lecture.mp3"),
      note("c", "Lecture 10", "2026-01-03T00:00:00.000Z", "other.mp3"),
    ]
    expect(sortNotes(notes, notes, "name", "asc").map((item) => item.id)).toEqual(["a", "b", "c"])
  })

  it("sorts dates by createdAt and keeps each option's direction", () => {
    const notes = [
      note("new", "Lecture 5", "2026-03-01T00:00:00.000Z"),
      note("old", "Lecture 10", "2026-01-01T00:00:00.000Z"),
    ]
    expect(sortNotes(notes, notes, "date", "asc").map((item) => item.id)).toEqual(["old", "new"])
    expect(sortNotes(notes, notes, "date", "desc").map((item) => item.id)).toEqual(["new", "old"])
    expect(sortNotes(notes, notes, "name", "asc").map((item) => item.id)).toEqual(["new", "old"])

    expect(DEFAULT_NOTE_SORT).toEqual({ noteSort: "name", noteSortName: "asc", noteSortDate: "asc" })
    const dated = nextNoteSort(DEFAULT_NOTE_SORT, "date")
    expect(dated).toEqual({ noteSort: "date", noteSortName: "asc", noteSortDate: "asc" })
    const nameDesc = nextNoteSort(DEFAULT_NOTE_SORT, "name")
    expect(nameDesc.noteSortName).toBe("desc")
    const dateKeepsName = nextNoteSort({ ...nameDesc, noteSortDate: "desc" }, "date")
    expect(dateKeepsName).toEqual({ noteSort: "date", noteSortName: "desc", noteSortDate: "desc" })
    expect(nextNoteSort(dateKeepsName, "date").noteSortDate).toBe("asc")
    expect(nextNoteSort(dateKeepsName, "name").noteSortName).toBe("desc")
  })

  it("orders lecture modules so Lecture 5 comes before Lecture 10 and Lecture 15", () => {
    const modules = [
      { id: "15", name: "Lecture 15", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "5", name: "Lecture 5", createdAt: "2026-03-01T00:00:00.000Z" },
      { id: "10", name: "Lecture 10", createdAt: "2026-02-01T00:00:00.000Z" },
    ]
    const notes = [
      note("n15", "ISC 102 U15", "2026-04-01T00:00:00.000Z"),
      note("n5", "ISC 102 U05", "2026-01-02T00:00:00.000Z"),
      note("n10", "ISC 102 U10", "2026-02-02T00:00:00.000Z"),
    ].map((item, index) => ({ ...item, moduleId: modules[index].id }))
    expect(sortModules(modules, notes, "name", "asc").map((item) => item.name)).toEqual([
      "Lecture 5",
      "Lecture 10",
      "Lecture 15",
    ])
    expect(sortModules(modules, notes, "name", "desc").map((item) => item.id)).toEqual(["15", "10", "5"])
    expect(sortModules(modules, notes, "date", "asc").map((item) => item.id)).toEqual(["5", "10", "15"])
  })

  it("names the direction the next activation will apply", () => {
    const sort = { noteSort: "name" as const, noteSortName: "asc" as const, noteSortDate: "desc" as const }
    expect(sortOptionName(sort, "name")).toBe("Sort by name, descending")
    expect(sortOptionName(sort, "date")).toBe("Sort by date, descending")
    expect(sortOptionName(nextNoteSort(sort, "name"), "name")).toBe("Sort by name, ascending")
  })
})
