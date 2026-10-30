import { describe, expect, it } from "vitest"
import {
  assertHeardRecording,
  FFMPEG_BUNDLE,
  localJobMessage,
  parseWhisperJson,
  SPEECH_MODEL,
  WHISPER_ENGINE,
  whisperThreadCount,
} from "./localSpeech"

const whisperJson = `{
  "transcription": [
    {
      "timestamps": { "from": "00:00:00,000", "to": "00:00:02,480" },
      "offsets": { "from": 0, "to": 2480 },
      "text": " Mitosis begins when the cell divides."
    },
    {
      "offsets": { "from": 2480, "to": 4000 },
      "text": " [BLANK_AUDIO]"
    }
  ]
}`

describe("whisper transcript", () => {
  it("reads timed speech and drops non-speech markers", () => {
    expect(parseWhisperJson(whisperJson)).toEqual([
      { start: 0, end: 2.48, text: "Mitosis begins when the cell divides." },
    ])
  })

  it("rejects a transcript that is not the model file", () => {
    expect(() => parseWhisperJson("not json")).toThrow(/did not write a transcript/)
  })
})

describe("long recordings", () => {
  it("rejects a 57-minute transcript that finishes in under a minute", () => {
    expect(() =>
      assertHeardRecording({
        durationSeconds: 57 * 60,
        elapsedMs: 59_000,
        segments: [{ start: 0, end: 57 * 60, text: "A fake line of notes." }],
      }),
    ).toThrow(/could have heard/)
  })

  it("accepts a long transcript that took longer than a minute", () => {
    expect(() =>
      assertHeardRecording({
        durationSeconds: 57 * 60,
        elapsedMs: 90_000,
        segments: [{ start: 0, end: 120, text: "Mitosis begins when the cell divides." }],
      }),
    ).not.toThrow()
  })

  it("accepts a short recording that finishes quickly", () => {
    expect(() =>
      assertHeardRecording({
        durationSeconds: 4,
        elapsedMs: 1500,
        segments: [{ start: 0, end: 4, text: "Mitosis begins." }],
      }),
    ).not.toThrow()
  })

  it("rejects silence", () => {
    expect(() =>
      assertHeardRecording({
        durationSeconds: 4,
        elapsedMs: 1500,
        segments: [],
      }),
    ).toThrow(/No speech/)
  })
})

describe("transcription stays usable", () => {
  it("uses half the processors so a lecture does not pin the machine", () => {
    expect(whisperThreadCount(1)).toBe(1)
    expect(whisperThreadCount(2)).toBe(1)
    expect(whisperThreadCount(4)).toBe(2)
    expect(whisperThreadCount(8)).toBe(4)
    expect(whisperThreadCount(4)).toBeLessThan(4)
  })

  it("shows reading, percent, and the notes write", () => {
    expect(localJobMessage("ISC 102 U01.mp3", null)).toBe("Transcribing ISC 102 U01.mp3…")
    expect(localJobMessage("ISC 102 U01.mp3", { phase: "reading", label: "Reading the recording", percent: null })).toBe(
      "Reading ISC 102 U01.mp3…",
    )
    expect(
      localJobMessage("ISC 102 U01.mp3", { phase: "transcribing", label: "Transcribing the recording", percent: 40 }),
    ).toBe("Transcribing ISC 102 U01.mp3… 40%")
    expect(
      localJobMessage("ISC 102 U01.mp3", { phase: "writing", label: "Writing the notes and PDF", percent: null }),
    ).toBe("Writing the notes and PDF for ISC 102 U01.mp3…")
  })
})

describe("setup downloads", () => {
  it("names the speech model, engine, and ffmpeg archive", () => {
    expect(SPEECH_MODEL).toMatchObject({
      name: "ggml-base.en",
      file: "ggml-base.en.bin",
      bytes: 147_964_211,
    })
    expect(SPEECH_MODEL.url).toContain("ggml-base.en.bin")
    expect(WHISPER_ENGINE.version).toBe("1.9.2")
    expect(WHISPER_ENGINE.zipUrl).toContain("whisper-bin-x64.zip")
    expect(FFMPEG_BUNDLE.version).toBe("9.0.2")
    expect(FFMPEG_BUNDLE.zipUrl).toContain("ffmpeg-9.0.2-essentials_build.zip")
  })
})
