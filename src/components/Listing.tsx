import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import type { Instruction } from '../lib/disasm'
import { hexByte } from '../lib/encoding'

const ROW_H = 20

export function Listing({ insns, highlight }: { insns: Instruction[]; highlight?: bigint | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({
    count: insns.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  })
  // Scroll the highlighted address into view (entry point, clicked symbol).
  useEffect(() => {
    if (highlight === null || highlight === undefined || !insns.length) return
    let lo = 0
    let hi = insns.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (insns[mid].address < highlight) lo = mid + 1
      else hi = mid
    }
    v.scrollToIndex(lo, { align: 'center' })
  }, [highlight, insns, v])

  const addrW = Math.max(8, insns.length ? insns[insns.length - 1].address.toString(16).length : 8)

  return (
    <div ref={ref} className="h-full overflow-auto font-mono text-xs select-text">
      <div style={{ height: v.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
        {v.getVirtualItems().map((r) => {
          const i = insns[r.index]
          const isData = i.mnemonic === '.byte'
          return (
            <div
              key={r.key}
              className={`absolute left-0 flex w-full items-center gap-4 px-2 whitespace-pre ${highlight === i.address ? 'bg-sel' : ''}`}
              style={{ top: r.start, height: ROW_H }}
            >
              <span className="text-accent/70">{i.address.toString(16).padStart(addrW, '0')}</span>
              <span className="w-[30ch] truncate text-dim">{Array.from(i.bytes, hexByte).join(' ')}</span>
              <span className={`w-[9ch] ${isData ? 'text-warn' : 'text-[#c586c0]'}`}>{i.mnemonic}</span>
              <span className="text-[#9cdcfe]">{i.opStr}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
