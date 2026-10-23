import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin } from "vite"
import { createNodeFileStore, dispatchDesktop } from "./nodeFs.ts"

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(payload))
}

export function devApiPlugin(): Plugin {
  const store = createNodeFileStore()
  return {
    name: "study-notes-dev-api",
    configureServer(server) {
      server.middlewares.use("/api/desktop", (req, res, next) => {
        if (req.method !== "POST") {
          next()
          return
        }
        const host = req.headers.host ?? ""
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
          send(res, 403, { ok: false, error: "The file service is local only." })
          return
        }
        void (async () => {
          try {
            const raw = await readBody(req)
            const request = raw ? JSON.parse(raw) : {}
            const value = await dispatchDesktop(store, request)
            send(res, 200, { ok: true, value })
          } catch (error) {
            const message = error instanceof Error ? error.message : "Request failed."
            send(res, 400, { ok: false, error: message })
          }
        })()
      })
    },
  }
}
