import { useEffect, useState, type FormEvent } from "react"
import { Link, useParams } from "react-router-dom"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { messageOf } from "../domain/errors"
import { fileName } from "../domain/paths"
import { formatRange } from "../domain/text"
import type { Preset } from "../domain/types"
import { useHost } from "../platform/host"
import { readNote, restyleNote, undoRestyle, type NoteDocument } from "../services/library"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: "concise", label: "Concise" },
  { id: "bullets", label: "Bullets" },
  { id: "paragraphs", label: "Paragraphs" },
  { id: "table", label: "Table" },
]

export function NoteScreen() {
  const { courseId = "", noteId = "" } = useParams()
  const host = useHost()
  const { store } = host
  const { settings, revision } = useLibrary()
  const [note, setNote] = useState<NoteDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset | null>(null)
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)

  useEffect(() => {
    const home = settings.homeDirectory
    if (!home) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const next = await readNote(store, home, courseId, noteId)
        if (!cancelled) {
          setNote(next)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(messageOf(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [courseId, noteId, revision, settings.homeDirectory, store])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [noteId])

  if (loading && !note) return <p className="text-muted-foreground">Opening the note…</p>
  if ((error && !note) || !note || !settings.homeDirectory) {
    return (
      <div className="max-w-md">
        <h1 className="font-serif text-3xl">Note unavailable</h1>
        <p className="mt-3 text-muted-foreground">{error ?? "That note is not in this course."}</p>
        <Button asChild variant="outline" className="mt-6">
          <Link to={`/courses/${courseId}`}>Back to the course</Link>
        </Button>
      </div>
    )
  }

  const home = settings.homeDirectory
  const backTo = note.moduleId
    ? `/courses/${courseId}?module=${encodeURIComponent(note.moduleId)}`
    : `/courses/${courseId}`
  const backLabel = note.moduleName ?? note.courseName

  async function onRestyle(event: FormEvent) {
    event.preventDefault()
    setFormError(null)
    if (!preset && !prompt.trim()) {
      setFormError("Choose a preset or write a prompt.")
      return
    }
    setBusy(true)
    try {
      const next = await restyleNote(store, {
        home,
        courseId,
        noteId,
        provider: settings.provider,
        preset,
        prompt,
      })
      setNote(next)
    } catch (err) {
      setFormError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function onUndo() {
    setFormError(null)
    setBusy(true)
    try {
      setNote(await undoRestyle(store, home, courseId, noteId))
    } catch (err) {
      setFormError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pb-10">
      <Link to={backTo} className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to {backLabel}
      </Link>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {note.moduleName ?? "This course"}
          {note.mediaPath ? ` · ${fileName(note.mediaPath)}` : ""}
          {" · "}
          {note.fileStem}.md and {note.fileStem}.pdf
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={!note.pdfExists}
          onClick={() => {
            setPdfError(null)
            void host.openPath(note.pdfPath).catch((err: unknown) => setPdfError(messageOf(err)))
          }}
        >
          Open PDF
        </Button>
      </div>
      {pdfError ? <p className="mt-3 text-sm text-destructive">{pdfError}</p> : null}
      <article className="note-body mt-6 max-w-2xl">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            table: (props) => {
              const { node, ...rest } = props
              void node
              return (
                <div className="note-table">
                  <table {...rest} />
                </div>
              )
            },
          }}
        >
          {note.body}
        </ReactMarkdown>
      </article>
      {note.transcriptProduced && note.segments.some((segment) => segment.text.trim()) ? (
        <details className="mt-10 max-w-2xl border-t border-border pt-6">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Transcript
          </summary>
          <ul className="mt-4 space-y-3">
            {note.segments
              .filter((segment) => segment.text.trim())
              .map((segment, index) => (
                <li key={`${segment.start}-${index}`} className="text-sm leading-relaxed">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">
                    {formatRange(segment.start, segment.end)}
                  </span>
                  {segment.text}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      <form
        onSubmit={(event) => void onRestyle(event)}
        className="mt-12 max-w-2xl border-t border-border pt-6"
      >
        <h2 className="font-serif text-2xl">Restyle these notes</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {settings.provider === "cloud"
            ? settings.groqApiKey.trim()
              ? "Restyle asks Groq to rewrite these notes. One previous copy is kept."
              : "The Groq API key is missing. Paste it under Cloud in the sidebar."
            : "Restyle uses local notes. One previous copy is kept."}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map((item) => (
            <Button
              key={item.id}
              type="button"
              variant={preset === item.id ? "default" : "outline"}
              aria-pressed={preset === item.id}
              onClick={() => setPreset((current) => (current === item.id ? null : item.id))}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <Textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Or describe the change"
          className="mt-4 min-h-24"
          aria-label="Restyle prompt"
        />
        {formError ? <p className="mt-3 text-sm text-destructive">{formError}</p> : null}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={busy}>
            {busy ? "Restyling…" : "Restyle notes"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !note.hasHistory}
            onClick={() => void onUndo()}
          >
            Undo restyle
          </Button>
        </div>
      </form>
    </div>
  )
}
