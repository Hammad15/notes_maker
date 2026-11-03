import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useLibrary } from "../state/library-context"
import { Button } from "@/components/ui/button"

interface TourStep {
  target: string
  fallback?: string
  title: string
  body: string
  fallbackBody?: string
}

const STEPS: TourStep[] = [
  {
    target: "courses",
    title: "Courses",
    body: "Your courses are listed here on the left.",
  },
  {
    target: "new-course",
    title: "Add a course",
    body: "The plus button adds a course.",
  },
  {
    target: "course-page",
    title: "Course page",
    body: "The course page shows the notes for the class you have open.",
  },
  {
    target: "make-notes",
    fallback: "course-page",
    title: "Make Notes",
    body: "Make Notes is this button. It starts from a recording already on this computer.",
    fallbackBody: "Make Notes is the button at the top of a course.",
  },
]

function placeCard(rect: DOMRect): { top: number; left: number } {
  const width = Math.min(280, window.innerWidth - 24)
  const height = 176
  const gap = 12
  let top = rect.top
  let left = rect.right + gap
  if (rect.width > 420) {
    top = rect.top + 16
    left = rect.left + 16
  } else if (left + width > window.innerWidth - 12) {
    left = rect.left - width - gap
    if (left < 12) {
      left = rect.left
      top = rect.bottom + gap
    }
  }
  if (top + height > window.innerHeight - 12) top = window.innerHeight - height - 12
  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12
  if (top < 12) top = 12
  if (left < 12) left = 12
  return { top, left }
}

export function FirstRunTour() {
  const { settings, dismissTour } = useLibrary()
  const [step, setStep] = useState(0)
  const [spot, setSpot] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  const [card, setCard] = useState<{ top: number; left: number } | null>(null)
  const [usingFallback, setUsingFallback] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const current = STEPS[step]
  const shown = Boolean(card) && !settings.tourDismissed

  const measure = useCallback(() => {
    const primary = document.querySelector(`[data-tour="${current.target}"]`)
    const node = primary ?? (current.fallback ? document.querySelector(`[data-tour="${current.fallback}"]`) : null)
    if (!(node instanceof HTMLElement)) {
      setSpot(null)
      setCard({ top: 72, left: 16 })
      setUsingFallback(true)
      return
    }
    const rect = node.getBoundingClientRect()
    setSpot({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    setCard(placeCard(rect))
    setUsingFallback(primary == null)
  }, [current])

  useLayoutEffect(() => {
    if (settings.tourDismissed) return
    measure()
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [measure, settings.tourDismissed])

  useEffect(() => {
    if (!shown) return
    dialogRef.current?.focus()
  }, [shown, step])

  if (settings.tourDismissed || !card) return null
  const last = step === STEPS.length - 1
  const body = usingFallback && current.fallbackBody ? current.fallbackBody : current.body

  async function finish() {
    setSaving(true)
    setError(null)
    try {
      await dismissTour()
    } catch {
      setSaving(false)
      setError("Could not save that choice. The tour stays until it does.")
    }
  }

  return createPortal(
    <>
      {spot ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 rounded-md ring-2 ring-primary-text"
          style={{ top: spot.top - 4, left: spot.left - 4, width: spot.width + 8, height: spot.height + 8 }}
        />
      ) : null}
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-labelledby="first-run-tour-title"
        aria-describedby="first-run-tour-body"
        className="fixed z-50 max-h-[calc(100dvh-1.5rem)] w-[min(280px,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
        style={{ top: card.top, left: card.left }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.preventDefault()
          event.stopPropagation()
          void finish()
        }}
      >
        <p className="text-xs font-medium text-primary-text">
          {step + 1} of {STEPS.length}
        </p>
        <h2 id="first-run-tour-title" className="mt-1 text-sm font-medium">
          {current.title}
        </h2>
        <p id="first-run-tour-body" className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        {error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => void finish()}>
            Dismiss
          </Button>
          {last ? (
            <Button type="button" size="sm" disabled={saving} onClick={() => void finish()}>
              Done
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => setStep((value) => value + 1)}>
              Next
            </Button>
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}
