import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { promises as fs } from "node:fs"
import path from "node:path"
import { finished } from "node:stream/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { LocalSetupError, StudyError } from "../domain/errors.ts"
import {
  assertHeardRecording,
  FFMPEG_BUNDLE,
  parseWhisperJson,
  SPEECH_MODEL,
  WHISPER_ENGINE,
  type LocalRuntimeStatus,
  type SetupProgress,
  type TranscriptionResult,
} from "../domain/localSpeech.ts"

const execFileAsync = promisify(execFile)

const ENGINE_DLLS = ["whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-x64.dll"]

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

function binDir(appData: string): string {
  return path.join(appData, "bin")
}

function modelPath(appData: string): string {
  return path.join(appData, "models", SPEECH_MODEL.file)
}

function configPath(appData: string): string {
  return path.join(appData, "models", "local.json")
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function sha256File(target: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve())
  })
  return hash.digest("hex")
}

async function fileMatches(target: string, bytes: number, sha256: string): Promise<boolean> {
  try {
    const info = await fs.stat(target)
    if (info.size !== bytes) return false
  } catch {
    return false
  }
  return (await sha256File(target)) === sha256
}

async function commandWorks(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"], { windowsHide: true, timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export async function toolPath(appData: string, name: string): Promise<string | null> {
  const bundled = path.join(binDir(appData), exe(name))
  if (await exists(bundled)) return bundled
  if (await commandWorks(name)) return name
  return null
}

async function engineReady(dir: string): Promise<boolean> {
  const cli = path.join(dir, WHISPER_ENGINE.file)
  try {
    const info = await fs.stat(cli)
    if (info.size !== WHISPER_ENGINE.exeBytes) return false
  } catch {
    return false
  }
  for (const dll of ENGINE_DLLS) {
    if (!(await exists(path.join(dir, dll)))) return false
  }
  return true
}

async function readConfig(appData: string): Promise<boolean> {
  try {
    const json = JSON.parse(await fs.readFile(configPath(appData), "utf8")) as {
      ready?: unknown
      model?: unknown
      modelBytes?: unknown
    }
    return json.ready === true && json.model === SPEECH_MODEL.name && json.modelBytes === SPEECH_MODEL.bytes
  } catch {
    return false
  }
}

export async function localRuntimeStatus(appData: string): Promise<LocalRuntimeStatus> {
  const missing: LocalRuntimeStatus["missing"] = []
  if (!(await toolPath(appData, "ffmpeg"))) missing.push("ffmpeg")
  if (!(await toolPath(appData, "ffprobe"))) missing.push("ffprobe")
  if (!(await engineReady(binDir(appData)))) missing.push("engine")
  if (!(await fileMatches(modelPath(appData), SPEECH_MODEL.bytes, SPEECH_MODEL.sha256))) missing.push("model")
  if (!(await readConfig(appData))) missing.push("config")
  return { ready: missing.length === 0, model: SPEECH_MODEL.name, missing }
}

async function downloadVerified(
  url: string,
  dest: string,
  bytes: number,
  sha256: string,
  onChunk?: (received: number, total: number) => void,
): Promise<void> {
  if (await fileMatches(dest, bytes, sha256)) {
    onChunk?.(bytes, bytes)
    return
  }
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  await fs.rm(partial, { force: true })
  let response: Response
  try {
    response = await fetch(url, {
      headers: { "user-agent": "StudyNotes/0.1" },
      redirect: "follow",
    })
  } catch {
    throw new Error("Check the network and press Set up local notes again.")
  }
  if (!response.ok || !response.body) {
    throw new Error(`The download was refused (${response.status}).`)
  }
  const file = createWriteStream(partial)
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once("drain", () => resolve()))
      }
      onChunk?.(received, bytes)
    }
  } finally {
    file.end()
    await finished(file)
  }
  const info = await fs.stat(partial).catch(() => null)
  if (!info || info.size !== bytes) {
    await fs.rm(partial, { force: true })
    throw new Error("The download was incomplete.")
  }
  if ((await sha256File(partial)) !== sha256) {
    await fs.rm(partial, { force: true })
    throw new Error("The download did not match the expected file.")
  }
  await fs.rm(dest, { force: true })
  await fs.rename(partial, dest)
}

