import { renderFull, renderRestyle } from "./compose"
import { EntitlementError } from "./errors"
import type {
  MediaProbe,
  NoteContent,
  Preset,
  ProviderId,
  Transcript,
  TranscriptSegment,
} from "./types"

export interface Entitlement {
  entitled: boolean
  source: "missing" | "license"
}

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
  const segments: TranscriptSegment[] = input.probe.chapters.length
    ? input.probe.chapters.map((chapter) => ({
        start: chapter.start,
        end: chapter.end,
        text: chapter.title.trim() || "Untitled section",
      }))
    : [
        {
          start: 0,
          end: input.probe.durationSeconds ?? 0,
          text: input.title,
        },
      ]
  return {
    noteId: input.noteId,
    provider,
    createdAt,
    durationSeconds: input.probe.durationSeconds,
    segments,
  }
}

function assertEntitled(entitlement: Entitlement): void {
  if (!entitlement.entitled) throw new EntitlementError()
}

class LocalProvider implements NotesProvider {
  readonly id = "local" as const

  transcribe(input: TranscribeInput): Transcript {
    return buildTranscript(input, this.id)
  }

  compose(content: NoteContent): string {
    return renderFull(content)
  }

  restyle(content: NoteContent, preset: Preset | null, prompt: string): string {
    return renderRestyle(content, preset, prompt)
  }
}

class CloudProvider implements NotesProvider {
  readonly id = "cloud" as const

  constructor(private readonly entitlement: Entitlement) {}

  transcribe(input: TranscribeInput): Transcript {
    assertEntitled(this.entitlement)
    return buildTranscript(input, this.id)
  }

  compose(content: NoteContent): string {
    assertEntitled(this.entitlement)
    return renderFull(content)
  }

  restyle(content: NoteContent, preset: Preset | null, prompt: string): string {
    assertEntitled(this.entitlement)
    return renderRestyle(content, preset, prompt)
  }
}

export function createProvider(
  id: ProviderId,
  entitlement: Entitlement,
): NotesProvider {
  if (id === "cloud") return new CloudProvider(entitlement)
  return new LocalProvider()
}
