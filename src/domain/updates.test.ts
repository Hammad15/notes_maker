import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { APP_VERSION, installerFileName, installerLaunch, installerRedirect, newerInstaller, versionIsNewer } from "./updates"

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

describe("installer launch", () => {
  it("names a GitHub Windows installer and follows only GitHub asset hosts", () => {
    expect(installerFileName(setup)).toBe("CreateNotes_0.2.0_x64-setup.exe")
    expect(
      installerFileName(
        "https://github.com/Hammad15/notes_maker/releases/download/v0.2.0/Create%20Notes.msi",
      ),
    ).toBe("Create Notes.msi")
    expect(installerFileName("https://example.com/Setup.exe")).toBeNull()
    expect(installerFileName("mailto:person@school.test")).toBeNull()
    const asset = "https://objects.githubusercontent.com/github-production-release-asset-2e65be/Setup.exe"
    expect(installerRedirect(setup, asset)).toBe(asset)
    expect(installerRedirect(setup, "https://evil.example/Setup.exe")).toBeNull()
    expect(installerRedirect(setup, "http://release-assets.githubusercontent.com/Setup.exe")).toBeNull()
  })

  it("starts the installer window with no unattended switches", () => {
    const exe = "C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Setup.exe"
    expect(installerLaunch(exe)).toEqual({ command: exe, args: [] })
    const msi = "C:\\Users\\Ada\\AppData\\Local\\Study Notes\\updates\\Create Notes.msi"
    expect(installerLaunch(msi)).toEqual({ command: "msiexec", args: ["/i", msi] })
    expect(installerLaunch(exe)?.args.join(" ")).not.toMatch(/\/(s|quiet|qn|qb|passive)\b/i)
    expect(installerLaunch(msi)?.args.join(" ")).not.toMatch(/\/(s|quiet|qn|qb|passive)\b/i)
  })

  it("keeps the update banner from opening a browser on its own", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/update-notice.tsx"), "utf8")
    expect(source.includes("openUrl")).toBe(false)
    expect(source.includes("window.open")).toBe(false)
    expect(source.includes("startInstaller")).toBe(true)
    const effect = source.slice(source.indexOf("useEffect"), source.indexOf("if (!update)"))
    expect(effect.includes("startInstaller")).toBe(false)
    expect(effect.includes("confirmInstall")).toBe(false)
  })

  it("hides a dismissed update until the app restarts", () => {
    const source = readFileSync(path.join(process.cwd(), "src/components/update-notice.tsx"), "utf8")
    expect(source).toContain("Dismiss the update notice")
    expect(source).toContain("dismissedUntilRestart")
    expect(source.includes("localStorage")).toBe(false)
    expect(source.includes("sessionStorage")).toBe(false)
    expect(source.includes("saveSettings")).toBe(false)
  })
})
