export class StudyError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = "StudyError"
    this.code = code
  }
}

export class EntitlementError extends StudyError {
  constructor() {
    super(
      "Cloud notes need an entitlement on this computer.",
      "ENTITLEMENT_REQUIRED",
    )
    this.name = "EntitlementError"
  }
}

export class LocalSetupError extends StudyError {
  constructor() {
    super("Press Set up local notes before making notes.", "LOCAL_SETUP")
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
