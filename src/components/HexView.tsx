import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { binByte, findBytes, formatBytes, hexByte, parseHex, printableChar } from '../lib/encoding'
import { doc, useDoc } from '../store'
import { Inspector } from './Inspector'

type Mode = 'hex' | 'binary' | 'decimal'
type Col = 'data' | 'ascii'

const ROW_H = 20
const CELL_CH: Record<Mode, number> = { hex: 2, binary: 8, decimal: 3 }

export function HexView() {
  const { bytes, rev } = useDoc()
  const [mode, setMode] = useState<Mode>('hex')
  const [cursor, setCursor] = useState(0)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [col, setCol] = useState<Col>('data')
  const [insert, setInsert] = useState(false)
  const [sub, setSub] = useState<{ nibble: number; bit: number; dec: string }>({ nibble: 0, bit: 0, dec: '' })
  const [gotoText, setGotoText] = useState('')
  const [findText, setFindText] = useState('')
  const [findHex, setFindHex] = useState(false)
  const [status, setStatus] = useState('')
  const dragging = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const perRow = mode === 'binary' ? 8 : 16
  const rowCount = Math.floor(bytes.length / perRow) + 1
  const selStart = anchor === null ? cursor : Math.min(anchor, cursor)
  const selEnd = anchor === null ? cursor : Math.max(anchor, cursor)
  const hasSel = anchor !== null && anchor !== cursor
  const selLen = hasSel ? Math.min(selEnd, bytes.length - 1) - selStart + 1 : 0

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  })

  useEffect(() => {
    if (cursor > bytes.length) setCursor(bytes.length)
  }, [bytes.length, cursor])

  useEffect(() => {
    virtualizer.scrollToIndex(Math.floor(cursor / perRow), { align: 'auto' })
  }, [cursor, perRow, virtualizer])

  const resetSub = () => setSub({ nibble: 0, bit: 0, dec: '' })

  const move = (to: number, extend: boolean) => {
    const c = Math.max(0, Math.min(to, bytes.length))
    if (extend) setAnchor((a) => (a === null ? cursor : a))
    else setAnchor(null)
    setCursor(c)
    resetSub()
  }

  /** `merge` folds this write into the previous undo step (later nibbles/bits of the same byte). */
  const writeByte = (offset: number, value: number, freshInsert: boolean, merge = false) => {
    const v = new Uint8Array([value & 0xff])
    if (offset >= bytes.length || freshInsert) doc.splice(offset, 0, v)
    else doc.splice(offset, 1, v, { merge })
  }

  const deleteSelection = () => {
    if (!hasSel) return false
    doc.splice(selStart, selLen)
    setAnchor(null)
    setCursor(selStart)
    resetSub()
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.metaKey || e.ctrlKey
    const k = e.key

    if (mod && k.toLowerCase() === 'z') {
      e.preventDefault()
      const r = e.shiftKey ? doc.redo() : doc.undo()
      if (r) move(r.offset, false)
      return
    }
    if (mod && k.toLowerCase() === 'y') {
      e.preventDefault()
      const r = doc.redo()
      if (r) move(r.offset, false)
      return
    }
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault()
      setAnchor(0)
      setCursor(Math.max(0, bytes.length - 1))
      return
    }
    if (mod) return

    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_H) - 1)
    const nav: Record<string, number> = {
      ArrowLeft: cursor - 1,
      ArrowRight: cursor + 1,
      ArrowUp: cursor - perRow,
      ArrowDown: cursor + perRow,
      PageUp: cursor - perRow * pageRows,
      PageDown: cursor + perRow * pageRows,
      Home: cursor - (cursor % perRow),
      End: Math.min(bytes.length, cursor - (cursor % perRow) + perRow - 1),
    }
    if (k in nav) {
      e.preventDefault()
      if (k === 'ArrowUp' && cursor < perRow) return
      if (k === 'ArrowDown' && cursor + perRow > bytes.length) return move(bytes.length, e.shiftKey)
      return move(nav[k], e.shiftKey)
    }
    if (k === 'Tab') {
      e.preventDefault()
      setCol((c) => (c === 'data' ? 'ascii' : 'data'))
      resetSub()
      return
    }
    if (k === 'Insert') {
      e.preventDefault()
      setInsert((i) => !i)
      return
    }
    if (k === 'Escape') {
      setAnchor(null)
      resetSub()
      return
    }
    if (k === 'Backspace') {
      e.preventDefault()
      if (deleteSelection()) return
      if (cursor > 0) {
        doc.splice(cursor - 1, 1)
        move(cursor - 1, false)
      }
      return
    }
    if (k === 'Delete') {
      e.preventDefault()
      if (deleteSelection()) return
      if (cursor < bytes.length) doc.splice(cursor, 1)
      resetSub()
      return
    }
    if (k.length !== 1) return

    // Typing
    if (col === 'ascii') {
      const code = k.charCodeAt(0)
      if (code > 0xff) return
      e.preventDefault()
      writeByte(cursor, code, insert)
      move(cursor + 1, false)
      return
    }

    const old = cursor < bytes.length ? bytes[cursor] : 0
    const fresh = insert || cursor >= bytes.length
    if (mode === 'hex' && /^[0-9a-f]$/i.test(k)) {
      e.preventDefault()
      const n = parseInt(k, 16)
      if (sub.nibble === 0) {
        writeByte(cursor, (n << 4) | (fresh ? 0 : old & 0x0f), fresh)
        setSub({ ...sub, nibble: 1 })
      } else {
        writeByte(cursor, (old & 0xf0) | n, false, true)
        move(cursor + 1, false)
      }
    } else if (mode === 'binary' && (k === '0' || k === '1')) {
      e.preventDefault()
      const base = fresh && sub.bit === 0 ? 0 : old
      const mask = 0x80 >> sub.bit
      const v = k === '1' ? base | mask : base & ~mask
      writeByte(cursor, v, fresh && sub.bit === 0, sub.bit > 0)
      if (sub.bit === 7) move(cursor + 1, false)
      else setSub({ ...sub, bit: sub.bit + 1 })
    } else if (mode === 'decimal' && /^\d$/.test(k)) {
      e.preventDefault()
      const dec = sub.dec + k
      if (Number(dec) > 255) {
        setStatus('Decimal byte must be 0–255')
        return
      }
      if (dec.length === 3 || Number(dec) * 10 > 255) {
        writeByte(cursor, Number(dec), fresh)
        move(cursor + 1, false)
      } else setSub({ ...sub, dec })
    } else if (mode === 'decimal' && (k === ' ' || k === 'Enter') && sub.dec) {
      e.preventDefault()
      writeByte(cursor, Number(sub.dec), fresh)
      move(cursor + 1, false)
    }
  }

  const onCopy = (e: ClipboardEvent) => {
    const slice = hasSel ? bytes.subarray(selStart, selStart + selLen) : bytes.subarray(cursor, cursor + 1)
    e.preventDefault()
    e.clipboardData.setData(
      'text/plain',
      col === 'ascii' ? new TextDecoder().decode(slice) : formatBytes(slice, 'hex').replace(/\n/g, ' '),
    )
  }

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    let data: Uint8Array
    if (col === 'data') {
      try {
        data = parseHex(text)
      } catch {
        setStatus('Clipboard is not hex — paste into the ASCII column for text')
        return
      }
    } else data = new TextEncoder().encode(text)
    const at = hasSel ? selStart : cursor
    const del = hasSel ? selLen : insert ? 0 : Math.min(data.length, bytes.length - at)
    doc.splice(at, del, data)
    move(at + data.length, false)
    setStatus(`Pasted ${data.length} bytes`)
  }

  const goto = () => {
    const t = gotoText.trim()
    const n = /^0x/i.test(t) ? parseInt(t, 16) : /[a-f]/i.test(t) ? parseInt(t, 16) : parseInt(t, 10)
    if (Number.isNaN(n)) return setStatus('Invalid offset')
    move(n, false)
    scrollRef.current?.focus()
  }

  const find = () => {
    let needle: Uint8Array
    try {
      needle = findHex ? parseHex(findText) : new TextEncoder().encode(findText)
    } catch (e) {
      return setStatus((e as Error).message)
    }
    const hit = findBytes(bytes, needle, cursor + 1)
    if (hit < 0) return setStatus('Not found')
    setAnchor(hit)
    setCursor(hit + needle.length - 1)
    resetSub()
    setStatus(`Found at 0x${hit.toString(16)}`)
    scrollRef.current?.focus()
  }

  const cellW = CELL_CH[mode]
  const inSel = (i: number) => hasSel && i >= selStart && i <= selEnd

  return (
    <Group orientation="horizontal" className="h-full">
      <Panel defaultSize="74" minSize="40" className="flex h-full flex-col">
        <div className="pane-header flex-wrap">
          {(['hex', 'binary', 'decimal'] as Mode[]).map((m) => (
            <button
              key={m}
              className={m === mode ? 'btn-primary' : 'btn'}
              onClick={() => {
                setMode(m)
                resetSub()
              }}
            >
              {m}
            </button>
          ))}
          <button className={insert ? 'btn-primary' : 'btn'} onClick={() => setInsert(!insert)} title="Insert key">
            {insert ? 'INS' : 'OVR'}
          </button>
          <span className="mx-1 h-4 w-px bg-line" />
          <input
            className="field w-24 font-mono"
            placeholder="go to 0x…"
            value={gotoText}
            onChange={(e) => setGotoText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && goto()}
          />
          <input
            className="field w-36 font-mono"
            placeholder={findHex ? 'find hex…' : 'find text…'}
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && find()}
          />
          <button className={findHex ? 'btn-primary' : 'btn'} onClick={() => setFindHex(!findHex)}>
            hex
          </button>
          <button className="btn" onClick={find}>
            Find next
          </button>
          <span className="ml-auto truncate text-dim">{status}</span>
        </div>
        <div
          ref={scrollRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
          onMouseUp={() => (dragging.current = false)}
          onMouseLeave={() => (dragging.current = false)}
          className="min-h-0 flex-1 overflow-auto font-mono outline-none select-none focus:ring-1 focus:ring-accent/40 focus:ring-inset"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const start = vr.index * perRow
              const end = Math.min(start + perRow, bytes.length + 1)
              const cells = []
              const chars = []
              for (let i = start; i < end; i++) {
                const isCur = i === cursor
                const exists = i < bytes.length
                const b = exists ? bytes[i] : 0
                const text = !exists
                  ? '··'.padEnd(cellW, '·').slice(0, cellW)
                  : isCur && mode === 'decimal' && sub.dec
                    ? sub.dec.padEnd(3, '_')
                    : mode === 'hex'
                      ? hexByte(b).toUpperCase()
                      : mode === 'binary'
                        ? binByte(b)
                        : String(b).padStart(3, ' ')
                const cls = `${isCur ? (col === 'data' ? 'bg-accent text-black' : 'outline outline-accent') : inSel(i) ? 'bg-sel' : ''} ${!exists ? 'text-dim/40' : b === 0 ? 'text-dim' : ''}`
                const onDown = (c: Col) => (e: MouseEvent) => {
                  dragging.current = true
                  setCol(c)
                  if (e.shiftKey) move(i, true)
                  else {
                    setAnchor(i)
                    setCursor(i)
                    resetSub()
                  }
                }
                const onEnter = () => {
                  if (dragging.current) setCursor(i)
                }
                cells.push(
                  <span
                    key={i}
                    onMouseDown={onDown('data')}
                    onMouseEnter={onEnter}
                    className={`inline-block cursor-text px-[3px] ${cls} ${i % perRow === 7 && perRow === 16 ? 'mr-2' : ''}`}
                    style={{ width: `calc(${cellW}ch + 6px)`, whiteSpace: 'pre' }}
                  >
                    {text}
                  </span>,
                )
                chars.push(
                  <span
                    key={i}
                    onMouseDown={onDown('ascii')}
                    onMouseEnter={onEnter}
                    className={`inline-block w-[1ch] cursor-text ${isCur ? (col === 'ascii' ? 'bg-accent text-black' : 'outline outline-accent') : inSel(i) ? 'bg-sel' : ''} ${exists && (b < 0x20 || b >= 0x7f) ? 'text-dim' : ''}`}
                  >
                    {exists ? printableChar(b) : ' '}
                  </span>,
                )
              }
              return (
                <div
                  key={vr.key}
                  className="absolute left-0 flex items-center whitespace-nowrap"
                  style={{ top: vr.start, height: ROW_H }}
                >
                  <span className="w-[10ch] shrink-0 pl-2 text-accent/70">
                    {start.toString(16).toUpperCase().padStart(8, '0')}
                  </span>
                  <span className="shrink-0" style={{ width: `calc(${perRow} * (${cellW}ch + 6px) + ${perRow === 16 ? 8 : 0}px + 1ch)` }}>
                    {cells}
                  </span>
                  <span className="border-l border-line pl-2">{chars}</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-2 text-xs text-dim">
          <span>{bytes.length.toLocaleString()} bytes</span>
          <span>
            cursor 0x{cursor.toString(16).toUpperCase()}
            {hasSel && ` · selected ${selLen} (0x${selStart.toString(16)}–0x${(selStart + selLen - 1).toString(16)})`}
          </span>
          <span className="ml-auto">Tab: switch hex/ASCII · Ins: insert mode · ⌘Z/⇧⌘Z: undo/redo</span>
        </div>
      </Panel>
      <Separator className="separator" />
      <Panel defaultSize="26" minSize="15">
        <Inspector
          bytes={bytes}
          rev={rev}
          offset={selStart}
          selLength={selLen}
          onWrite={(off, data) => doc.splice(off, data.length, data)}
        />
      </Panel>
    </Group>
  )
}
