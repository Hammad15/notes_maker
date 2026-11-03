import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  assertHeardRecording,
  cleanNotesReply,
  FFMPEG_BUNDLE,
  LLAMA_ENGINE,
  LOCAL_HARDWARE_NOTE,
  NOTES_MODEL,
  formatRemaining,
  localJobMessage,
  parseWhisperJson,
  barPercent,
  chunkTranscriptionPercent,
  notesRunPercent,
  remainingSeconds,
  scaleTranscriptionPercent,
  sameSavedRecording,
  SPEECH_MODEL,
  setupStepLabel,
  speechModel,
  speechModelsForSetup,
  TINY_MODEL,
  WHISPER_ENGINE,
  forwardProgress,
  parseProcessSnapshot,
  planResume,
  sameTranscriptionJob,
  whisperPidsToStop,
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

describe("local hardware", () => {
  it("uses the same note in the README", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8")
    expect(readme).toContain(LOCAL_HARDWARE_NOTE)
  })
})

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

  it("uses every processor and the tiny model when the pace is faster", () => {
    expect(whisperThreadCount(1, "faster")).toBe(1)
    expect(whisperThreadCount(4, "faster")).toBe(4)
    expect(whisperThreadCount(8, "faster")).toBe(8)
    expect(speechModel("faster")).toBe(TINY_MODEL)
    expect(speechModel("clearer")).toBe(SPEECH_MODEL)
    expect(TINY_MODEL).toMatchObject({
      name: "ggml-tiny.en",
      file: "ggml-tiny.en.bin",
      bytes: 77_704_715,
      sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
    })
    expect(TINY_MODEL.url).toContain("ggml-tiny.en.bin")
    expect(speechModelsForSetup("faster").map((model) => model.file)).toEqual(["ggml-tiny.en.bin"])
    expect(speechModelsForSetup("clearer").map((model) => model.file)).toEqual(["ggml-base.en.bin"])
    expect(setupStepLabel("model")).toBe("Downloading the speech model")
    expect(setupStepLabel("notes")).toBe("Downloading the notes model")
    for (const phase of ["ffmpeg", "engine", "model", "notesEngine", "notes", "config"] as const) {
      expect(setupStepLabel(phase)).not.toMatch(/ggml|qwen|\.bin|\.gguf|\.zip/i)
    }
  })

  it("shows reading, percent, and the notes write", () => {
    expect(localJobMessage("ISC 102 U01.mp3", null)).toBe("Transcribing ISC 102 U01.mp3…")
    expect(localJobMessage("ISC 102 U01.mp3", { phase: "reading", label: "Reading the recording", percent: null })).toBe(
      "Reading ISC 102 U01.mp3…",
    )
    expect(
      localJobMessage("ISC 102 U01.mp3", { phase: "transcribing", label: "Transcribing the recording", percent: 40 }),
    ).toBe("Transcribing ISC 102 U01.mp3…")
    expect(
      barPercent({ phase: "transcribing", label: "Transcribing the recording", percent: 40 }),
    ).toBeNull()
    expect(
      localJobMessage("ISC 102 U01.mp3", { phase: "writing", label: "Writing the notes and PDF", percent: null }),
    ).toBe("Writing the notes and PDF for ISC 102 U01.mp3…")
    const writingStarted = Date.now() - 60_000
    expect(
      localJobMessage("ISC 102 U01.mp3", {
        phase: "writing",
        label: "Writing the notes and PDF",
        percent: 92,
        startedMs: writingStarted,
      }),
    ).toBe("Writing the notes and PDF for ISC 102 U01.mp3… 92% · less than a minute left")
    expect(
      barPercent({
        phase: "writing",
        label: "Writing the notes and PDF",
        percent: 92,
        startedMs: writingStarted,
      }),
    ).toBe(92)
    expect(scaleTranscriptionPercent(40)).toBe(36)
    expect(scaleTranscriptionPercent(100)).toBe(90)
    expect(chunkTranscriptionPercent(0, 1, 0, 30_000)).toBe(0)
    expect(chunkTranscriptionPercent(0, 1, 3_000, 30_000)).toBe(10)
    expect(chunkTranscriptionPercent(0, 1, 120_000, 30_000)).toBeLessThan(100)
    expect(notesRunPercent(0, false)).toBe(0)
    expect(notesRunPercent(1_000, false)).toBe(5)
    expect(notesRunPercent(0, true)).toBe(90)
    const started = 1_700_000_000_000
    expect(remainingSeconds(started, 25, started + 60_000)).toBe(180)
    expect(remainingSeconds(started, 0, started + 60_000)).toBeNull()
    expect(remainingSeconds(started, 100, started + 60_000)).toBeNull()
    expect(remainingSeconds(started, 40, started + 400)).toBeNull()
    expect(formatRemaining(30)).toBe("less than a minute left")
    expect(formatRemaining(90)).toBe("about 2 min left")
    expect(formatRemaining(3600)).toBe("about 1 hour left")
    expect(formatRemaining(5400)).toBe("about 1 hr 30 min left")
    const underway = Date.now() - 60_000
    expect(
      localJobMessage("ISC 102 U01.mp3", {
        phase: "transcribing",
        label: "Transcribing the recording",
        percent: 25,
        startedMs: underway,
      }),
    ).toBe("Transcribing ISC 102 U01.mp3… 25% · about 3 min left")
  })
})

