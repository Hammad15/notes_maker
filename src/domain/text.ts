import { fileName } from "./paths"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".mpeg",
  ".mpg",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".opus",
  ".wma",
  ".aif",
  ".aiff",
])

export function isMediaFile(path: string): boolean {
  const name = fileName(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return false
  return MEDIA_EXTENSIONS.has(name.slice(dot))
}

export function titleFromMediaPath(mediaPath: string): string {
  const base = fileName(mediaPath)
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  const cleaned = stem.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim()
  return cleaned || "Untitled recording"
}

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const total = Math.round(safe)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`
}

export function formatRange(start: number, end: number): string {
  return `${formatClock(start)}–${formatClock(end)}`
}

export function formatDurationWords(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return total === 1 ? "1 second" : `${total} seconds`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts: string[] = []
  if (hours) parts.push(hours === 1 ? "1 hour" : `${hours} hours`)
  if (minutes) parts.push(minutes === 1 ? "1 minute" : `${minutes} minutes`)
  if (secs && hours === 0) parts.push(secs === 1 ? "1 second" : `${secs} seconds`)
  return parts.join(" ")
}

export function formatFiledDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

export function formatWhen(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return iso
  const minutes = Math.round((now - then) / 60000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
  return formatFiledDate(iso)
}
