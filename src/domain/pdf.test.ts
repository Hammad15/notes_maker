import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { fitToFont, parseStudyMarkdown, renderPdf, toWinAnsi } from "./pdf"

const lecture = `# Darul Arqam and Migration to Abyssinia

- **Darul Arqam as a secret meeting place**
- Located near Mount Safa, about 130\u202fm from the Kaaba.
- Owned by **Al-Arqam ibn Abi al-Arqam**, a 16-year-old Sahabi from the **Banu Makhzumi** tribe
- The house is described as *quiet* and the owner as _young_.
- See [the Kaaba](https://example.com/kaaba) and \`Darul Arqam\`.

1. First migration
   - A nested point

\`\`\`
const place = "Darul Arqam"
\`\`\`
`

async function pdfText(bytes: Uint8Array): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "notes-pdf-"))
  const file = join(dir, "note.pdf")
  await writeFile(file, bytes)
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile("pdftotext", ["-enc", "UTF-8", file, "-"], (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("pdf markdown", () => {
  it("names the character that used to print as 130?m", () => {
    const narrowNoBreakSpace = "\u202f"
    expect(toWinAnsi(`130${narrowNoBreakSpace}m`)).toBe("130?m")
    expect(toWinAnsi("130\u00a0m")).toBe("130 m")
    expect(toWinAnsi("130\u2019m")).toBe("130'm")
    const ascii = new Set<number>([32, ...Array.from({ length: 95 }, (_, index) => 32 + index)])
    expect(fitToFont(`130${narrowNoBreakSpace}m`, ascii)).toBe("130 m")
    expect(fitToFont(`130${narrowNoBreakSpace}m`, new Set([...ascii, 0x202f]))).toBe(`130${narrowNoBreakSpace}m`)
  })

  it("turns style marks into text instead of printing them", () => {
    const blocks = parseStudyMarkdown(lecture)
    const heading = blocks.find((block) => block.type === "heading")
    expect(heading).toMatchObject({ type: "heading", level: 1 })
    if (heading?.type !== "heading") return
    expect(heading.pieces.map((piece) => piece.text).join("")).toBe("Darul Arqam and Migration to Abyssinia")

    const items = blocks.filter((block) => block.type === "item")
    const secret = items[0]
    expect(secret?.type).toBe("item")
    if (secret?.type !== "item") return
    expect(secret.pieces).toEqual([
      expect.objectContaining({ text: "Darul Arqam as a secret meeting place", bold: true }),
    ])
    expect(secret.marker).toBe("•")

    const distance = items[1]
    if (distance?.type !== "item") throw new Error("missing distance")
    expect(distance.pieces.map((piece) => piece.text).join("")).toContain("130\u202fm")

    const owned = items[2]
    if (owned?.type !== "item") throw new Error("missing owner")
    expect(owned.pieces.filter((piece) => piece.bold).map((piece) => piece.text)).toEqual([
      "Al-Arqam ibn Abi al-Arqam",
      "Banu Makhzumi",
    ])

    const described = items[3]
    if (described?.type !== "item") throw new Error("missing italics")
    expect(described.pieces.filter((piece) => piece.italic).map((piece) => piece.text)).toEqual(["quiet", "young"])

    const linked = items[4]
    if (linked?.type !== "item") throw new Error("missing link")
    expect(linked.pieces.find((piece) => piece.href)?.text).toBe("the Kaaba")
    expect(linked.pieces.find((piece) => piece.href)?.href).toBe("https://example.com/kaaba")
    expect(linked.pieces.find((piece) => piece.code)?.text).toBe("Darul Arqam")

    const ordered = items.find((block) => block.type === "item" && block.marker === "1.")
    expect(ordered?.type).toBe("item")
    const nested = items.find((block) => block.type === "item" && block.depth === 1)
    expect(nested && nested.type === "item" ? nested.pieces.map((piece) => piece.text).join("") : "").toBe(
      "A nested point",
    )

    const code = blocks.find((block) => block.type === "code")
    expect(code?.type === "code" ? code.text : "").toContain('const place = "Darul Arqam"')

    const visible = JSON.stringify(blocks)
    expect(visible).not.toContain("**")
    expect(visible).not.toContain("##")
    expect(visible).not.toContain("`")
  })

  it("writes a PDF whose text is styled markdown, not raw marks", async () => {
    const source = lecture
    const bytes = await renderPdf(source)
    expect(source).toContain("**")
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-")
    const loaded = await PDFDocument.load(bytes)
    expect(loaded.getPageCount()).toBeGreaterThan(0)
    const annots = loaded.getPages()[0]?.node.Annots()
    const urls: string[] = []
    if (annots) {
      for (let index = 0; index < annots.size(); index += 1) {
        const annot = annots.lookup(index)
        if (!(annot instanceof PDFDict)) continue
        const action = annot.lookup(PDFName.of("A"))
        if (!(action instanceof PDFDict)) continue
        const uri = action.lookup(PDFName.of("URI"))
        if (uri instanceof PDFString || uri instanceof PDFHexString) urls.push(uri.decodeText())
      }
    }
    expect(urls).toContain("https://example.com/kaaba")
    const text = await pdfText(bytes)
    if (text == null) return
    expect(text).toContain("Darul Arqam and Migration to Abyssinia")
    expect(text).toContain("Darul Arqam as a secret meeting place")
    expect(text).toContain("quiet")
    expect(text).toContain("young")
    expect(text).toContain("the Kaaba")
    expect(text).toContain("Darul Arqam")
    expect(text).toContain("First migration")
    expect(text).toContain("A nested point")
    expect(text).not.toContain("**")
    expect(text).not.toContain("130?m")
    expect(text).toMatch(/130\s*m/)
    expect(text).not.toContain("[the Kaaba]")
    expect(text).not.toContain("`Darul")
  })
})
