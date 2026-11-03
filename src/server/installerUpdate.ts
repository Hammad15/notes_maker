import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { installerFileName, installerLaunch, installerRedirect } from "../domain/updates.ts"

const MAX_INSTALLER_BYTES = 512 * 1024 * 1024
const MAX_REDIRECTS = 5

async function fetchInstaller(url: string): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "CreateNotes/0.1",
      },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      const next = location ? installerRedirect(current, location) : null
      if (!next || hop === MAX_REDIRECTS) {
        throw new Error("The installer download did not finish.")
      }
      current = next
      continue
    }
    if (!response.ok) {
      throw new Error(`The installer download was refused (${response.status}).`)
    }
    return response
  }
  throw new Error("The installer download did not finish.")
}

async function writeInstaller(response: Response, dest: string): Promise<void> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_INSTALLER_BYTES) {
    throw new Error("The installer download did not finish.")
  }
  if (!response.body) throw new Error("The installer download did not finish.")
  const partial = `${dest}.partial`
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.rm(partial, { force: true })
  const handle = await fs.open(partial, "w")
  let received = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > MAX_INSTALLER_BYTES) {
        throw new Error("The installer download did not finish.")
      }
      await handle.write(value)
    }
  } catch (error) {
    await handle.close()
    await fs.rm(partial, { force: true })
    throw error
  }
  await handle.close()
  if (received === 0 || (Number.isFinite(declared) && declared > 0 && received !== declared)) {
    await fs.rm(partial, { force: true })
    throw new Error("The installer download did not finish.")
  }
  await fs.rm(dest, { force: true })
  await fs.rename(partial, dest)
}

function startDownloadedInstaller(dest: string): Promise<void> {
  const launch = installerLaunch(dest)
  if (!launch) return Promise.reject(new Error("That installer cannot be started."))
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    })
    child.once("error", () => {
      if (settled) return
      settled = true
      reject(new Error("The installer did not start."))
    })
    child.once("spawn", () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

export async function downloadAndStartWindowsInstaller(appData: string, url: string): Promise<void> {
  const fileName = installerFileName(url)
  if (!fileName) throw new Error("That installer cannot be downloaded.")
  if (process.platform !== "win32") {
    throw new Error("The Windows installer starts on Windows.")
  }
  const updates = path.win32.join(appData, "updates")
  const dest = path.win32.join(updates, fileName)
  const relative = path.win32.relative(updates, dest)
  if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
    throw new Error("That installer cannot be downloaded.")
  }
  const response = await fetchInstaller(url)
  await writeInstaller(response, dest)
  await startDownloadedInstaller(dest)
}
