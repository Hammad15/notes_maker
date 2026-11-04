import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeFrontmatter } from "../domain/frontmatter"
import { GROQ_WHISPER_MODEL } from "../domain/groq"
import { estimateTokens } from "../domain/lectureNotes"
import { CloudNotesError } from "../domain/errors"
import type { LocalNotesMessage } from "../domain/localSpeech"
import type { FileStore } from "../platform/types"
import { createNodeFileStore, dispatchDesktop, resolveAppDataDir } from "../server/nodeFs"
import {
  createCourse,
  createModule,
  deleteNote,
  findRecordingNote,
  getCourse,
  loadSettings,
  makeNotes,
  requestNoteCancel,
  readNote,
  renameCourse,
  restyleNote,
  undoRestyle,
} from "./library"

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "study-notes-"))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

function wav(seconds = 1): Buffer {
  const sampleRate = 8000
  const sampleCount = sampleRate * seconds
  const dataSize = sampleCount * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

async function pathsContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = []
  const needleBytes = Buffer.from(needle)
  async function walk(current: string) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if ((await readFile(full)).includes(needleBytes)) hits.push(full)
    }
  }
  await walk(dir)
  return hits
}

function readyLocal(store: FileStore): void {
  store.localStatus = async () => ({ ready: true, model: "ggml-base.en", missing: [] })
}

function requestHref(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  if (typeof input === "string") return input
  return input.url
}

function blockGroq(): { calls: number } {
  const seen = { calls: 0 }
  const native = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (requestHref(input).startsWith("file:")) return native(input, init)
    seen.calls += 1
    throw new Error("Groq must not run.")
  })
  return seen
}

function studyReply(messages: LocalNotesMessage[], version?: { n: number }): string {
  const system = messages.find((message) => message.role === "system")?.content ?? ""
  const user = messages.find((message) => message.role === "user")?.content ?? ""
  if (/compact summary/i.test(system)) {
    const points = [...user.matchAll(/point (\d+)/g)]
    const first = points[0]?.[1] ?? "0"
    const last = points[points.length - 1]?.[1] ?? first
    return `0-1 | Covers point ${first} through point ${last}.`
  }
  if (/outline of the whole lecture/i.test(system)) {
    if (/cell division|mitosis/i.test(user)) {
      return '{"sections":[{"title":"Cell division","start":0,"end":20}]}'
    }
    if (/supply and demand|supply/i.test(user) && !/point \d+/.test(user)) {
      return '{"sections":[{"title":"Supply","start":0,"end":4}]}'
    }
    return JSON.stringify({
      sections: [{ title: "Elasticity", ranges: [{ start: 0, end: 100000 }] }],
    })
  }
  if (version) return `## Cell division\n\n- Version ${version.n}.`
  const point = user.match(/point (\d+)/)?.[1]
  if (point) return `## Elasticity\n\n- Point ${point} belongs in the lecture.\n  - Detail ${point}.\n`
  if (/cell division|mitosis/i.test(user)) {
    return "## Cell division\n\n- Mitosis is the process where the cell divides.\n\n## Transcript\n\nword for word"
  }
  return "## Supply\n\n- Demand meets supply."
}

