import { assertHeardRecording } from "../domain/localSpeech"
import type { TranscribeInput } from "../domain/providers"
import type { Transcript } from "../domain/types"
import type { FileStore } from "../platform/types"

export async function transcribeLocal(
  store: FileStore,
  mediaPath: string,
  input: TranscribeInput,
): Promise<Transcript> {
  const started = Date.now()
  const result = await store.transcribeMedia(mediaPath)
  const elapsedMs = Date.now() - started
  const durationSeconds = result.durationSeconds ?? input.probe.durationSeconds
  assertHeardRecording({
    durationSeconds,
    elapsedMs,
    segments: result.segments,
  })
  return {
    noteId: input.noteId,
    provider: "local",
    createdAt: new Date().toISOString(),
    durationSeconds,
    transcribed: true,
    segments: result.segments,
    chapters: input.probe.chapters.filter(
      (chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end),
    ),
    model: result.model,
    elapsedMs,
  }
}
