import { StudyError } from "./errors"

const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g
const RESERVED_DEVICE =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const RESERVED_FOLDERS = new Set(["notes", ".study"])

export function isReservedFolder(name: string): boolean {
  return RESERVED_FOLDERS.has(name.toLowerCase())
}

export function folderNameFromDisplay(displayName: string): string {
  let name = displayName
    .replace(INVALID, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
  if (name.length > 80) {
    name = name.slice(0, 80).replace(/[. ]+$/g, "").trim()
  }
  if (RESERVED_DEVICE.test(name)) name = `${name} course`
  return name
}

export function assertUsableFolderName(displayName: string): string {
  if (!displayName.trim()) {
    throw new StudyError("Name the folder.", "NAME")
  }
  const folder = folderNameFromDisplay(displayName)
  if (!folder) {
    throw new StudyError(
      "That name only has characters Windows rejects. Use letters or numbers.",
      "NAME",
    )
  }
  if (isReservedFolder(folder)) {
    throw new StudyError("That name is reserved. Choose another.", "NAME")
  }
  return folder
}
