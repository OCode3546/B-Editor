import { useEffect, useState } from 'react'
import { CompileView } from './components/CompileView'
import { DecompileView } from './components/DecompileView'
import { DisasmView } from './components/DisasmView'
import { EncodeView } from './components/EncodeView'
import { FormatsView } from './components/FormatsView'
import { HexView } from './components/HexView'
import { SettingsDialog } from './components/SettingsDialog'
import { desktop, errorText, isDesktop } from './platform'
import { doc, useDoc } from './store'

type Tab = 'encode' | 'hex' | 'formats' | 'disasm' | 'compile' | 'decompile'

const TABS: [Tab, string][] = [
  ['encode', 'Text ↔ Binary'],
  ['hex', 'Hex Editor'],
  ['formats', 'Data Formats'],
  ['disasm', 'Disassemble'],
  ['compile', 'Compile'],
  ['decompile', 'Decompile'],
]

export default function App() {
  const { name, path, recent, dirty, bytes, canUndo, canRedo } = useDoc()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('encode')
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = (p: Promise<unknown>) => p.catch((e) => setError(errorText(e)))

  useEffect(() => {
    doc.loadRecent().catch(() => {})
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (k === 'o') {
        e.preventDefault()
        run(doc.open())
      } else if (k === 's') {
        e.preventDefault()
        run(doc.save(e.shiftKey))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const title = `${dirty ? '● ' : ''}${name} — Binary Editor`
    document.title = title
    if (isDesktop) desktop.setTitle(title).catch(() => {})
  }, [name, dirty])

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const f = e.dataTransfer.files[0]
        if (f) run(doc.openFile(f))
      }}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="mr-2 font-mono font-bold text-accent">01</span>
        <button className="btn" onClick={() => doc.newFile()}>
          New
        </button>
        <button className="btn" onClick={() => run(doc.open())} title="⌘O">
          Open…
        </button>
        <button className="btn" onClick={() => run(doc.save())} title="⌘S">
          Save
        </button>
        <button className="btn" onClick={() => run(doc.save(true))} title="⇧⌘S">
          Save as…
        </button>
        {isDesktop && recent.length > 0 && (
          <select
            className="field max-w-40"
            value=""
            onChange={(e) => e.target.value && run(doc.openPath(e.target.value))}
            title="Recent files"
          >
            <option value="">Recent…</option>
            {recent.map((p) => (
              <option key={p} value={p}>
                {p.split(/[\\/]/).pop()} — {p}
              </option>
            ))}
          </select>
        )}
        <span className="mx-1 h-4 w-px bg-line" />
        <button className="btn" disabled={!canUndo} onClick={() => doc.undo()}>
          Undo
        </button>
        <button className="btn" disabled={!canRedo} onClick={() => doc.redo()}>
          Redo
        </button>
        <nav className="ml-4 flex self-stretch">
          {TABS.map(([id, label]) => (
            <button key={id} className={`tab ${tab === id ? 'tab-active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="ml-auto truncate font-mono text-xs text-dim" title={path ?? name}>
          {dirty && <span className="text-accent">● </span>}
          {name} · {bytes.length.toLocaleString()} B
        </span>
        {isDesktop && (
          <button className="btn" onClick={() => setSettingsOpen(true)} title="Tool paths and timeouts">
            ⚙
          </button>
        )}
      </header>
      {error && (
        <div className="flex items-center gap-2 border-b border-warn/50 bg-warn/10 px-3 py-1 text-xs text-warn">
          {error}
          <button className="ml-auto" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      <main className="relative min-h-0 flex-1">
        {tab === 'encode' && <EncodeView />}
        {tab === 'hex' && <HexView />}
        {tab === 'formats' && <FormatsView />}
        {tab === 'disasm' && <DisasmView />}
        {tab === 'compile' && <CompileView />}
        {tab === 'decompile' && <DecompileView />}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-accent bg-bg/80 text-lg">
            Drop file to open
          </div>
        )}
      </main>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
