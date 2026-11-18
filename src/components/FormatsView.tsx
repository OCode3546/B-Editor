import { useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { formatBytes } from '../lib/encoding'
import {
  DATA_FORMATS,
  MONACO_LANG,
  decodeBinary,
  encodeBinary,
  isBinaryFormat,
  parseText,
  stringify,
  type DataFormat,
} from '../lib/formats'
import { doc, download, useDoc } from '../store'
import { CodeEditor } from './CodeEditor'

const SAMPLE = `{
  "name": "binary-editor",
  "version": 1,
  "tags": ["hex", "utf-8", "wasm"],
  "ok": true,
  "size": 3.5
}`

const EXT: Record<DataFormat, string> = {
  json: 'json',
  yaml: 'yaml',
  csv: 'csv',
  xml: 'xml',
  msgpack: 'msgpack',
  cbor: 'cbor',
}

export function FormatsView() {
  const { bytes, rev, name } = useDoc()
  const [from, setFrom] = useState<DataFormat>('json')
  const [to, setTo] = useState<DataFormat>('msgpack')
  const [input, setInput] = useState(SAMPLE)

  const binaryIn = isBinaryFormat(from)
  const binaryOut = isBinaryFormat(to)

  const result = useMemo(() => {
    try {
      const value = binaryIn ? decodeBinary(from, bytes) : parseText(from, input)
      if (binaryOut) {
        const out = encodeBinary(to, value)
        return { ok: true as const, bytes: out, text: formatBytes(out, 'hex') }
      }
      const text = stringify(to, value)
      return { ok: true as const, bytes: new TextEncoder().encode(text), text }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
    // rev tracks in-place buffer edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, input, bytes, rev, binaryIn, binaryOut])

  const swap = () => {
    if (!result.ok) return
    if (binaryOut) doc.replace(result.bytes)
    else setInput(result.text)
    setFrom(to)
    setTo(from)
  }

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="50" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">From</span>
          <FormatSelect value={from} onChange={setFrom} />
          {binaryIn ? (
            <span className="text-dim">reads the current buffer ({name}, {bytes.length} bytes)</span>
          ) : (
            <>
              <button className="btn" onClick={() => setInput(new TextDecoder().decode(bytes))}>
                Load buffer as text
              </button>
              <button className="btn" onClick={() => doc.replace(new TextEncoder().encode(input))}>
                Save text to buffer
              </button>
            </>
          )}
          <button className="btn ml-auto" onClick={swap} disabled={!result.ok} title="Use output as new input">
            ⇄ Swap
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {binaryIn ? (
            <CodeEditor value={formatBytes(bytes.subarray(0, 1 << 20), 'hex')} readOnly language="bytes" />
          ) : (
            <CodeEditor value={input} onChange={setInput} language={MONACO_LANG[from]} />
          )}
        </div>
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="50" minSize="20" className="flex h-full flex-col">
        <div className="pane-header">
          <span className="font-semibold">To</span>
          <FormatSelect value={to} onChange={setTo} />
          {result.ok ? (
            <>
              <span className="text-ok">✓ {result.bytes.length} bytes</span>
              <button className="btn ml-auto" onClick={() => doc.replace(result.bytes)}>
                Use as buffer
              </button>
              <button className="btn" onClick={() => download(result.bytes, `output.${EXT[to]}`)}>
                Download
              </button>
            </>
          ) : (
            <span className="truncate text-warn">✗ {result.error}</span>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={result.ok ? result.text : ''}
            readOnly
            language={binaryOut ? 'bytes' : MONACO_LANG[to]}
          />
        </div>
      </Panel>
    </Group>
  )
}

function FormatSelect({ value, onChange }: { value: DataFormat; onChange: (f: DataFormat) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as DataFormat)}>
      {DATA_FORMATS.map((f) => (
        <option key={f} value={f}>
          {f.toUpperCase()}
          {isBinaryFormat(f) ? ' (binary)' : ''}
        </option>
      ))}
    </select>
  )
}
