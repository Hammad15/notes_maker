import { describe, expect, it } from "vitest"
import { StudyError } from "./errors"
import {
  chatText,
  completeChat,
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
    expect(GROQ_NOTES_MODEL).toBe("llama-3.3-70b-versatile")
    expect(GROQ_WHISPER_MODEL).not.toMatch(/gpt|whisper-1/)
    expect(GROQ_NOTES_MODEL).not.toMatch(/gpt|whisper-1/)
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
    expect(studyNotesInstruction(notesLanguage("en"))).toContain("English")
  })

  it("sends one chunk and refuses a key echoed in an error", async () => {
    const key = "gsk_secret_value"
    const calls: Array<{ url: string; model: FormDataEntryValue | null; language: FormDataEntryValue | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      const form = init?.body
      if (!(form instanceof FormData)) throw new Error("expected form")
      calls.push({ url, model: form.get("model"), language: form.get("language") })
      const auth = new Headers(init?.headers).get("authorization") ?? ""
      expect(auth).toBe(`Bearer ${key}`)
      return Response.json({ text: "Mitosis begins." })
    }
    const segments = await transcribeChunk(key, new Uint8Array([1, 2, 3]), "clip.wav", notesLanguage("en"), 0, fetchImpl)
    expect(segments).toEqual([{ start: 0, end: 0, text: "Mitosis begins." }])
    expect(calls).toEqual([
      { url: GROQ_TRANSCRIPTIONS_URL, model: GROQ_WHISPER_MODEL, language: "en" },
    ])

    const refused: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: `bad ${key}` } }), { status: 400 })
    await expect(completeChat(key, [{ role: "user", content: "notes" }], refused)).rejects.toThrow(
      /Groq refused the request \(400\)/,
    )
    const denied: typeof fetch = async () => new Response("{}", { status: 401 })
    await expect(transcribeChunk(key, new Uint8Array([1]), "clip.wav", notesLanguage("en"), 0, denied)).rejects.toThrow(
      "Groq refused that API key.",
    )
  })

  it("reads the chat text", () => {
    expect(chatText({ choices: [{ message: { content: "  ## Cells\n" } }] })).toBe("## Cells")
    expect(() => {
      throw new StudyError("Cloud notes use Groq.", "GROQ")
    }).toThrow(StudyError)
  })
})
