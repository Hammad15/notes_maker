import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { speechPace } from "../domain/localSpeech.ts"
import { durationFromHeader } from "../domain/media.ts"
import type { DirEntry, FileStat, MediaProbe } from "../domain/types.ts"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs.ts"
import { downloadAndStartWindowsInstaller } from "./installerUpdate.ts"
import { Ops } from "../platform/ops.ts"
import type { FileStore } from "../platform/types.ts"
import {
  cancelMakeNotes as cancelMakeNotesRuntime,
  clearTranscriptionJob,
  freeSpaceBytes,
  localRuntimeStatus,
  prepareCloudAudio,
  readActiveTranscription,
  reconcileTranscriptionOnLaunch,
  completeLocalNotes,
  setupLocalRuntime,
  toolPath,
  transcribeWithRuntime,
} from "./localRuntime.ts"

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

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function readPrefix(target: string, limit: number): Promise<Uint8Array> {
  const handle = await fs.open(target, "r")
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function windowsMediaDuration(target: string): Promise<number | null> {
  if (process.platform !== "win32") return null
  const script = [
    `$dir = ${powershellLiteral(path.dirname(target))}`,
    `$name = ${powershellLiteral(path.basename(target))}`,
    "$shell = New-Object -ComObject Shell.Application",
    "$folder = $shell.NameSpace($dir)",
    "if ($null -eq $folder) { exit 2 }",
    "$item = $folder.ParseName($name)",
    "if ($null -eq $item) { exit 3 }",
    "$d = $item.ExtendedProperty('System.Media.Duration')",
    "if ($null -eq $d) { exit 4 }",
    "Write-Output $d",
  ].join("; ")
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout: 15000, windowsHide: true },
    )
    const raw = Number(String(stdout).trim())
    if (!Number.isFinite(raw) || raw <= 0) return null
    return raw / 10_000_000
  } catch {
    return null
  }
}

async function readProbe(target: string, size: number, ffprobe: string | null): Promise<MediaProbe> {
  let durationSeconds: number | null = null
  let title: string | null = null
  let chapters: MediaProbe["chapters"] = []
  try {
    if (!ffprobe) throw new Error("ffprobe is not installed yet.")
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_chapters", target],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    )
    const json = JSON.parse(stdout) as {
      format?: { duration?: string; tags?: Record<string, string> }
      chapters?: Array<{ start_time?: string; end_time?: string; tags?: Record<string, string> }>
    }
    const duration = json.format?.duration ? Number(json.format.duration) : null
    const tags = json.format?.tags ?? {}
    title = tags.title || tags.Title || null
    chapters = (json.chapters ?? [])
      .map((chapter) => ({
        start: Number(chapter.start_time),
        end: Number(chapter.end_time),
        title: chapter.tags?.title || chapter.tags?.Title || "",
      }))
      .filter((chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end))
    durationSeconds = duration != null && Number.isFinite(duration) ? duration : null
  } catch {
    durationSeconds = null
  }
  if (durationSeconds == null) {
    try {
      durationSeconds = durationFromHeader(await readPrefix(target, 256 * 1024), size)
    } catch {
      durationSeconds = null
    }
  }
  if (durationSeconds == null) durationSeconds = await windowsMediaDuration(target)
  return { size, durationSeconds, title, chapters }
}

export function createNodeFileStore(appData = resolveAppDataDir(process.platform, process.env, os.homedir())): FileStore {
  void reconcileTranscriptionOnLaunch(appData).catch(() => undefined)
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
      return readProbe(target, info.size, await toolPath(appData, "ffprobe"))
    },
    localStatus(pace) {
      return localRuntimeStatus(appData, speechPace(pace))
    },
    setupLocal(pace) {
      return setupLocalRuntime(appData, speechPace(pace))
    },
    completeLocal(messages, maxCompletionTokens, jobId) {
      return completeLocalNotes(appData, messages, maxCompletionTokens, jobId)
    },
    prepareCloudAudio(target) {
      return prepareCloudAudio(appData, target)
    },
    async readBytes(target) {
      return new Uint8Array(await fs.readFile(target))
    },
    transcribeMedia(target, request) {
      return transcribeWithRuntime(appData, target, request)
    },
    activeTranscription() {
      return readActiveTranscription(appData)
    },
    clearTranscription(id) {
      return clearTranscriptionJob(appData, id)
    },
    cancelMakeNotes(id) {
      return cancelMakeNotesRuntime(appData, id)
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

function localMessages(value: unknown): Array<{ role: "system" | "user"; content: string }> {
  if (!Array.isArray(value)) return []
  const parsed: Array<{ role: "system" | "user"; content: string }> = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const row = item as { role?: unknown; content?: unknown }
    if ((row.role === "system" || row.role === "user") && typeof row.content === "string") {
      parsed.push({ role: row.role, content: row.content })
    }
  }
  return parsed
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

function optionalString(request: Record<string, unknown>, key: string): string | null {
  const value = request[key]
  if (typeof value !== "string") return null
  const text = value.trim()
  return text || null
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
    case Ops.localStatus:
      return store.localStatus(speechPace(body.pace))
    case Ops.freeSpace:
      return freeSpaceBytes(await store.appDataDir())
    case Ops.setupLocal:
      return store.setupLocal(speechPace(body.pace))
    case Ops.completeLocal: {
      const max = typeof body.maxCompletionTokens === "number" ? body.maxCompletionTokens : 1200
      return store.completeLocal(localMessages(body.messages), max, optionalString(body, "jobId") ?? undefined)
    }
    case Ops.prepareCloudAudio:
      return store.prepareCloudAudio(requiredString(body, "path"))
    case Ops.readBytes: {
      const bytes = await store.readBytes(requiredString(body, "path"))
      return Buffer.from(bytes).toString("base64")
    }
    case Ops.transcribeMedia:
      return store.transcribeMedia(requiredString(body, "path"), {
        jobId: optionalString(body, "jobId") ?? "",
        home: optionalString(body, "home") ?? "",
        mediaPath: requiredString(body, "path"),
        courseId: optionalString(body, "courseId") ?? "",
        moduleId: optionalString(body, "moduleId"),
        moduleName: optionalString(body, "moduleName"),
        newModuleName: optionalString(body, "newModuleName"),
        pace: speechPace(body.pace),
        language: optionalString(body, "language") ?? "en",
      })
    case Ops.activeTranscription:
      return store.activeTranscription()
    case Ops.clearTranscription:
      await store.clearTranscription(requiredString(body, "id"))
      return null
    case Ops.cancelMakeNotes:
      await store.cancelMakeNotes(requiredString(body, "id"))
      return null
    case Ops.pickDirectory:
    case Ops.pickMedia:
      throw new Error(WINDOWS_DIALOG_REQUIRED)
    case Ops.startInstaller:
      await downloadAndStartWindowsInstaller(await store.appDataDir(), requiredString(body, "url"))
      return null
    default:
      throw new Error(`Unknown request ${op}.`)
  }
}
