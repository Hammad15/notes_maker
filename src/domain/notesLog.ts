import { StudyError, messageOf } from "./errors"
import { redactLogText } from "./groq"
import { joinPath } from "./paths"
import type { FileStore } from "../platform/types"

export const NOTES_LOG_FILE = "make-notes.log"

/** %LOCALAPPDATA%\Study Notes\logs\make-notes.log on Windows. */
export function notesLogPath(appData: string): string {
  return joinPath(appData, "logs", NOTES_LOG_FILE)
}

export function notesFailureReport(label: string, error: unknown, at = new Date()): string {
  const lines = [`${at.toISOString()} Could not write notes for ${label}. ${messageOf(error)}`]
  if (error instanceof StudyError && error.detail) lines.push(error.detail)
  return redactLogText(lines.join("\n"))
}

/** Append one Make Notes failure to the log file and print those same lines. */
export async function recordMakeNotesFailure(store: FileStore, label: string, error: unknown): Promise<void> {
  const report = notesFailureReport(label, error)
  console.error(report)
  try {
    const appData = await store.appDataDir()
    const file = notesLogPath(appData)
    await store.mkdir(joinPath(appData, "logs"))
    const previous = (await store.readText(file)) ?? ""
    const prefix = previous.length === 0 ? "" : previous.endsWith("\n") ? previous : `${previous}\n`
    await store.writeText(file, `${prefix}${report}\n`)
  } catch (err) {
    console.error(messageOf(err))
  }
}
