import fontkit from "@pdf-lib/fontkit"
import { unified } from "unified"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import type { Content, PhrasingContent, Root } from "mdast"
import {
  PDFDocument,
  PDFName,
  PDFString,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib"

export type MarkdownStyle = {
  bold: boolean
  italic: boolean
  code: boolean
  href?: string
}

export type MarkdownPiece = MarkdownStyle & { text: string }

type MarkdownBlock =
  | { type: "heading"; level: number; pieces: MarkdownPiece[] }
  | { type: "paragraph"; pieces: MarkdownPiece[]; indent: number }
  | { type: "item"; depth: number; marker: string; pieces: MarkdownPiece[] }
  | { type: "code"; text: string }
  | { type: "rule" }
  | { type: "table"; header: MarkdownPiece[][]; rows: MarkdownPiece[][][] }

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 64

const paper = rgb(0.98, 0.96, 0.93)
const ink = rgb(0.16, 0.14, 0.11)
const muted = rgb(0.4, 0.36, 0.3)
const brass = rgb(0.62, 0.46, 0.22)
const rule = rgb(0.76, 0.7, 0.6)
const linkInk = rgb(0.33, 0.24, 0.62)
const codeBg = rgb(0.93, 0.9, 0.84)

const PLAIN: MarkdownStyle = { bold: false, italic: false, code: false }

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
  "\u02bc": "'",
  "\u02be": "'",
  "\u02bf": "'",
  "\u2032": "'",
  "\u2033": '"',
  "\u2044": "/",
  "\u2212": "-",
}

/** Characters the old Times PDF font could not store, rewritten as "?". */
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

function isSpaceSeparator(code: number): boolean {
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}

function isDropped(code: number): boolean {
  return code === 0x00ad || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060 || code === 0xfeff
}

function fallback(code: number): string | null {
  if (isSpaceSeparator(code)) return " "
  if (isDropped(code)) return null
  const punct = PUNCTUATION[String.fromCodePoint(code)]
  if (punct) return punct
  const decomposed = String.fromCodePoint(code).normalize("NFKD")
  if (decomposed === String.fromCodePoint(code)) return null
  let base = ""
  for (const char of decomposed) {
    const piece = char.codePointAt(0) ?? 0
    if (piece >= 0x0300 && piece <= 0x036f) continue
    base += char
  }
  return base || null
}

/** Keep glyphs the embedded font can draw. Map the rest to ASCII, never to a fake question mark when a space or letter will do. */
export function fitToFont(text: string, supported: ReadonlySet<number>): string {
  let out = ""
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (supported.has(code)) {
      out += char
      continue
    }
    const mapped = fallback(code)
    if (mapped == null) continue
    let safe = ""
    for (const piece of mapped) {
      const point = piece.codePointAt(0) ?? 0
      if (supported.has(point)) safe += piece
    }
    if (safe) out += safe
    else if (supported.has(0x3f)) out += "?"
  }
  return out
}

function parseTree(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
}

function inlinePieces(nodes: PhrasingContent[], style: MarkdownStyle): MarkdownPiece[] {
  const pieces: MarkdownPiece[] = []
  for (const node of nodes) {
    if (node.type === "text") {
      pieces.push({ ...style, text: node.value.replace(/[ \t]*\n[ \t]*/g, " ") })
    } else if (node.type === "strong") {
      pieces.push(...inlinePieces(node.children, { ...style, bold: true }))
    } else if (node.type === "emphasis") {
      pieces.push(...inlinePieces(node.children, { ...style, italic: true }))
    } else if (node.type === "delete") {
      pieces.push(...inlinePieces(node.children, style))
    } else if (node.type === "inlineCode") {
      pieces.push({ ...style, code: true, text: node.value })
    } else if (node.type === "break") {
      pieces.push({ ...style, text: "\n" })
    } else if (node.type === "link") {
      const linked = { ...style, href: node.url }
      const inner = inlinePieces(node.children, linked)
      pieces.push(...(inner.some((piece) => piece.text.trim()) ? inner : [{ ...linked, text: node.url }]))
    } else if (node.type === "linkReference") {
      pieces.push(...inlinePieces(node.children, style))
    } else if (node.type === "imageReference") {
      if (node.alt) pieces.push({ ...style, text: node.alt })
    } else if (node.type === "image") {
      pieces.push({ ...style, text: node.alt || node.url })
    } else if (node.type === "html") {
      const text = node.value.replace(/<[^>]+>/g, "")
      if (text) pieces.push({ ...style, text })
    } else if (node.type === "footnoteReference") {
      pieces.push({ ...style, text: `[${node.label ?? node.identifier}]` })
    }
  }
  return pieces
}

