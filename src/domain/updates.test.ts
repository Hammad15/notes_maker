import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { APP_VERSION, newerInstaller, versionIsNewer } from "./updates"

const setup = "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/CreateNotes_0.2.0_x64-setup.exe"

function release(tag: string, assets: Array<{ name: string; browser_download_url: string }>, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, name: `Create Notes ${tag}`, draft: false, prerelease: false, assets, ...extra }
}

describe("newerInstaller", () => {
  it("matches the desktop app version", () => {
    const conf = readFileSync(path.join(process.cwd(), "src-tauri/tauri.conf.json"), "utf8")
    expect(conf).toContain(`"version": "${APP_VERSION}"`)
  })

  it("prefers a newer Windows setup exe and ignores drafts, prereleases, and other files", () => {
    const update = newerInstaller([
      release("v0.2.0", [
        { name: "CreateNotes_0.2.0_x64-setup.exe.sig", browser_download_url: `${setup}.sig` },
        { name: "notes.zip", browser_download_url: "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/notes.zip" },
        { name: "Create Notes.msi", browser_download_url: "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/Create.Notes.msi" },
        { name: "CreateNotes_0.2.0_x64-setup.exe", browser_download_url: setup },
      ]),
      release("v0.3.0", [{ name: "CreateNotes.dmg", browser_download_url: "https://github.com/Hammad15/notes_maker/releases/download/v0.3.0/CreateNotes.dmg" }]),
      release("v9.0.0", [{ name: "Setup.exe", browser_download_url: setup }], { draft: true }),
      release("v8.0.0", [{ name: "Setup.exe", browser_download_url: setup }], { prerelease: true }),
    ])
    expect(update).toEqual({
      version: "0.2.0",
      name: "Create Notes v0.2.0",
      downloadUrl: setup,
    })
  })

  it("keeps a lower installer when a higher release has none", () => {
    const older = "https://github.com/Hammad15/notes_maker/releases/download/v0.1.1/CreateNotes.exe"
    const update = newerInstaller([
      release("v0.4.0", [{ name: "AppImage", browser_download_url: "https://example.com/CreateNotes.AppImage" }]),
      release("v0.1.1", [{ name: "CreateNotes.exe", browser_download_url: older }]),
    ])
    expect(update?.version).toBe("0.1.1")
    expect(update?.downloadUrl).toBe(older)
  })

  it("stays quiet for the current version, older versions, and bad payloads", () => {
    expect(versionIsNewer("0.1.0", APP_VERSION)).toBe(false)
    expect(versionIsNewer("v0.0.9", APP_VERSION)).toBe(false)
    expect(
      newerInstaller([release(APP_VERSION, [{ name: "Setup.exe", browser_download_url: setup }])]),
    ).toBeNull()
    expect(
      newerInstaller([release("v0.0.9", [{ name: "Setup.exe", browser_download_url: setup }])]),
    ).toBeNull()
    expect(newerInstaller({ tag_name: "v9.0.0" })).toBeNull()
    expect(
      newerInstaller([
        release("v2.0.0", [
          {
            name: "Setup.exe",
            browser_download_url: "https://evil.example/github.com/Hammad15/notes_maker/releases/download/v2.0.0/Setup.exe",
          },
        ]),
      ]),
    ).toBeNull()
  })
})
