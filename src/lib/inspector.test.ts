import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { NUM_TYPES, TYPE_SIZE, readValue, utf8CharAt, writeValue } from './inspector'

describe('inspector', () => {
  const b = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff])

  it('reads little and big endian', () => {
    expect(readValue(b, 0, 'uint16', true)).toBe('513')
    expect(readValue(b, 0, 'uint16', false)).toBe('258')
    expect(readValue(b, 0, 'uint32', false)).toBe(String(0x01020304))
    expect(readValue(b, 4, 'int32', true)).toBe('-1')
    expect(readValue(b, 4, 'uint32', true)).toBe('4294967295')
    expect(readValue(b, 0, 'uint64', false)).toBe(String(0x01020304ffffffffn))
    expect(readValue(b, 6, 'int32', true)).toBeNull()
  })

  it('write then read is identity for integers in range', () => {
    for (const t of NUM_TYPES.filter((t) => !t.startsWith('float'))) {
      const bits = BigInt(TYPE_SIZE[t] * 8)
      const signed = t.startsWith('int')
      const min = signed ? -(1n << (bits - 1n)) : 0n
      const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n
      fc.assert(
        fc.property(fc.bigInt({ min, max }), fc.boolean(), (v, le) => {
          const out = writeValue(new Uint8Array(8), 0, t, le, v.toString())
          expect(readValue(out, 0, t, le)).toBe(v.toString())
        }),
      )
    }
  })

  it('floats', () => {
    const out = writeValue(new Uint8Array(8), 0, 'float64', true, '3.5')
    expect(readValue(out, 0, 'float64', true)).toBe('3.5')
    expect(Array.from(writeValue(new Uint8Array(4), 0, 'float32', false, '1'))).toEqual([0x3f, 0x80, 0, 0])
  })

  it('rejects out of range and garbage', () => {
    expect(() => writeValue(new Uint8Array(1), 0, 'uint8', true, '256')).toThrow()
    expect(() => writeValue(new Uint8Array(1), 0, 'int8', true, '-129')).toThrow()
    expect(() => writeValue(new Uint8Array(4), 0, 'int32', true, 'abc')).toThrow()
    expect(() => writeValue(new Uint8Array(2), 0, 'int32', true, '1')).toThrow()
  })

  it('utf-8 char', () => {
    expect(utf8CharAt(new TextEncoder().encode('€'), 0)).toContain('U+20AC')
    expect(utf8CharAt(new Uint8Array([0x80]), 0)).toBeNull()
  })
})
