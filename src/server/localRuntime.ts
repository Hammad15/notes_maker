import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { finished } from "node:stream/promises"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { LocalSetupError } from "../domain/errors.ts"
import {
  assertHeardRecording,
  FFMPEG_BUNDLE,
  forwardProgress,
  parseProcessSnapshot,
  parseSavedTranscription,
  parseWhisperJson,
  planResume,
  sameTranscriptionJob,
  SPEECH_MODEL,
  TRANSCRIPTION_REPLACED,
  WHISPER_ENGINE,
  whisperPidsToStop,
  whisperThreadCount,
  type ActiveTranscription,
  type LocalRuntimeStatus,
  type SavedTranscription,
  type SetupProgress,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionTarget,
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

const PROCESS_SNAPSHOT_SCRIPT =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'whisper-cli.exe' -or $_.Name -eq 'ffmpeg.exe' } | ForEach-Object { $cmd = $_.CommandLine; if ($null -eq $cmd) { $cmd = '' }; $cmd = ($cmd -replace \"`t\", ' ' -replace \"`r|`n\", ' '); $exe = $_.ExecutablePath; if ($null -eq $exe) { $exe = '' }; Write-Output (('{0}`t{1}`t{2}' -f $_.ProcessId, $exe, $cmd)) }"

function jobFile(appData: string): string {
  return path.join(appData, "transcription-job.json")
}

function whisperExe(appData: string): string {
  return path.join(binDir(appData), WHISPER_ENGINE.file)
}

function ffmpegExe(appData: string): string {
  return path.join(binDir(appData), exe("ffmpeg"))
}

async function readJob(appData: string): Promise<SavedTranscription | null> {
  try {
    return parseSavedTranscription(await fs.readFile(jobFile(appData), "utf8"))
  } catch {
    return null
  }
}

async function writeJob(appData: string, job: SavedTranscription): Promise<void> {
  const temp = `${jobFile(appData)}.tmp`
  await fs.mkdir(appData, { recursive: true })
  await fs.writeFile(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8")
  await fs.rename(temp, jobFile(appData))
}

async function updateJob(appData: string, id: string, mutate: (job: SavedTranscription) => void): Promise<void> {
  const job = await readJob(appData)
  if (!job || job.id !== id) return
  mutate(job)
  await writeJob(appData, job)
}

function isTmpFile(appData: string, target: string): boolean {
  const tmp = path.join(appData, "tmp")
  const relative = path.relative(tmp, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function removeWork(appData: string, job: SavedTranscription): Promise<void> {
  for (const target of [job.wavPath, job.jsonPath, job.stderrPath, job.stdoutPath]) {
    if (target && isTmpFile(appData, target)) await fs.rm(target, { force: true })
  }
}

async function processSnapshot(): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SNAPSHOT_SCRIPT],
      { windowsHide: true, timeout: 30_000 },
    )
    return String(stdout)
  }
  const lines: string[] = []
  let names: string[] = []
  try {
    names = await fs.readdir("/proc")
  } catch {
    return ""
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    const dir = path.join("/proc", name)
    let executable = ""
    try {
      executable = await fs.readlink(path.join(dir, "exe"))
    } catch {
      executable = ""
    }
    let command = ""
    try {
      command = (await fs.readFile(path.join(dir, "cmdline"))).toString("utf8").replace(/\u0000/g, " ")
    } catch {
      command = ""
    }
    lines.push(`${name}\t${executable}\t${command.replace(/\t/g, " ")}`)
  }
  return lines.join("\n")
}

async function killPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) return
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true })
      return
    }
    process.kill(pid, "SIGKILL")
  } catch {
    // The process already exited.
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 4) return false
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        windowsHide: true,
      })
      const text = String(stdout)
      return !text.toLowerCase().includes("no tasks") && text.includes(String(pid))
    } catch {
      return false
    }
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopOwned(executable: string, keepPid: number | null, snapshot?: string): Promise<void> {
  const processes = parseProcessSnapshot(snapshot ?? (await processSnapshot()))
  for (const pid of whisperPidsToStop(processes, executable, keepPid)) {
    await killPid(pid)
  }
}

async function jsonReady(file: string): Promise<boolean> {
  if (!file) return false
  try {
    parseWhisperJson(await fs.readFile(file, "utf8"))
    return true
  } catch {
    return false
  }
}

type Flight = {
  id: string
  target: TranscriptionTarget
  cancelled: boolean
  pid: number | null
  settled: boolean
  promise: Promise<TranscriptionResult>
  resolve: (value: TranscriptionResult) => void
  reject: (error: Error) => void
}

