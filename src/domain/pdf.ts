import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"

type Block =
  | { type: "h1" | "h2" | "h3" | "p" | "bullet"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] }

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 64

const paper = rgb(0.98, 0.96, 0.93)
const ink = rgb(0.16, 0.14, 0.11)
const muted = rgb(0.4, 0.36, 0.3)
const brass = rgb(0.62, 0.46, 0.22)
const rule = rgb(0.76, 0.7, 0.6)

const PUNCTUATION: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2022": "-",
  "\u2026": "...",
  "\u00a0": " ",
}

export function toWinAnsi(text: string): string {
  let out = ""
  for (const char of text) {
    if (PUNCTUATION[char]) {
      out += PUNCTUATION[char]
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) out += char
    else out += "?"
  }
  return out
}

function splitCells(line: string): string[] {
  const parts = line.split("|").map((cell) => cell.trim())
  if (parts[0] === "") parts.shift()
  if (parts[parts.length - 1] === "") parts.pop()
  return parts
}

function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

export function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() })
      index += 1
      continue
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() })
      index += 1
      continue
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() })
      index += 1
      continue
    }
    if (line.trimStart().startsWith("- ")) {
      blocks.push({ type: "bullet", text: line.trimStart().slice(2).trim() })
      index += 1
      continue
    }
    if (line.trimStart().startsWith("|")) {
      const tableLines: string[] = []
      while (index < lines.length && lines[index].trimStart().startsWith("|")) {
        tableLines.push(lines[index])
        index += 1
      }
      const parsed = tableLines
        .filter((entry) => !isSeparator(entry))
        .map(splitCells)
        .filter((cells) => cells.length > 0)
      if (parsed.length > 0) {
        blocks.push({ type: "table", headers: parsed[0], rows: parsed.slice(1) })
      }
      continue
    }
    const paragraph = [line.trim()]
    index += 1
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("#") &&
      !lines[index].trimStart().startsWith("|") &&
      !lines[index].trimStart().startsWith("- ")
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push({ type: "p", text: paragraph.join(" ") })
  }
  return blocks
}

function wrapLine(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = toWinAnsi(text).trim()
  if (!clean) return [""]
  const words = clean.split(/\s+/)
  const lines: string[] = []
  let current = ""
  const pushWord = (word: string) => {
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word
      return
    }
    let rest = word
    while (rest.length > 1 && font.widthOfTextAtSize(rest, size) > maxWidth) {
      let cut = rest.length - 1
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
        cut -= 1
      }
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    current = rest
  }
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= maxWidth) current = next
    else {
      if (current) lines.push(current)
      pushWord(word)
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : [""]
}

export async function renderPdf(markdown: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const serif = await pdf.embedFont(StandardFonts.TimesRoman)
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold)
  const sans = await pdf.embedFont(StandardFonts.Helvetica)
  const blocks = parseMarkdownBlocks(markdown)
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const paintPaper = (target: PDFPage) => {
    target.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: paper,
    })
  }
  paintPaper(page)

  const nextPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    paintPaper(page)
    y = PAGE_HEIGHT - MARGIN
  }

  const ensure = (height: number) => {
    if (y - height < MARGIN) nextPage()
  }

  const drawLines = (
    lines: string[],
    font: PDFFont,
    size: number,
    leading: number,
    x: number,
    color = ink,
  ) => {
    for (const line of lines) {
      ensure(leading)
      const safe = toWinAnsi(line)
      if (safe.trim()) {
        page.drawText(safe, { x, y: y - size, size, font, color })
      }
      y -= leading
    }
  }

  const usable = PAGE_WIDTH - MARGIN * 2

  for (const block of blocks) {
    if (block.type === "h1") {
      ensure(36)
      const lines = wrapLine(block.text, serifBold, 22, usable)
      drawLines(lines, serifBold, 22, 26, MARGIN)
      y -= 4
      ensure(8)
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: MARGIN + 84, y },
        thickness: 1.5,
        color: brass,
      })
      y -= 16
      continue
    }
    if (block.type === "h2" || block.type === "h3") {
      y -= block.type === "h2" ? 10 : 6
      const size = block.type === "h2" ? 14 : 12
      const lines = wrapLine(block.text, serifBold, size, usable)
      drawLines(lines, serifBold, size, size + 4, MARGIN)
      y -= 4
      continue
    }
    if (block.type === "bullet") {
      const lines = wrapLine(block.text, serif, 11, usable - 16)
      ensure(16)
      page.drawText("-", { x: MARGIN, y: y - 11, size: 11, font: serif, color: ink })
      const saved = y
      drawLines(lines, serif, 11, 15, MARGIN + 14)
      if (y === saved) y -= 15
      continue
    }
    if (block.type === "table") {
      const columns = Math.max(block.headers.length, 1)
      const widths =
        columns === 2
          ? [Math.min(132, usable * 0.32), usable - Math.min(132, usable * 0.32)]
          : Array.from({ length: columns }, () => usable / columns)
      const drawRow = (cells: string[], header: boolean) => {
        const font = header ? serifBold : sans
        const size = header ? 10 : 9.5
        const leading = 12
        const wrapped = cells.map((cell, cellIndex) =>
          wrapLine(cell, font, size, Math.max(24, (widths[cellIndex] ?? widths[0]) - 8)),
        )
        const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length))
        const height = lineCount * leading + 8
        ensure(height)
        let x = MARGIN
        const top = y
        wrapped.forEach((lines, cellIndex) => {
          const width = widths[cellIndex] ?? widths[0]
          lines.forEach((line, lineIndex) => {
            const safe = toWinAnsi(line)
            if (safe.trim()) {
              page.drawText(safe, {
                x: x + 4,
                y: top - 14 - lineIndex * leading,
                size,
                font,
                color: ink,
              })
            }
          })
          x += width
        })
        y -= height
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: MARGIN + usable, y },
          thickness: header ? 1 : 0.4,
          color: header ? ink : rule,
        })
      }
      y -= 6
      ensure(8)
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: MARGIN + usable, y },
        thickness: 0.6,
        color: ink,
      })
      drawRow(block.headers, true)
      for (const row of block.rows) drawRow(row, false)
      y -= 10
      continue
    }
    const lines = wrapLine(block.text, serif, 11, usable)
    drawLines(lines, serif, 11, 15, MARGIN)
    y -= 8
  }

  const pages = pdf.getPages()
  pages.forEach((target, index) => {
    target.drawText("Study Notes", {
      x: MARGIN,
      y: 36,
      size: 9,
      font: sans,
      color: muted,
    })
    const label = String(index + 1)
    const width = sans.widthOfTextAtSize(label, 9)
    target.drawText(label, {
      x: PAGE_WIDTH - MARGIN - width,
      y: 36,
      size: 9,
      font: sans,
      color: muted,
    })
  })

  return pdf.save()
}
