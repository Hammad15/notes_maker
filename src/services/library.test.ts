import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GROQ_NOTES_MODEL, GROQ_WHISPER_MODEL } from "../domain/groq"
import { estimateTokens, GROQ_REQUEST_TOKEN_BUDGET } from "../domain/lectureNotes"
import { GroqKeyError } from "../domain/errors"
import { createNodeFileStore, dispatchDesktop, resolveAppDataDir } from "../server/nodeFs"
import {
  createCourse,
  createModule,
  getCourse,
  makeNotes,
  readNote,
  renameCourse,
  restyleNote,
  saveSettings,
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

const DEV_KEY = "gsk_dev_setting_only_7c1e9a"

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

function groqFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    calls.push(url)
    expect(new URL(url).host).toBe("api.groq.com")
    expect(url).not.toContain("api.openai.com")
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    if (auth !== `Bearer ${DEV_KEY}`) {
      return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
    }
    if (url.includes("/audio/transcriptions")) {
      const form = init?.body
      if (!(form instanceof FormData)) throw new Error("expected form")
      expect(form.get("model")).toBe(GROQ_WHISPER_MODEL)
      expect(form.get("language")).toBe("en")
      expect(form.get("response_format")).toBe("verbose_json")
      return Response.json({
        segments: [
          { start: 0, end: 8, text: "Today we talk about cell division." },
          { start: 8, end: 20, text: "Mitosis is the process where the cell divides." },
        ],
      })
    }
    return Response.json({
      choices: [{ message: { content: notesChatContent(String(init?.body)) } }],
    })
  }
}

