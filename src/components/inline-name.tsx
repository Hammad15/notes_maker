import { useEffect, useId, useRef, useState, type FormEvent } from "react"
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
  const restoreFocus = useRef(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const errorId = useId()
  const accessibleName = label.includes(value) ? label : `${label}, ${value}`

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [editing])

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
      <button
        ref={buttonRef}
        type="button"
        className={`name-edit max-w-full rounded-sm text-left break-words ${className}`}
        aria-label={accessibleName}
        onClick={() => setEditing(true)}
      >
        {value}
      </button>
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    restoreFocus.current = true
    void commit()
  }

  return (
    <form onSubmit={onSubmit} className="w-full min-w-0">
      <input
        autoFocus
        value={draft}
        aria-label={accessibleName}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`name-edit w-full max-w-full ${className}`}
        onChange={(event) => {
          setDraft(event.target.value)
          setError(null)
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          restoreFocus.current = true
          skipCommit.current = true
          setDraft(value)
          setEditing(false)
          setError(null)
        }}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-sm font-sans text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
