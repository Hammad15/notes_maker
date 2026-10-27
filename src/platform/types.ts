import type { LocalRuntimeStatus, SetupProgress, TranscriptionResult } from "../domain/localSpeech"
import type { DirEntry, FileStat, MediaProbe } from "../domain/types"

export interface FileStore {
  appDataDir(): Promise<string>
  userHome(): Promise<string>
  roots(): Promise<string[]>
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  list(path: string): Promise<DirEntry[]>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<FileStat | null>
  setHidden(path: string): Promise<void>
  probeMedia(path: string): Promise<MediaProbe>
  localStatus(): Promise<LocalRuntimeStatus>
  setupLocal(): Promise<LocalRuntimeStatus>
  transcribeMedia(path: string): Promise<TranscriptionResult>
}

export interface Host {
  nativeDialogs: boolean
  store: FileStore
  pickDirectory(): Promise<string | null>
  pickMedia(directory?: string | null): Promise<string | null>
  openPath(path: string): Promise<void>
  setupLocal(onProgress?: (progress: SetupProgress) => void): Promise<LocalRuntimeStatus>
}