function notesChatContent(raw: string): string {
  const posted = JSON.parse(raw) as {
    model?: string
    max_completion_tokens?: number
    messages?: Array<{ role: string; content: string }>
  }
  expect(posted.model).toBe(GROQ_NOTES_MODEL)
  expect(posted.model).not.toBe("llama-3.3-70b-versatile")
  expect(posted.model).not.toMatch(/whisper-1/)
  const messages = posted.messages ?? []
  const system = messages.find((message) => message.role === "system")?.content ?? ""
  const user = messages.find((message) => message.role === "user")?.content ?? ""
  const used = estimateTokens(messages.map((message) => message.content).join("\n")) + (posted.max_completion_tokens ?? 0)
  expect(used).toBeLessThanOrEqual(GROQ_REQUEST_TOKEN_BUDGET)
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

    await saveSettings(store, {
      homeDirectory: home,
      provider: "cloud",
      lastMediaDirectory: null,
      speechPace: "clearer",
      groqApiKey: DEV_KEY,
      languageCode: "en",
    })
    const calls: string[] = []
    vi.stubGlobal("fetch", groqFetch(calls))
    const filed = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud",
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
    expect(transcript.provider).toBe("cloud")
    expect(transcript.transcribed).toBe(true)
    expect(transcript.model).toBe(GROQ_WHISPER_MODEL)
    expect(transcript.segments.map((segment: { text: string }) => segment.text).join(" ")).toContain("Mitosis")
    expect(transcript.durationSeconds).toBeGreaterThan(1)
    expect(markdown).toContain("## Cell division")
    expect(markdown).not.toContain("## Transcript")
    expect(markdown).not.toContain(DEV_KEY)
    expect(await store.stat(path.join(course.path, ".study"))).toMatchObject({ isDir: true })
    expect(calls.filter((url) => url.includes("/audio/transcriptions"))).toHaveLength(1)

    const rewritten = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud",
      moduleId: filed.moduleId,
      moduleName: filed.moduleName,
      newModuleName: null,
    })
    expect(rewritten.id).toBe(filed.id)
    expect(calls.filter((url) => url.includes("/audio/transcriptions"))).toHaveLength(1)
    expect(calls.filter((url) => url.includes("/chat/completions")).length).toBeGreaterThanOrEqual(2)
    const settingsText = await store.readText(path.join(data, "settings.json"))
    expect(settingsText).toContain(DEV_KEY)
    expect(await pathsContaining(course.path, DEV_KEY)).toEqual([])

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

  it("keeps the transcript when Groq notes fail and does not transcribe again", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "ISC 102")
    const media = path.join(root, "ISC 102 U06.mp3")
    await writeFile(media, wav(2))
    await saveSettings(store, {
      homeDirectory: home,
      provider: "cloud",
      lastMediaDirectory: null,
      speechPace: "clearer",
      groqApiKey: DEV_KEY,
      languageCode: "en",
    })
    let chats = 0
    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      const auth = new Headers(init?.headers).get("authorization") ?? ""
      if (auth !== `Bearer ${DEV_KEY}`) return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
      if (url.includes("/audio/transcriptions")) {
        return Response.json({
          segments: [{ start: 0, end: 4, text: "Supply and demand." }],
        })
      }
      chats += 1
      if (chats === 1) {
        return Response.json(
          { error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it." } },
          { status: 400 },
        )
      }
      return Response.json({ choices: [{ message: { content: notesChatContent(String(init?.body)) } }] })
    })
    const request = {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud" as const,
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    }
    await expect(makeNotes(store, request)).rejects.toThrow(/llama-3\.3-70b-versatile/)
    const transcriptDir = path.join(course.path, ".study", "transcripts")
    const transcriptFiles = (await readdir(transcriptDir)).filter((name) => name.endsWith(".json"))
    expect(transcriptFiles).toHaveLength(1)
    expect(await store.readText(path.join(transcriptDir, transcriptFiles[0]))).toContain("Supply and demand.")
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    const filed = await makeNotes(store, request)
    expect(calls.filter((url) => url.includes("/audio/transcriptions"))).toHaveLength(1)
    expect(calls.filter((url) => url.includes("/chat/completions")).length).toBeGreaterThanOrEqual(2)
    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("Demand meets supply.")
    expect(markdown).not.toContain("## Transcript")
    vi.unstubAllGlobals()
  })

  it("refuses cloud notes without a key, even when a license file says entitled", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "lecture.mp3")
    await writeFile(media, wav())
    await store.writeText(
      path.join(await store.appDataDir(), "license.json"),
      '{"entitled":true}\n',
    )
    await expect(
      makeNotes(store, {
        home,
        courseId: course.id,
        mediaPath: media,
        provider: "cloud",
        moduleId: null,
        moduleName: null,
        newModuleName: null,
      }),
    ).rejects.toBeInstanceOf(GroqKeyError)
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)
    expect(await store.exists(path.join(course.path, ".study"))).toBe(false)
  })

  it("rewrites study notes from a saved transcript without local setup", async () => {
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
    const markdown = await store.readText(filed.markdownPath)
    expect(markdown).toContain("Mitosis")
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
    await saveSettings(store, {
      homeDirectory: home,
      provider: "cloud",
      lastMediaDirectory: null,
      speechPace: "clearer",
      groqApiKey: DEV_KEY,
      languageCode: "en",
    })
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
    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      expect(url).not.toContain("/audio/transcriptions")
      const auth = new Headers(init?.headers).get("authorization") ?? ""
      if (auth !== `Bearer ${DEV_KEY}`) return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
      const system = (JSON.parse(String(init?.body)) as { messages?: Array<{ content: string }> }).messages?.[0]?.content ?? ""
      if (/compact summary/i.test(system)) kinds.push("summary")
      else if (/outline of the whole lecture/i.test(system)) kinds.push("outline")
      else kinds.push("fill")
      return Response.json({ choices: [{ message: { content: notesChatContent(String(init?.body)) } }] })
    })
    const filed = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud",
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    })
    expect(filed.id).toBe(noteId)
    expect(kinds[0]).toBe("summary")
    expect(kinds.filter((kind) => kind === "outline")).toEqual(["outline"])
    expect(kinds.indexOf("fill")).toBeGreaterThan(kinds.indexOf("outline"))
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
    expect(calls.filter((url) => url.includes("/audio/transcriptions"))).toHaveLength(0)

    const styled = await restyleNote(store, {
      home,
      courseId: course.id,
      noteId,
      provider: "cloud",
      preset: "bullets",
      prompt: "",
    })
    expect(await store.readText(transcriptPath)).toBe(savedTranscript)
    expect(calls.filter((url) => url.includes("/audio/transcriptions"))).toHaveLength(0)
    expect(styled.body).toContain("## Elasticity")
    expect(styled.body).not.toContain("## Transcript")
    expect(await store.stat(styled.pdfPath)).toMatchObject({ isDir: false })
    const after = await readdir(notesDir)
    expect(after.filter((name) => name.endsWith(".md"))).toHaveLength(1)
    expect(after.filter((name) => name.endsWith(".pdf"))).toHaveLength(1)
    vi.unstubAllGlobals()
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
  })
})
