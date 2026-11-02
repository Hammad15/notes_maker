import { describe, expect, it } from "vitest"
import { StudyError } from "./errors"
import {
  estimateTokens,
  GROQ_REQUEST_TOKEN_BUDGET,
  mergeMarkdownSections,
  packSpeech,
  requestTokens,
  writeLectureNotes,
} from "./lectureNotes"
import type { NoteContent, TranscriptSegment } from "./types"

function content(segments: TranscriptSegment[]): NoteContent {
  return {
    title: "ISC 102 U06",
    courseName: "ISC 102",
    moduleName: null,
    filedAt: "2026-01-01T00:00:00.000Z",
    durationSeconds: 3600,
    segments,
    chapters: [],
    transcriptProduced: true,
  }
}

function longLecture(): { segments: TranscriptSegment[]; last: number } {
  const segments: TranscriptSegment[] = []
  let index = 0
  let cursor = 0
  while (estimateTokens(segments.map((segment) => segment.text).join("\n")) < 9000 && index < 400) {
    const topic = index % 2 === 0 ? "Elasticity" : "Supply"
    segments.push({
      start: cursor,
      end: cursor + 3,
      text: `${topic} point ${index} is a complete sentence about prices, buyers, sellers, and the market.`,
    })
    cursor += 4.2
    index += 1
  }
  return { segments, last: index - 1 }
}

describe("lecture note chunks", () => {
  it("keeps a paused sentence together and splits on the next sentence", () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 1.2, text: "The price rises and" },
      { start: 2.6, end: 4, text: "the quantity falls." },
      { start: 6, end: 8, text: "Buyers leave the market." },
    ]
    const chunks = packSpeech(segments, 5)
    expect(chunks[0]?.map((segment) => segment.text).join(" ")).toBe("The price rises and the quantity falls.")
    expect(chunks[1]?.map((segment) => segment.text).join(" ")).toBe("Buyers leave the market.")
    expect(chunks).toHaveLength(2)
  })

  it("splits on silence between utterances and on a sentence boundary", () => {
    const paused: TranscriptSegment[] = [
      { start: 0, end: 2, text: "Supply is the amount offered" },
      { start: 4, end: 6, text: "Demand is the amount wanted." },
    ]
    expect(packSpeech(paused, 5)).toHaveLength(2)

    const sentences: TranscriptSegment[] = [
      { start: 0, end: 2, text: "Alpha sentence is long enough to spend the budget." },
      { start: 2.1, end: 4, text: "Beta sentence starts the next paragraph." },
    ]
    const chunks = packSpeech(sentences, 5)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.[0]?.text).toContain("Alpha")
    expect(chunks[1]?.[0]?.text).toContain("Beta")
    expect(chunks[0]?.[0]?.text.endsWith("budget.")).toBe(true)
  })

  it("merges the same topic from two chunks under one heading", () => {
    const note = mergeMarkdownSections([
      { markdown: "## Elasticity\n\n- Price responds.\n  - Substitutes matter.\n", title: "Elasticity" },
      { markdown: "## elasticity\n\n- Price responds.\n- Demand stretches.\n", title: "Elasticity" },
      { markdown: "## Supply\n\n- Markets clear.\n", title: "Supply" },
    ])
    expect(note.match(/^## .+$/gm)).toEqual(["## Elasticity", "## Supply"])
    expect(note).toContain("- Price responds.")
    expect(note).toContain("  - Substitutes matter.")
    expect(note).toContain("- Demand stretches.")
    expect(note.match(/- Price responds\./g)).toHaveLength(1)
  })
})