describe("course files", () => {
  it("files markdown, a PDF, a transcript, and the media path", async () => {
    const home = path.join(root, "home")
    const data = path.join(root, "appdata")
    const media = path.join(root, "Lecture 3.wav")
    await writeFile(media, wav(2))
    const store = createNodeFileStore(data)
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology: 101")
    expect(course.folderName).toBe("Biology 101")
    const again = await createCourse(store, home, "Biology: 101")
    expect(again.folderName).toBe("Biology 101 (2)")

    await store.mkdir(path.join(course.path, "notes"))
    await store.writeText(path.join(course.path, "notes", "module.json"), '{"id":"x","name":"Nope"}')
    await store.mkdir(path.join(course.path, "Loose"))

    readyLocal(store)
    const groq = blockGroq()
    let transcribed = 0
    let notesCalls = 0
    store.transcribeMedia = async () => {
      transcribed += 1
      return {
        segments: [
          { start: 0, end: 8, text: "Today we talk about cell division." },
          { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
        ],
        durationSeconds: 20,
        elapsedMs: 1000,
        model: "ggml-base.en",
      }
    }
    store.completeLocal = async (messages) => {
      notesCalls += 1
      return studyReply(messages)
    }
    const filed = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local",
      moduleId: null,
      moduleName: "Cells",
      newModuleName: "Cells",
    })
    const detail = await getCourse(store, home, course.id)
    expect(detail.modules.map((module) => module.name)).toEqual(["Cells"])
    expect(detail.notes).toHaveLength(1)
    expect(filed.moduleName).toBe("Cells")

    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("id:")
    expect(markdown).toContain("# Lecture 3")
    expect(filed.markdownPath).toContain(`${path.sep}Cells${path.sep}notes${path.sep}`)
    const pdfBytes = await store.stat(filed.pdfPath)
    expect(pdfBytes?.size).toBeGreaterThan(500)

    const source = JSON.parse(
      (await store.readText(path.join(course.path, ".study", "sources", `${filed.id}.json`))) ?? "{}",
    )
    expect(source).toMatchObject({
      noteId: filed.id,
      mediaPath: media,
      courseId: course.id,
      moduleId: filed.moduleId,
    })
    const transcript = JSON.parse(
      (await store.readText(path.join(course.path, ".study", "transcripts", `${filed.id}.json`))) ??
        "{}",
    )
    expect(transcript.provider).toBe("local")
    expect(transcript.transcribed).toBe(true)
    expect(transcript.model).toBe("ggml-base.en")
    expect(transcript.segments.map((segment: { text: string }) => segment.text).join(" ")).toContain("Mitosis")
    expect(transcript.durationSeconds).toBeGreaterThan(1)
    expect(markdown).toContain("## Cell division")
    expect(markdown).not.toContain("## Transcript")
    expect(await store.stat(path.join(course.path, ".study"))).toMatchObject({ isDir: true })
    expect(transcribed).toBe(1)
    expect(groq.calls).toBe(0)

    const rewritten = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local",
      moduleId: filed.moduleId,
      moduleName: filed.moduleName,
      newModuleName: null,
    })
    expect(rewritten.id).toBe(filed.id)
    expect(transcribed).toBe(1)
    expect(notesCalls).toBeGreaterThanOrEqual(2)

    const styled = await restyleNote(store, {
      home,
      courseId: course.id,
      noteId: filed.id,
      provider: "local",
      preset: "bullets",
      prompt: "",
    })
    expect(styled.body).toContain("Mitosis")
    expect(styled.hasHistory).toBe(true)
    const undone = await undoRestyle(store, home, course.id, filed.id)
    expect(undone.body).toContain("## Cell division")
    expect(undone.body).not.toContain("## Transcript")
    expect(undone.hasHistory).toBe(false)
    expect(await store.stat(undone.pdfPath)).toMatchObject({ isDir: false })

    const renamed = await renameCourse(store, home, course.id, "Life science")
    expect(renamed.id).toBe(course.id)
    expect(renamed.folderName).toBe("Life science")
    const reread = await readNote(store, home, course.id, filed.id)
    expect(reread.title).toBe("Lecture 3")
    expect(reread.courseName).toBe("Life science")
    vi.unstubAllGlobals()
  })

  it("does not file local notes before setup", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "lecture.wav")
    await writeFile(media, wav(2))
    await expect(
      makeNotes(store, {
        home,
        courseId: course.id,
        mediaPath: media,
        provider: "local",
        moduleId: null,
        moduleName: null,
        newModuleName: null,
      }),
    ).rejects.toThrow(/Set up local notes/)
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    expect(await store.exists(path.join(course.path, ".study"))).toBe(false)
  })

  it("keeps the transcript when local notes fail and does not transcribe again", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "ISC 102")
    const media = path.join(root, "ISC 102 U06.mp3")
    await writeFile(media, wav(2))
    readyLocal(store)
    const groq = blockGroq()
    let transcribed = 0
    let notesCalls = 0
    store.transcribeMedia = async () => {
      transcribed += 1
      return {
        segments: [{ start: 0, end: 4, text: "Supply and demand." }],
        durationSeconds: 4,
        elapsedMs: 1000,
        model: "ggml-base.en",
      }
    }
    store.completeLocal = async (messages) => {
      notesCalls += 1
      if (notesCalls === 1) throw new Error("The notes model did not return study notes.")
      return studyReply(messages)
    }
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    await expect(makeNotes(store, request)).rejects.toThrow(/did not return study notes/)
    const transcriptDir = path.join(course.path, ".study", "transcripts")
    const transcriptFiles = (await readdir(transcriptDir)).filter((name) => name.endsWith(".json"))
    expect(transcriptFiles).toHaveLength(1)
    expect(await store.readText(path.join(transcriptDir, transcriptFiles[0]))).toContain("Supply and demand.")
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    const filed = await makeNotes(store, request)
    expect(transcribed).toBe(1)
    expect(notesCalls).toBeGreaterThanOrEqual(2)
    expect(groq.calls).toBe(0)
    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("Demand meets supply.")
    expect(markdown).not.toContain("## Transcript")
    vi.unstubAllGlobals()
  })

  it("refuses cloud notes and drops a pasted key, even when a license file says entitled", async () => {
    const home = path.join(root, "home")
    const data = path.join(root, "appdata")
    const store = createNodeFileStore(data)
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "lecture.mp3")
    await writeFile(media, wav())
    const pasted = "gsk_pasted_not_a_real_key"
    await store.writeText(
      path.join(data, "settings.json"),
      `${JSON.stringify({ homeDirectory: home, provider: "cloud", groqApiKey: pasted, languageCode: "en" }, null, 2)}\n`,
    )
    await store.writeText(path.join(data, "license.json"), '{"entitled":true}\n')
    const groq = blockGroq()
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    await expect(makeNotes(store, request)).rejects.toBeInstanceOf(CloudNotesError)
    await expect(makeNotes(store, request)).rejects.toThrow("Cloud notes are not available in this build.")
    await expect(
      restyleNote(store, {
        home,
        courseId: course.id,
        noteId: "missing",
        provider: "cloud",
        preset: "bullets",
        prompt: pasted,
      }),
    ).rejects.toBeInstanceOf(CloudNotesError)
    expect(groq.calls).toBe(0)
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    expect(await store.exists(path.join(course.path, ".study"))).toBe(false)
    const loaded = await loadSettings(store)
    expect(loaded).not.toHaveProperty("groqApiKey")
    expect(loaded.provider).toBe("cloud")
    const settingsText = (await store.readText(path.join(data, "settings.json"))) ?? ""
    expect(settingsText).not.toContain(pasted)
    expect(settingsText).not.toContain("groqApiKey")
    expect(await pathsContaining(course.path, pasted)).toEqual([])
    expect(await pathsContaining(data, pasted)).toEqual([])
    vi.unstubAllGlobals()
  })

  it("shows the first-run tour until the saved choice says it was dismissed", async () => {
    const data = path.join(root, "appdata")
    const store = createNodeFileStore(data)
    expect((await loadSettings(store)).tourDismissed).toBe(false)
    await store.writeText(path.join(data, "settings.json"), `${JSON.stringify({ provider: "local" })}\n`)
    expect((await loadSettings(store)).tourDismissed).toBe(false)
    await store.writeText(
      path.join(data, "settings.json"),
      `${JSON.stringify({ provider: "local", tourDismissed: true })}\n`,
    )
    expect((await loadSettings(store)).tourDismissed).toBe(true)
  })

  it("writes study notes from a saved transcript with the local notes model", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "Lecture 3.wav")
    await writeFile(media, wav(2))
    const noteId = "saved-note"
    const study = path.join(course.path, ".study")
    await store.mkdir(path.join(study, "transcripts"))
    await store.mkdir(path.join(study, "sources"))
    const transcript = {
      noteId,
      provider: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
      durationSeconds: 80,
      transcribed: true,
      segments: [
        { start: 0, end: 8, text: "Um so, today we're going to talk about cell division." },
        { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
        { start: 20, end: 32, text: "The cell divides into two daughter cells." },
        { start: 32, end: 40, text: "[Music] na na na la la la" },
        { start: 40, end: 55, text: "Photosynthesis. Plants convert light into chemical energy." },
      ],
      chapters: [],
    }
    const transcriptPath = path.join(study, "transcripts", `${noteId}.json`)
    await store.writeText(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
    await store.writeText(
      path.join(study, "sources", `${noteId}.json`),
      `${JSON.stringify({ noteId, mediaPath: media, courseId: course.id, moduleId: null }, null, 2)}\n`,
    )
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    await expect(makeNotes(store, request)).rejects.toThrow(/Set up local notes/)
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    let groqCalls = 0
    const nativeFetch = globalThis.fetch
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestHref(input).startsWith("file:")) return nativeFetch(input, init)
      groqCalls += 1
      return Response.json({ error: { message: "Groq must not run for local notes." } }, { status: 500 })
    })
    store.localStatus = async () => ({ ready: true, model: "ggml-base.en", missing: [] })
    store.completeLocal = async (messages) => {
      const system = messages.find((message) => message.role === "system")?.content ?? ""
      const user = messages.find((message) => message.role === "user")?.content ?? ""
      expect(user).toContain("Mitosis")
      expect(system).not.toMatch(/compact summary|outline of the whole lecture/i)
      expect(system).toContain("Study notes only.")
      expect(system).toContain("Do not copy transcript lines.")
      return "## Cell division\n\n- Mitosis splits one cell into two daughter cells."
    }
    const filed = await makeNotes(store, request)
    expect(groqCalls).toBe(0)
    expect(filed.id).toBe(noteId)
    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("Mitosis splits one cell into two daughter cells.")
    expect(markdown).not.toContain("Um so")
    expect(markdown?.toLowerCase()).not.toContain("na na")
    expect(markdown).not.toContain("## Transcript")
    const raw = await store.readText(transcriptPath)
    expect(raw).toContain("na na na")
    const savedRaw = raw
    const rewritten = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local",
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    })
    expect(rewritten.id).toBe(noteId)
    expect(rewritten.markdownPath).toBe(filed.markdownPath)
    expect(await store.readText(transcriptPath)).toBe(savedRaw)
    const other = path.join(root, "Lecture 4.wav")
    await writeFile(other, wav(2))
    await expect(
      makeNotes(store, {
        home,
        courseId: course.id,
        mediaPath: other,
        provider: "local",
        moduleId: null,
        moduleName: null,
        newModuleName: null,
      }),
    ).rejects.toThrow(/Set up local notes/)
    const detail = await getCourse(store, home, course.id)
    expect(detail.notes).toHaveLength(1)
  })

  it("keeps loose folders and reserved names out of the module list", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    await createModule(store, home, course.id, "Cells")
    await expect(createModule(store, home, course.id, "notes")).rejects.toThrow(/reserved/)
    const detail = await getCourse(store, home, course.id)
    expect(detail.modules).toHaveLength(1)
  })
})

