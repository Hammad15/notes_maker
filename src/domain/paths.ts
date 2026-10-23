export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/"
  let result = base.replace(/[\\/]+$/, "")
  for (const part of parts) {
    const clean = part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "")
    if (!clean || clean === "." || clean === "..") continue
    result = result ? `${result}${sep}${clean}` : clean
  }
  return result
}

export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

export function parentPath(input: string): string | null {
  const trimmed = input.replace(/[\\/]+$/, "")
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return null
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (index < 0) return null
  if (trimmed[index] === "/" && index === 0) return "/"
  const parent = trimmed.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent || null
}

export function truncateMiddle(value: string, max = 36): string {
  if (value.length <= max) return value
  const side = Math.floor((max - 1) / 2)
  return `${value.slice(0, side)}…${value.slice(value.length - side)}`
}