function blocksFrom(nodes: Content[], depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  for (const node of nodes) {
    if (node.type === "heading") {
      blocks.push({ type: "heading", level: node.depth, pieces: inlinePieces(node.children, PLAIN) })
    } else if (node.type === "paragraph") {
      blocks.push({ type: "paragraph", indent: depth, pieces: inlinePieces(node.children, PLAIN) })
    } else if (node.type === "list") {
      const start = node.start ?? 1
      node.children.forEach((item, index) => {
        const marker = node.ordered ? `${start + index}.` : "•"
        const check = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : ""
        let marked = false
        for (const child of item.children) {
          if (child.type === "paragraph") {
            const pieces = inlinePieces(child.children, PLAIN)
            if (!marked && check) pieces.unshift({ ...PLAIN, text: check })
            blocks.push({ type: "item", depth, marker: marked ? "" : marker, pieces })
            marked = true
          } else if (child.type === "list") {
            blocks.push(...blocksFrom([child], depth + 1))
          } else {
            blocks.push(...blocksFrom([child], depth + 1))
          }
        }
      })
    } else if (node.type === "blockquote") {
      blocks.push(...blocksFrom(node.children, depth + 1))
    } else if (node.type === "code") {
      blocks.push({ type: "code", text: node.value.replace(/\s+$/, "") })
    } else if (node.type === "thematicBreak") {
      blocks.push({ type: "rule" })
    } else if (node.type === "table") {
      const rows = node.children.map((row) => row.children.map((cell) => inlinePieces(cell.children, PLAIN)))
      blocks.push({ type: "table", header: rows[0] ?? [], rows: rows.slice(1) })
    } else if (node.type === "footnoteDefinition") {
      blocks.push(...blocksFrom(node.children, depth))
    }
  }
  return blocks
}

export function parseStudyMarkdown(markdown: string): MarkdownBlock[] {
  return blocksFrom(parseTree(markdown).children, 0)
}

type Face = {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  boldItalic: PDFFont
  mono: PDFFont
  supported: Map<PDFFont, Set<number>>
}

type Token = {
  text: string
  font: PDFFont
  width: number
  style: MarkdownStyle
}

const regularUrl = new URL("./fonts/LiberationSerif-Regular.ttf", import.meta.url)
const boldUrl = new URL("./fonts/LiberationSerif-Bold.ttf", import.meta.url)
const italicUrl = new URL("./fonts/LiberationSerif-Italic.ttf", import.meta.url)
const boldItalicUrl = new URL("./fonts/LiberationSerif-BoldItalic.ttf", import.meta.url)
const monoUrl = new URL("./fonts/LiberationMono-Regular.ttf", import.meta.url)

async function readFont(url: URL): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error("Could not load a PDF font.")
  return new Uint8Array(await response.arrayBuffer())
}

let fontBytes: Promise<[Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]> | null = null

function loadFontBytes() {
  fontBytes ??= Promise.all([
    readFont(regularUrl),
    readFont(boldUrl),
    readFont(italicUrl),
    readFont(boldItalicUrl),
    readFont(monoUrl),
  ])
  return fontBytes
}

function charset(font: PDFFont): Set<number> {
  return new Set(font.getCharacterSet())
}

function pickFont(face: Face, style: MarkdownStyle): PDFFont {
  if (style.code) return face.mono
  if (style.bold && style.italic) return face.boldItalic
  if (style.bold) return face.bold
  if (style.italic) return face.italic
  return face.regular
}

function breakToken(text: string, font: PDFFont, size: number, maxWidth: number, supported: ReadonlySet<number>): string[] {
  const fitted = fitToFont(text, supported)
  if (!fitted) return []
  if (font.widthOfTextAtSize(fitted, size) <= maxWidth) return [fitted]
  const parts: string[] = []
  let current = ""
  for (const char of fitted) {
    const next = current + char
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      parts.push(current)
      current = char
    } else current = next
  }
  if (current) parts.push(current)
  return parts
}