describe("a saved long transcript", () => {
  it("writes one note and restyles it without Whisper", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "ISC 102")
    const media = path.join(root, "ISC 102 U06.mp3")
    await writeFile(media, wav(2))
    readyLocal(store)
    const noteId = "u06"
    const segments: Array<{ start: number; end: number; text: string }> = []
    let index = 0
    let cursor = 0
    while (estimateTokens(segments.map((segment) => segment.text).join("\n")) < 9000 && index < 400) {
      const topic = index % 2 === 0 ? "Elasticity" : "Supply"
      segments.push({
        start: cursor,
        end: cursor + 3,
        text: `${topic} point ${index} is a complete sentence about prices, buyers, sellers, and the market.`,
      })
      cursor += 4.2
      index += 1
    }
    const study = path.join(course.path, ".study")
    await store.mkdir(path.join(study, "transcripts"))
    await store.mkdir(path.join(study, "sources"))
    const transcript = {
      noteId,
      provider: "cloud",
      createdAt: "2026-01-01T00:00:00.000Z",
      durationSeconds: cursor,
      transcribed: true,
      segments,
      chapters: [],
      model: GROQ_WHISPER_MODEL,
    }
    const transcriptPath = path.join(study, "transcripts", `${noteId}.json`)
    await store.writeText(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
    await store.writeText(
      path.join(study, "sources", `${noteId}.json`),
      `${JSON.stringify({ noteId, mediaPath: media, courseId: course.id, moduleId: null }, null, 2)}\n`,
    )
    const kinds: string[] = []
    const groq = blockGroq()
    store.transcribeMedia = async () => {
      throw new Error("A saved transcript must not be transcribed again.")
    }
    store.completeLocal = async (messages) => {
      const system = messages.find((message) => message.role === "system")?.content ?? ""
      if (/compact summary/i.test(system)) kinds.push("summary")
      else if (/outline of the whole lecture/i.test(system)) kinds.push("outline")
      else kinds.push("fill")
      return studyReply(messages)
    }
    const filed = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local",
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    })
    expect(filed.id).toBe(noteId)
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.every((kind) => kind === "fill")).toBe(true)
    const notesDir = path.join(course.path, "notes")
    const names = await readdir(notesDir)
    expect(names.filter((name) => name.endsWith(".md"))).toHaveLength(1)
    expect(names.filter((name) => name.endsWith(".pdf"))).toHaveLength(1)
    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("# ISC 102 U06")
    expect(markdown?.match(/^## .+$/gm)).toEqual(["## Elasticity"])
    expect(markdown).toContain("  - Detail")
    expect((markdown?.match(/^- Point /gm) ?? []).length).toBeGreaterThan(1)
    expect(markdown).not.toContain("## Transcript")
    expect(await store.stat(filed.pdfPath)).toMatchObject({ isDir: false })
    expect((await store.stat(filed.pdfPath))?.size).toBeGreaterThan(500)
    const savedTranscript = await store.readText(transcriptPath)
    expect(savedTranscript).toContain("point 0")
    expect(groq.calls).toBe(0)

    const styled = await restyleNote(store, {
      home,
      courseId: course.id,
      noteId,
      provider: "local",
      preset: "bullets",
      prompt: "",
    })
    expect(await store.readText(transcriptPath)).toBe(savedTranscript)
    expect(groq.calls).toBe(0)
    expect(styled.body).toContain("## Elasticity")
    expect(styled.body).not.toContain("## Transcript")
    expect(await store.stat(styled.pdfPath)).toMatchObject({ isDir: false })
    const after = await readdir(notesDir)
    expect(after.filter((name) => name.endsWith(".md"))).toHaveLength(1)
    expect(after.filter((name) => name.endsWith(".pdf"))).toHaveLength(1)
    vi.unstubAllGlobals()
  })
})

