import { describe, expect, it } from "vitest"
import { durationFromHeader } from "./media"

function wav(seconds: number): Uint8Array {
  const sampleRate = 8000
  const dataSize = sampleRate * seconds * 2
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  view.setUint32(4, 36 + dataSize, true)
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  bytes.set([0x64, 0x61, 0x74, 0x61], 36)
  view.setUint32(40, dataSize, true)
  return bytes
}

function xingFrame(mono: boolean, frames: number): Uint8Array {
  const sideInfo = mono ? 17 : 32
  const bytes = new Uint8Array(4 + sideInfo + 12)
  bytes.set([0xff, 0xfb, 0x90, mono ? 0xc0 : 0x00], 0)
  const mark = 4 + sideInfo
  bytes.set([0x58, 0x69, 0x6e, 0x67], mark)
  bytes[mark + 7] = 0x01
  const view = new DataView(bytes.buffer)
  view.setUint32(mark + 8, frames, false)
  return bytes
}

describe("media duration", () => {
  it("reads a wav header without a speech model", () => {
    expect(durationFromHeader(wav(2), wav(2).byteLength)).toBe(2)
  })

  it("reads an mp3 Xing frame count", () => {
    const frames = 1152
    const expected = (frames * 1152) / 44100
    expect(durationFromHeader(xingFrame(true, frames), 999999)).toBeCloseTo(expected, 5)
    expect(durationFromHeader(xingFrame(false, frames), 999999)).toBeCloseTo(expected, 5)
  })

  it("skips an ID3 tag before the first frame", () => {
    const frame = xingFrame(false, 44100)
    const tagged = new Uint8Array(10 + 171 + frame.length)
    tagged.set([0x49, 0x44, 0x33, 3, 0, 0], 0)
    tagged[8] = 0x01
    tagged[9] = 0x2b
    tagged.set(frame, 181)
    expect(durationFromHeader(tagged, tagged.byteLength)).toBeCloseTo(44100 * 1152 / 44100, 5)
  })
})
