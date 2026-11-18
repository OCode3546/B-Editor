import { Buffer } from 'buffer'
import iconv from 'iconv-lite'

export const TEXT_ENCODINGS = [
  'utf-8',
  'utf-16le',
  'utf-16be',
  'latin1',
  'ascii',
  'windows-1252',
  'cp437',
] as const
export type TextEncodingName = (typeof TEXT_ENCODINGS)[number]

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8')

export function encodeText(text: string, enc: TextEncodingName): Uint8Array {
  if (enc === 'utf-8') return utf8Encoder.encode(text)
  return new Uint8Array(iconv.encode(text, enc))
}

export function decodeText(bytes: Uint8Array, enc: TextEncodingName): string {
  if (enc === 'utf-8') return utf8Decoder.decode(bytes)
  return iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), enc)
}

export const REPRS = ['hex', 'binary', 'decimal', 'octal', 'base64'] as const
export type Repr = (typeof REPRS)[number]

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const BIN = Array.from({ length: 256 }, (_, i) => i.toString(2).padStart(8, '0'))
const OCT = Array.from({ length: 256 }, (_, i) => i.toString(8).padStart(3, '0'))

export const hexByte = (b: number) => HEX[b]
export const binByte = (b: number) => BIN[b]

const PER_LINE: Record<Exclude<Repr, 'base64'>, number> = {
  hex: 16,
  binary: 8,
  decimal: 16,
  octal: 16,
}

export function formatBytes(bytes: Uint8Array, repr: Repr): string {
  if (repr === 'base64') return toBase64(bytes).replace(/(.{76})/g, '$1\n').trimEnd()
  const table = repr === 'hex' ? HEX : repr === 'binary' ? BIN : repr === 'octal' ? OCT : null
  const per = PER_LINE[repr]
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += per) {
    const parts: string[] = []
    const end = Math.min(i + per, bytes.length)
    for (let j = i; j < end; j++) parts.push(table ? table[bytes[j]] : String(bytes[j]))
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
}

export class ParseError extends Error {}

export function parseBytes(text: string, repr: Repr): Uint8Array {
  switch (repr) {
    case 'hex':
      return parseHex(text)
    case 'binary':
      return parseBits(text)
    case 'decimal':
      return parseRadixTokens(text, 10)
    case 'octal':
      return parseRadixTokens(text, 8)
    case 'base64':
      return fromBase64(text)
  }
}

export function parseHex(text: string): Uint8Array {
  const clean = text.replace(/0x/gi, '').replace(/[\s,;:-]/g, '')
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new ParseError('Invalid hex character')
  if (clean.length % 2) throw new ParseError('Odd number of hex digits')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

export function parseBits(text: string): Uint8Array {
  const clean = text.replace(/0b/gi, '').replace(/[\s,_]/g, '')
  if (!/^[01]*$/.test(clean)) throw new ParseError('Only 0 and 1 allowed')
  if (clean.length % 8) throw new ParseError(`Bit count ${clean.length} is not a multiple of 8`)
  const out = new Uint8Array(clean.length / 8)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 8, 8), 2)
  return out
}

function parseRadixTokens(text: string, radix: 8 | 10): Uint8Array {
  const tokens = text.split(/[\s,;]+/).filter(Boolean)
  const re = radix === 10 ? /^\d+$/ : /^[0-7]+$/
  const out = new Uint8Array(tokens.length)
  tokens.forEach((t, i) => {
    if (!re.test(t)) throw new ParseError(`Invalid token "${t}"`)
    const n = parseInt(t, radix)
    if (n > 255) throw new ParseError(`Value ${t} out of byte range`)
    out[i] = n
  })
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i
B64_LOOKUP['-'.charCodeAt(0)] = 62
B64_LOOKUP['_'.charCodeAt(0)] = 63

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[n >> 18] + B64[(n >> 12) & 63] + '=='
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s/g, '').replace(/=+$/, '')
  if (clean.length % 4 === 1) throw new ParseError('Invalid base64 length')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buf = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i)
    const v = c < 128 ? B64_LOOKUP[c] : -1
    if (v < 0) throw new ParseError(`Invalid base64 character "${clean[i]}"`)
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out
}

export function printableChar(b: number): string {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function findBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (!needle.length) return -1
  const first = needle[0]
  const last = hay.length - needle.length
  const scan = (start: number, end: number) => {
    for (let i = start; i <= end; i++) {
      if (hay[i] !== first) continue
      let j = 1
      while (j < needle.length && hay[i + j] === needle[j]) j++
      if (j === needle.length) return i
    }
    return -1
  }
  const hit = scan(from, last)
  return hit >= 0 ? hit : scan(0, Math.min(from - 1, last))
}
