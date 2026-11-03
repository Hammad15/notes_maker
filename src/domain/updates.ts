// GitHub releases are opened for the user. The Tauri updater installs a signed
// bundle and does not fit this app.

export const APP_VERSION = "0.1.0"

export const RELEASES_URL = "https://api.github.com/repos/Hammad15/notes_maker/releases?per_page=20"

const DOWNLOAD_PREFIX = "https://github.com/Hammad15/notes_maker/releases/download/"

export interface InstallerUpdate {
  version: string
  name: string
  downloadUrl: string
}

export function parseReleaseVersion(tag: string): [number, number, number] | null {
  const cleaned = tag.trim().replace(/^v/i, "")
  if (!/^\d+(\.\d+){0,2}$/.test(cleaned)) return null
  const parts = cleaned.split(".").map((part) => Number(part))
  while (parts.length < 3) parts.push(0)
  return [parts[0], parts[1], parts[2]]
}

export function versionIsNewer(candidate: string, current: string): boolean {
  const next = parseReleaseVersion(candidate)
  const now = parseReleaseVersion(current)
  if (!next || !now) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > now[index]) return true
    if (next[index] < now[index]) return false
  }
  return false
}

function installerRank(name: string): number {
  const lower = name.toLowerCase()
  if (lower.endsWith(".exe") && lower.includes("setup")) return 3
  if (lower.endsWith(".exe")) return 2
  if (lower.endsWith(".msi")) return 1
  return 0
}

function releaseDownload(url: string): boolean {
  if (!url.startsWith(DOWNLOAD_PREFIX)) return false
  const rest = url.slice(DOWNLOAD_PREFIX.length)
  const lower = rest.toLowerCase()
  if (rest.includes("?") || rest.includes("#") || rest.includes("\\") || rest.includes("..")) return false
  if (lower.includes("%2f") || lower.includes("%5c")) return false
  const parts = rest.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  const file = parts[1].toLowerCase()
  return file.endsWith(".exe") || file.endsWith(".msi")
}

function windowsInstaller(assets: unknown): { name: string; downloadUrl: string } | null {
  if (!Array.isArray(assets)) return null
  let best: { name: string; downloadUrl: string; rank: number } | null = null
  for (const asset of assets) {
    if (!asset || typeof asset !== "object") continue
    const record = asset as { name?: unknown; browser_download_url?: unknown }
    if (typeof record.name !== "string" || typeof record.browser_download_url !== "string") continue
    const rank = installerRank(record.name)
    if (rank === 0 || !releaseDownload(record.browser_download_url)) continue
    if (!best || rank > best.rank) best = { name: record.name, downloadUrl: record.browser_download_url, rank }
  }
  return best
}

export function newerInstaller(payload: unknown, current = APP_VERSION): InstallerUpdate | null {
  if (!Array.isArray(payload)) return null
  const found: Array<InstallerUpdate & { parts: [number, number, number] }> = []
  for (const item of payload) {
    if (!item || typeof item !== "object") continue
    const release = item as {
      tag_name?: unknown
      name?: unknown
      draft?: unknown
      prerelease?: unknown
      assets?: unknown
    }
    if (release.draft === true || release.prerelease === true) continue
    if (typeof release.tag_name !== "string" || !versionIsNewer(release.tag_name, current)) continue
    const parts = parseReleaseVersion(release.tag_name)
    const installer = windowsInstaller(release.assets)
    if (!parts || !installer) continue
    found.push({
      version: release.tag_name.trim().replace(/^v/i, ""),
      name: typeof release.name === "string" && release.name.trim() ? release.name.trim() : installer.name,
      downloadUrl: installer.downloadUrl,
      parts,
    })
  }
  found.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index]
    }
    return 0
  })
  const best = found[0]
  if (!best) return null
  return { version: best.version, name: best.name, downloadUrl: best.downloadUrl }
}
