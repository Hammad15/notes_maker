import { describe, expect, it } from "vitest"
import { StudyError } from "./errors"
import {
  chatText,
  completeChat,
  groqCallDetail,
  GROQ_CHAT_URL,
  GROQ_NOTES_MODEL,
  GROQ_ORIGIN,
  GROQ_TRANSCRIPTIONS_URL,
  GROQ_WHISPER_MODEL,
  parseGroqSegments,
  studyNotesInstruction,
  transcribeChunk,
} from "./groq"
import { notesLanguage } from "./language"

describe("Groq speech and notes", () => {
  it("keeps the host and models on Groq", () => {
    expect(new URL(GROQ_TRANSCRIPTIONS_URL).host).toBe("api.groq.com")
    expect(new URL(GROQ_CHAT_URL).host).toBe("api.groq.com")
    expect(GROQ_ORIGIN).toBe("https://api.groq.com")
    expect(GROQ_TRANSCRIPTIONS_URL).not.toContain("api.openai.com")
    expect(GROQ_CHAT_URL).not.toContain("api.openai.com")
    expect(GROQ_WHISPER_MODEL).toBe("whisper-large-v3-turbo")
    expect(GROQ_NOTES_MODEL).toBe("openai/gpt-oss-120b")
    expect(GROQ_NOTES_MODEL).not.toBe("llama-3.3-70b-versatile")
    expect(GROQ_WHISPER_MODEL).not.toMatch(/whisper-1/)
    expect(GROQ_NOTES_MODEL).not.toMatch(/whisper-1/)
  })

  it("shifts segment times and names the notes language", () => {
    expect(
      parseGroqSegments(
        {
          segments: [
            { start: 1.5, end: 4, text: " Mitosis begins. " },
            { start: 4, end: 5, text: "[Music]" },
          ],
        },
        540,
      ),
    ).toEqual([{ start: 541.5, end: 544, text: "Mitosis begins." }])
    const spanish = studyNotesInstruction({ code: "es", name: "Spanish" })
    expect(spanish).toContain("Spanish")
    expect(spanish).not.toContain("English")
    expect(notesLanguage("es")).toEqual({ code: "es", name: "es" })
    const english = studyNotesInstruction(notesLanguage("en"))
    expect(english).toContain("English")
    expect(english).toContain("Use a level-2 Markdown heading for each major topic.")
    expect(english).toContain("use a bold bullet for each subtopic and indented bullets for the facts under it.")
    expect(english).toContain("Keep the density of the speech: names, numbers, places, counts, and the order of events.")
    expect(english).toContain(
      "Keep every date, year, month, and named time period that was spoken, including ordinal years and relative timing.",
    )
    expect(english).toContain("Do not invent dates.")
    expect(english).toContain("Never mention a transcript.")
    expect(english).toContain("Omit a heading that would have no bullets.")
    expect(english).not.toMatch(/Hijrah|Biʿthah|Bi.thah|ISC\s*102/i)
  })

  it("sends chat and speech to Groq and keeps the key out of the log", async () => {
    const key = "gsk_secret_value"
    const request = "Transcript for this section:\n[00:00] The year 622 was spoken."
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      const auth = new Headers(init?.headers).get("authorization")
      expect(auth).toBe(`Bearer ${key}`)
      if (String(input).includes("/audio/")) {
        return Response.json({ segments: [{ start: 0, end: 1, text: "Cells." }] })
      }
      return Response.json({ choices: [{ message: { content: "## Cells" } }] })
    }
    await expect(completeChat(key, [{ role: "user", content: request }], fetchImpl)).resolves.toBe("## Cells")
    await expect(
      transcribeChunk(key, new Uint8Array([1, 2, 3]), "clip.wav", notesLanguage("en"), 0, fetchImpl),
    ).resolves.toEqual([{ start: 0, end: 1, text: "Cells." }])
    expect(urls).toEqual([GROQ_CHAT_URL, GROQ_TRANSCRIPTIONS_URL])
    const detail = groqCallDetail(GROQ_NOTES_MODEL, 400, `bad ${key}`, key)
    expect(detail).toContain(`model: ${GROQ_NOTES_MODEL}`)
    expect(detail).toContain("status: 400")
    expect(detail).not.toContain(key)
    expect(detail).toContain("[redacted]")
    expect(detail).not.toContain(request)
    expect(detail).not.toContain("The year 622 was spoken")
  })

  it("reads the chat text and keeps notes Groq placed beside an empty content field", () => {
    expect(chatText({ choices: [{ message: { content: "  ## Cells\n" } }] })).toBe("## Cells")
    expect(
      chatText({ choices: [{ message: { content: "<think>draft</think>\n## Cells" } }] }),
    ).toBe("## Cells")
    expect(
      chatText({
        choices: [{ message: { content: [{ type: "text", text: "## Cells\n\n- Mitosis." }] } }],
      }),
    ).toBe("## Cells\n\n- Mitosis.")
    expect(
      chatText({
        choices: [
          {
            message: {
              content: "",
              reasoning: "The speech covers cell division.\n\n## Cells\n\n- Mitosis splits one cell.",
            },
          },
        ],
      }),
    ).toBe("## Cells\n\n- Mitosis splits one cell.")
    expect(chatText({ choices: [{ message: { content: "", reasoning: "Nothing to add." } }] })).toBe("")
    expect(() => {
      throw new StudyError("Cloud notes use Groq.", "GROQ")
    }).toThrow(StudyError)
  })

})
