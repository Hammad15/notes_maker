const MPEG1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0]
const MPEG1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0]
const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const MPEG2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0]
const MPEG2_L2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const MPEG2_L3 = MPEG2_L2

const MAX_DURATION_SECONDS = 48 * 60 * 60

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ""
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0)
  }
  return out
}

function u16le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true)
}

function u32le(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function u32be(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)
}

function plausible(seconds: number | null): number | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_DURATION_SECONDS) {
    return null
  }
  return seconds
}

function wavDuration(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let dataSize: number | null = null
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4)
    const size = u32le(bytes, offset + 4)
    if (size == null) return null
    const start = offset + 8
    if (id === "fmt " && size >= 16 && start + 16 <= bytes.length) {
      channels = u16le(bytes, start + 2) ?? 0
      sampleRate = u32le(bytes, start + 4) ?? 0
      bits = u16le(bytes, start + 14) ?? 0
    } else if (id === "data") {
      dataSize = size
      break
    }
    offset = start + size + (size % 2)
  }
  if (!sampleRate || !channels || !bits || dataSize == null) return null
  const bytesPerSecond = sampleRate * channels * (bits / 8)
  if (!bytesPerSecond) return null
  return plausible(dataSize / bytesPerSecond)
}

interface FrameInfo {
  offset: number
  bitrate: number
  sampleRate: number
  samplesPerFrame: number
  xingOffset: number
}

function bitrateFor(version: number, layer: number, index: number): number {
  const table =
    version === 3
      ? layer === 3
        ? MPEG1_L1
        : layer === 2
          ? MPEG1_L2
          : MPEG1_L3
      : layer === 3
        ? MPEG2_L1
        : layer === 2
          ? MPEG2_L2
          : MPEG2_L3
  const kbps = table[index] ?? 0
  return kbps > 0 ? kbps * 1000 : 0
}

function frameAt(bytes: Uint8Array, offset: number): FrameInfo | null {
  if (offset + 4 > bytes.length) return null
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null
  const version = (bytes[offset + 1] >> 3) & 0x3
  const layer = (bytes[offset + 1] >> 1) & 0x3
  const bitrateIndex = (bytes[offset + 2] >> 4) & 0xf
  const sampleIndex = (bytes[offset + 2] >> 2) & 0x3
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
    return null
  }
  const mpeg1 = version === 3
  const sampleRates = mpeg1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
  const sampleRate = sampleRates[sampleIndex] ?? 0
  const bitrate = bitrateFor(version, layer, bitrateIndex)
  if (!sampleRate || !bitrate) return null
  const channelMode = (bytes[offset + 3] >> 6) & 0x3
  const mono = channelMode === 3
  let samplesPerFrame = 1152
  let sideInfo = 0
  if (layer === 3) samplesPerFrame = 384
  else if (layer === 1 && !mpeg1) samplesPerFrame = 576
  if (layer === 1) sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17
  return {
    offset,
    bitrate,
    sampleRate,
    samplesPerFrame,
    xingOffset: 4 + sideInfo,
  }
}

function mp3Duration(bytes: Uint8Array, fileSize: number): number | null {
  let start = 0
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    const size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f)
    start = 10 + size + ((bytes[5] & 0x10) !== 0 ? 10 : 0)
  }
  const limit = Math.min(bytes.length - 4, start + 65536)
  let frame: FrameInfo | null = null
  for (let offset = start; offset <= limit; offset += 1) {
    frame = frameAt(bytes, offset)
    if (frame) break
  }
  if (!frame) return null
  const mark = frame.offset + frame.xingOffset
  const tag = ascii(bytes, mark, 4)
  if (tag === "Xing" || tag === "Info") {
    const flags = u32be(bytes, mark + 4)
    if (flags != null && (flags & 0x1) !== 0) {
      const frames = u32be(bytes, mark + 8)
      if (frames != null && frames > 0) {
        return plausible((frames * frame.samplesPerFrame) / frame.sampleRate)
      }
    }
  }
  const audioBytes = Math.max(0, fileSize - frame.offset)
  if (!audioBytes) return null
  return plausible((audioBytes * 8) / frame.bitrate)
}

export function durationFromHeader(bytes: Uint8Array, fileSize: number): number | null {
  const wav = wavDuration(bytes)
  if (wav != null) return wav
  if (ascii(bytes, 0, 3) === "ID3" || frameAt(bytes, 0)) return mp3Duration(bytes, fileSize)
  return null
}