describe("a recording that already has a note", () => {
  it("replaces that note or writes another beside it", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const cells = await createModule(store, home, course.id, "Cells")
    const media = path.join(root, "Lecture 3.wav")
    await writeFile(media, wav(2))
    readyLocal(store)
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    const study = path.join(course.path, ".study")
    const orphanId = "orphan-transcript"
    await store.mkdir(path.join(study, "transcripts"))
    await store.mkdir(path.join(study, "sources"))
    await store.writeText(
      path.join(study, "transcripts", `${orphanId}.json`),
      `${JSON.stringify(
        {
          noteId: orphanId,
          provider: "cloud",
          createdAt: "2026-01-01T00:00:00.000Z",
          durationSeconds: 20,
          transcribed: true,
          segments: [
            { start: 0, end: 8, text: "Today we talk about cell division." },
            { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
          ],
          chapters: [],
          model: GROQ_WHISPER_MODEL,
        },
        null,
        2,
      )}\n`,
    )
    await store.writeText(
      path.join(study, "sources", `${orphanId}.json`),
      `${JSON.stringify({ noteId: orphanId, mediaPath: media, courseId: course.id, moduleId: null }, null, 2)}\n`,
    )
    expect(await findRecordingNote(store, request)).toBeNull()
    expect(await findRecordingNote(store, { ...request, moduleId: cells.id })).toBeNull()
    expect(await findRecordingNote(store, { ...request, newModuleName: "Week two" })).toBeNull()

    const version = { n: 1 }
    const groq = blockGroq()
    let transcribed = 0
    store.transcribeMedia = async () => {
      transcribed += 1
      return {
        segments: [
          { start: 0, end: 8, text: "Today we talk about cell division." },
          { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
        ],
        durationSeconds: 20,
        elapsedMs: 1000,
        model: "ggml-base.en",
      }
    }
    store.completeLocal = async (messages) => studyReply(messages, version)

    const filed = await makeNotes(store, { ...request, noteChoice: "add" })
    expect(filed.id).toBe(orphanId)
    expect(transcribed).toBe(0)
    expect((await findRecordingNote(store, request))?.id).toBe(filed.id)
    expect(await findRecordingNote(store, { ...request, moduleId: cells.id })).toBeNull()
    expect(await findRecordingNote(store, { ...request, newModuleName: "Week two" })).toBeNull()

    version.n = 2
    const replaced = await makeNotes(store, { ...request, noteChoice: "replace" })
    expect(replaced.id).toBe(filed.id)
    expect(replaced.markdownPath).toBe(filed.markdownPath)
    expect(await store.readText(replaced.markdownPath)).toContain("Version 2.")
    expect((await getCourse(store, home, course.id)).notes).toHaveLength(1)
    const kept = await store.readText(filed.markdownPath)
    const keptPdf = (await store.stat(filed.pdfPath))?.size

    version.n = 3
    const added = await makeNotes(store, { ...request, noteChoice: "add" })
    expect(added.id).not.toBe(filed.id)
    expect(added.markdownPath).not.toBe(filed.markdownPath)
    expect(added.fileStem.endsWith(" (2)")).toBe(true)
    expect(await store.readText(filed.markdownPath)).toBe(kept)
    expect((await store.stat(filed.pdfPath))?.size).toBe(keptPdf)
    expect(await store.readText(added.markdownPath)).toContain("Version 3.")
    expect(transcribed).toBe(0)
    expect((await getCourse(store, home, course.id)).notes).toHaveLength(2)
    expect((await findRecordingNote(store, request))?.id).toBe(added.id)
    const originalTranscript = await store.readText(path.join(study, "transcripts", `${filed.id}.json`))
    expect(originalTranscript).toContain("Mitosis")
    const copy = JSON.parse(
      (await store.readText(path.join(study, "transcripts", `${added.id}.json`))) ?? "{}",
    ) as { noteId: string; createdAt: string }
    expect(copy.noteId).toBe(added.id)
    expect(copy.createdAt > "2026-01-01T00:00:00.000Z").toBe(true)

    version.n = 4
    const replacedNewest = await makeNotes(store, { ...request, noteChoice: "replace" })
    expect(replacedNewest.id).toBe(added.id)
    expect(replacedNewest.markdownPath).toBe(added.markdownPath)
    expect(await store.readText(replacedNewest.markdownPath)).toContain("Version 4.")
    expect(await store.readText(filed.markdownPath)).toBe(kept)
    expect((await store.stat(filed.pdfPath))?.size).toBe(keptPdf)
    expect((await getCourse(store, home, course.id)).notes).toHaveLength(2)

    version.n = 5
    const inModule = await makeNotes(store, {
      ...request,
      moduleId: cells.id,
      moduleName: cells.name,
    })
    expect(inModule.moduleId).toBe(cells.id)
    expect(transcribed).toBe(1)
    expect((await findRecordingNote(store, { ...request, moduleId: cells.id }))?.id).toBe(inModule.id)
    expect((await findRecordingNote(store, request))?.id).toBe(added.id)
    const moduleMarkdown = await store.readText(inModule.markdownPath)
    const modulePdf = (await store.stat(inModule.pdfPath))?.size
    await new Promise((resolve) => setTimeout(resolve, 5))
    version.n = 6
    const moduleAdded = await makeNotes(store, {
      ...request,
      moduleId: cells.id,
      moduleName: cells.name,
      noteChoice: "add",
    })
    expect(moduleAdded.id).not.toBe(inModule.id)
    expect(moduleAdded.markdownPath).toContain(`${path.sep}Cells${path.sep}`)
    expect(moduleAdded.fileStem.endsWith(" (2)")).toBe(true)
    expect(await store.readText(inModule.markdownPath)).toBe(moduleMarkdown)
    expect((await store.stat(inModule.pdfPath))?.size).toBe(modulePdf)
    expect(transcribed).toBe(1)
    expect((await findRecordingNote(store, { ...request, moduleId: cells.id }))?.id).toBe(moduleAdded.id)
    const detail = await getCourse(store, home, course.id)
    expect(detail.notes).toHaveLength(4)
    expect(detail.modules[0]?.noteCount).toBe(2)
    expect(groq.calls).toBe(0)
    vi.unstubAllGlobals()
  })
})

