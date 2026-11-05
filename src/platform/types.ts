import type { PreparedAudio } from "../domain/groq"
import type {
  ActiveTranscription,
  LocalNotesMessage,
  LocalRuntimeStatus,
  SetupProgress,
  SpeechPace,
  TranscriptionProgress,
  TranscriptionRequest,
  TranscriptionResult,
} from "../domain/localSpeech"
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
  localStatus(pace: SpeechPace): Promise<LocalRuntimeStatus>
  setupLocal(pace: SpeechPace): Promise<LocalRuntimeStatus>
  prepareCloudAudio(path: string): Promise<PreparedAudio>
  readBytes(path: string): Promise<Uint8Array>
  completeLocal(messages: LocalNotesMessage[], maxCompletionTokens: number, jobId?: string): Promise<string>
  transcribeMedia(path: string, request: TranscriptionRequest): Promise<TranscriptionResult>
  activeTranscription(): Promise<ActiveTranscription | null>
  clearTranscription(id: string): Promise<void>
  cancelMakeNotes(id: string): Promise<void>
}

export interface Host {
  nativeDialogs: boolean
  store: FileStore
  pickDirectory(): Promise<string | null>
  pickMedia(directory?: string | null): Promise<string | null>
  openPath(path: string): Promise<void>
  openUrl(url: string): Promise<void>
  startInstaller(url: string): Promise<void>
  setupLocal(pace: SpeechPace, onProgress?: (progress: SetupProgress) => void): Promise<LocalRuntimeStatus>
  /** Free bytes on the disk that holds local setup files. */
  freeSpace(): Promise<number>
  watchTranscription?(onProgress: (progress: TranscriptionProgress) => void): Promise<() => void>
}
