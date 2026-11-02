import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const capabilityPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/capabilities/default.json",
)
const capability = JSON.parse(readFileSync(capabilityPath, "utf8")) as {
  permissions: Array<string | { identifier?: string; allow?: Array<{ path: string }> }>
  remote?: { urls?: string[] }
}

function openerPaths(): string[] {
  const entry = capability.permissions.find(
    (permission) => typeof permission !== "string" && permission.identifier === "opener:allow-open-path",
  )
  if (!entry || typeof entry === "string" || !entry.allow) return []
  return entry.allow.map((item) => item.path)
}

describe("opener scope", () => {
  it("allows a note PDF on a Windows drive, including the canonical prefix", () => {
    const paths = openerPaths()
    expect(capability.permissions).toContain("opener:allow-open-path")
    expect(paths).toContain("**/notes/*.pdf")
    expect(paths).toContain("C:/**/*.pdf")
    expect(paths).toContain("C:/**/notes/*.pdf")
    expect(paths).toContain("//?/C:/**/*.pdf")
    expect(paths).toContain("$HOME/**/*.pdf")
    expect(paths).toContain("$DOCUMENT/**/*.pdf")
    expect(capability.remote?.urls).toContain("http://127.0.0.1:43127/*")
  })
})
