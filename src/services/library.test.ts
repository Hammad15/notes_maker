import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EntitlementError } from "../domain/errors"
import { createNodeFileStore, dispatchDesktop, resolveAppDataDir } from "../server/nodeFs"
import {
  createCourse,
  createModule,
  getCourse,
  makeNotes,
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

    await store.writeText(path.join(data, "license.json"), "{\"entitled\":true}\n")
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
    expect(transcript.transcribed).toBe(false)
    expect(transcript.segments).toEqual([])
    expect(transcript.durationSeconds).toBeGreaterThan(1)
    expect(markdown).toContain("No transcript was produced")
    expect(markdown).not.toContain("## Transcript")
    expect(await store.stat(path.join(course.path, ".study"))).toMatchObject({ isDir: true })

    const styled = await restyleNote(store, {
      home,
      courseId: course.id,
      noteId: filed.id,
      provider: "local",
      preset: "bullets",
      prompt: "",
    })
    expect(styled.body).toContain("- Course: Biology: 101")
    expect(styled.hasHistory).toBe(true)
    const undone = await undoRestyle(store, home, course.id, filed.id)
    expect(undone.body).toContain("No transcript was produced")
    expect(undone.body).not.toContain("## Transcript")
    expect(undone.hasHistory).toBe(false)
    expect(await store.stat(undone.pdfPath)).toMatchObject({ isDir: false })

    const renamed = await renameCourse(store, home, course.id, "Life science")
    expect(renamed.id).toBe(course.id)
    expect(renamed.folderName).toBe("Life science")
    const reread = await readNote(store, home, course.id, filed.id)
    expect(reread.title).toBe("Lecture 3")
    expect(reread.courseName).toBe("Life science")
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

  it("refuses cloud notes without writing files", async () => {
    const home = path.join(root, "home")
    const store = createNodeFileStore(path.join(root, "appdata"))
    await store.mkdir(home)
    const course = await createCourse(store, home, "Biology 101")
    const media = path.join(root, "lecture.mp3")
    await writeFile(media, wav())
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
    ).rejects.toBeInstanceOf(EntitlementError)
    expect(await store.exists(path.join(course.path, "notes"))).toBe(false)

    await store.writeText(
      path.join(await store.appDataDir(), "license.json"),
      '{"entitled":true}\n',
    )
    const filed = await makeNotes(store, {
      home,
      courseId: course.id,
      mediaPath: media,
      provider: "cloud",
      moduleId: null,
      moduleName: null,
      newModuleName: null,
    })
    expect(filed.provider).toBe("cloud")
    const note = await readNote(store, home, course.id, filed.id)
    expect(note.body).toContain("# lecture")
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
