import type { SpeechPace, ActiveTranscription, LocalNotesMessage, LocalRuntimeStatus, TranscriptionRequest, TranscriptionResult } from "../domain/localSpeech"
import type { PreparedAudio } from "../domain/groq"
import type { DirEntry, FileStat, MediaProbe } from "../domain/types"
import { Ops } from "./ops"
import type { FileStore } from "./types"

type Caller = <T>(request: Record<string, unknown>) => Promise<T>

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const size = 0x8000
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size))
  }
  return btoa(binary)
}

export function createRemoteStore(call: Caller): FileStore {
  return {
    appDataDir: () => call<string>({ op: Ops.appDataDir }),
    groqApiKey: async () => {
      const value = await call<string | null>({ op: Ops.groqApiKey })
      const key = value?.trim() ?? ""
      return key || null
    },
    userHome: () => call<string>({ op: Ops.userHome }),
    roots: () => call<string[]>({ op: Ops.roots }),
    readText: (path) => call<string | null>({ op: Ops.readText, path }),
    writeText: async (path, text) => {
      await call({ op: Ops.writeText, path, text })
    },
    writeBytes: async (path, bytes) => {
      await call({ op: Ops.writeBytes, path, base64: bytesToBase64(bytes) })
    },
    exists: (path) => call<boolean>({ op: Ops.exists, path }),
    list: (path) => call<DirEntry[]>({ op: Ops.list, path }),
    mkdir: async (path) => {
      await call({ op: Ops.mkdir, path })
    },
    rename: async (from, to) => {
      await call({ op: Ops.rename, from, to })
    },
    remove: async (path) => {
      await call({ op: Ops.remove, path })
    },
    stat: (path) => call<FileStat | null>({ op: Ops.stat, path }),
    setHidden: async (path) => {
      await call({ op: Ops.setHidden, path })
    },
    probeMedia: (path) => call<MediaProbe>({ op: Ops.probeMedia, path }),
    localStatus: (pace: SpeechPace) => call<LocalRuntimeStatus>({ op: Ops.localStatus, pace }),
    setupLocal: (pace: SpeechPace) => call<LocalRuntimeStatus>({ op: Ops.setupLocal, pace }),
    prepareCloudAudio: (path) => call<PreparedAudio>({ op: Ops.prepareCloudAudio, path }),
    readBytes: async (path) => {
      const encoded = await call<string>({ op: Ops.readBytes, path })
      const binary = atob(encoded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    },
    completeLocal: (messages: LocalNotesMessage[], maxCompletionTokens: number, jobId?: string) =>
      call<string>({ op: Ops.completeLocal, messages, maxCompletionTokens, jobId }),
    transcribeMedia: (path, request: TranscriptionRequest) =>
      call<TranscriptionResult>({
        op: Ops.transcribeMedia,
        path,
        jobId: request.jobId,
        home: request.home,
        courseId: request.courseId,
        moduleId: request.moduleId,
        moduleName: request.moduleName,
        newModuleName: request.newModuleName,
        pace: request.pace,
        language: request.language,
      }),
    activeTranscription: () => call<ActiveTranscription | null>({ op: Ops.activeTranscription }),
    clearTranscription: async (id) => {
      await call({ op: Ops.clearTranscription, id })
    },
    cancelMakeNotes: async (id) => {
      await call({ op: Ops.cancelMakeNotes, id })
    },
  }
}
