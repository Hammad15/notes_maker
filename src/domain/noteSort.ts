import { noteListTitle, type ListedNote } from "./noteTitle"

export type NoteSortKey = "name" | "date"
export type NoteSortDirection = "asc" | "desc"

export interface NoteSortSettings {
  noteSort: NoteSortKey
  noteSortName: NoteSortDirection
  noteSortDate: NoteSortDirection
}

export const DEFAULT_NOTE_SORT: NoteSortSettings = {
  noteSort: "name",
  noteSortName: "asc",
  noteSortDate: "asc",
}

export function noteSortKey(value: unknown): NoteSortKey {
  return value === "date" ? "date" : "name"
}

export function noteSortDirection(value: unknown): NoteSortDirection {
  return value === "desc" ? "desc" : "asc"
}

export function directionFor(sort: NoteSortSettings, key: NoteSortKey): NoteSortDirection {
  return key === "name" ? sort.noteSortName : sort.noteSortDate
}

/** Direction the next activation applies. The active option flips. The other option keeps its own direction. */
export function upcomingSortDirection(sort: NoteSortSettings, key: NoteSortKey): NoteSortDirection {
  const stored = directionFor(sort, key)
  if (sort.noteSort !== key) return stored
  return stored === "asc" ? "desc" : "asc"
}

/** Accessible name for an option. It names the direction activation will apply. */
export function sortOptionName(sort: NoteSortSettings, key: NoteSortKey): string {
  const direction = upcomingSortDirection(sort, key) === "asc" ? "ascending" : "descending"
  return `Sort by ${key}, ${direction}`
}

export function nextNoteSort(sort: NoteSortSettings, key: NoteSortKey): NoteSortSettings {
  if (sort.noteSort !== key) return { ...sort, noteSort: key }
  if (key === "name") {
    return { ...sort, noteSortName: sort.noteSortName === "asc" ? "desc" : "asc" }
  }
  return { ...sort, noteSortDate: sort.noteSortDate === "asc" ? "desc" : "asc" }
}

/** Case-insensitive text, with digit runs compared as integers. */
export function compareNatural(left: string, right: string): number {
  const leftChunks = left.match(/\d+|\D+/g) ?? []
  const rightChunks = right.match(/\d+|\D+/g) ?? []
  const count = Math.min(leftChunks.length, rightChunks.length)
  for (let index = 0; index < count; index += 1) {
    const a = leftChunks[index]
    const b = rightChunks[index]
    const diff = /^\d+$/.test(a) && /^\d+$/.test(b) ? compareInteger(a, b) : a.localeCompare(b, undefined, { sensitivity: "accent" })
    if (diff !== 0) return diff
  }
  if (leftChunks.length === rightChunks.length) return 0
  return leftChunks.length < rightChunks.length ? -1 : 1
}

function compareInteger(left: string, right: string): number {
  const a = left.replace(/^0+/, "") || "0"
  const b = right.replace(/^0+/, "") || "0"
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

type ModuleNote = ListedNote & { moduleId: string | null }

export interface SortableModule {
  id: string
  name: string
  createdAt: string
}

/** Earliest note in the module. A module with no notes uses its own createdAt. */
export function moduleSortDate(moduleId: string, createdAt: string, notes: readonly ModuleNote[]): string {
  let earliest: string | null = null
  for (const note of notes) {
    if (note.moduleId !== moduleId) continue
    if (earliest == null || note.createdAt < earliest) earliest = note.createdAt
  }
  return earliest ?? createdAt
}

export function sortModules<T extends SortableModule>(
  modules: readonly T[],
  notes: readonly ModuleNote[],
  key: NoteSortKey,
  direction: NoteSortDirection,
): T[] {
  const sorted = [...modules]
  sorted.sort((left, right) => {
    let diff = 0
    if (key === "date") {
      const leftDate = moduleSortDate(left.id, left.createdAt, notes)
      const rightDate = moduleSortDate(right.id, right.createdAt, notes)
      if (leftDate !== rightDate) diff = leftDate < rightDate ? -1 : 1
    } else {
      diff = compareNatural(left.name, right.name)
    }
    if (diff === 0) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    return direction === "desc" ? -diff : diff
  })
  return sorted
}

export function sortNotes<T extends ListedNote>(
  visible: readonly T[],
  all: readonly ListedNote[],
  key: NoteSortKey,
  direction: NoteSortDirection,
): T[] {
  const sorted = [...visible]
  sorted.sort((left, right) => {
    let diff = 0
    if (key === "date") {
      if (left.createdAt !== right.createdAt) diff = left.createdAt < right.createdAt ? -1 : 1
    } else {
      diff = compareNatural(noteListTitle(left, all), noteListTitle(right, all))
    }
    if (diff === 0) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    return direction === "desc" ? -diff : diff
  })
  return sorted
}