async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(full, name)
      if (nested) return nested
      continue
    }
    if (entry.name.toLowerCase() === name.toLowerCase()) return full
  }
  return null
}

function keepEngineFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === "whisper-cli.exe") return true
  return lower.endsWith(".dll")
}

async function flattenEngine(root: string, dest: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await flattenEngine(full, dest)
      continue
    }
    if (!keepEngineFile(entry.name)) continue
    await fs.copyFile(full, path.join(dest, entry.name))
  }
}

async function expandZip(zip: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  await execFileAsync("tar", ["-xf", zip, "-C", dest], { windowsHide: true, timeout: 10 * 60_000 })
}

function report(
  onProgress: ((progress: SetupProgress) => void) | undefined,
  phase: SetupProgress["phase"],
  label: string,
  received: number,
  total: number | null,
) {
  onProgress?.({ phase, label, received, total })
}

export async function setupLocalRuntime(
  appData: string,
  onProgress?: (progress: SetupProgress) => void,
): Promise<LocalRuntimeStatus> {
  const bin = binDir(appData)
  const downloads = path.join(appData, "downloads")
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(path.join(appData, "models"), { recursive: true })
  await fs.mkdir(downloads, { recursive: true })

  if (!(await toolPath(appData, "ffmpeg")) || !(await toolPath(appData, "ffprobe"))) {
    const label = "Downloading ffmpeg and ffprobe"
    report(onProgress, "ffmpeg", label, 0, FFMPEG_BUNDLE.zipBytes)
    const zip = path.join(downloads, "ffmpeg-9.0.2-essentials_build.zip")
    try {
      await downloadVerified(FFMPEG_BUNDLE.zipUrl, zip, FFMPEG_BUNDLE.zipBytes, FFMPEG_BUNDLE.zipSha256, (received, total) =>
        report(onProgress, "ffmpeg", label, received, total),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The download failed."
      throw new Error(`Could not download ffmpeg and ffprobe. ${detail}`)
    }
    const extracted = path.join(downloads, "ffmpeg-extract")
    await expandZip(zip, extracted)
    const ffmpegExe = await findFile(extracted, "ffmpeg.exe")
    const ffprobeExe = await findFile(extracted, "ffprobe.exe")
    if (!ffmpegExe || !ffprobeExe) {
      throw new Error("The ffmpeg download did not include ffmpeg and ffprobe.")
    }
    await fs.copyFile(ffmpegExe, path.join(bin, "ffmpeg.exe"))
    await fs.copyFile(ffprobeExe, path.join(bin, "ffprobe.exe"))
    await fs.rm(extracted, { recursive: true, force: true })
    if (!(await commandWorks(path.join(bin, "ffmpeg.exe"))) || !(await commandWorks(path.join(bin, "ffprobe.exe")))) {
      throw new Error("ffmpeg was downloaded but did not start.")
    }
  }

  if (!(await engineReady(bin))) {
    const label = "Downloading the speech engine"
    report(onProgress, "engine", label, 0, WHISPER_ENGINE.zipBytes)
    const zip = path.join(downloads, "whisper-bin-x64.zip")
    try {
      await downloadVerified(WHISPER_ENGINE.zipUrl, zip, WHISPER_ENGINE.zipBytes, WHISPER_ENGINE.zipSha256, (received, total) =>
        report(onProgress, "engine", label, received, total),
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The download failed."
      throw new Error(`Could not download the speech engine. ${detail}`)
    }
    const extracted = path.join(downloads, "whisper-extract")
    await expandZip(zip, extracted)
    await flattenEngine(extracted, bin)
    await fs.rm(extracted, { recursive: true, force: true })
    if (!(await engineReady(bin))) throw new Error("The speech engine download did not include whisper-cli.")
  }

  const label = "Downloading the speech model"
  report(onProgress, "model", label, 0, SPEECH_MODEL.bytes)
  try {
    await downloadVerified(SPEECH_MODEL.url, modelPath(appData), SPEECH_MODEL.bytes, SPEECH_MODEL.sha256, (received, total) =>
      report(onProgress, "model", label, received, total),
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The download failed."
    throw new Error(`Could not download the speech model. ${detail}`)
  }

  report(onProgress, "config", "Saving local setup", 1, 1)
  const ffmpegFromPath = !(await exists(path.join(bin, "ffmpeg.exe")))
  const config = {
    ready: true,
    model: SPEECH_MODEL.name,
    modelFile: SPEECH_MODEL.file,
    modelBytes: SPEECH_MODEL.bytes,
    engine: "whisper.cpp",
    engineVersion: WHISPER_ENGINE.version,
    ffmpeg: ffmpegFromPath ? "path" : FFMPEG_BUNDLE.version,
  }
  await fs.writeFile(configPath(appData), `${JSON.stringify(config, null, 2)}\n`, "utf8")
  const status = await localRuntimeStatus(appData)
  if (!status.ready) throw new Error("Local notes are still missing pieces after setup.")
  return status
}

async function probeDuration(ffprobe: string, media: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", media],
      { windowsHide: true, timeout: 60_000 },
    )
    const seconds = Number(String(stdout).trim())
    if (!Number.isFinite(seconds) || seconds <= 0) return null
    return seconds
  } catch {
    return null
  }
}

function wavSeconds(size: number): number | null {
  if (size <= 44) return null
  const seconds = (size - 44) / 32_000
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds
}

function whisperTimeout(durationSeconds: number | null): number {
  const duration = durationSeconds ?? 60 * 60
  return Math.min(6 * 60 * 60 * 1000, Math.max(15 * 60 * 1000, Math.round(duration * 20 * 1000)))
}

export async function transcribeWithRuntime(appData: string, mediaPath: string): Promise<TranscriptionResult> {
  const status = await localRuntimeStatus(appData)
  if (!status.ready) throw new LocalSetupError()
  const ffmpeg = await toolPath(appData, "ffmpeg")
  const ffprobe = await toolPath(appData, "ffprobe")
  if (!ffmpeg || !ffprobe) throw new LocalSetupError()
  const started = Date.now()
  const tmp = path.join(appData, "tmp")
  await fs.mkdir(tmp, { recursive: true })
  const id = crypto.randomUUID()
  const wav = path.join(tmp, `${id}.wav`)
  const jsonBase = path.join(tmp, id)
  try {
    await execFileAsync(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-i", mediaPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-vn", wav],
      { windowsHide: true, timeout: 2 * 60 * 60 * 1000 },
    )
    let durationSeconds = await probeDuration(ffprobe, wav)
    if (durationSeconds == null) {
      const info = await fs.stat(wav)
      durationSeconds = wavSeconds(info.size)
    }
    const whisper = path.join(binDir(appData), WHISPER_ENGINE.file)
    await execFileAsync(
      whisper,
      ["-m", modelPath(appData), "-f", wav, "-l", "en", "-oj", "-of", jsonBase, "-np", "-ng"],
      {
        windowsHide: true,
        timeout: whisperTimeout(durationSeconds),
        maxBuffer: 16 * 1024 * 1024,
        cwd: binDir(appData),
      },
    )
    const raw = await fs.readFile(`${jsonBase}.json`, "utf8")
    const segments = parseWhisperJson(raw)
    const elapsedMs = Date.now() - started
    assertHeardRecording({ durationSeconds, elapsedMs, segments })
    return { segments, durationSeconds, elapsedMs, model: SPEECH_MODEL.name }
  } catch (error) {
    if (error instanceof StudyError) throw error
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "The speech model stopped."
    const tail = detail.length > 500 ? detail.slice(-500) : detail
    throw new Error(`Could not transcribe that recording. ${tail}`)
  } finally {
    await fs.rm(wav, { force: true })
    await fs.rm(`${jsonBase}.json`, { force: true })
  }
}
