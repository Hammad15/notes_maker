import type { ProviderId } from "./types"

export interface NoteMeta {
  id: string
  title: string
  courseId: string
  moduleId: string | null
  createdAt: string
  updatedAt: string
  provider: ProviderId
}

function quoteYaml(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")}"`
}

function unquoteYaml(raw: string): string {
  const value = raw.trim()
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value
  }
  let out = ""
  const inner = value.slice(1, -1)
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1]
      if (next === "n") out += "\n"
      else if (next === "\\") out += "\\"
      else if (next === '"') out += '"'
      else out += next
      i += 1
    } else {
      out += inner[i]
    }
  }
  return out
}

export function writeFrontmatter(meta: NoteMeta, body: string): string {
  const lines = [
    "---",
    `id: ${quoteYaml(meta.id)}`,
    `title: ${quoteYaml(meta.title)}`,
    `courseId: ${quoteYaml(meta.courseId)}`,
    `moduleId: ${quoteYaml(meta.moduleId ?? "")}`,
    `createdAt: ${quoteYaml(meta.createdAt)}`,
    `updatedAt: ${quoteYaml(meta.updatedAt)}`,
    `provider: ${quoteYaml(meta.provider)}`,
    "---",
    "",
    body.replace(/^\n+/, "").replace(/\s+$/, ""),
    "",
  ]
  return lines.join("\n")
}

export function parseNoteFile(text: string): { meta: NoteMeta; body: string } | null {
  const normalized = text.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return null
  const end = normalized.indexOf("\n---\n", 4)
  if (end < 0) return null
  const header = normalized.slice(4, end)
  const body = normalized.slice(end + 5).replace(/^\n/, "")
  const fields = new Map<string, string>()
  for (const line of header.split("\n")) {
    const split = line.indexOf(":")
    if (split <= 0) continue
    fields.set(line.slice(0, split).trim(), unquoteYaml(line.slice(split + 1)))
  }
  const id = fields.get("id")
  const title = fields.get("title")
  const courseId = fields.get("courseId")
  if (!id || !title || !courseId) return null
  const providerRaw = fields.get("provider")
  const provider: ProviderId = providerRaw === "cloud" ? "cloud" : "local"
  const moduleId = fields.get("moduleId") || null
  return {
    meta: {
      id,
      title,
      courseId,
      moduleId,
      createdAt: fields.get("createdAt") || new Date(0).toISOString(),
      updatedAt: fields.get("updatedAt") || new Date(0).toISOString(),
      provider,
    },
    body,
  }
}
