import { useState } from "react"
import { FEEDBACK_EMAIL, feedbackMailto } from "../domain/feedback"
import { messageOf } from "../domain/errors"
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
import { Textarea } from "@/components/ui/textarea"

export function FeedbackDialog() {
  const host = useHost()
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function submit() {
    const text = message.trim()
    if (!text) return
    setSending(true)
    setError(null)
    try {
      await host.openUrl(feedbackMailto(text, email))
      setMessage("")
      setEmail("")
      setOpen(false)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Button type="button" variant="secondary" className="w-full" onClick={() => setOpen(true)}>
        Contact us
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Contact us</DialogTitle>
            <DialogDescription>
              Submit feedback. This opens your email app with the message addressed to {FEEDBACK_EMAIL}. Create Notes
              does not keep a copy, and you do not need an account.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="grid gap-1.5">
              <label htmlFor="feedback-message" className="text-sm font-medium">
                What would you like to say?
              </label>
              <Textarea
                id="feedback-message"
                name="message"
                required
                rows={5}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="feedback-email" className="text-sm font-medium">
                Email, if you want a reply <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="feedback-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={sending || message.trim().length === 0}>
                Open email
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