function layoutPieces(pieces: MarkdownPiece[], face: Face, size: number, maxWidth: number): Token[][] {
  const lines: Token[][] = []
  let line: Token[] = []
  let used = 0
  const commit = () => {
    if (line.length > 0) lines.push(line)
    line = []
    used = 0
  }
  for (const piece of pieces) {
    const font = pickFont(face, piece)
    const supported = face.supported.get(font) ?? new Set<number>()
    for (const chunk of piece.text.split(/(\n)/)) {
      if (chunk === "\n") {
        commit()
        continue
      }
      for (const part of chunk.split(/(\s+)/)) {
        if (!part) continue
        for (const text of breakToken(part, font, size, maxWidth, supported)) {
          const space = /^\s+$/.test(text)
          const width = font.widthOfTextAtSize(text, size)
          if (space && line.length === 0) continue
          if (used + width > maxWidth && line.length > 0) commit()
          if (space && line.length === 0) continue
          line.push({ text, font, width, style: piece })
          used += width
        }
      }
    }
  }
  commit()
  return lines
}

function linkTarget(url: string): string | null {
  const trimmed = url.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return null
}

function addLink(page: PDFPage, x: number, y: number, width: number, height: number, url: string) {
  const target = linkTarget(url)
  if (!target || width <= 0) return
  const annot = page.doc.context.register(
    page.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(target),
      },
    }),
  )
  const existing = page.node.Annots()
  if (existing) existing.push(annot)
  else page.node.set(PDFName.of("Annots"), page.doc.context.obj([annot]))
}

