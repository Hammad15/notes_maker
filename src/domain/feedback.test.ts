import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { FEEDBACK_EMAIL, feedbackMailto } from "./feedback"

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full))
      continue
    }
    if (/\.(ts|tsx|rs|json)$/.test(name)) found.push(full)
  }
  return found
}

describe("feedbackMailto", () => {
  it("opens the email app to the one placeholder address and does not post the message", () => {
    const url = feedbackMailto("The plus button is hard to see.", "student@example.edu")
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true)
    expect(url.startsWith("http")).toBe(false)
    expect(url).not.toContain("https://")
    expect(decodeURIComponent(url)).toContain("The plus button is hard to see.")
    expect(decodeURIComponent(url)).toContain("Reply to: student@example.edu")
    const withoutReply = feedbackMailto("Hello", "  ")
    expect(decodeURIComponent(withoutReply)).not.toContain("Reply to:")
  })

  it("keeps the address in one constant", () => {
    const hits = [...sourceFiles("src"), ...sourceFiles("src-tauri")].filter((file) =>
      readFileSync(file, "utf8").includes(FEEDBACK_EMAIL),
    )
    expect(hits).toEqual([path.join("src", "domain", "feedback.ts")])
  })
})
