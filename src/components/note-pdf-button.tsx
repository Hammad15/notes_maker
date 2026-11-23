import { Button } from "@/components/ui/button"

export function notePdfName(title: string, busy: boolean, pdfExists: boolean): string {
  if (busy) return `Generating PDF for ${title}`
  if (pdfExists) return `Open PDF for ${title}`
  return `Generate PDF for ${title}`
}

export function notePdfLabel(busy: boolean, pdfExists: boolean): string {
  if (busy) return "Generating…"
  if (pdfExists) return "Open PDF"
  return "Generate PDF"
}

/** Open a saved PDF, or render one from the note Markdown and then open that file. */
export async function openOrGenerateNotePdf(options: {
  pdfExists: boolean
  pdfPath: string
  generate: () => Promise<{ pdfPath: string }>
  openPath: (path: string) => Promise<void>
}): Promise<void> {
  if (options.pdfExists) {
    await options.openPath(options.pdfPath)
    return
  }
  const generated = await options.generate()
  await options.openPath(generated.pdfPath)
}

export function NotePdfButton({
  title,
  busy,
  pdfExists,
  className = "shrink-0",
  onClick,
}: {
  title: string
  busy: boolean
  pdfExists: boolean
  className?: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      aria-label={notePdfName(title, busy, pdfExists)}
      aria-busy={busy}
      disabled={busy}
      onClick={onClick}
    >
      {notePdfLabel(busy, pdfExists)}
    </Button>
  )
}