export async function renderPdf(markdown: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const [regularBytes, boldBytes, italicBytes, boldItalicBytes, monoBytes] = await loadFontBytes()
  const embed = (bytes: Uint8Array) => pdf.embedFont(bytes, { subset: true })
  const regular = await embed(regularBytes)
  const bold = await embed(boldBytes)
  const italic = await embed(italicBytes)
  const boldItalic = await embed(boldItalicBytes)
  const mono = await embed(monoBytes)
  const face: Face = {
    regular,
    bold,
    italic,
    boldItalic,
    mono,
    supported: new Map([
      [regular, charset(regular)],
      [bold, charset(bold)],
      [italic, charset(italic)],
      [boldItalic, charset(boldItalic)],
      [mono, charset(mono)],
    ]),
  }
  const blocks = parseStudyMarkdown(markdown)
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let y = PAGE_HEIGHT - MARGIN

  const paintPaper = (target: PDFPage) => {
    target.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: paper })
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

  const drawTokens = (lines: Token[][], x: number, size: number, leading: number) => {
    for (const line of lines) {
      ensure(leading)
      const baseline = y - size
      let cursor = x
      let index = 0
      while (index < line.length) {
        const token = line[index]
        if (!token) break
        if (token.style.href) {
          const href = token.style.href
          const start = cursor
          let width = 0
          while (index < line.length && line[index]?.style.href === href) {
            const part = line[index]
            if (!part) break
            if (part.style.code) {
              page.drawRectangle({
                x: cursor,
                y: baseline - 2,
                width: part.width,
                height: size + 3,
                color: codeBg,
              })
            }
            if (part.text) {
              page.drawText(part.text, { x: cursor, y: baseline, size, font: part.font, color: linkInk })
              page.drawLine({
                start: { x: cursor, y: baseline - 1.5 },
                end: { x: cursor + part.width, y: baseline - 1.5 },
                thickness: 0.6,
                color: linkInk,
              })
            }
            cursor += part.width
            width += part.width
            index += 1
          }
          addLink(page, start, baseline - 2, width, size + 3, href)
          continue
        }
        if (token.style.code && token.text.trim()) {
          page.drawRectangle({
            x: cursor,
            y: baseline - 2,
            width: token.width,
            height: size + 3,
            color: codeBg,
          })
        }
        if (token.text) {
          page.drawText(token.text, { x: cursor, y: baseline, size, font: token.font, color: ink })
        }
        cursor += token.width
        index += 1
      }
      y -= leading
    }
  }

  const usable = PAGE_WIDTH - MARGIN * 2

  for (const block of blocks) {
    if (block.type === "heading") {
      const size = block.level <= 1 ? 22 : block.level === 2 ? 15 : block.level === 3 ? 13 : 12
      const leading = size + 6
      y -= block.level === 1 ? 0 : 8
      drawTokens(layoutPieces(block.pieces, face, size, usable), MARGIN, size, leading)
      if (block.level === 1) {
        y -= 4
        ensure(8)
        page.drawLine({
          start: { x: MARGIN, y },
          end: { x: MARGIN + 84, y },
          thickness: 1.5,
          color: brass,
        })
        y -= 16
      } else y -= 4
      continue
    }
    if (block.type === "item") {
      const size = 11
      const leading = 15
      const x = MARGIN + block.depth * 18
      const markerFont = face.regular
      const marker = block.marker ? fitToFont(block.marker, face.supported.get(markerFont) ?? new Set()) : ""
      const markerWidth = marker ? markerFont.widthOfTextAtSize(marker, size) + 8 : 0
      const textX = x + (marker ? Math.max(16, markerWidth) : 0)
      const lines = layoutPieces(block.pieces, face, size, Math.max(40, usable - (textX - MARGIN)))
      if (lines.length === 0) {
        ensure(leading)
        if (marker) page.drawText(marker, { x, y: y - size, size, font: markerFont, color: ink })
        y -= leading
        continue
      }
      lines.forEach((line, lineIndex) => {
        ensure(leading)
        if (lineIndex === 0 && marker) {
          page.drawText(marker, { x, y: y - size, size, font: markerFont, color: ink })
        }
        drawTokens([line], textX, size, leading)
      })
      continue
    }
    if (block.type === "code") {
      const size = 10
      const leading = 14
      const supported = face.supported.get(mono) ?? new Set<number>()
      for (const source of block.text.split("\n")) {
        const text = fitToFont(source, supported)
        ensure(leading)
        page.drawRectangle({
          x: MARGIN,
          y: y - leading + 2,
          width: usable,
          height: leading,
          color: codeBg,
        })
        if (text.trim()) page.drawText(text, { x: MARGIN + 6, y: y - size, size, font: mono, color: ink })
        y -= leading
      }
      y -= 8
      continue
    }
    if (block.type === "rule") {
      y -= 6
      ensure(8)
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: MARGIN + usable, y },
        thickness: 0.6,
        color: rule,
      })
      y -= 10
      continue
    }
    if (block.type === "table") {
      const columns = Math.max(block.header.length, 1)
      const widths =
        columns === 2
          ? [Math.min(132, usable * 0.32), usable - Math.min(132, usable * 0.32)]
          : Array.from({ length: columns }, () => usable / columns)
      const drawRow = (cells: MarkdownPiece[][], header: boolean) => {
        const size = header ? 10 : 9.5
        const leading = 12
        const wrapped = cells.map((cell, cellIndex) =>
          layoutPieces(
            header ? cell.map((piece) => (piece.code ? piece : { ...piece, bold: true })) : cell,
            face,
            size,
            Math.max(24, (widths[cellIndex] ?? widths[0]) - 8),
          ),
        )
        const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length))
        const height = lineCount * leading + 8
        ensure(height)
        let x = MARGIN
        const top = y
        wrapped.forEach((lines, cellIndex) => {
          lines.forEach((line, lineIndex) => {
            let cursor = x + 4
            const baseline = top - 14 - lineIndex * leading
            for (const token of line) {
              if (token.text) {
                page.drawText(token.text, {
                  x: cursor,
                  y: baseline,
                  size,
                  font: token.font,
                  color: token.style.href ? linkInk : ink,
                })
              }
              cursor += token.width
            }
          })
          x += widths[cellIndex] ?? widths[0]
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
      drawRow(block.header, true)
      for (const row of block.rows) drawRow(row, false)
      y -= 10
      continue
    }
    const size = 11
    const x = MARGIN + block.indent * 16
    drawTokens(layoutPieces(block.pieces, face, size, Math.max(40, usable - block.indent * 16)), x, size, 15)
    y -= 8
  }

  const pages = pdf.getPages()
  const footerSet = face.supported.get(regular) ?? new Set<number>()
  pages.forEach((target, index) => {
    const label = fitToFont("Create Notes", footerSet)
    target.drawText(label, { x: MARGIN, y: 36, size: 9, font: regular, color: muted })
    const pageLabel = String(index + 1)
    const width = regular.widthOfTextAtSize(pageLabel, 9)
    target.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN - width,
      y: 36,
      size: 9,
      font: regular,
      color: muted,
    })
  })

  return pdf.save()
}