describe("cancelling note making", () => {
  it("keeps the transcript, drops unfinished notes, and leaves a finished note", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "Lecture 3.wav")
    await writeFile(media, wav(2))
    readyLocal(store)
    blockGroq()
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    store.transcribeMedia = async () => ({
      segments: [
        { start: 0, end: 8, text: "Today we talk about cell division." },
        { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
      ],
      durationSeconds: 20,
      elapsedMs: 1000,
      model: "ggml-base.en",
    })
    store.completeLocal = async (messages) => studyReply(messages)
    const finished = await makeNotes(store, request)
    const finishedMarkdown = await store.readText(finished.markdownPath)
    const finishedPdf = (await store.stat(finished.pdfPath))?.size
    const jobId = "cancel-replace"
    store.completeLocal = async () => {
      requestNoteCancel(jobId)
      return "## Cell division\n\n- This replacement should not be saved.\n"
    }
    await expect(makeNotes(store, { ...request, noteChoice: "replace", jobId })).rejects.toThrow(/cancelled/i)
    expect(await store.readText(finished.markdownPath)).toBe(finishedMarkdown)
    expect((await store.stat(finished.pdfPath))?.size).toBe(finishedPdf)
    expect(await store.exists(`${finished.markdownPath}.partial`)).toBe(false)
    expect(await store.exists(`${finished.pdfPath}.partial`)).toBe(false)
    const keptTranscript = await store.readText(path.join(course.path, ".study", "transcripts", `${finished.id}.json`))
    expect(keptTranscript).toContain("Mitosis")

    const freshMedia = path.join(root, "Lecture 4.wav")
    await writeFile(freshMedia, wav(2))
    const freshJob = "cancel-fresh"
    store.completeLocal = async () => {
      requestNoteCancel(freshJob)
      return "## Supply\n\n- These notes are not finished.\n"
    }
    await expect(
      makeNotes(store, { ...request, mediaPath: freshMedia, jobId: freshJob }),
    ).rejects.toThrow(/cancelled/i)
    const detail = await getCourse(store, home, course.id)
    expect(detail.notes.map((note) => note.id)).toEqual([finished.id])
    expect(await store.readText(finished.markdownPath)).toBe(finishedMarkdown)
    const transcripts = (await store.list(path.join(course.path, ".study", "transcripts"))).map((entry) => entry.name)
    expect(transcripts.some((name) => name.endsWith(".json") && name !== `${finished.id}.json`)).toBe(true)
    const partials = await pathsContaining(course.path, "These notes are not finished")
    expect(partials).toEqual([])
  })

  it("drops a partial transcription and does not remove a finished note", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "Lecture 3.wav")
    await writeFile(media, wav(2))
    readyLocal(store)
    blockGroq()
    store.transcribeMedia = async () => ({
      segments: [{ start: 0, end: 4, text: "Cells divide." }],
      durationSeconds: 4,
      elapsedMs: 1000,
      model: "ggml-base.en",
    })
    store.completeLocal = async (messages) => studyReply(messages)
    const finished = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "local",
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    })
    const finishedMarkdown = await store.readText(finished.markdownPath)
    const other = path.join(root, "Lecture 5.wav")
    await writeFile(other, wav(2))
    const jobId = "cancel-transcribe"
    store.transcribeMedia = async () => {
      requestNoteCancel(jobId)
      throw new Error("Transcription was replaced by a different recording.")
    }
    await expect(
      makeNotes(store, {
        home,
        courseId: course.id,
        mediaPath: other,
        provider: "local",
        moduleId: null,
        moduleName: null,
        newModuleName: null,
        jobId,
      }),
    ).rejects.toThrow(/cancelled/i)
    expect(await store.readText(finished.markdownPath)).toBe(finishedMarkdown)
    expect((await getCourse(store, home, course.id)).notes).toHaveLength(1)
    const transcripts = await store.list(path.join(course.path, ".study", "transcripts"))
    expect(transcripts.map((entry) => entry.name)).toEqual([`${finished.id}.json`])
  })
})

