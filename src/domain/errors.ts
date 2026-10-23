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

export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return "Something went wrong."
}
