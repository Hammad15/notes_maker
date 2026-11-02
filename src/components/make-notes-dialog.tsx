import { useEffect, useState, type FormEvent } from "react"
import { messageOf } from "../domain/errors"
import { assertUsableFolderName } from "../domain/names"
import { fileName } from "../domain/paths"
import { isMediaFile } from "../domain/text"
import { WINDOWS_DIALOG_REQUIRED } from "../platform/dialogs"
import { useHost } from "../platform/host"
import type { ModuleInfo } from "../services/library"
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

  useEffect(() => {
    if (!open) return
    setMediaPath(null)
    setModuleChoice("course")
    setNewModuleName("")
    setError(null)
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

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings.homeDirectory) return
    if (!mediaPath || !isMediaFile(mediaPath)) {
      setError("Choose a video or audio file.")
      return
    }
    let moduleId: string | null = null
    let moduleName: string | null = null
    let createdModule: string | null = null
    if (moduleChoice === "new") {
      try {
        assertUsableFolderName(newModuleName)
      } catch (err) {
        setError(messageOf(err))
        return
      }
      createdModule = newModuleName.trim()
      moduleName = createdModule
    } else if (moduleChoice !== "course") {
      moduleId = moduleChoice
      moduleName = modules.find((item) => item.id === moduleChoice)?.name ?? null
    }
    startMakeNotes({
      home: settings.homeDirectory,
      courseId,
      mediaPath,
      provider: settings.provider,
      moduleId,
      moduleName,
      newModuleName: createdModule,
    })
    onOpenChange(false)
  }

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Make notes</DialogTitle>
              <DialogDescription>
                {courseName} stays the course for these notes.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label>Course</Label>
              <p className="font-serif text-lg">{courseName}</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="recording">Recording</Label>
              {mediaPath ? (
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <p className="truncate text-sm">{fileName(mediaPath)}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={mediaPath}>
                    {mediaPath}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No file chosen yet.</p>
              )}
              <Button id="recording" type="button" variant="outline" onClick={() => void chooseFile()}>
                {mediaPath ? "Change file" : "Choose video or audio"}
              </Button>
            </div>
            <div className="grid gap-2">
              <Label>Where should the notes go?</Label>
              <Select value={moduleChoice} onValueChange={setModuleChoice}>
                <SelectTrigger className="w-full">
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
                Cloud notes need an entitlement on this computer. Local notes still work.
              </p>
            ) : localStatus && !localStatus.ready ? (
              <p className="text-sm text-muted-foreground">
                Press Set up local notes in the sidebar. That downloads the speech model and finishes setup.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Using the speech model on this computer. The note is the study notes.
              </p>
            )}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="sm:items-center sm:justify-between">
              <p className="text-xs leading-relaxed text-muted-foreground sm:max-w-[16rem]">
                You can close this window. Writing the notes and PDF keeps going.
              </p>
              <Button type="submit" disabled={settings.provider === "local" && localStatus?.ready !== true}>
                Make notes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  )
}