describe("saved transcripts", () => {
  const source = {
    mediaPath: "D:\\Lectures\\ISC 102 U01.mp3",
    courseId: "isc-102",
    moduleId: null as string | null,
  }

  it("matches the same recording, course, and module", () => {
    expect(
      sameSavedRecording(source, {
        mediaPath: "d:/lectures/isc 102 u01.mp3",
        courseId: "isc-102",
        moduleId: null,
        newModuleName: null,
      }),
    ).toBe(true)
    expect(
      sameSavedRecording(source, {
        ...source,
        moduleId: null,
        newModuleName: "Cells",
      }),
    ).toBe(false)
    expect(
      sameSavedRecording(
        { ...source, moduleId: "module-1" },
        { ...source, moduleId: "module-1", newModuleName: null },
      ),
    ).toBe(true)
    expect(
      sameSavedRecording(source, { ...source, courseId: "other", newModuleName: null }),
    ).toBe(false)
    expect(
      sameSavedRecording(source, {
        ...source,
        mediaPath: "D:\\Lectures\\ISC 102 U02.mp3",
        newModuleName: null,
      }),
    ).toBe(false)
  })
})

describe("one transcription", () => {
  const own = "C:\\Users\\A\\AppData\\Local\\Study Notes\\bin\\whisper-cli.exe"
  const lecture = {
    mediaPath: "D:\\Lectures\\ISC 102 U01.mp3",
    courseId: "isc-102",
    moduleId: null,
    moduleName: null,
  }

  it("resumes the same recording and course or module", () => {
    expect(
      sameTranscriptionJob(lecture, {
        ...lecture,
        mediaPath: "d:/lectures/isc 102 u01.mp3",
      }),
    ).toBe(true)
    expect(
      sameTranscriptionJob(lecture, {
        ...lecture,
        moduleId: null,
        moduleName: "Cells",
      }),
    ).toBe(false)
    expect(
      sameTranscriptionJob(
        { ...lecture, moduleId: null, moduleName: "Cells" },
        { ...lecture, moduleId: "module-1", moduleName: "Cells" },
      ),
    ).toBe(true)
    expect(
      sameTranscriptionJob(
        { ...lecture, moduleId: "module-1", moduleName: "Cells" },
        { ...lecture, moduleId: "module-2", moduleName: "Labs" },
      ),
    ).toBe(false)
    expect(sameTranscriptionJob(lecture, { ...lecture, mediaPath: "D:\\Lectures\\ISC 102 U02.mp3" })).toBe(false)
  })

  it("stops leftover whisper-cli from this app and keeps the live one", () => {
    const processes = parseProcessSnapshot(
      [
        `11\t${own}\t${own} -m model`,
        `22\t${own}\t${own} -m model`,
        `33\t${own}\t${own} -m model`,
        `44\t${own}\t${own} -m model`,
        `55\t${own}\t${own} -m model`,
        `66\tC:\\tools\\whisper-cli.exe\tC:\\tools\\whisper-cli.exe -m model`,
        `77\tC:\\Windows\\System32\\notepad.exe\tnotepad`,
      ].join("\n"),
    )
    expect(whisperPidsToStop(processes, own, 11).sort((a, b) => a - b)).toEqual([22, 33, 44, 55])
    expect(whisperPidsToStop(processes, own, null).sort((a, b) => a - b)).toEqual([11, 22, 33, 44, 55])
  })

  it("attaches to the same job and starts fresh when the file or module differs", () => {
    const processes = parseProcessSnapshot(`11\t${own}\t${own} -m model`)
    expect(
      planResume({ ...lecture, pid: 11, jsonReady: false }, lecture, processes, own),
    ).toEqual({ action: "attach", pid: 11 })
    expect(
      planResume(
        { ...lecture, pid: 11, jsonReady: false },
        { ...lecture, moduleName: "Cells" },
        processes,
        own,
      ),
    ).toEqual({ action: "start" })
    expect(
      planResume({ ...lecture, pid: null, jsonReady: true }, lecture, [], own),
    ).toEqual({ action: "reuse" })
    expect(planResume({ ...lecture, pid: null, jsonReady: false }, lecture, [], own)).toEqual({
      action: "continue",
    })
    expect(planResume({ ...lecture, pid: 99, jsonReady: false }, lecture, [], own)).toEqual({
      action: "continue",
    })
  })

  it("does not move the percent backward", () => {
    expect(forwardProgress(30, 15)).toBe(30)
    expect(forwardProgress(15, 30)).toBe(30)
    expect(forwardProgress(null, 15)).toBe(15)
    expect(forwardProgress(15, null)).toBe(15)
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
    expect(NOTES_MODEL).toMatchObject({
      name: "Qwen2.5-3B-Instruct",
      file: "qwen2.5-3b-instruct-q4_k_m.gguf",
      bytes: 2_104_932_768,
      sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
    })
    expect(NOTES_MODEL.url).toContain("qwen2.5-3b-instruct-q4_k_m.gguf")
    expect(LLAMA_ENGINE.version).toBe("b10599")
    expect(LLAMA_ENGINE.zipBytes).toBe(18_061_865)
    expect(LLAMA_ENGINE.zipUrl).toContain("llama-b10599-bin-win-cpu-x64.zip")
    expect(cleanNotesReply("llama_print_timings: load\n## Cells\n\n- Mitosis.<|im_end|>\n")).toBe(
      "## Cells\n\n- Mitosis.",
    )
    expect(FFMPEG_BUNDLE.version).toBe("9.0.2")
    expect(FFMPEG_BUNDLE.zipUrl).toContain("ffmpeg-9.0.2-essentials_build.zip")
  })
})