let currentFlight: Flight | null = null
let gate: Promise<unknown> = Promise.resolve()

function withGate<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn)
  gate = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function createFlight(id: string, target: TranscriptionTarget): Flight {
  let resolve: (value: TranscriptionResult) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<TranscriptionResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { id, target, cancelled: false, pid: null, settled: false, promise, resolve, reject }
}

function settle(flight: Flight, work: Promise<TranscriptionResult>) {
  void work.then(
    (value) => {
      flight.settled = true
      flight.resolve(value)
    },
    (error: unknown) => {
      flight.settled = true
      const wrapped = error instanceof Error ? error : new Error("Could not transcribe that recording.")
      flight.reject(wrapped)
      if (currentFlight === flight && !flight.cancelled) currentFlight = null
    },
  )
}

function resultFrom(saved: SavedTranscription, segments: TranscriptionResult["segments"]): TranscriptionResult {
  return {
    segments,
    durationSeconds: saved.durationSeconds,
    elapsedMs: Math.max(0, Date.now() - (saved.startedMs || Date.now())),
    model: SPEECH_MODEL.name,
  }
}

async function finishSaved(saved: SavedTranscription): Promise<TranscriptionResult> {
  const raw = await fs.readFile(saved.jsonPath, "utf8")
  const segments = parseWhisperJson(raw)
  const result = resultFrom(saved, segments)
  assertHeardRecording({
    durationSeconds: result.durationSeconds,
    elapsedMs: result.elapsedMs,
    segments,
  })
  return result
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pullProgress(file: string, offset: number, last: number | null): Promise<{ offset: number; last: number | null; emitted: number | null }> {
  let text = ""
  try {
    const handle = await fs.open(file, "r")
    try {
      const info = await handle.stat()
      if (info.size <= offset) return { offset, last, emitted: null }
      const buf = Buffer.alloc(info.size - offset)
      await handle.read(buf, 0, buf.length, offset)
      text = buf.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return { offset, last, emitted: null }
  }
  const newline = text.endsWith("\n") ? text.length : text.lastIndexOf("\n") + 1
  if (newline <= 0) return { offset, last, emitted: null }
  let emitted: number | null = null
  for (const line of text.slice(0, newline).split(/\r?\n/)) {
    const marker = "progress ="
    const at = line.indexOf(marker)
    if (at < 0) continue
    const value = Number(line.slice(at + marker.length).trim().replace(/%$/, ""))
    const next = forwardProgress(last, Number.isFinite(value) ? value : null)
    if (next !== last) {
      emitted = next
      last = next
    }
  }
  return { offset: offset + Buffer.byteLength(text.slice(0, newline)), last, emitted }
}

export async function readActiveTranscription(appData: string): Promise<ActiveTranscription | null> {
  const saved = await readJob(appData)
  if (!saved) return null
  return {
    id: saved.id,
    jobId: saved.id,
    mediaPath: saved.mediaPath,
    home: saved.home,
    courseId: saved.courseId,
    moduleId: saved.moduleId,
    moduleName: saved.moduleName,
    newModuleName: saved.newModuleName,
    phase: saved.phase,
    label: saved.label,
    percent: saved.percent,
  }
}

export async function clearTranscriptionJob(appData: string, id: string): Promise<void> {
  const saved = await readJob(appData)
  if (saved?.id === id) {
    const stillRunning =
      saved.pid != null &&
      whisperPidsToStop(parseProcessSnapshot(await processSnapshot().catch(() => "")), whisperExe(appData), null).includes(
        saved.pid,
      )
    if (stillRunning && currentFlight?.id === id && !currentFlight.settled) return
    await removeWork(appData, saved)
    await fs.rm(jobFile(appData), { force: true })
  }
  if (currentFlight?.id === id) currentFlight = null
}

export async function reconcileTranscriptionOnLaunch(appData: string): Promise<void> {
  const saved = await readJob(appData)
  const snapshot = await processSnapshot()
  const own = whisperExe(appData)
  const processes = parseProcessSnapshot(snapshot)
  const keep = saved?.pid && whisperPidsToStop(processes, own, null).includes(saved.pid) ? saved.pid : null
  await stopOwned(own, keep, snapshot)
  await stopOwned(ffmpegExe(appData), null, snapshot)
  if (saved && keep == null) {
    saved.pid = null
    await writeJob(appData, saved)
  }
}

export async function transcribeWithRuntime(
  appData: string,
  mediaPath: string,
  request: TranscriptionRequest,
): Promise<TranscriptionResult> {
  const status = await localRuntimeStatus(appData)
  if (!status.ready) throw new LocalSetupError()
  const target: TranscriptionTarget = {
    mediaPath,
    courseId: request.courseId,
    moduleId: request.moduleId,
    moduleName: request.moduleName,
  }
  const admitted = await withGate(async () => {
    if (currentFlight && sameTranscriptionJob(currentFlight.target, target) && !currentFlight.cancelled) {
      if (currentFlight.pid) await stopOwned(whisperExe(appData), currentFlight.pid)
      return { kind: "wait" as const, promise: currentFlight.promise }
    }
    if (currentFlight && !currentFlight.settled) {
      currentFlight.cancelled = true
      const pid = currentFlight.pid
      currentFlight.reject(new Error(TRANSCRIPTION_REPLACED))
      currentFlight.settled = true
      currentFlight = null
      if (pid) await killPid(pid)
    } else {
      currentFlight = null
    }
    const saved = await readJob(appData)
    const own = whisperExe(appData)
    const snapshot = await processSnapshot()
    const processes = parseProcessSnapshot(snapshot)
    const plan = planResume(
      saved ? { mediaPath: saved.mediaPath, courseId: saved.courseId, moduleId: saved.moduleId, moduleName: saved.moduleName, pid: saved.pid, jsonReady: await jsonReady(saved.jsonPath) } : null,
      target,
      processes,
      own,
    )
    const keep = plan.action === "attach" ? plan.pid : null
    await stopOwned(own, keep, snapshot)
    await stopOwned(ffmpegExe(appData), null, snapshot)
    if (plan.action === "start" && saved) await removeWork(appData, saved)
    if (plan.action === "reuse" && saved) return { kind: "reuse" as const, saved }
    if (plan.action === "attach" && saved) {
      const flight = createFlight(request.jobId || saved.id, target)
      flight.pid = plan.pid
      currentFlight = flight
      return { kind: "attach" as const, flight, saved, pid: plan.pid }
    }
    const flight = createFlight(request.jobId || crypto.randomUUID(), target)
    currentFlight = flight
    return { kind: "start" as const, flight }
  })
  if (admitted.kind === "wait") return admitted.promise
  if (admitted.kind === "reuse") {
    const saved = { ...admitted.saved, id: request.jobId || admitted.saved.id, jobId: request.jobId || admitted.saved.id, pid: null, phase: "writing" as const, percent: 100 }
    await writeJob(appData, saved)
    return finishSaved(saved)
  }
  if (admitted.kind === "attach") {
    settle(admitted.flight, attachJob(appData, admitted.saved, admitted.pid, admitted.flight))
    return admitted.flight.promise
  }
  settle(admitted.flight, startFresh(appData, mediaPath, request, admitted.flight))
  return admitted.flight.promise
}

async function attachJob(appData: string, saved: SavedTranscription, pid: number, flight: Flight): Promise<TranscriptionResult> {
  const job = { ...saved, id: flight.id, jobId: flight.id }
  await writeJob(appData, job)
  let offset = 0
  let last = job.percent
  let ticks = 0
  while (!flight.cancelled) {
    const pulled = await pullProgress(job.stderrPath, offset, last)
    offset = pulled.offset
    last = pulled.last
    if (pulled.emitted != null) {
      await updateJob(appData, job.id, (current) => {
        current.phase = "transcribing"
        current.percent = forwardProgress(current.percent, pulled.emitted)
      })
    }
    ticks += 1
    if (ticks % 10 === 0 && !(await pidAlive(pid))) break
    await delay(200)
  }
  if (flight.cancelled) {
    await killPid(pid)
    throw new Error(TRANSCRIPTION_REPLACED)
  }
  const done = (await readJob(appData)) ?? job
  done.pid = null
  done.phase = "writing"
  done.percent = 100
  await writeJob(appData, done)
  return finishSaved(done)
}

async function startFresh(
  appData: string,
  mediaPath: string,
  request: TranscriptionRequest,
  flight: Flight,
): Promise<TranscriptionResult> {
  const ffmpeg = await toolPath(appData, "ffmpeg")
  const ffprobe = await toolPath(appData, "ffprobe")
  if (!ffmpeg || !ffprobe) throw new LocalSetupError()
  const tmp = path.join(appData, "tmp")
  await fs.mkdir(tmp, { recursive: true })
  const work = `${process.pid}-${Date.now()}`
  const wav = path.join(tmp, `${work}.wav`)
  const jsonBase = path.join(tmp, work)
  const jsonPath = `${jsonBase}.json`
  const stderrPath = path.join(tmp, `${work}.stderr`)
  const stdoutPath = path.join(tmp, `${work}.stdout`)
  const job: SavedTranscription = {
    id: flight.id,
    jobId: flight.id,
    mediaPath,
    home: request.home,
    courseId: request.courseId,
    moduleId: request.moduleId,
    moduleName: request.moduleName,
    newModuleName: request.newModuleName,
    phase: "reading",
    label: "Reading the recording",
    percent: null,
    pid: null,
    stderrPath,
    stdoutPath,
    jsonPath,
    wavPath: wav,
    startedMs: Date.now(),
    durationSeconds: null,
  }
  await writeJob(appData, job)
  await runChild(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", mediaPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-vn", wav],
    flight,
    appData,
    null,
    null,
    undefined,
    "Could not read that recording.",
  )
  if (flight.cancelled) throw new Error(TRANSCRIPTION_REPLACED)
  let durationSeconds = await probeDuration(ffprobe, wav)
  if (durationSeconds == null) {
    const info = await fs.stat(wav)
    durationSeconds = wavSeconds(info.size)
  }
  await updateJob(appData, flight.id, (current) => {
    current.durationSeconds = durationSeconds
    current.pid = null
  })
  const own = whisperExe(appData)
  await stopOwned(own, null)
  const still = whisperPidsToStop(parseProcessSnapshot(await processSnapshot()), own, null)
  if (still.length > 0) {
    for (const pid of still) await killPid(pid)
    const left = whisperPidsToStop(parseProcessSnapshot(await processSnapshot()), own, null)
    if (left.length > 0) throw new Error("A transcription is already running. Wait for it to finish.")
  }
  await runChild(
    own,
    ["-m", modelPath(appData), "-f", wav, "-l", "en", "-t", String(whisperThreadCount(os.availableParallelism())), "-oj", "-of", jsonBase, "-np", "-pp", "-ng"],
    flight,
    appData,
    stderrPath,
    stdoutPath,
    binDir(appData),
    "Could not transcribe that recording.",
  )
  if (flight.cancelled) throw new Error(TRANSCRIPTION_REPLACED)
  const done = (await readJob(appData)) ?? job
  done.pid = null
  done.phase = "writing"
  done.percent = 100
  done.durationSeconds = durationSeconds
  await writeJob(appData, done)
  return finishSaved(done)
}

function runChild(
  command: string,
  args: string[],
  flight: Flight,
  appData: string,
  stderrPath: string | null,
  stdoutPath: string | null,
  cwd: string | undefined,
  failure: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = stdoutPath ? createWriteStream(stdoutPath) : null
    const stderr = stderrPath ? createWriteStream(stderrPath) : null
    const child: ChildProcess = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: cwd ? { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH ?? ""}` } : process.env,
      stdio: ["ignore", stdout ?? "ignore", stderr ?? "ignore"],
    })
    flight.pid = child.pid ?? null
    if (child.pid) {
      void updateJob(appData, flight.id, (job) => {
        job.pid = child.pid ?? null
        if (stderrPath) {
          job.phase = "transcribing"
          job.label = "Transcribing the recording"
        }
      })
    }
    let offset = 0
    let last: number | null = null
    let timer: NodeJS.Timeout | null = null
    const stopTimer = () => {
      if (timer) clearInterval(timer)
      timer = null
      stdout?.end()
      stderr?.end()
    }
    if (stderrPath) {
      timer = setInterval(() => {
        if (flight.cancelled && child.pid) {
          void killPid(child.pid)
          return
        }
        void pullProgress(stderrPath, offset, last).then((pulled) => {
          offset = pulled.offset
          last = pulled.last
          if (pulled.emitted == null) return
          void updateJob(appData, flight.id, (job) => {
            job.percent = forwardProgress(job.percent, pulled.emitted)
          })
        })
      }, 200)
    }
    child.once("error", (error) => {
      stopTimer()
      flight.pid = null
      reject(error)
    })
    child.once("exit", (code) => {
      stopTimer()
      flight.pid = null
      if (flight.cancelled) {
        reject(new Error(TRANSCRIPTION_REPLACED))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      void fs.readFile(stderrPath || "", "utf8").then(
        (detail) => reject(new Error(`${failure} ${detail.trim().slice(-500)}`)),
        () => reject(new Error(failure)),
      )
    })
  })
}
