import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack'
import { decode as cborDecode, encode as cborEncode } from 'cbor-x'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import Papa from 'papaparse'
import YAML from 'yaml'

export const DATA_FORMATS = ['json', 'yaml', 'csv', 'xml', 'msgpack', 'cbor'] as const
export type DataFormat = (typeof DATA_FORMATS)[number]
export const isBinaryFormat = (f: DataFormat) => f === 'msgpack' || f === 'cbor'

export const MONACO_LANG: Record<DataFormat, string> = {
  json: 'json',
  yaml: 'yaml',
  csv: 'plaintext',
  xml: 'xml',
  msgpack: 'plaintext',
  cbor: 'plaintext',
}

const xmlOpts = { ignoreAttributes: false, attributeNamePrefix: '@_' }

export function parseText(fmt: DataFormat, text: string): unknown {
  switch (fmt) {
    case 'json':
      return JSON.parse(text)
    case 'yaml':
      return YAML.parse(text)
    case 'csv': {
      const r = Papa.parse<Record<string, unknown>>(text.trim(), {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
      })
      if (r.errors.length) throw new Error(`CSV row ${r.errors[0].row}: ${r.errors[0].message}`)
      return r.data
    }
    case 'xml':
      return new XMLParser(xmlOpts).parse(text, true)
    default:
      throw new Error(`${fmt} is a binary format`)
  }
}

/** Converts values JSON / YAML cannot represent (bigint, Map, typed arrays, Date). */
export function toPlain(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  }
  if (value instanceof Uint8Array) return Array.from(value)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([k, v]) => [String(k), toPlain(v)]))
  }
  if (value instanceof Set) return Array.from(value, toPlain)
  if (Array.isArray(value)) return value.map(toPlain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]))
  }
  return value
}

export function stringify(fmt: DataFormat, value: unknown): string {
  const plain = toPlain(value)
  switch (fmt) {
    case 'json':
      return JSON.stringify(plain, null, 2)
    case 'yaml':
      return YAML.stringify(plain)
    case 'csv': {
      const rows = Array.isArray(plain) ? plain : [plain]
      const flat = rows.map((r) =>
        r && typeof r === 'object' && !Array.isArray(r)
          ? Object.fromEntries(
              Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v]),
            )
          : r,
      )
      return Papa.unparse(flat as object[])
    }
    case 'xml': {
      const root =
        plain && typeof plain === 'object' && !Array.isArray(plain) && Object.keys(plain).length === 1
          ? plain
          : { root: Array.isArray(plain) ? { item: plain } : plain }
      return new XMLBuilder({ ...xmlOpts, format: true }).build(root)
    }
    default:
      throw new Error(`${fmt} is a binary format`)
  }
}

export function decodeBinary(fmt: DataFormat, bytes: Uint8Array): unknown {
  if (fmt === 'msgpack') return msgpackDecode(bytes)
  if (fmt === 'cbor') return cborDecode(bytes)
  throw new Error(`${fmt} is a text format`)
}

export function encodeBinary(fmt: DataFormat, value: unknown): Uint8Array {
  if (fmt === 'msgpack') return msgpackEncode(value)
  if (fmt === 'cbor') return new Uint8Array(cborEncode(value))
  throw new Error(`${fmt} is a text format`)
}
