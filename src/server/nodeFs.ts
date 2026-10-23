import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { DirEntry, FileStat, MediaProbe } from "../domain/types.ts"
import { Ops } from "../platform/ops.ts"
import type { FileStore } from "../platform/types.ts"

const execFileAsync = promisify(execFile)

export function resolveAppDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string,
): string {
  const paths = platform === "win32" ? path.win32 : path.posix
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || paths.join(homedir, "AppData", "Local")
    return paths.join(base, "Study Notes")
  }
  if (platform === "darwin") {
    return paths.join(homedir, "Library", "Application Support", "Study Notes")
  }
  const base = env.XDG_DATA_HOME || paths.join(homedir, ".local", "share")
  return paths.join(base, "Study Notes")
}

function kindOf(isDir: boolean): DirEntry["kind"] {
  return isDir ? "dir" : "file"
}

async function readProbe(target: string, size: number): Promise<MediaProbe> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_chapters", target],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
    )
    const json = JSON.parse(stdout) as {
      format?: { duration?: string; tags?: Record<string, string> }
      chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>
    }
    const duration = json.format?.duration ? Number(json.format.duration) : null
    const tags = json.format?.tags ?? {}
    const title = tags.title || tags.Title || null
    const chapters = (json.chapters ?? [])
      .map((chapter) => ({
        start: Number(chapter.start_time),
        end: Number(chapter.end_time),
        title: chapter.tags?.title || chapter.tags?.Title || "",
      }))
      .filter((chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end))
    return {
      size,
      durationSeconds: duration != null && Number.isFinite(duration) ? duration : null,
      title,
      chapters,
    }
  } catch {
    return { size, durationSeconds: null, title: null, chapters: [] }
  }
}

export function createNodeFileStore(appData = resolveAppDataDir(process.platform, process.env, os.homedir())): FileStore {
  return {
    async appDataDir() {
      return appData
    },
    async userHome() {
      return os.homedir()
    },
    async roots() {
      if (process.platform === "win32") {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        const found: string[] = []
        for (const letter of letters) {
          const root = `${letter}:\\`
          try {
            await fs.access(root)
            found.push(root)
          } catch {
            // Drive is absent.
          }
        }
        return found.length > 0 ? found : ["C:\\"]
      }
      return ["/"]
    },
    async readText(target) {
      try {
        return await fs.readFile(target, "utf8")
      } catch (error) {
        if (isNotFound(error)) return null
        throw new Error(ioMessage(target, error))
      }
    },
    async writeText(target, text) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, text, "utf8")
    },
    async writeBytes(target, bytes) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes)
    },
    async exists(target) {
      try {
        await fs.access(target)
        return true
      } catch {
        return false
      }
    },
    async list(target) {
      let entries
      try {
        entries = await fs.readdir(target, { withFileTypes: true })
      } catch (error) {
        throw new Error(ioMessage(target, error))
      }
      const result: DirEntry[] = []
      for (const entry of entries) {
        const entryPath = path.join(target, entry.name)
        try {
          const info = await fs.stat(entryPath)
          result.push({ name: entry.name, kind: kindOf(info.isDirectory()) })
        } catch {
          result.push({ name: entry.name, kind: entry.isDirectory() ? "dir" : "file" })
        }
      }
      return result
    },
    async mkdir(target) {
      await fs.mkdir(target, { recursive: true })
    },
    async rename(from, to) {
      await fs.rename(from, to)
    },
    async remove(target) {
      try {
        const info = await fs.stat(target)
        if (info.isDirectory()) throw new Error("Refusing to remove a folder.")
        await fs.rm(target)
      } catch (error) {
        if (isNotFound(error)) return
        throw error instanceof Error ? error : new Error(ioMessage(target, error))
      }
    },
    async stat(target) {
      try {
        const info = await fs.stat(target)
        return {
          size: info.size,
          isDir: info.isDirectory(),
          modifiedMs: info.mtimeMs,
        } satisfies FileStat
      } catch (error) {
        if (isNotFound(error)) return null
        throw new Error(ioMessage(target, error))
      }
    },
    async setHidden(target) {
      if (process.platform !== "win32") return
      await execFileAsync("attrib", ["+H", target])
    },
    async probeMedia(target) {
      const info = await fs.stat(target).catch((error) => {
        throw new Error(ioMessage(target, error))
      })
      if (info.isDirectory()) throw new Error("That recording is not there anymore.")
      return readProbe(target, info.size)
    },
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}

function ioMessage(target: string, error: unknown): string {
  if (isNotFound(error)) return `That folder is not there: ${target}`
  if (error instanceof Error && error.message) return error.message
  return `Could not use ${target}.`
}

function asRecord(request: unknown): Record<string, unknown> {
  if (!request || typeof request !== "object") throw new Error("Missing request.")
  return request as Record<string, unknown>
}

function requiredString(request: Record<string, unknown>, key: string): string {
  const value = request[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}.`)
  return value
}

export async function dispatchDesktop(
  store: FileStore,
  request: unknown,
): Promise<unknown> {
  const body = asRecord(request)
  const op = requiredString(body, "op")
  switch (op) {
    case Ops.appDataDir:
      return store.appDataDir()
    case Ops.userHome:
      return store.userHome()
    case Ops.roots:
      return store.roots()
    case Ops.readText:
      return store.readText(requiredString(body, "path"))
    case Ops.writeText:
      await store.writeText(requiredString(body, "path"), String(body.text ?? ""))
      return null
    case Ops.writeBytes: {
      const encoded = requiredString(body, "base64")
      const bytes = Buffer.from(encoded, "base64")
      await store.writeBytes(requiredString(body, "path"), bytes)
      return null
    }
    case Ops.exists:
      return store.exists(requiredString(body, "path"))
    case Ops.list:
      return store.list(requiredString(body, "path"))
    case Ops.mkdir:
      await store.mkdir(requiredString(body, "path"))
      return null
    case Ops.rename:
      await store.rename(requiredString(body, "from"), requiredString(body, "to"))
      return null
    case Ops.remove:
      await store.remove(requiredString(body, "path"))
      return null
    case Ops.stat:
      return store.stat(requiredString(body, "path"))
    case Ops.setHidden:
      await store.setHidden(requiredString(body, "path"))
      return null
    case Ops.probeMedia:
      return store.probeMedia(requiredString(body, "path"))
    case Ops.pickDirectory:
    case Ops.pickMedia:
      throw new Error("Open the desktop window to use the system file dialog.")
    default:
      throw new Error(`Unknown request ${op}.`)
  }
}
