import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { CLOUD_NOTES_UNAVAILABLE, messageOf } from "../domain/errors"
import { LOCAL_HARDWARE_NOTE } from "../domain/localSpeech"
import { assertUsableFolderName } from "../domain/names"
import { fileName } from "../domain/paths"
import { isMediaFile } from "../domain/text"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import { findRecordingNote, type MakeNotesInput, type ModuleInfo, type NoteInfo } from "../services/library"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
export function MakeNotesDialog({
  open,
  courseId,
  courseName,
  modules,
  onOpenChange,
}: {
  open: boolean
  courseId: string
  courseName: string
  modules: ModuleInfo[]
  onOpenChange: (open: boolean) => void
}) {
  const host = useHost()
  const { settings, startMakeNotes, localStatus } = useLibrary()
  const [mediaPath, setMediaPath] = useState<string | null>(null)
  const [moduleChoice, setModuleChoice] = useState("course")
  const [newModuleName, setNewModuleName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [existing, setExisting] = useState<{ input: MakeNotesInput; note: NoteInfo } | null>(null)
  const openRef = useRef(open)
  const placeId = useId()
  openRef.current = open

  useEffect(() => {
    if (!open) return
    setMediaPath(null)
    setModuleChoice("course")
    setNewModuleName("")
    setError(null)
    setChecking(false)
    setExisting(null)
  }, [open])

  async function chooseFile() {
    setError(null)
    if (!host.nativeDialogs) {
      setError(WINDOWS_DIALOG_REQUIRED)
      return
    }
    try {
      const picked = await host.pickMedia(settings.lastMediaDirectory ?? settings.homeDirectory)
      if (picked) setMediaPath(picked)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  function preparedInput(): MakeNotesInput | null {
    if (!settings.homeDirectory) return null
    if (!mediaPath || !isMediaFile(mediaPath)) {
      setError("Choose a video or audio file.")
      return null
    }
    let moduleId: string | null = null
    let moduleName: string | null = null
    let createdModule: string | null = null
    if (moduleChoice === "new") {
      try {
        assertUsableFolderName(newModuleName)
      } catch (err) {
        setError(messageOf(err))
        return null
      }
      createdModule = newModuleName.trim()
      moduleName = createdModule
    } else if (moduleChoice !== "course") {
      moduleId = moduleChoice
      moduleName = modules.find((item) => item.id === moduleChoice)?.name ?? null
    }
    return {
      home: settings.homeDirectory,
      courseId,
      mediaPath,
      provider: settings.provider,
      moduleId,
      moduleName,
      newModuleName: createdModule,
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const input = preparedInput()
    if (!input || checking) return
    setChecking(true)
    setError(null)
    try {
      const note = await findRecordingNote(host.store, input)
      if (!openRef.current) return
      if (note) {
        setExisting({ input, note })
        return
      }
      startMakeNotes(input)
      onOpenChange(false)
    } catch (err) {
      if (openRef.current) setError(messageOf(err))
    } finally {
      if (openRef.current) setChecking(false)
    }
  }

  function choose(noteChoice: "replace" | "add") {
    if (!existing) return
    startMakeNotes({ ...existing.input, noteChoice })
    onOpenChange(false)
  }

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          {existing ? (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle>This recording already has a note</DialogTitle>
                <DialogDescription>
                  {existing.note.title} is already in {existing.note.moduleName ?? courseName}. Replace
                  overwrites that note&apos;s Markdown and PDF. Add keeps those files and writes a new note
                  beside them.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:flex-wrap sm:justify-end">
                <Button type="button" variant="outline" onClick={() => setExisting(null)}>
                  Back
                </Button>
                <Button type="button" variant="outline" onClick={() => choose("add")}>
                  Add another note
                </Button>
                <Button type="button" onClick={() => choose("replace")}>
                  Replace note
                </Button>
              </DialogFooter>
            </div>
          ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create notes</DialogTitle>
            </DialogHeader>
            <div className="grid gap-2">
              <p className="text-sm font-medium">Course</p>
              <p className="font-serif text-lg break-words">{courseName}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="recording">Recording</Label>
              {mediaPath ? (
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <p className="text-sm break-all">{fileName(mediaPath)}</p>
                  <p className="font-mono text-xs break-all text-muted-foreground">{mediaPath}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No file chosen yet.</p>
              )}
              <Button id="recording" type="button" variant="outline" onClick={() => void chooseFile()}>
                {mediaPath ? "Change file" : "Choose video or audio"}
              </Button>
            </div>
            <div className="grid gap-2">
              <p id={placeId} className="text-sm font-medium">
                Where should the notes go?
              </p>
              <Select value={moduleChoice} onValueChange={setModuleChoice}>
                <SelectTrigger className="w-full" aria-labelledby={placeId}>
                  <SelectValue placeholder="This course" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="course">This course</SelectItem>
                  {modules.map((module) => (
                    <SelectItem key={module.id} value={module.id}>
                      {module.name}
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  <SelectItem value="new">New module</SelectItem>
                </SelectContent>
              </Select>
              {moduleChoice === "new" ? (
                <Input
                  value={newModuleName}
                  onChange={(event) => {
                    setNewModuleName(event.target.value)
                    setError(null)
                  }}
                  placeholder="Cells"
                  aria-label="New module name"
                  className="h-10"
                />
              ) : null}
            </div>
            {settings.provider === "cloud" ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                {CLOUD_NOTES_UNAVAILABLE}
              </p>
            ) : (
              <div className="grid gap-2">
                {localStatus && !localStatus.ready ? (
                  <p className="text-sm text-muted-foreground">
                    Press Set up local notes in the sidebar to start creating notes.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Study notes are written on this computer.</p>
                )}
                <p className="text-sm leading-relaxed text-muted-foreground">{LOCAL_HARDWARE_NOTE}</p>
              </div>
            )}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter className="sm:justify-end">
              <Button
                type="submit"
                disabled={
                  checking ||
                  settings.provider === "cloud" ||
                  (settings.provider === "local" && localStatus?.ready !== true)
                }
              >
                Create notes
              </Button>
            </DialogFooter>
          </form>
          )}
        </DialogContent>
      </Dialog>
  )
}
