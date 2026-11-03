import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const nativeFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = input instanceof URL ? input.href : typeof input === "string" ? input : input.url
  if (!href.startsWith("file:")) return nativeFetch(input, init)
  const bytes = await readFile(fileURLToPath(href))
  return new Response(bytes)
}
