import { useEffect, useState } from "react"
import { messageOf } from "../domain/errors"
import { parentPath } from "../domain/paths"
import { isMediaFile } from "../domain/text"
import type { DirEntry } from "../domain/types"
import { useHost } from "../platform/host"
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
import { ScrollArea } from "@/components/ui/scroll-area"

export function PathBrowser({
  open,
  mode,
  initialPath,
  onOpenChange,
  onPick,
}: {
  open: boolean
  mode: "directory" | "media"
  initialPath?: string | null
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
}) {
  const { store } = useHost()
  const [current, setCurrent] = useState("")
  const [draft, setDraft] = useState("")
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function openAt(path: string) {
    setLoading(true)
    setError(null)
    try {
      const stat = await store.stat(path)
      if (!stat?.isDir) throw new Error("That folder is not there.")
      const listed = await store.list(path)
      listed.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      })
      setCurrent(path)
      setDraft(path)
      setEntries(listed)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const fallback = initialPath || (await store.userHome())
      const stat = fallback ? await store.stat(fallback) : null
      const start = stat?.isDir ? fallback : await store.userHome()
      if (!cancelled) await openAt(start)
    })()
    return () => {
      cancelled = true
    }
    // Open a fresh listing each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const parent = current ? parentPath(current) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "directory" ? "Choose a folder" : "Choose a recording"}</DialogTitle>
          <DialogDescription>
            {mode === "directory"
              ? "Courses will live in this folder."
              : "Video and audio files can be selected. The file stays where it is."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void openAt(draft.trim())
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Folder path"
            className="h-9 font-mono text-xs"
          />
          <Button type="submit" variant="outline" className="h-9">
            Go
          </Button>
        </form>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={current}>
            {loading ? "Reading folder…" : current}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!parent}
            onClick={() => parent && void openAt(parent)}
          >
            Up
          </Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <ScrollArea className="h-72 rounded-lg border border-border">
          <ul className="p-1">
            {entries.length === 0 && !loading ? (
              <li className="px-3 py-6 text-sm text-muted-foreground">This folder is empty.</li>
            ) : null}
            {entries.map((entry) => {
              const entryPath = current.endsWith("/") || current.endsWith("\\")
                ? `${current}${entry.name}`
                : `${current}${current.includes("\\") ? "\\" : "/"}${entry.name}`
              const selectable = entry.kind === "file" && mode === "media" && isMediaFile(entry.name)
              const muted = entry.kind === "file" && !selectable
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    disabled={muted}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                    onClick={() => {
                      if (entry.kind === "dir") {
                        void openAt(entryPath)
                        return
                      }
                      if (selectable) {
                        onPick(entryPath)
                        onOpenChange(false)
                      }
                    }}
                  >
                    <span className="truncate">{entry.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.kind === "dir" ? "Folder" : entry.name.slice(entry.name.lastIndexOf("."))}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
        {mode === "directory" ? (
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (!current) return
                onPick(current)
                onOpenChange(false)
              }}
              disabled={!current || loading}
            >
              Use this folder
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
