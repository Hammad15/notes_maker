import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GROQ_NOTES_MODEL, GROQ_WHISPER_MODEL } from "../domain/groq"
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
    const body = JSON.parse(String(init?.body)) as { model?: string }
    expect(body.model).toBe(GROQ_NOTES_MODEL)
    expect(body.model).not.toMatch(/gpt|whisper-1/)
    return Response.json({
      choices: [
        {
          message: {
            content: "## Cell division\n\n- Mitosis is the process where the cell divides.\n\n## Transcript\n\nword for word",
          },
        },
      ],
    })
  }
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
