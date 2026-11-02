import { useEffect, useRef, useState, type FormEvent } from "react"
import { messageOf } from "../domain/errors"

export function InlineName({
  value,
  className,
  label,
  onRename,
}: {
  value: string
  className: string
  label: string
  onRename: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const skipCommit = useRef(false)
  const committing = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  async function commit() {
    if (skipCommit.current) {
      skipCommit.current = false
      return
    }
    if (committing.current) return
    committing.current = true
    const next = draft.trim()
    try {
      if (!next || next === value) {
        setDraft(value)
        setEditing(false)
        setError(null)
        return
      }
      await onRename(next)
      setEditing(false)
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      committing.current = false
    }
  }

  if (!editing) {
    return (
      <button type="button" className={`name-edit text-left ${className}`} aria-label={label} onClick={() => setEditing(true)}>
        {value}
      </button>
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void commit()
  }

  return (
    <form onSubmit={onSubmit} className="w-full min-w-0">
      <input
        autoFocus
        value={draft}
        aria-label={label}
        className={`name-edit w-full bg-transparent outline-none ${className}`}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          skipCommit.current = true
          setDraft(value)
          setEditing(false)
          setError(null)
        }}
      />
      {error ? <p className="mt-1 text-sm font-sans text-destructive">{error}</p> : null}
    </form>
  )
}
