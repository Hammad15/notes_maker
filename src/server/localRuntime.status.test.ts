import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { abandonInterruptedNotes, cancelMakeNotes, localRuntimeStatus, markTranscriptFiled } from "./localRuntime"

describe("local setup for one speech speed", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it("stays not ready for Clearer when only a Faster file is on disk", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "study-notes-pace-"))
    await mkdir(path.join(dir, "models"), { recursive: true })
    await writeFile(path.join(dir, "models", "ggml-tiny.en.bin"), "not the model")
    const faster = await localRuntimeStatus(dir, "faster")
    const clearer = await localRuntimeStatus(dir, "clearer")
    expect(faster.model).toBe("ggml-tiny.en")
    expect(clearer.model).toBe("ggml-base.en")
    expect(faster.missing).toContain("model")
    expect(clearer.missing).toContain("model")
    expect(faster.ready).toBe(false)
    expect(clearer.ready).toBe(false)
  })

  it("deletes a partial transcript and leaves a finished transcript and note", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "study-notes-cancel-"))
    const tmp = path.join(dir, "tmp")
    const notes = path.join(dir, "notes")
    await mkdir(tmp, { recursive: true })
    await mkdir(notes, { recursive: true })
    const finished = path.join(notes, "Lecture.md")
    await writeFile(finished, "finished note\n")
    const partialJson = path.join(tmp, "partial.json")
    const partialWav = path.join(tmp, "partial.wav")
    await writeFile(partialJson, "{")
    await writeFile(partialWav, "wav")
    await writeFile(
      path.join(dir, "transcription-job.json"),
      JSON.stringify({
        id: "partial",
        mediaPath: path.join(dir, "lecture.mp3"),
        home: dir,
        courseId: "course",
        phase: "transcribing",
        jsonPath: partialJson,
        wavPath: partialWav,
        stderrPath: path.join(tmp, "partial.stderr"),
        stdoutPath: path.join(tmp, "partial.stdout"),
      }),
    )
    await cancelMakeNotes(dir, "partial")
    await expect(readFile(partialJson, "utf8")).rejects.toThrow()
    await expect(readFile(partialWav, "utf8")).rejects.toThrow()
    await expect(readFile(path.join(dir, "transcription-job.json"), "utf8")).rejects.toThrow()
    expect(await readFile(finished, "utf8")).toBe("finished note\n")

    const completeJson = path.join(tmp, "complete.json")
    const completeWav = path.join(tmp, "complete.wav")
    await writeFile(
      completeJson,
      JSON.stringify({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: "Cells divide." }],
      }),
    )
    await writeFile(completeWav, "wav")
    await writeFile(
      path.join(dir, "transcription-job.json"),
      JSON.stringify({
        id: "complete",
        mediaPath: path.join(dir, "lecture.mp3"),
        home: dir,
        courseId: "course",
        phase: "writing",
        jsonPath: completeJson,
        wavPath: completeWav,
        stderrPath: path.join(tmp, "complete.stderr"),
        stdoutPath: path.join(tmp, "complete.stdout"),
      }),
    )
    await cancelMakeNotes(dir, "complete")
    expect(await readFile(completeJson, "utf8")).toContain("Cells divide.")
    expect(await readFile(completeWav, "utf8")).toBe("wav")
    expect(await readFile(finished, "utf8")).toBe("finished note\n")
    expect(await readFile(path.join(dir, "transcription-job.json"), "utf8")).toContain("complete")
  })

  it("rolls a closed or restarted run back the same way as cancel", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "study-notes-abandon-"))
    const home = path.join(dir, "home")
    const notes = path.join(home, "Biology", "notes")
    const tmp = path.join(dir, "tmp")
    const transcript = path.join(home, "Biology", ".study", "transcripts", "note.json")
    await mkdir(notes, { recursive: true })
    await mkdir(tmp, { recursive: true })
    await mkdir(path.dirname(transcript), { recursive: true })
    await writeFile(path.join(notes, "Lecture.md"), "finished note\n")
    await writeFile(path.join(notes, "Lecture.pdf"), "pdf")
    await writeFile(transcript, "{\"text\":\"Cells divide.\"}\n")
    await writeFile(path.join(notes, "Lecture.md.partial"), "unfinished\n")
    await writeFile(path.join(notes, "Lecture.pdf.partial"), "partial pdf")
    const partialJson = path.join(tmp, "partial.json")
    await writeFile(partialJson, "{")
    await writeFile(path.join(tmp, "partial.wav"), "wav")
    await writeFile(
      path.join(dir, "transcription-job.json"),
      JSON.stringify({
        id: "partial",
        mediaPath: path.join(home, "lecture.mp3"),
        home,
        courseId: "course",
        phase: "transcribing",
        jsonPath: partialJson,
        wavPath: path.join(tmp, "partial.wav"),
        stderrPath: path.join(tmp, "partial.stderr"),
        stdoutPath: path.join(tmp, "partial.stdout"),
      }),
    )
    await abandonInterruptedNotes(dir)
    await expect(readFile(partialJson, "utf8")).rejects.toThrow()
    await expect(readFile(path.join(dir, "transcription-job.json"), "utf8")).rejects.toThrow()
    await expect(readFile(path.join(notes, "Lecture.md.partial"), "utf8")).rejects.toThrow()
    await expect(readFile(path.join(notes, "Lecture.pdf.partial"), "utf8")).rejects.toThrow()
    expect(await readFile(path.join(notes, "Lecture.md"), "utf8")).toBe("finished note\n")
    expect(await readFile(path.join(notes, "Lecture.pdf"), "utf8")).toBe("pdf")
    expect(await readFile(transcript, "utf8")).toContain("Cells divide.")

    const completeJson = path.join(tmp, "complete.json")
    await writeFile(
      completeJson,
      JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: "Cells divide." }] }),
    )
    await writeFile(path.join(notes, "Lecture.md.partial"), "still unfinished\n")
    await writeFile(
      path.join(dir, "transcription-job.json"),
      JSON.stringify({
        id: "complete",
        mediaPath: path.join(home, "lecture.mp3"),
        home,
        courseId: "course",
        phase: "writing",
        jsonPath: completeJson,
        wavPath: path.join(tmp, "complete.wav"),
        stderrPath: path.join(tmp, "complete.stderr"),
        stdoutPath: path.join(tmp, "complete.stdout"),
      }),
    )
    await abandonInterruptedNotes(dir)
    expect(await readFile(completeJson, "utf8")).toContain("Cells divide.")
    expect(await readFile(path.join(dir, "transcription-job.json"), "utf8")).toContain("complete")
    await expect(readFile(path.join(notes, "Lecture.md.partial"), "utf8")).rejects.toThrow()
    expect(await readFile(path.join(notes, "Lecture.md"), "utf8")).toBe("finished note\n")

    await markTranscriptFiled(dir, "complete")
    await abandonInterruptedNotes(dir)
    await expect(readFile(completeJson, "utf8")).rejects.toThrow()
    await expect(readFile(path.join(dir, "transcription-job.json"), "utf8")).rejects.toThrow()
    expect(await readFile(path.join(notes, "Lecture.md"), "utf8")).toBe("finished note\n")
    expect(await readFile(transcript, "utf8")).toContain("Cells divide.")
  })
})
