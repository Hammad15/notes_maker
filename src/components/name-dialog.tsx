import { useEffect, useId, useState, type FormEvent } from "react"
import { messageOf } from "../domain/errors"
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

export function NameDialog({
  open,
  title,
  description,
  initial,
  confirmLabel,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  title: string
  description: string
  initial: string
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameId = useId()
  const errorId = useId()
  const helpId = useId()

  useEffect(() => {
    if (!open) return
    setName(initial)
    setError(null)
    setBusy(false)
  }, [open, initial])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await onSubmit(name)
      onOpenChange(false)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              placeholder="Biology 101"
              className="h-10"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${helpId} ${errorId}` : helpId}
            />
            <p id={helpId} className="text-xs leading-relaxed text-muted-foreground">
              The folder uses this name, with characters Windows does not allow removed.
            </p>
          </div>
          {error ? (
            <p id={errorId} className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
