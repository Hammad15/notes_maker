export interface ListedNote {
  id: string
  title: string
  createdAt: string
  mediaFileName: string | null
}

/** A later note from the same recording gets (2), (3), so the list can tell them apart. */
export function noteListTitle(note: ListedNote, notes: ListedNote[]): string {
  const media = note.mediaFileName
  if (!media) return note.title
  const same = notes.filter((item) => item.mediaFileName === media && item.title === note.title)
  if (same.length < 2) return note.title
  same.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
    return left.id < right.id ? -1 : 1
  })
  const index = same.findIndex((item) => item.id === note.id)
  if (index <= 0) return note.title
  return `${note.title} (${index + 1})`
}
