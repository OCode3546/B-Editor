import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decodeBinary, encodeBinary, parseText, stringify } from './formats'

// cbor-x deliberately renames "__proto__" keys (prototype-pollution guard), so exclude them.
const jsonValue = fc
  .jsonValue({ maxDepth: 3 })
  .map((v) => JSON.parse(JSON.stringify(v)))
  .filter((v) => !JSON.stringify(v).includes('"__proto__"'))

describe('data formats', () => {
  for (const fmt of ['msgpack', 'cbor'] as const) {
    it(`${fmt}: decode(encode(x)) === x`, () => {
      fc.assert(fc.property(jsonValue, (v) => { expect(decodeBinary(fmt, encodeBinary(fmt, v))).toEqual(v) }))
    })
  }

  for (const fmt of ['json', 'yaml'] as const) {
    it(`${fmt}: parse(stringify(x)) === x`, () => {
      fc.assert(fc.property(jsonValue, (v) => { expect(parseText(fmt, stringify(fmt, v))).toEqual(v) }))
    })
  }

  it('csv', () => {
    const rows = [
      { a: 1, b: 'x' },
      { a: 2, b: 'y, z' },
    ]
    expect(parseText('csv', stringify('csv', rows))).toEqual(rows)
  })

  it('xml', () => {
    const v = parseText('xml', '<root a="1"><item>x</item><item>y</item></root>')
    expect(v).toEqual({ root: { '@_a': '1', item: ['x', 'y'] } })
    expect(parseText('xml', stringify('xml', v))).toEqual(v)
  })

  it('known msgpack bytes', () => {
    expect(Array.from(encodeBinary('msgpack', { a: 1 }))).toEqual([0x81, 0xa1, 0x61, 0x01])
  })
})
