import { CloudNotesError, LocalSetupError } from "./errors"
import type { MediaProbe, NoteContent, Preset, ProviderId, Transcript } from "./types"

export interface TranscribeInput {
  noteId: string
  title: string
  probe: MediaProbe
}

export interface NotesProvider {
  readonly id: ProviderId
  transcribe(input: TranscribeInput): Transcript
  compose(content: NoteContent): string
  restyle(content: NoteContent, preset: Preset | null, prompt: string): string
}

export function buildTranscript(
  input: TranscribeInput,
  provider: ProviderId,
  createdAt = new Date().toISOString(),
): Transcript {
  return {
    noteId: input.noteId,
    provider,
    createdAt,
    durationSeconds: input.probe.durationSeconds,
    transcribed: false,
    segments: [],
    chapters: input.probe.chapters.filter(
      (chapter) => Number.isFinite(chapter.start) && Number.isFinite(chapter.end),
    ),
  }
}

class LocalProvider implements NotesProvider {
  readonly id = "local" as const

  transcribe(_input: TranscribeInput): Transcript {
    throw new LocalSetupError()
  }

  compose(_content: NoteContent): string {
    throw new LocalSetupError()
  }

  restyle(_content: NoteContent, _preset: Preset | null, _prompt: string): string {
    throw new LocalSetupError()
  }
}

class CloudProvider implements NotesProvider {
  readonly id = "cloud" as const

  transcribe(_input: TranscribeInput): Transcript {
    throw new CloudNotesError()
  }

  compose(_content: NoteContent): string {
    throw new CloudNotesError()
  }

  restyle(_content: NoteContent, _preset: Preset | null, _prompt: string): string {
    throw new CloudNotesError()
  }
}

export function createProvider(id: ProviderId): NotesProvider {
  if (id === "cloud") return new CloudProvider()
  return new LocalProvider()
}
