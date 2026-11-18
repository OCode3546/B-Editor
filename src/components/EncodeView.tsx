import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  REPRS,
  TEXT_ENCODINGS,
  bytesEqual,
  decodeText,
  encodeText,
  formatBytes,
  parseBytes,
  type Repr,
  type TextEncodingName,
} from '../lib/encoding'
import { doc, useDoc } from '../store'
import { CodeEditor } from './CodeEditor'

const MAX_TEXT_VIEW = 4 * 1024 * 1024

export function EncodeView() {
  const { bytes, rev } = useDoc()
  const [enc, setEnc] = useState<TextEncodingName>('utf-8')
  const [repr, setRepr] = useState<Repr>('hex')
  const tooBig = bytes.length > MAX_TEXT_VIEW
  const [left, setLeft] = useState(() => (tooBig ? '' : decodeText(bytes, enc)))
  const [right, setRight] = useState(() => (tooBig ? '' : formatBytes(bytes, repr)))
  const [error, setError] = useState<string | null>(null)
  const ownRev = useRef(tooBig ? -1 : rev)

  // Buffer changed elsewhere (file open, hex edit, undo): refresh both sides.
  useEffect(() => {
    if (rev === ownRev.current || tooBig) return
    ownRev.current = rev
    setLeft(decodeText(bytes, enc))
    setRight(formatBytes(bytes, repr))
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])

  const lossy = useMemo(() => {
    if (tooBig) return false
    try {
      return !bytesEqual(encodeText(decodeText(bytes, enc), enc), bytes)
    } catch {
      return true
    }
  }, [bytes, rev, enc, tooBig])

  if (tooBig) {
    return (
      <div className="p-6 text-dim">
        Buffer is {bytes.length.toLocaleString()} bytes — too large for the text view. Use the Hex tab.
      </div>
    )
  }

  const onLeft = (v: string) => {
    setLeft(v)
    try {
      const b = encodeText(v, enc)
      ownRev.current = doc.replace(b)
      setRight(formatBytes(b, repr))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onRight = (v: string) => {
    setRight(v)
    try {
      const b = parseBytes(v, repr)
      ownRev.current = doc.replace(b)
      setLeft(decodeText(b, enc))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const changeEnc = (e: TextEncodingName) => {
    setEnc(e)
    setLeft(decodeText(bytes, e))
  }

  const changeRepr = (r: Repr) => {
    setRepr(r)
    setRight(formatBytes(bytes, r))
    setError(null)
  }

  return (
    <div className="flex h-full flex-col">
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="50" minSize="15" className="flex h-full flex-col">
          <div className="pane-header">
            <span className="font-semibold">Text</span>
            <select className="field" value={enc} onChange={(e) => changeEnc(e.target.value as TextEncodingName)}>
              {TEXT_ENCODINGS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            {lossy && <span className="text-warn">⚠ bytes are not valid {enc} — text view is lossy</span>}
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor value={left} onChange={onLeft} />
          </div>
        </Panel>
        <Separator className="separator" />
        <Panel defaultSize="50" minSize="15" className="flex h-full flex-col">
          <div className="pane-header">
            <span className="font-semibold">Bytes</span>
            {REPRS.map((r) => (
              <button key={r} className={r === repr ? 'btn-primary' : 'btn'} onClick={() => changeRepr(r)}>
                {r}
              </button>
            ))}
            {error && <span className="truncate text-warn">✗ {error}</span>}
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor value={right} onChange={onRight} language="bytes" wordWrap={repr === 'base64'} />
          </div>
        </Panel>
      </Group>
      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-2 text-xs text-dim">
        <span>{bytes.length.toLocaleString()} bytes</span>
        <span>{(bytes.length * 8).toLocaleString()} bits</span>
        <span>{[...left].length.toLocaleString()} chars</span>
      </div>
    </div>
  )
}
