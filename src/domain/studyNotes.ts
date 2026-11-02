import type { TranscriptSegment } from "./types"

export interface StudyBullet {
  text: string
  children: string[]
}

export interface StudySection {
  title: string
  level: 2 | 3
  bullets: StudyBullet[]
}

const MAJOR_GAP_SECONDS = 45
const MINOR_GAP_SECONDS = 12

const BRACKET_NOISE =
  /\[(?:music|applause|laughter|noise|silence|blank_audio|inaudible|background)[^\]]*\]|\((?:music|applause|laughter|noise|silence|blank audio)[^)]*\)|♪+/gi
const PHRASE_FILLER = /\b(?:you know|i mean|sort of|kind of)\b[,.]?/gi
const LEADING_FILLER =
  /^(?:(?:um+|uh+|er+|ah+|hmm+|hm+|erm+|umm+|uhh+)[,.]?\s+|(?:okay|ok|yeah|yep|yup|so|well|anyway)[,]\s+)/i
const MUSIC_WORD = /^(?:na|la|da|ba|oh|ah|ha|mm|hmm|doo|sha|woah|whoa|ohh|ahh|laa|nah)+$/i
const CLOSER =
  /^(?:thank you|thanks for watching|thanks for listening|please subscribe|like and subscribe|subtitles by\b.*|bye|goodbye)[.!]*$/i
