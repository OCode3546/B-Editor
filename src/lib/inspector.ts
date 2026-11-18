export const NUM_TYPES = [
  'int8',
  'uint8',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'int64',
  'uint64',
  'float32',
  'float64',
] as const
export type NumType = (typeof NUM_TYPES)[number]

export const TYPE_SIZE: Record<NumType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  int64: 8,
  uint64: 8,
  float32: 4,
  float64: 8,
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function readValue(
  bytes: Uint8Array,
  offset: number,
  type: NumType,
  little: boolean,
): string | null {
  if (offset < 0 || offset + TYPE_SIZE[type] > bytes.length) return null
  const v = view(bytes)
  switch (type) {
    case 'int8':
      return String(v.getInt8(offset))
    case 'uint8':
      return String(v.getUint8(offset))
    case 'int16':
      return String(v.getInt16(offset, little))
    case 'uint16':
      return String(v.getUint16(offset, little))
    case 'int32':
      return String(v.getInt32(offset, little))
    case 'uint32':
      return String(v.getUint32(offset, little))
    case 'int64':
      return String(v.getBigInt64(offset, little))
    case 'uint64':
      return String(v.getBigUint64(offset, little))
    case 'float32':
      return String(v.getFloat32(offset, little))
    case 'float64':
      return String(v.getFloat64(offset, little))
  }
}

/** Returns a copy of `bytes` with `value` written at `offset`. Throws on invalid input. */
export function writeValue(
  bytes: Uint8Array,
  offset: number,
  type: NumType,
  little: boolean,
  value: string,
): Uint8Array {
  const size = TYPE_SIZE[type]
  if (offset < 0 || offset + size > bytes.length) throw new Error('Not enough bytes at offset')
  const out = bytes.slice()
  const v = view(out)
  const s = value.trim()
  if (type.startsWith('float')) {
    const n = Number(s)
    if (s === '' || (Number.isNaN(n) && s.toLowerCase() !== 'nan')) throw new Error('Not a number')
    if (type === 'float32') v.setFloat32(offset, n, little)
    else v.setFloat64(offset, n, little)
    return out
  }
  if (!/^-?(0x[0-9a-f]+|\d+)$/i.test(s)) throw new Error('Not an integer')
  const neg = s.startsWith('-')
  const big = neg ? -BigInt(s.slice(1)) : BigInt(s)
  const bits = BigInt(size * 8)
  const signed = type.startsWith('int')
  const min = signed ? -(1n << (bits - 1n)) : 0n
  const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n
  if (big < min || big > max) throw new Error(`Out of range ${min}..${max}`)
  switch (type) {
    case 'int8':
      v.setInt8(offset, Number(big))
      break
    case 'uint8':
      v.setUint8(offset, Number(big))
      break
    case 'int16':
      v.setInt16(offset, Number(big), little)
      break
    case 'uint16':
      v.setUint16(offset, Number(big), little)
      break
    case 'int32':
      v.setInt32(offset, Number(big), little)
      break
    case 'uint32':
      v.setUint32(offset, Number(big), little)
      break
    case 'int64':
      v.setBigInt64(offset, big, little)
      break
    case 'uint64':
      v.setBigUint64(offset, big, little)
      break
  }
  return out
}

export function utf8CharAt(bytes: Uint8Array, offset: number): string | null {
  if (offset >= bytes.length) return null
  const b = bytes[offset]
  const len = b < 0x80 ? 1 : b >> 5 === 6 ? 2 : b >> 4 === 14 ? 3 : b >> 3 === 30 ? 4 : 0
  if (!len || offset + len > bytes.length) return null
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + len))
    const cp = s.codePointAt(0)!
    return `${JSON.stringify(s)} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
  } catch {
    return null
  }
}