describe("deleting a note", () => {
  it("removes the markdown, the PDF, and the saved recording link", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const noteId = "note-to-delete"
    const notesDir = path.join(course.path, "notes")
    await store.mkdir(notesDir)
    const markdownPath = path.join(notesDir, "Lecture.md")
    await store.writeText(
      markdownPath,
      writeFrontmatter(
        {
          id: noteId,
          title: "Lecture",
          courseId: course.id,
          moduleId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          provider: "local",
        },
        "# Lecture\n\n- Cells divide.\n",
      ),
    )
    await store.writeBytes(path.join(notesDir, "Lecture.pdf"), new Uint8Array([1, 2, 3, 4]))
    const study = path.join(course.path, ".study")
    await store.mkdir(path.join(study, "sources"))
    await store.mkdir(path.join(study, "transcripts"))
    await store.writeText(
      path.join(study, "sources", `${noteId}.json`),
      `${JSON.stringify({ noteId, mediaPath: path.join(root, "Lecture.mp3"), courseId: course.id, moduleId: null })}\n`,
    )
    await store.writeText(
      path.join(study, "transcripts", `${noteId}.json`),
      `${JSON.stringify({ noteId, provider: "local", createdAt: "2026-01-01T00:00:00.000Z", transcribed: true, segments: [{ start: 0, end: 1, text: "Cells." }] })}\n`,
    )
    const before = await getCourse(store, home, course.id)
    expect(before.notes.map((note) => note.mediaFileName)).toEqual(["Lecture.mp3"])
    await deleteNote(store, home, course.id, noteId)
    const after = await getCourse(store, home, course.id)
    expect(after.notes).toEqual([])
    expect(await store.exists(markdownPath)).toBe(false)
    expect(await store.exists(path.join(notesDir, "Lecture.pdf"))).toBe(false)
    expect(await store.exists(path.join(study, "sources", `${noteId}.json`))).toBe(false)
    expect(await store.exists(path.join(study, "transcripts", `${noteId}.json`))).toBe(false)
  })
})

