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
    expect(english).toContain(
      "When the lecture's context needs them, such as history, keep dates, years, and named time periods that were spoken.",
    )
    expect(english).toContain("Do not invent dates.")
    expect(english).not.toMatch(/Hijrah|Biʿthah|Bi.thah|ISC\s*102/i)
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
    try {
      await completeChat(key, [{ role: "user", content: "The lecture says Hijrah in 622." }], refused)
      throw new Error("expected Groq to refuse")
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError)
      const failure = error as StudyError
      expect(failure.message).toBe("Groq refused the request (400).")
      expect(failure.detail).toContain(`model: ${GROQ_NOTES_MODEL}`)
      expect(failure.detail).toContain("status: 400")
      expect(failure.detail).toContain("body:")
      expect(failure.detail).not.toContain(key)
      expect(failure.detail).not.toContain("Hijrah")
    }
    const denied: typeof fetch = async () => new Response("{}", { status: 401 })
    await expect(transcribeChunk(key, new Uint8Array([1]), "clip.wav", notesLanguage("en"), 0, denied)).rejects.toThrow(
      "Groq refused that API key.",
    )
  })

  it("caps the completion and retries a rate limit without an upgrade pitch", async () => {
    const key = "gsk_secret_value"
    const bodies: Array<{ max_completion_tokens?: number }> = []
    let tries = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      tries += 1
      bodies.push(JSON.parse(String(init?.body)) as { max_completion_tokens?: number })
      if (tries === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Rate limit reached. Please try again in 0.01s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
            },
          }),
          { status: 429 },
        )
      }
      return Response.json({ choices: [{ message: { content: "## Cells" } }] })
    }
    await expect(completeChat(key, [{ role: "user", content: "notes" }], fetchImpl, 400)).resolves.toBe("## Cells")
    expect(tries).toBe(2)
    expect(bodies[0]?.max_completion_tokens).toBe(400)

    const blocked: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: { message: "Rate limit reached. Need more tokens? Upgrade to Dev Tier today." },
        }),
        { status: 429, headers: { "retry-after": "0" } },
      )
    await expect(completeChat(key, [{ role: "user", content: "notes" }], blocked, 200)).rejects.toThrow(
      /^Rate limit reached\.$/,
    )
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

  it("logs an empty study-notes reply with the model, status, and body", async () => {
    const key = "gsk_secret_value"
    const fetchImpl: typeof fetch = async () =>
      Response.json({
        model: GROQ_NOTES_MODEL,
        choices: [{ message: { content: null, reasoning: "This slice has no heading." } }],
      })
    await expect(
      completeChat(key, [{ role: "user", content: "Transcript for this section:\n[00:00] The year 622 was spoken." }], fetchImpl),
    ).rejects.toMatchObject({
      message: "Groq did not return study notes.",
      code: "NOTES",
    })
    try {
      await completeChat(
        key,
        [{ role: "user", content: "Transcript for this section:\n[00:00] The year 622 was spoken." }],
        fetchImpl,
      )
    } catch (error) {
      expect(error).toBeInstanceOf(StudyError)
      const detail = (error as StudyError).detail ?? ""
      expect(detail).toContain(`model: ${GROQ_NOTES_MODEL}`)
      expect(detail).toContain("status: 200")
      expect(detail).toContain("This slice has no heading.")
      expect(detail).not.toContain(key)
      expect(detail).not.toContain("The year 622 was spoken")
    }
  })
})
