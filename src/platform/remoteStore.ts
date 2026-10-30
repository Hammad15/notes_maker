import type { ActiveTranscription, LocalRuntimeStatus, TranscriptionRequest, TranscriptionResult } from "../domain/localSpeech"
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
    localStatus: () => call<LocalRuntimeStatus>({ op: Ops.localStatus }),
    setupLocal: () => call<LocalRuntimeStatus>({ op: Ops.setupLocal }),
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
      }),
    activeTranscription: () => call<ActiveTranscription | null>({ op: Ops.activeTranscription }),
    clearTranscription: async (id) => {
      await call({ op: Ops.clearTranscription, id })
    },
  }
}