describe("desktop dispatch", () => {
  it("resolves the Windows app data folder and round-trips a file", async () => {
    expect(
      resolveAppDataDir("win32", { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "C:\\Users\\Ada"),
    ).toBe(path.win32.join("C:\\Users\\Ada\\AppData\\Local", "Study Notes"))
    const store = createNodeFileStore(path.join(root, "appdata"))
    const value = await dispatchDesktop(store, {
      op: "writeText",
      path: path.join(root, "appdata", "settings.json"),
      text: "{\"provider\":\"local\"}\n",
    })
    expect(value).toBeNull()
    await expect(dispatchDesktop(store, { op: "readText", path: path.join(root, "appdata", "settings.json") })).resolves.toContain("local")
    await expect(dispatchDesktop(store, { op: "pickDirectory" })).rejects.toThrow(/tauri dev/)
    await expect(
      dispatchDesktop(store, { op: "startInstaller", url: "https://example.com/Setup.exe" }),
    ).rejects.toThrow(/cannot be downloaded/)
    if (process.platform !== "win32") {
      await expect(
        dispatchDesktop(store, {
          op: "startInstaller",
          url: "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/CreateNotes_0.2.0_x64-setup.exe",
        }),
      ).rejects.toThrow(/Windows/)
    }
  })
})
