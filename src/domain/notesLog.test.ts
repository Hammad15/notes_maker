import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StudyError } from "./errors"
import { notesFailureReport, notesLogPath, recordMakeNotesFailure } from "./notesLog"
import { createNodeFileStore, resolveAppDataDir } from "../server/nodeFs"

describe("Make Notes failure log", () => {
  let root = ""

  afterEach(async () => {
    vi.restoreAllMocks()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it("uses the Study Notes logs folder", () => {
    const appData = resolveAppDataDir("win32", { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "C:\\Users\\Ada")
    expect(notesLogPath(appData)).toBe(path.win32.join(appData, "logs", "make-notes.log"))
  })

  it("writes the same lines to the log file and the console", async () => {
    root = await mkdtemp(path.join(tmpdir(), "study-notes-log-"))
    const store = createNodeFileStore(path.join(root, "appdata"))
    const error = new StudyError(
      "Groq did not return study notes.",
      "NOTES",
      "model: openai/gpt-oss-120b\nstatus: 200\nbody: {\"choices\":[{\"message\":{\"content\":null}}]}",
    )
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await recordMakeNotesFailure(store, "ISC 102 U06.mp3", error)
    const file = notesLogPath(await store.appDataDir())
    const text = await store.readText(file)
    const printed = String(errors.mock.calls[0]?.[0])
    expect(text?.trim()).toBe(printed)
    expect(printed).toContain("Could not write notes for ISC 102 U06.mp3. Groq did not return study notes.")
    expect(printed).toContain("model: openai/gpt-oss-120b")
    expect(printed).toContain("status: 200")
    expect(printed).toContain("body:")
    expect(await store.stat(path.join(await store.appDataDir(), "logs"))).toMatchObject({ isDir: true })
  })

  it("leaves the API key out of the report", () => {
    const key = "gsk_secret_value"
    const report = notesFailureReport(
      "ISC 102 U06.mp3",
      new StudyError("Groq did not return study notes.", "NOTES", `model: openai/gpt-oss-120b\nstatus: 200\nbody: bad ${key}`),
    )
    expect(report).not.toContain(key)
    expect(report).toContain("[redacted]")
  })
})