const AGENDA =
  /^(?:today |now )?(?:we(?:'re| are)|let(?:'s| us)|i(?:'m| am)) (?:going to |gonna )?(?:talk|learn|look|go over) about (.+?)[.!?]*$/i
const MAJOR_CUE = /^(?:in this lecture|today we|we will cover|let's begin|let us begin)\b/i
const MINOR_CUE = /^(?:next|then|moving on|another|first|second|third|now let's|let's talk|let us talk)\b/i
const CUE_PREFIX = /^(?:next|then|moving on|another|first|second|third)[,:]?\s+/i

interface Spoken {
  start: number
  end: number
  text: string
  agenda: string | null
}

function capitalize(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function finish(text: string): string {
  const trimmed = text.replace(/[.!?]+$/g, "").trim()
  if (!trimmed) return ""
  return `${capitalize(trimmed)}.`
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
}

function isPrefix(shorter: string, longer: string): boolean {
  const left = words(shorter)
  const right = words(longer)
  if (left.length === 0 || left.length >= right.length) return false
  return left.every((word, index) => word === right[index])
}

function stripMusicWords(text: string): string {
  return text
    .replace(/^(?:(?:na|la|da|ba|oh|ah|ha|mm|hmm|doo|sha|woah|whoa|ohh|ahh|laa|nah)\s+)+/i, "")
    .replace(/(?:\s+(?:na|la|da|ba|oh|ah|ha|mm|hmm|doo|sha|woah|whoa|ohh|ahh|laa|nah))+$/i, "")
    .trim()
}

function collapseRepeats(text: string): string {
  return text.replace(/\b([A-Za-z']+)(?:\s+\1\b)+/gi, "$1")
}

function dropCommaRestart(text: string): string {
  return text.replace(/^([A-Za-z']+),\s+\1\b/i, "$1")
}

function stripLeadingFiller(text: string): string {
  let next = text.trim()
  let previous = ""
  while (next && next !== previous) {
    previous = next
    next = next.replace(LEADING_FILLER, "").trim()
  }
  return next
}

function isGibberish(text: string): boolean {
  const tokens = words(text)
  if (tokens.length === 0) return true
  if (tokens.every((token) => MUSIC_WORD.test(token))) return true
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  const most = Math.max(...counts.values())
  if (tokens.length >= 4 && most / tokens.length >= 0.6) return true
  const vowelless = tokens.filter((token) => token.length > 2 && !/[aeiouy]/i.test(token))
  return tokens.length >= 3 && vowelless.length / tokens.length > 0.45
}

function cleanSentence(raw: string): string {
  const withoutNoise = raw.replace(BRACKET_NOISE, " ").replace(/\s+/g, " ").trim()
  const stripped = stripLeadingFiller(
    stripMusicWords(collapseRepeats(dropCommaRestart(withoutNoise.replace(PHRASE_FILLER, " ")))),
  )
    .replace(/\s+/g, " ")
    .replace(/^[,.;:]+/, "")
    .trim()
  if (!stripped || CLOSER.test(stripped) || isGibberish(stripped)) return ""
  return capitalize(stripped)
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function agendaAbout(text: string): string | null {
  const match = text.match(AGENDA)
  if (!match) return null
  const about = match[1].replace(/[.!?]+$/g, "").trim()
  return about || null
}

function topicTitle(text: string): string {
  const about = agendaAbout(text)
  if (about) return capitalize(about)
  const defined = text.match(/^(.+?) (?:is|are|was|were|means|refers to)\b/i)
  if (defined) {
    const subject = defined[1].replace(/[.!?]+$/g, "").trim()
    if (subject && subject.split(/\s+/).length <= 6 && subject.length <= 48) return capitalize(subject)
  }
  const wordsOnly = text.replace(/[.!?]+$/g, "").trim().split(/\s+/).slice(0, 8).join(" ")
  return capitalize(wordsOnly || "Notes")
}

function isDefinition(text: string): boolean {
  const match = text.match(/^(.+?) (?:is|are|was|were|means|refers to)\b/i)
  if (!match) return false
  const count = match[1].trim().split(/\s+/).length
  return count > 0 && count <= 5
}

function stripCue(text: string): string {
  return text.replace(CUE_PREFIX, "").trim()
}

function spokenLines(segments: TranscriptSegment[]): Spoken[] {
  const lines: Spoken[] = []
  for (const segment of segments) {
    const source = segment.text.replace(/\s+/g, " ").trim()
    if (!source) continue
    for (const piece of splitSentences(source)) {
      const text = cleanSentence(piece)
      if (!text) continue
      const previous = lines[lines.length - 1]
      if (previous && (previous.text.toLowerCase() === text.toLowerCase() || isPrefix(previous.text, text))) {
        if (isPrefix(previous.text, text)) lines.pop()
        else continue
      }
      lines.push({
        start: segment.start,
        end: segment.end,
        text,
        agenda: agendaAbout(text),
      })
    }
  }
  return lines
}

function bulletsOf(group: Spoken[], heading: string): StudyBullet[] {
  const sentences = group
    .filter((line) => !line.agenda)
    .map((line) => stripCue(line.text).replace(/[.!?]+$/g, "").trim())
    .filter((text) => text && text.toLowerCase() !== heading.toLowerCase())
  if (sentences.length === 0) return []
  const [first, ...rest] = sentences
  return [{ text: finish(first), children: rest.map((child) => finish(child)) }]
}

function lastSpoken(lines: Spoken[] | undefined): Spoken | undefined {
  if (!lines || lines.length === 0) return undefined
  return lines[lines.length - 1]
}

function splitSubs(topic: Spoken[]): Spoken[][] {
  const content = topic.filter((line) => !line.agenda)
  const source = content.length > 0 ? content : topic
  const groups: Spoken[][] = []
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index]
    const previous = lastSpoken(groups[groups.length - 1])
    const minor =
      index > 0 &&
      !!previous &&
      (line.start - previous.end >= MINOR_GAP_SECONDS || MINOR_CUE.test(line.text) || isDefinition(line.text))
    if (minor || groups.length === 0) groups.push([line])
    else groups[groups.length - 1].push(line)
  }
  return groups
}

export function studySections(segments: TranscriptSegment[]): StudySection[] {
  const lines = spokenLines(segments)
  if (lines.length === 0) return []
  const topics: Spoken[][] = []
  for (const line of lines) {
    const previous = lastSpoken(topics[topics.length - 1])
    const major = !previous || line.start - previous.end >= MAJOR_GAP_SECONDS || MAJOR_CUE.test(line.text)
    if (major || topics.length === 0) topics.push([line])
    else topics[topics.length - 1].push(line)
  }

  const sections: StudySection[] = []
  for (const topic of topics) {
    const agenda = topic.find((line) => line.agenda)?.agenda
    const umbrella = capitalize(agenda || topicTitle(topic[0].text))
    const subs = splitSubs(topic)
    if (subs.length <= 1) {
      sections.push({ title: umbrella, level: 2, bullets: bulletsOf(subs[0] ?? topic, umbrella) })
      continue
    }
    sections.push({ title: umbrella, level: 2, bullets: [] })
    for (const sub of subs) {
      const title = topicTitle(stripCue(sub[0].text))
      sections.push({ title, level: 3, bullets: bulletsOf(sub, title) })
    }
  }
  return sections
}

export function formatStudyBody(sections: StudySection[]): string {
  if (sections.length === 0) return "No lecture points were found in this recording.\n"
  const lines: string[] = []
  for (const section of sections) {
    lines.push(`${section.level === 2 ? "##" : "###"} ${section.title}`, "")
    for (const bullet of section.bullets) {
      lines.push(`- ${bullet.text}`)
      for (const child of bullet.children) lines.push(`  - ${child}`)
    }
    if (section.bullets.length > 0) lines.push("")
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`
}

export function renderTranscript(segments: TranscriptSegment[]): string {
  const lines = segments
    .filter((segment) => segment.text.trim())
    .map((segment) => segment.text.replace(/\s+/g, " ").trim())
  if (lines.length === 0) return ""
  return lines.join("\n")
}
