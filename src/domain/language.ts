/**
 * This build's notes are English. Call sites take a NotesLanguage so another
 * language can be added later without hunting for a hard-coded "en".
 */
export interface NotesLanguage {
  code: string
  name: string
}

export const BUILD_LANGUAGE: NotesLanguage = {
  code: "en",
  name: "English",
}

export function notesLanguage(code: string | null | undefined): NotesLanguage {
  const trimmed = (code ?? "").trim()
  if (!trimmed) return BUILD_LANGUAGE
  const normalized = trimmed.toLowerCase()
  if (normalized === BUILD_LANGUAGE.code || normalized === "english") return BUILD_LANGUAGE
  return { code: normalized, name: trimmed }
}

/** Local speech files in this build are the English models. */
export function localLanguageSupported(language: NotesLanguage): boolean {
  return language.code === BUILD_LANGUAGE.code
}
