import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  REPRS,
  TEXT_ENCODINGS,
  decodeText,
  encodeText,
  findBytes,
  formatBytes,
  fromBase64,
  parseBytes,
  toBase64,
} from './encoding'

const bytesArb = fc.uint8Array({ maxLength: 512 })

describe('byte representations round-trip', () => {
  for (const repr of REPRS) {
    it(`parse(format(x)) === x for ${repr}`, () => {
      fc.assert(fc.property(bytesArb, (b) => { expect(parseBytes(formatBytes(b, repr), repr)).toEqual(b) }))
    })
  }

  it('base64 matches Node Buffer', () => {
    fc.assert(
      fc.property(bytesArb, (b) => {
        expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'))
        expect(fromBase64(Buffer.from(b).toString('base64'))).toEqual(b)
      }),
    )
  })

  it('hex accepts 0x prefixes, commas and no spaces', () => {
    expect(parseBytes('0x48,0x69', 'hex')).toEqual(new Uint8Array([0x48, 0x69]))
    expect(parseBytes('4869', 'hex')).toEqual(new Uint8Array([0x48, 0x69]))
  })

  it('rejects malformed input', () => {
    expect(() => parseBytes('abc', 'hex')).toThrow()
    expect(() => parseBytes('0101', 'binary')).toThrow()
    expect(() => parseBytes('256', 'decimal')).toThrow()
    expect(() => parseBytes('9', 'octal')).toThrow()
    expect(() => parseBytes('a$==', 'base64')).toThrow()
  })
})

describe('text encodings', () => {
  it('utf-8 round-trips any well-formed string', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme' }), (s) => { expect(decodeText(encodeText(s, 'utf-8'), 'utf-8')).toBe(s) }))
  })

  for (const enc of ['utf-16le', 'utf-16be'] as const) {
    it(`${enc} round-trips`, () => {
      fc.assert(fc.property(fc.string({ unit: 'grapheme' }), (s) => { expect(decodeText(encodeText(s, enc), enc)).toBe(s) }))
    })
  }

  it('latin1 round-trips every byte', () => {
    fc.assert(fc.property(bytesArb, (b) => { expect(encodeText(decodeText(b, 'latin1'), 'latin1')).toEqual(b) }))
  })

  it('known encodings', () => {
    expect(Array.from(encodeText('é', 'utf-8'))).toEqual([0xc3, 0xa9])
    expect(Array.from(encodeText('é', 'latin1'))).toEqual([0xe9])
    expect(Array.from(encodeText('A', 'utf-16be'))).toEqual([0x00, 0x41])
    expect(Array.from(encodeText('€', 'windows-1252'))).toEqual([0x80])
    for (const e of TEXT_ENCODINGS) expect(decodeText(encodeText('Hi', e), e)).toBe('Hi')
  })
})

describe('findBytes', () => {
  const hay = new TextEncoder().encode('abcabcabc')
  it('finds next and wraps', () => {
    const n = new TextEncoder().encode('bc')
    expect(findBytes(hay, n, 0)).toBe(1)
    expect(findBytes(hay, n, 2)).toBe(4)
    expect(findBytes(hay, n, 8)).toBe(1)
    expect(findBytes(hay, new TextEncoder().encode('x'), 0)).toBe(-1)
  })
})
