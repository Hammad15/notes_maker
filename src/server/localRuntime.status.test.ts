import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { localRuntimeStatus } from "./localRuntime"

describe("local setup for one speech speed", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it("stays not ready for Clearer when only a Faster file is on disk", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "study-notes-pace-"))
    await mkdir(path.join(dir, "models"), { recursive: true })
    await writeFile(path.join(dir, "models", "ggml-tiny.en.bin"), "not the model")
    const faster = await localRuntimeStatus(dir, "faster")
    const clearer = await localRuntimeStatus(dir, "clearer")
    expect(faster.model).toBe("ggml-tiny.en")
    expect(clearer.model).toBe("ggml-base.en")
    expect(faster.missing).toContain("model")
    expect(clearer.missing).toContain("model")
    expect(faster.ready).toBe(false)
    expect(clearer.ready).toBe(false)
  })
})
