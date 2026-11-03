export const FEEDBACK_EMAIL = "feedback@example.com"

export function feedbackMailto(message: string, replyEmail: string): string {
  const text = message.trim()
  const reply = replyEmail.trim()
  const body = reply ? `${text}\n\nReply to: ${reply}` : text
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("Create Notes feedback")}&body=${encodeURIComponent(body)}`
}
