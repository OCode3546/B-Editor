import { useState } from 'react'
import { binByte, hexByte } from '../lib/encoding'
import { NUM_TYPES, TYPE_SIZE, readValue, utf8CharAt, writeValue, type NumType } from '../lib/inspector'

interface Props {
  bytes: Uint8Array
  rev: number
  offset: number
  selLength: number
  onWrite: (offset: number, data: Uint8Array) => void
}

export function Inspector({ bytes, rev, offset, selLength, onWrite }: Props) {
  const [little, setLittle] = useState(true)
  const b = offset < bytes.length ? bytes[offset] : null

  return (
    <div className="flex h-full flex-col overflow-auto bg-panel text-xs">
      <div className="pane-header">
        <span className="font-semibold">Inspector</span>
        <div className="ml-auto flex gap-1">
          <button className={little ? 'btn-primary' : 'btn'} onClick={() => setLittle(true)}>
            LE
          </button>
          <button className={!little ? 'btn-primary' : 'btn'} onClick={() => setLittle(false)}>
            BE
          </button>
        </div>
      </div>
      <table className="w-full font-mono">
        <tbody>
          <Row label="offset" value={`0x${offset.toString(16).toUpperCase()} (${offset})`} />
          {selLength > 0 && <Row label="selection" value={`${selLength} bytes`} />}
          <Row label="hex" value={b === null ? '—' : hexByte(b).toUpperCase()} />
          <Row label="binary" value={b === null ? '—' : binByte(b)} />
          <Row label="octal" value={b === null ? '—' : b.toString(8).padStart(3, '0')} />
          <Row label="char" value={b === null ? '—' : b >= 0x20 && b < 0x7f ? `'${String.fromCharCode(b)}'` : '—'} />
          <Row label="utf-8" value={utf8CharAt(bytes, offset) ?? '—'} />
          {NUM_TYPES.map((t) => (
            <EditableRow
              key={`${t}-${offset}-${rev}-${little}`}
              type={t}
              value={readValue(bytes, offset, t, little)}
              onCommit={(s) => onWrite(offset, writeValue(bytes, offset, t, little, s).subarray(offset, offset + TYPE_SIZE[t]))}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-line/50">
      <td className="w-20 px-2 py-1 text-dim">{label}</td>
      <td className="px-2 py-1 break-all select-text">{value}</td>
    </tr>
  )
}

function EditableRow({
  type,
  value,
  onCommit,
}: {
  type: NumType
  value: string | null
  onCommit: (s: string) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  const [err, setErr] = useState<string | null>(null)
  if (value === null) return <Row label={type} value="—" />
  return (
    <tr className="border-b border-line/50">
      <td className="w-20 px-2 py-0.5 text-dim">{type}</td>
      <td className="px-1 py-0.5">
        <input
          className={`field w-full font-mono ${err ? 'border-warn' : ''}`}
          value={draft}
          title={err ?? 'Edit and press Enter to write'}
          onChange={(e) => {
            setDraft(e.target.value)
            setErr(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              try {
                onCommit(draft)
              } catch (x) {
                setErr((x as Error).message)
              }
            } else if (e.key === 'Escape') {
              setDraft(value)
              setErr(null)
            }
          }}
        />
      </td>
    </tr>
  )
}