describe("one lecture outline", () => {
  it("drops a not-in-the-transcript disclaimer and keeps the real section", async () => {
    const body = await writeLectureNotes({
      language: { code: "en", name: "English" },
      content: content([
        { start: 0, end: 4, text: "Price responds to substitutes." },
        { start: 6, end: 9, text: "The market segment does not contain many buyers." },
      ]),
      complete: async (messages) => {
        const system = messages[0]?.content ?? ""
        const user = messages[1]?.content ?? ""
        if (/outline of the whole lecture/i.test(system)) {
          return JSON.stringify({
            sections: [
              { title: "Elasticity", start: 0, end: 4 },
              { title: "Market failure", start: 6, end: 9 },
            ],
          })
        }
        expect(system).toMatch(/Do not mention a transcript, a segment, a slice, or missing source material/)
        expect(system).toMatch(/return no heading and no text/)
        expect(system).toMatch(
          /When the lecture's context needs them, such as history, keep dates, years, and named time periods that were spoken/,
        )
        expect(system).toMatch(/Do not invent dates/)
        if (/Section: Market failure/.test(user)) {
          return [
            "## Market failure",
            "",
            "The provided transcript segment does not contain any discussion of market failure.",
            "",
            "Not in the transcript.",
            "",
            "This slice does not cover market failure.",
          ].join("\n")
        }
        return "## Elasticity\n\n- Price responds to substitutes.\n- The market segment does not contain many buyers.\n"
      },
    })
    expect(body).toContain("## Elasticity")
    expect(body).toContain("Price responds to substitutes.")
    expect(body).toContain("The market segment does not contain many buyers.")
    expect(body).not.toMatch(/not in the transcript/i)
    expect(body).not.toMatch(/does not contain any discussion/i)
    expect(body).not.toMatch(/transcript segment/i)
    expect(body).not.toMatch(/this slice/i)
    expect(body).not.toMatch(/## Market failure/)
    expect(mergeMarkdownSections([
      { title: "Externalities", markdown: "## Externalities\n\nNot in the transcript.\n" },
      { title: "Elasticity", markdown: "## Elasticity\n\n- Demand stretches.\n" },
    ])).toBe("## Elasticity\n\n- Demand stretches.")
  })

  it("keeps the lecture when one section comes back empty", async () => {
    const body = await writeLectureNotes({
      language: { code: "en", name: "English" },
      content: content([
        { start: 0, end: 4, text: "Price responds to substitutes." },
        { start: 6, end: 9, text: "Buyers and sellers meet in the market." },
      ]),
      complete: async (messages) => {
        const system = messages[0]?.content ?? ""
        const user = messages[1]?.content ?? ""
        if (/outline of the whole lecture/i.test(system)) {
          return JSON.stringify({
            sections: [
              { title: "Elasticity", start: 0, end: 4 },
              { title: "Markets", start: 6, end: 9 },
            ],
          })
        }
        if (/Section: Markets/.test(user)) {
          throw new StudyError(
            "Groq did not return study notes.",
            "NOTES",
            "model: openai/gpt-oss-120b\nstatus: 200\nbody: {\"choices\":[{\"message\":{\"content\":null}}]}",
          )
        }
        return "## Elasticity\n\n- Price responds to substitutes.\n"
      },
    })
    expect(body).toContain("## Elasticity")
    expect(body).toContain("Price responds to substitutes.")
    expect(body).not.toContain("## Markets")
  })

  it("outlines a short lecture before writing its section", async () => {
    const kinds: string[] = []
    const body = await writeLectureNotes({
      language: { code: "en", name: "English" },
      content: content([
        { start: 0, end: 4, text: "Today we talk about cell division." },
        { start: 5, end: 9, text: "Mitosis is the process where the cell divides." },
      ]),
      complete: async (messages) => {
        const system = messages[0]?.content ?? ""
        if (/compact summary/i.test(system)) {
          kinds.push("summary")
          return "0-9 | Cell division."
        }
        if (/outline of the whole lecture/i.test(system)) {
          kinds.push("outline")
          expect(messages[1]?.content).toContain("cell division")
          expect(messages[1]?.content).toContain("Mitosis")
          return '{"sections":[{"title":"Cell division","start":0,"end":9}]}'
        }
        kinds.push("fill")
        expect(messages[1]?.content).toContain("Outline of the whole lecture:")
        expect(system).not.toMatch(/outline of the whole lecture/i)
        return "## Cell division\n\n- Mitosis divides one cell.\n  - Two daughter cells result.\n"
      },
    })
    expect(kinds).toEqual(["outline", "fill"])
    expect(body).toContain("## Cell division")
    expect(body).toContain("  - Two daughter cells result.")
    expect(body).not.toMatch(/^# /m)
  })

  it("summarizes a long lecture, outlines it once, then merges section chunks", async () => {
    const lecture = longLecture()
    const kinds: string[] = []
    const outlineUsers: string[] = []
    const body = await writeLectureNotes({
      language: { code: "en", name: "English" },
      content: content(lecture.segments),
      complete: async (messages, maxCompletionTokens) => {
        expect(requestTokens(messages, maxCompletionTokens)).toBeLessThanOrEqual(GROQ_REQUEST_TOKEN_BUDGET)
        const system = messages[0]?.content ?? ""
        const user = messages[1]?.content ?? ""
        if (/compact summary/i.test(system)) {
          kinds.push("summary")
          const points = [...user.matchAll(/point (\d+)/g)]
          const first = points[0]?.[1] ?? "0"
          const last = points[points.length - 1]?.[1] ?? first
          return `0-1 | Covers point ${first} through point ${last}.`
        }
        if (/outline of the whole lecture/i.test(system)) {
          kinds.push("outline")
          outlineUsers.push(user)
          return JSON.stringify({
            sections: [
              { title: "Elasticity", ranges: [{ start: 0, end: 10_000 }] },
              { title: "elasticity", start: 10_000, end: 20_000 },
            ],
          })
        }
        kinds.push("fill")
        const point = user.match(/point (\d+)/)?.[1] ?? "x"
        return `## Elasticity\n\n- Point ${point} belongs in the lecture.\n  - Detail ${point}.\n`
      },
    })
    expect(kinds[0]).toBe("summary")
    expect(kinds.filter((kind) => kind === "outline")).toEqual(["outline"])
    expect(kinds.indexOf("fill")).toBeGreaterThan(kinds.indexOf("outline"))
    expect(kinds.slice(kinds.indexOf("outline") + 1).every((kind) => kind === "fill")).toBe(true)
    expect(outlineUsers[0]).toContain("point 0")
    expect(outlineUsers[0]).toContain(`point ${lecture.last}`)
    expect(body.match(/^## .+$/gm)).toEqual(["## Elasticity"])
    expect(body).toContain("  - Detail")
    expect((body.match(/^- Point /gm) ?? []).length).toBeGreaterThan(1)
  })
})
