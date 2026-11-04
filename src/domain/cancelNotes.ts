import { messageOf } from "./errors"

export const NOTES_CANCELLED = "Note making was cancelled."

/** Hover and screen-reader text for the progress cancel control. */
export const CANCEL_NOTE_HELP =
  "Stop this run. A partial transcript is deleted. If the transcript is finished, unfinished notes are deleted. A finished note stays."

export function notesWereCancelled(error: unknown): boolean {
  return messageOf(error).includes("Note making was cancelled")
}

export interface CancelRollback {
  /** Whisper has already produced a transcript for this run. */
  transcriptionComplete: boolean
  /** Transcript files that exist only because this run is still transcribing. */
  partialTranscriptPaths: readonly string[]
  /** Note files this run started and has not finished saving. */
  incompleteNotePaths: readonly string[]
  /** Markdown and PDF of a note that was already saved before this run. */
  finishedNotePaths: readonly string[]
}

/** Files cancel should delete. A finished note is never included. */
export function pathsToRemoveOnCancel(rollback: CancelRollback): string[] {
  const finished = new Set(rollback.finishedNotePaths.filter(Boolean))
  const candidates = rollback.transcriptionComplete
    ? rollback.incompleteNotePaths
    : rollback.partialTranscriptPaths
  const seen = new Set<string>()
  const removed: string[] = []
  for (const target of candidates) {
    if (!target || finished.has(target) || seen.has(target)) continue
    seen.add(target)
    removed.push(target)
  }
  return removed
}
