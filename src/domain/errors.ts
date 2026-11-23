export class StudyError extends Error {
  readonly code: string
  /** Extra lines for the notes log. Never shown in the banner. */
  readonly detail: string | null

  constructor(message: string, code: string, detail: string | null = null) {
    super(message)
    this.name = "StudyError"
    this.code = code
    this.detail = detail
  }
}

export const GROQ_KEY_REQUIRED =
  "A Groq API key is required. Paste it in the Groq API key field under Cloud."

export class CloudNotesError extends StudyError {
  constructor() {
    super(GROQ_KEY_REQUIRED, "CLOUD_NOTES")
    this.name = "CloudNotesError"
  }
}

export class LocalSetupError extends StudyError {
  constructor() {
    super("Press Set up local notes before creating notes.", "LOCAL_SETUP")
    this.name = "LocalSetupError"
  }
}

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text || null
}

export function messageOf(error: unknown): string {
  const direct = textOf(error)
  if (direct) return direct
  if (error instanceof Error) {
    const message = error.message.trim()
    if (message) return message
  }
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; error?: unknown }
    const nested = textOf(record.message) ?? textOf(record.error)
    if (nested) return nested
  }
  return "Something went wrong."
}
